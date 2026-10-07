import { basename } from "node:path";
import { memoPlan, selfCalls } from "./memo";
import { reorderStructs } from "./reorder";
import { Expr, Node, children } from "./ast";
import { A, Analyzer, CallSite, ClosureSpec, INT_TYPES, markInlined, SpecInfo, nodeText, posOf, unwrapProc } from "./analyzer";
import type { GlobalSym, LocalSym, Sym } from "./scope";

type ProcLit = Extract<Expr, { k: "ProcLit" }>;

/** more differing constant arguments than this, and a proc keeps a single copy; also the most closure copies */
const MAX_COPIES = 4;
/** without a loop, a body is worth a table only past this many operations */
const TABLE_OPS = 24;
/** compile-time steps one input of an automatic table may take */
const TABLE_STEPS = 20_000;
/** results a table may hold: each is computed at compile time */
const TABLE_ENTRIES = 4096;

const KEEPS = new Set(["private", "require_results", "specialize", "table", "memo", "no_specialize", "no_table", "no_memo", "no_stack_buffer", "no_perfect_hash", "no_alloc", "hot"]);
const DIVIDES = new Set(["/", "%", "%%", "<<", ">>"]);
const ASSIGNS = new Set(["=", "+=", "-=", "*=", "/=", "%=", "%%=", "&=", "|=", "~=", "<<=", ">>=", "&~="]);

/**
 * -opt, after analysis: procs that weren't marked get @(table) or @(specialize) when that is
 * safe and likely to pay off. Each decision, and why it went the other way, is an `an.hint`.
 */
export function autoOptimize(an: Analyzer): void {
  for (const [sym, info] of an.specialized) {
    const sets = [...info.clones.values()].map((c) => c.join(", "));
    if (sets.length) an.hint(sym, `specialized ×${sets.length}`, `@(specialize): a copy with ${sets.join("; a copy with ")} known at compile time`);
    else if (!A(info.lit)._closureCopies) an.hint(sym, "not specialized", "@(specialize): no call passes a constant");
  }
  for (const [sym, sites] of an.callSites) {
    const lit = procOf(an, sym);
    if (!lit || an.tables.has(sym) || an.memos.has(sym)) continue;
    const off = an.optOut.get(sym);
    if (!off?.has("table") && autoTable(an, sym, lit)) continue;
    if (!off?.has("memo") && autoMemo(an, sym, lit)) continue;
    if (!off?.has("specialize")) autoSpecialize(an, sym, lit, closureSpecialize(an, sym, lit, sites));
  }
  reorderStructs(an);
}

/** Calls passing closure literals call a copy that calls their bodies directly. Returns the other calls. */
function closureSpecialize(an: Analyzer, sym: GlobalSym, lit: ProcLit, sites: CallSite[]): CallSite[] {
  if (!an.calledOnlyParams(lit, sym.scope).size) return sites;
  const found = sites.map((site) => ({ site, closures: an.closureLits(sym, lit, site.call) })).filter((x) => x.closures.size);
  if (!found.length) {
    const why = an.closureMisses(sym, lit, sites.map((s) => s.call));
    if (why) an.note(sym, `not specialized for closures: ${why}`);
    return sites;
  }
  const chosen = found.slice(0, MAX_COPIES);
  for (const { site, closures } of chosen) {
    A(site.call)._closureSpec = { sym, lit, consts: [], closures } satisfies ClosureSpec;
    markInlined(lit);
  }
  const params = [...new Set(chosen.flatMap((x) => [...x.closures.keys()]))].join(", ");
  const where = (call: Node) => {
    const at = posOf(call);
    return at.file === posOf(lit).file ? `${at.line}` : `${at.line} of ${basename(at.file)}`;
  };
  const lines = chosen.map((x) => where(x.site.call)).join(", ");
  const rest = found.length - chosen.length;
  an.note(sym, `specialized: a copy calling the closure passed to ${params} directly, for the call${chosen.length > 1 ? "s at lines" : " at line"} ${lines}` +
    (rest ? `; ${rest} more passing a closure literal call${rest === 1 ? "s" : ""} the original, past ${MAX_COPIES} copies` : ""));
  return sites.filter((s) => !A(s.call)._closureSpec);
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
  const flat = params.flatMap((p) => p.names.map((n) => ({ n, p })));
  if (flat.length < 1 || flat.length > 2 || unnamed || flat.some(({ n, p }) => !p.type || p.value || n.prefix)) return false;
  if (results.length !== 1 || !resultsUnnamed || !results[0].type) return false;
  const typeName = (t: Expr) => an.typeName({ t: "node", node: t, scope: A(t)._scope ?? sym.scope });
  const domains = flat.map(({ p }) => ({ bool: "bool", u8: "u8", byte: "u8", i8: "i8" } as const)[typeName(p.type!) ?? ""]);
  if (domains.some((d) => !d) || !isIntOrBool(typeName(results[0].type))) return false;
  if (!(lit.toks[lit.start].text === "proc" && lit.toks[lit.start + 1]?.text === "(")) return false;
  const size = (d: string | undefined) => (d === "bool" ? 2 : 256);
  const entries = domains.reduce((n, d) => n * size(d), 1);
  const label = flat.length === 2 ? "table 2D" : "table";
  if (entries > TABLE_ENTRIES) return no(an, sym, `${domains.join(" × ")} is ${entries} results, more than ${TABLE_ENTRIES}`, flat.length === 2);

  const shape = integerOnly(an, sym, lit, new Set([sym]));
  if (shape.why) return no(an, sym, `it ${shape.why}`, flat.length === 2);
  if (!shape.loop && shape.ops < TABLE_OPS) return no(an, sym, `${shape.ops} operation${shape.ops === 1 ? "" : "s"} and no loop, cheaper than a memory load`, flat.length === 2);
  const values = an.tabulate(sym, domains[0]!, TABLE_STEPS, domains[1]);
  if (!values) return no(an, sym, `the body doesn't finish at compile time for every ${domains.join(", ")} within ${TABLE_STEPS} steps`, flat.length === 2);
  const second = flat[1] && { domain: domains[1]!, param: flat[1].n.name, type: flat[1].p.type! };
  an.tables.set(sym, { lit, domain: domains[0]!, param: flat[0].n.name, type: flat[0].p.type!, result: results[0].type, values, second });
  an.hint(sym, label, `${values.length} results, ${shape.loop ? "has a loop" : `${shape.ops} operations`}, pure integer code`);
  return true;
}

