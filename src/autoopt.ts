import { Expr, Node, children } from "./ast";
import { A, Analyzer, CallSite, INT_TYPES, SpecInfo, nodeText, posOf, unwrapProc } from "./analyzer";
import type { GlobalSym, LocalSym, Sym } from "./scope";

type ProcLit = Extract<Expr, { k: "ProcLit" }>;

/** more differing constant arguments than this, and a proc keeps a single copy */
const MAX_COPIES = 4;
/** without a loop, a body is worth a table only past this many operations */
const TABLE_OPS = 24;
/** compile-time steps one input of an automatic table may take */
const TABLE_STEPS = 20_000;

const KEEPS = new Set(["private", "require_results", "specialize", "table", "no_specialize", "no_table"]);
const DIVIDES = new Set(["/", "%", "%%", "<<", ">>"]);
const ASSIGNS = new Set(["=", "+=", "-=", "*=", "/=", "%=", "%%=", "&=", "|=", "~=", "<<=", ">>=", "&~="]);

/**
 * -opt, after analysis: procs that weren't marked get @(table) or @(specialize) when that is
 * safe and likely to pay off. Each decision, and why it went the other way, goes to the report.
 */
export function autoOptimize(an: Analyzer): void {
  for (const [sym, info] of an.specialized) {
    const sets = [...info.clones.values()].map((c) => c.join(", "));
    an.note(sym, sets.length ? `@(specialize): a copy with ${sets.join("; a copy with ")} known at compile time` : "@(specialize): no call passes a constant");
  }
  for (const [sym, sites] of an.callSites) {
    const lit = procOf(an, sym);
    if (!lit || an.tables.has(sym)) continue;
    const off = an.optOut.get(sym);
    if (!off?.has("table") && autoTable(an, sym, lit)) continue;
    if (!off?.has("specialize")) autoSpecialize(an, sym, lit, sites);
  }
}

/** A plain proc declaration with a body and only attributes that a rewrite keeps meaning. */
function procOf(an: Analyzer, sym: GlobalSym): ProcLit | undefined {
  const value = sym.decl.values[sym.index];
  const lit = sym.isConst && value ? unwrapProc(value) : undefined;
  if (!lit?.body || lit.comptime || lit.captures || an.whenDeclared.has(sym)) return undefined;
  const attrs = sym.decl.attrs.flatMap((a) => a.replace(/^@\(?|\)$/g, "").split(",").map((x) => x.split("=")[0].trim()));
  return attrs.every((a) => KEEPS.has(a)) ? lit : undefined;
}

// ---- tables ----

function autoTable(an: Analyzer, sym: GlobalSym, lit: ProcLit): boolean {
  const { params, results, unnamed, resultsUnnamed } = lit.sig;
  const param = params[0];
  if (params.length !== 1 || param.names.length !== 1 || !param.type || param.value || param.names[0].prefix || unnamed) return false;
  if (results.length !== 1 || !resultsUnnamed || !results[0].type) return false;
  const typeName = (t: Expr) => an.typeName({ t: "node", node: t, scope: A(t)._scope ?? sym.scope });
  const domain = ({ bool: "bool", u8: "u8", byte: "u8", i8: "i8" } as const)[typeName(param.type) ?? ""];
  if (!domain || !isIntOrBool(typeName(results[0].type))) return false;
  if (!(lit.toks[lit.start].text === "proc" && lit.toks[lit.start + 1]?.text === "(")) return false;

  const shape = integerOnly(an, sym, lit, new Set([sym]));
  if (shape.why) return no(an, sym, `no table: it ${shape.why}`);
  if (!shape.loop && shape.ops < TABLE_OPS) return no(an, sym, `no table: ${shape.ops} operation${shape.ops === 1 ? "" : "s"} and no loop, cheaper than a memory load`);
  const values = an.tabulate(sym, domain, TABLE_STEPS);
  if (!values) return no(an, sym, `no table: the body doesn't finish at compile time for every ${domain} within ${TABLE_STEPS} steps`);
  an.tables.set(sym, { lit, domain, param: param.names[0].name, type: param.type, result: results[0].type, values });
  an.note(sym, `table of ${values.length} results, ${shape.loop ? "has a loop" : `${shape.ops} operations`}, pure integer code`);
  return true;
}

function no(an: Analyzer, sym: GlobalSym, why: string): false {
  an.note(sym, why);
  return false;
}

function isIntOrBool(name: string | undefined): boolean {
  return !!name && ((INT_TYPES.has(name) && name !== "uintptr") || name === "bool" || name === "rune");
}

interface Shape {
  /** what makes it unfit, when it is */
  why?: string;
  loop: boolean;
  ops: number;
}

