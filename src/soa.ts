import { Block, Expr, Node, Stmt } from "./ast";
import { A, Analyzer, nodeText, posOf } from "./analyzer";
import { kids } from "./optimize";
import { schedSourcePath } from "./project";
import type { LocalSym, Sym, Ty } from "./scope";

/** a struct narrower than this in both fields and bytes gains too little from #soa */
const MIN_FIELDS = 3;
const MIN_BYTES = 32;

const SIZES: Record<string, number> = {
  bool: 1, b8: 1, i8: 1, u8: 1, byte: 1, b16: 2, i16: 2, u16: 2, f16: 2, b32: 4, i32: 4, u32: 4, f32: 4, rune: 4,
  b64: 8, i64: 8, u64: 8, f64: 8, int: 8, uint: 8, uintptr: 8, rawptr: 8, string: 16, i128: 16, u128: 16,
};
const BY_REF = new Set(["append", "clear", "reserve", "resize"]);
const WHOLE_PARENTS = new Set(["ValueDecl", "Assign", "Call", "FieldValue", "CompoundLit", "Return"]);

type ValueDecl = Extract<Stmt, { k: "ValueDecl" }>;
type TypeExpr = Extract<Expr, { k: "TypeExpr" }>;

interface Candidate {
  sym: LocalSym;
  decl: ValueDecl;
  type: TypeExpr;
  /** the `make` type of a typed declaration with a value, which gets #soa too */
  made?: TypeExpr;
  struct: string;
  fields: string[];
  bytes: number;
  why?: string;
  /** fields each loop touches through the local */
  loops: Map<Node, Set<string>>;
}

/**
 * -opt: a local `[dynamic]T`, `make([]T, n)` or `[N]T` of a wide struct becomes `#soa` when some loop
 * touches only some of its fields and every use of it means the same on an #soa container.
 */
export function soaLocals(body: Block, an: Analyzer): void {
  const cands = new Map<LocalSym, Candidate>();
  const collect = (n: Node): void => {
    if (n.k === "Block") for (const s of n.stmts) {
      const c = s.k === "ValueDecl" && candidate(s, an);
      if (c) cands.set(c.sym, c);
    }
    for (const c of kids(n)) if (c.k !== "ProcLit") collect(c);
  };
  collect(body);
  if (!cands.size) return;
  scan(body, cands);
  const quiet = posOf(body).file === schedSourcePath();
  for (const c of cands.values()) {
    const note = (text: string) => {
      const i = text.indexOf(": ");
      if (!quiet) an.hint(c.type, text.slice(0, i), `${c.sym.name}: ${text.slice(i + 2)}`);
    };
    const width = `${c.fields.length} fields, ~${Math.ceil(c.bytes / 8) * 8} bytes`;
    if (c.fields.length < MIN_FIELDS && c.bytes < MIN_BYTES) {
      note(`not #soa: ${c.struct} is narrow (${width})`);
      continue;
    }
    if (c.why) {
      note(`not #soa: ${c.why}`);
      continue;
    }
    const best = [...c.loops.values()].filter((s) => s.size).sort((a, b) => a.size - b.size)[0];
    if (!best || best.size >= c.fields.length) {
      note(`not #soa: ${best ? `every loop touches all ${c.fields.length} fields` : "no loop reads or writes its fields"}`);
      continue;
    }
    for (const t of [c.type, c.made]) if (t) A(t)._fix = { prefix: "#soa", suffix: "" };
    note(`#soa: a loop touches ${best.size} of ${c.fields.length} fields of ${c.struct} (${[...best].join(", ")}); ${width}`);
  }
}

/**
 * `a: [dynamic]T`, `a: [N]T`, `a := make([dynamic]T, ...)`, `a := make([]T, ...)` or
 * `a: [dynamic]T = make([dynamic]T, ...)` with T a plain struct.
 */