function no(an: Analyzer, sym: GlobalSym, why: string, twoD = false): false {
  an.hint(sym, twoD ? "no table 2D" : "no table", why);
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

// ---- memo ----

/**
 * A pure integer proc that calls itself more than once per call (exponential recursion, like fib)
 * gets a memo table for the duration of each outer call.
 */
function autoMemo(an: Analyzer, sym: GlobalSym, lit: ProcLit): boolean {
  const calls = selfCalls(lit, sym);
  if (calls.length < 2) return false;
  const no = (why: string) => (an.hint(sym, "no memo", why), false);
  const { params, results } = lit.sig;
  const typeOk = (t: Expr | undefined) => !!t && isIntOrBool(an.typeName({ t: "node", node: t, scope: A(t)._scope ?? sym.scope }));
  if (!params.every((p) => typeOk(p.type)) || results.length !== 1 || !typeOk(results[0].type)) return no("it takes or returns more than integers and bools");
  const shape = integerOnly(an, sym, lit, new Set([sym]));
  if (shape.why) return no(`it ${shape.why}`);
  if (an.noAllocProcs.size) return no("the program has @(no_alloc) procs, and a memo allocates its table");
  const plan = memoPlan(an, sym, lit);
  if (typeof plan === "string") return no(plan);
  an.useMemo(sym, plan);
  an.hint(sym, "memo", `calls itself ${calls.length} times per call, pure integer code: a ${plan.array ? `${plan.array}-entry array` : "map"} for each outer call, shared by the recursive ones`);
  return true;
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
      : names.filter((n, i) => i < site.call.args.length && of(n) && an.isConstant(site.call.args[i], site.scope) && !an.emptiesRange(lit, n, site.call.args[i], site.scope));
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
  if (!combos.size) return void an.hint(sym, "not specialized", `no call passes a constant to ${[...roles.keys()].join(" or ")}`);
  const why = [...new Set([...combos.values()].flat())].map((p) => `${p} ${roles.get(p)}`).join(", ");
  if (combos.size === 1 && !runtimeCalls) return void an.hint(sym, "not specialized", `every call passes ${[...combos.keys()][0]}, which LLVM folds without a copy`);
  if (combos.size > MAX_COPIES) return void an.hint(sym, "not specialized", `${combos.size} different constant arguments, more than ${MAX_COPIES} copies`);

  for (const [site, consts] of chosen) {
    const key = consts.join("_");
    info.clones.set(key, consts);
    A(site.call)._spec = { sym, key };
  }
  an.specialized.set(sym, info);
  an.hint(sym, `specialized ×${combos.size}`, `${why}; one copy for each of ${[...combos.keys()].join(" | ")}`);
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