/**
 * Whether a body only does integer and bool arithmetic on its locals and constants, calling only
 * procs that do the same: the code compile-time evaluation runs exactly like the compiled program.
 */
function integerOnly(an: Analyzer, sym: GlobalSym, lit: ProcLit, seen: Set<GlobalSym>): Shape {
  const shape: Shape = { loop: false, ops: 0 };
  const fail = (why: string, n: Node) => (shape.why ??= `${why} (line ${posOf(n).line})`);
  const typeOk = (t: Expr) => isIntOrBool(an.typeName({ t: "node", node: t, scope: A(t)._scope ?? sym.scope }));

  const call = (n: Extract<Expr, { k: "Call" }>) => {
    if (n.args.some((a) => a.k === "FieldValue" || a.k === "Spread")) return fail("passes named or spread arguments", n);
    const target: Sym | undefined = n.fn.k === "Ident" ? A(n.fn)._sym : undefined;
    const name = n.fn.k === "Ident" ? n.fn.name : "";
    if (!target && (isIntOrBool(name) || ["min", "max", "abs"].includes(name))) return n.args.forEach(visit);
    const callee = target?.kind === "global" ? procOf(an, target) : undefined;
    if (!callee) return fail(/^f(16|32|64)/.test(name) ? "uses floats" : `calls '${nodeText(n.fn)}'`, n);
    if (!seen.has(target as GlobalSym)) {
      seen.add(target as GlobalSym);
      const { params, results } = callee.sig;
      if (!params.every((p) => p.type && typeOk(p.type) && !p.names.some((x) => x.prefix)) || results.length !== 1 || !results[0].type || !typeOk(results[0].type))
        return fail(`calls '${name}', which takes or returns more than integers and bools`, n);
      const inner = integerOnly(an, target as GlobalSym, callee, seen);
      if (inner.why) return fail(`calls '${name}', which ${inner.why.replace(/ \(line \d+\)$/, "")}`, n);
      shape.loop ||= inner.loop;
      shape.ops += inner.ops;
    }
    shape.ops++;
    n.args.forEach(visit);
  };

  const visit = (n: Node | null | undefined): void => {
    if (!n || shape.why) return;
    switch (n.k) {
      case "Lit":
        if (n.kind !== "int" && n.kind !== "rune") fail(`uses a ${n.kind} literal`, n);
        return;
      case "Ident": {
        if (n.name === "true" || n.name === "false") return;
        const s: Sym | undefined = A(n)._sym;
        if (s?.kind === "local") return;
        if (s?.kind !== "global" || !s.isConst) return void fail(`reads '${n.name}', which isn't a local or a constant`, n);
        const value = s.decl.values[s.index];
        if (!value || seen.has(s)) return;
        seen.add(s);
        return visit(value);
      }
      case "Unary":
        if (!["-", "+", "!", "~"].includes(n.op)) return void fail(`uses '${n.op}'`, n);
        shape.ops++;
        return visit(n.x);
      case "Binary":
        if (["in", "not_in", "or_else", "..<", "..="].includes(n.op)) return void fail(`uses '${n.op}'`, n);
        shape.ops++;
        return children(n).forEach(visit);
      case "Call":
        return void call(n);
      case "ValueDecl":
        if (n.type && !typeOk(n.type)) return void fail(`declares a ${nodeText(n.type)}`, n);
        if (!n.values.length && !n.type) return void fail("declares a value without a type", n);
        return n.values.forEach(visit);
      case "Assign":
        if (!ASSIGNS.has(n.op) || n.lhs.some((l) => l.k !== "Ident" || A(l)._sym?.kind !== "local")) return void fail("assigns to something other than a local", n);
        shape.ops++;
        return n.rhs.forEach(visit);
      case "For":
      case "RangeFor":
        shape.loop = true;
        if (n.k === "RangeFor") {
          if (n.x.k !== "Binary" || (n.x.op !== "..<" && n.x.op !== "..=") || n.vals.some((v) => v.byRef)) return void fail("loops over something other than a range", n);
          return [n.x.x, n.x.y, n.body].forEach(visit);
        }
        return children(n).forEach(visit);
      case "Switch":
        if (n.typeSwitchVar) return void fail("has a type switch", n);
        return children(n).forEach(visit);
      case "Return":
        if (n.results.length !== 1) return void fail("returns without a value", n);
        return visit(n.results[0]);
      case "Branch":
        if (n.op !== "break" && n.op !== "continue") fail(`uses '${n.op}'`, n);
        return;
      case "ExprStmt":
        if (A(n)._expansion) return void fail("uses a macro", n);
        return visit(n.x);
      case "Block":
      case "Case":
      case "If":
      case "Paren":
      case "Ternary":
      case "Empty":
        return children(n).forEach(visit);
    }
    fail(n.k === "MacroCall" ? "uses a macro" : `uses ${describe(n)}`, n);
  };

  visit(lit.body);
  return shape;
}