function candidate(s: ValueDecl, an: Analyzer): Candidate | undefined {
  if (s.isConst || s.names.length !== 1 || A(s)._pre?.length || A(s)._orReturn || A(s)._allocGroup || A(s)._allocGrouped) return undefined;
  const sym: LocalSym | undefined = A(s)._syms?.[0];
  if (sym?.kind !== "local" || sym.name === "_") return undefined;
  const made = (v: Expr): Expr | undefined => {
    if (v.k !== "Call" || v.fn.k !== "Ident" || v.fn.name !== "make" || A(v.fn)._sym || !v.args.length) return undefined;
    const t = v.args[0];
    return t.k === "TypeExpr" && (t.what === "dynamic" || t.what === "slice") && !t.parts[0] ? t : undefined;
  };
  let type: Expr | undefined;
  let also: Expr | undefined;
  if (s.type && !s.values.length) {
    type = s.type;
    if (type.k !== "TypeExpr" || !(type.what === "dynamic" ? !type.parts[0] : type.what === "array" && type.parts[0])) return undefined;
  } else if (s.type && s.values.length === 1) {
    type = s.type;
    also = made(s.values[0]);
    if (!also || nodeText(also) !== nodeText(type)) return undefined;
  } else if (!s.type && s.values.length === 1) {
    type = made(s.values[0]);
  }
  const elem = type?.k === "TypeExpr" ? type.parts[1] : null;
  if (!elem) return undefined;
  const shape = structShape(an, { t: "node", node: elem, scope: A(elem)._scope ?? sym.scope });
  if (!shape) return undefined;
  return { sym, decl: s, type: type as TypeExpr, made: also as TypeExpr | undefined, struct: elem.toks.slice(elem.start, elem.end).map((t) => t.text).join(""), ...shape, loops: new Map() };
}

/** Field names and a rough size of a plain struct: no `using`, field tags, directives or parameters. */
function structShape(an: Analyzer, ty: Ty): { fields: string[]; bytes: number } | undefined {
  const n = an.normalize(ty);
  if (n?.t !== "node" || n.node.k !== "StructType" || n.node.polyParams || n.node.extra.length) return undefined;
  const st = n.node;
  for (let i = st.start; i < st.end && st.toks[i].text !== "{"; i++) if (st.toks[i].kind === "directive") return undefined;
  const fields: string[] = [];
  let bytes = 0;
  for (const f of st.fields) {
    if (!f.type || f.names.some((x) => x.prefix)) return undefined;
    const size = sizeOf(an, { t: "node", node: f.type, scope: n.scope }, 0);
    for (const x of f.names) fields.push(x.name), (bytes += size);
  }
  return fields.length ? { fields, bytes } : undefined;
}

/** At least roughly the size of a type; 8 when unknown. */
export function sizeOf(an: Analyzer, ty: Ty, depth = 0): number {
  const n = an.normalize(ty);
  if (n?.t !== "node" || depth > 8) return 8;
  const e = n.node;
  if (e.k === "Ident") return SIZES[e.name] ?? 8;
  if (e.k === "TypeExpr" && e.what === "array" && e.parts[0]?.k === "Lit" && e.parts[1]) {
    const len = Number(e.parts[0].toks[e.parts[0].start].text.replace(/_/g, ""));
    return Number.isFinite(len) ? len * sizeOf(an, { t: "node", node: e.parts[1], scope: n.scope }, depth + 1) : 8;
  }
  if (e.k === "TypeExpr" && (e.what === "slice" || e.what === "dynamic")) return e.what === "slice" ? 16 : 40;
  if (e.k === "StructType") return e.fields.reduce((s, f) => s + f.names.length * (f.type ? sizeOf(an, { t: "node", node: f.type, scope: n.scope }, depth + 1) : 8), 0);
  return 8;
}

function isBuiltin(e: Expr, names: Set<string> | string): e is Extract<Expr, { k: "Ident" }> {
  return e.k === "Ident" && !A(e)._sym && (typeof names === "string" ? e.name === names : names.has(e.name));
}

function describe(n: Node | undefined, ident: Node, what: string): string {
  switch (n?.k) {
    case "Call":
      return `${what} is passed to '${n.fn.toks.slice(n.fn.start, n.fn.end).map((t) => t.text).join("")}'`;
    case "Assign":
      return n.lhs.includes(ident as Expr) ? `${what} is assigned as a whole` : `${what} is copied to another variable`;
    case "ValueDecl":
      return `${what} is copied to another variable`;
    case "Return":
      return `${what} is returned`;
    case "Unary":
      return n.op === "&" ? `it takes &${what}` : `it uses ${n.op}${what}`;
    case "Index":
      return n.slice ? `${what} is sliced` : `${what} is indexed in a way #soa doesn't support`;
  }
  return `${what} is used as a whole`;
}

