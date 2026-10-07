import { Expr, Node } from "./ast";
import { A, Analyzer, nodeText } from "./analyzer";
import { kids } from "./optimize";
import type { GlobalSym, Sym } from "./scope";

type ProcLit = Extract<Expr, { k: "ProcLit" }>;
type Call = Extract<Expr, { k: "Call" }>;

/** a memo table indexed directly holds at most this many results */
export const MEMO_ARRAY = 4096;

/**
 * A @(memo) proc: the outer call makes the table, the recursive calls share it, and it is freed
 * when the outer call returns. An array when every parameter is bool, u8 or i8, else a map.
 */
export interface MemoInfo {
  lit: ProcLit;
  params: { name: string; type: Expr; domain?: "bool" | "u8" | "i8" }[];
  result: Expr;
  /** entries of the array table, or 0 for a map */
  array: number;
  /** the calls in the body to the proc itself, which go to the memoized version */
  selfCalls: Call[];
}

const DOMAINS: Record<string, "bool" | "u8" | "i8"> = { bool: "bool", u8: "u8", byte: "u8", i8: "i8" };

/** The calls `lit`'s body makes to `sym`, outside nested procs. */
export function selfCalls(lit: ProcLit, sym: GlobalSym): Call[] {
  const out: Call[] = [];
  const visit = (n: Node): void => {
    if (n.k === "ProcLit") return;
    if (n.k === "Call" && n.fn.k === "Ident" && (A(n.fn)._sym as Sym | undefined) === sym) out.push(n);
    for (const c of kids(n)) visit(c);
  };
  if (lit.body) visit(lit.body);
  return out;
}

/** The memo plan for `lit`, or why it can't have one. */
export function memoPlan(an: Analyzer, sym: GlobalSym, lit: ProcLit): MemoInfo | string {
  const { params, results, unnamed, resultsUnnamed } = lit.sig;
  if (unnamed) return "its parameters have no names";
  if (results.length !== 1 || !resultsUnnamed || !results[0].type || results[0].names.length > 1) return "it doesn't have exactly one result";
  if (!(lit.toks[lit.start].text === "proc" && lit.toks[lit.start + 1]?.text === "(")) return "it has a calling convention or directive";
  const flat: MemoInfo["params"] = [];
  for (const p of params) {
    if (!p.type || p.value || p.names.some((n) => n.prefix)) return "a parameter has a default, `$` or `using`";
    const ty = { t: "node" as const, node: p.type, scope: A(p.type)._scope ?? sym.scope };
    const n = an.normalize(ty);
    if (!(an.isBasic(ty) && nodeText(p.type) !== "cstring") && !(n?.t === "node" && n.node.k === "EnumType")) return `'${nodeText(p.type)}' can't be a map key here`;
    for (const name of p.names) flat.push({ name: name.name, type: p.type, domain: DOMAINS[an.typeName(ty) ?? ""] });
  }
  if (!flat.length) return "it has no parameters";
  const entries = flat.every((p) => p.domain) ? flat.reduce((n, p) => n * (p.domain === "bool" ? 2 : 256), 1) : Infinity;
  return { lit, params: flat, result: results[0].type, array: entries <= MEMO_ARRAY ? entries : 0, selfCalls: selfCalls(lit, sym) };
}

/** Odin for a memo: the outer proc, the lookup proc and the table type (`body` is the renamed original). */
export function memoHelpers(name: string, m: MemoInfo, emit: (e: Expr) => string, bodyName: string): string {
  const R = emit(m.result);
  const params = m.params.map((p) => `${p.name}: ${emit(p.type)}`).join(", ");
  const args = m.params.map((p) => p.name).join(", ");
  const memo = `__${name}_memo`;
  const table = `__${name}_Memo`;
  let type: string;
  let lookup: string;
  let store: string;
  let free = "";
  if (m.array) {
    // row-major over the parameters, like a table
    const index = m.params.reduce((acc, p) => {
      const i = p.domain === "bool" ? `(1 if ${p.name} else 0)` : p.domain === "i8" ? `(int(${p.name}) + 128)` : `int(${p.name})`;
      return acc ? `${acc} * ${p.domain === "bool" ? 2 : 256} + ${i}` : i;
    }, "");
    type = `struct { done: [${m.array}]bool, value: [${m.array}]${R} }`;
    lookup = `\tkey := ${index}\n\t#no_bounds_check if __memo.done[key] do return __memo.value[key]\n`;
    store = `\t#no_bounds_check __memo.done[key], __memo.value[key] = true, r\n`;
  } else {
    const key = m.params.length === 1 ? emit(m.params[0].type) : `struct { ${m.params.map((p) => `${p.name}: ${emit(p.type)}`).join(", ")} }`;
    type = `map[${key}]${R}`;
    const k = m.params.length === 1 ? m.params[0].name : `${table}_Key{${args}}`;
    lookup = `\tkey := ${k}\n\tif v, ok := __memo[key]; ok do return v\n`;
    store = `\t__memo[key] = r\n`;
    free = "\tdefer delete(__memo)\n";
    if (m.params.length > 1) type = `map[${table}_Key]${R}\n${table}_Key :: ${key}`;
  }
  return (
    `// ${name} with a memo table: made by the outer call, shared by the recursive ones, freed on return\n` +
    `${table} :: ${type}\n\n` +
    `${name} :: proc(${params}) -> ${R} {\n\t__memo: ${table}\n${free}\treturn ${memo}(${args}, &__memo)\n}\n\n` +
    `${memo} :: proc(${params}, __memo: ^${table}) -> ${R} {\n${lookup}\tr := ${bodyName}(${args}, __memo)\n${store}\treturn r\n}`
  );
}