function describe(n: Node): string {
  const names: Partial<Record<Node["k"], string>> = {
    Index: "indexing", Selector: "a selector", CompoundLit: "a composite literal", Deref: "a pointer", Cast: "a cast",
    Defer: "defer", When: "when", Labeled: "a label", ImplicitSelector: "an enum value",
  };
  return names[n.k] ?? `'${n.k}'`;
}

// ---- specialization ----

function autoSpecialize(an: Analyzer, sym: GlobalSym, lit: ProcLit, sites: CallSite[]): void {
  const info: SpecInfo = { lit, scope: sym.scope, clones: new Map() };
  const eligible = an.specParams(info);
  if (!eligible.size) return;
  const names = lit.sig.params.flatMap((p) => p.names.map((n) => n.name));
  const constArgs = (site: CallSite, of: (name: string) => boolean) =>
    site.call.args.some((a) => a.k === "FieldValue" || a.k === "Spread")
      ? []
      : names.filter((n, i) => i < site.call.args.length && of(n) && an.isConstant(site.call.args[i], site.scope));
  if (!sites.some((s) => constArgs(s, (n) => eligible.has(n)).length)) return;

  const roles = drivers(lit, new Set(eligible));
  if (!roles.size) return;

  const combos = new Map<string, string[]>();
  const chosen = new Map<CallSite, string[]>();
  let runtimeCalls = 0;
  for (const site of sites) {
    const consts = constArgs(site, (n) => roles.has(n));
    if (!consts.length) {
      runtimeCalls++;
      continue;
    }
    chosen.set(site, consts);
    combos.set(consts.map((n) => `${n} = ${nodeText(site.call.args[names.indexOf(n)])}`).join(", "), consts);
  }
  if (!combos.size) return void an.note(sym, `not specialized: no call passes a constant to ${[...roles.keys()].join(" or ")}`);
  const why = [...new Set([...combos.values()].flat())].map((p) => `${p} ${roles.get(p)}`).join(", ");
  if (combos.size === 1 && !runtimeCalls) return void an.note(sym, `not specialized: every call passes ${[...combos.keys()][0]}, which LLVM folds without a copy`);
  if (combos.size > MAX_COPIES) return void an.note(sym, `not specialized: ${combos.size} different constant arguments, more than ${MAX_COPIES} copies`);

  for (const [site, consts] of chosen) {
    const key = consts.join("_");
    info.clones.set(key, consts);
    A(site.call)._spec = { sym, key };
  }
  an.specialized.set(sym, info);
  an.note(sym, `specialized: ${why}; one copy for each of ${[...combos.keys()].join(" | ")}`);
}

/** What each parameter does that a compile-time value speeds up: bounds a loop, or divides, shifts or branches inside one. */
function drivers(lit: ProcLit, eligible: Set<string>): Map<string, string> {
  const params = new Map<LocalSym, string>();
  for (const p of (A(lit)._params as LocalSym[] | undefined) ?? []) if (eligible.has(p.name)) params.set(p, p.name);
  const roles = new Map<string, string>();
  const mark = (e: Node | null | undefined, role: string) => {
    if (!e) return;
    if (e.k === "Ident" && params.has(A(e)._sym)) {
      const name = params.get(A(e)._sym)!;
      if (!roles.has(name)) roles.set(name, role);
    }
    for (const c of children(e)) if (c.k !== "ProcLit") mark(c, role);
  };
  const walk = (n: Node, inLoop: boolean): void => {
    if (n.k === "ProcLit") return;
    if (n.k === "For") mark(n.cond, "bounds a loop");
    if (n.k === "RangeFor") mark(n.x, "bounds a loop");
    if (inLoop) {
      if (n.k === "Binary" && DIVIDES.has(n.op)) mark(n.y, n.op === "<<" || n.op === ">>" ? "is a shift in a loop" : "divides in a loop");
      if (n.k === "If") mark(n.cond, "branches in a loop");
      if (n.k === "Switch") mark(n.tag, "branches in a loop");
      if (n.k === "Ternary") mark(n.cond, "branches in a loop");
    }
    const loop = inLoop || n.k === "For" || n.k === "RangeFor";
    for (const c of children(n)) walk(c, loop);
  };
  walk(lit.body!, false);
  return roles;
}