/** Checks every use of the candidates, and records the fields each loop touches through them. */
function scan(body: Block, cands: Map<LocalSym, Candidate>): void {
  /** variables of `for x in a` and `for &x in a` loops over a candidate */
  const loopVars = new Map<LocalSym, { c: Candidate; byRef: boolean }>();
  const stack: Node[] = [];
  const loops: Node[] = [];
  const line = (n: Node) => ` (line ${posOf(n).line})`;
  const fail = (c: Candidate, why: string, at: Node) => (c.why ??= why + line(at));
  const touch = (c: Candidate, fields: string[]) => {
    for (const l of loops) {
      const set = c.loops.get(l) ?? new Set();
      for (const f of fields) set.add(f);
      c.loops.set(l, set);
    }
  };
  const up = (i: number): Node | undefined => stack[stack.length - 1 - i];
  /** the top of `x.f`, `x.f.g`, `x.f[i]`, starting at the selector, and what holds it */
  const fieldChain = (from: number): { top: Node; parent: Node | undefined } => {
    let i = from;
    for (;;) {
      const p = up(i + 1);
      const cur = up(i)!;
      if ((p?.k === "Selector" && p.x === cur) || (p?.k === "Index" && p.x === cur && !p.slice)) i++;
      else return { top: cur, parent: p };
    }
  };
  /** `x.f...` where `x` is `up(at)`: allowed unless its address is taken, it's sliced or it gets a method call */
  const field = (c: Candidate, at: number): string | undefined => {
    const sel = up(at + 1);
    if (sel?.k !== "Selector" || sel.x !== up(at) || !c.fields.includes(sel.name)) return undefined;
    const { top, parent } = fieldChain(at + 1);
    if ((parent?.k === "Unary" && parent.op === "&") || parent?.k === "ArrowCall" || (parent?.k === "Index" && parent.x === top) || parent?.k === "Using") return undefined;
    return sel.name;
  };

  const ident = (n: Extract<Expr, { k: "Ident" }>) => {
    const sym: Sym | undefined = A(n)._sym;
    if (sym?.kind !== "local") return;
    const lv = loopVars.get(sym);
    if (lv) {
      const f = field(lv.c, 0);
      if (f) touch(lv.c, [f]);
      else if (lv.byRef) fail(lv.c, `'for &${sym.name}' uses ${sym.name} other than through its fields`, n);
      else touch(lv.c, lv.c.fields);
      return;
    }
    const c = cands.get(sym);
    if (!c) return;
    const p = up(1);
    const dynamic = c.type.what === "dynamic";
    if (p?.k === "Call" && p.args[0] === n && (isBuiltin(p.fn, "len") || isBuiltin(p.fn, "cap") || (isBuiltin(p.fn, "delete") && c.type.what !== "array"))) return;
    if (p?.k === "Unary" && p.op === "&") {
      const call = up(2);
      if (dynamic && call?.k === "Call" && call.args[0] === p && isBuiltin(call.fn, BY_REF)) return;
    }
    if (p?.k === "RangeFor" && p.x === n) return;
    if (p?.k === "Index" && p.x === n && !p.slice && p.indices.length === 1) {
      const f = field(c, 1);
      if (f) return touch(c, [f]);
      const g = up(2);
      const whole = g && WHOLE_PARENTS.has(g.k) && !(g.k === "Call" && g.fn === p) && !(g.k === "Assign" && g.op !== "=" && g.lhs.includes(p));
      if (whole && !A(p)._wrapIface && !A(p)._upcast) return touch(c, c.fields);
      if (g?.k === "Binary" && (g.op === "==" || g.op === "!=")) return touch(c, c.fields);
      return fail(c, describe(g, p, `${c.sym.name}[i]`), n);
    }
    fail(c, describe(p, n, c.sym.name), n);
  };

  const visit = (n: Node): void => {
    stack.push(n);
    if (n.k === "Ident") ident(n);
    if (n.k === "ProcLit") for (const cap of A(n)._captures ?? []) {
      let t: Sym = cap;
      while (t.kind === "capture") t = t.target;
      const c = cands.get(t as LocalSym) ?? loopVars.get(t as LocalSym)?.c;
      if (c) fail(c, `${cap.name} is captured by a closure`, n);
    }
    if (n.k === "RangeFor" && n.x.k === "Ident" && cands.has(A(n.x)._sym)) {
      const c = cands.get(A(n.x)._sym)!;
      const v: LocalSym | undefined = A(n)._syms?.[0];
      if (A(n)._pool) fail(c, "a Pool loop goes over it", n);
      else if (v && n.vals[0].name !== "_") loopVars.set(v, { c, byRef: n.vals[0].byRef });
    }
    const loop = n.k === "For" || n.k === "RangeFor";
    if (loop) loops.push(n);
    for (const c of kids(n)) visit(c);
    if (loop) loops.pop();
    stack.pop();
  };
  visit(body);
}
