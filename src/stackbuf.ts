import { dirname } from "node:path";
import { Block, Expr, Node, Stmt } from "./ast";
import { A, Analyzer, unwrapProc } from "./analyzer";
import { kids } from "./optimize";
import { schedSourcePath } from "./project";
import { sizeOf } from "./soa";
import type { CaptureSym, LocalSym, Sym } from "./scope";

type ProcLit = Extract<Expr, { k: "ProcLit" }>;
type Call = Extract<Expr, { k: "Call" }>;

/** goroutine stacks are small (256 KB by default, and deep call chains share them) */
const CAP_GOROUTINE = 4 * 1024;
const CAP = 64 * 1024;
/** how deep calls are followed to see that a callee doesn't keep the slice */
const MAX_DEPTH = 4;

/** core procs that never keep a slice they are given */
const QUIET: Record<string, true | string[]> = {
  "core:fmt": true,
  "core:math": true,
  "core:slice": ["sort", "sort_by", "sort_by_key", "stable_sort", "stable_sort_by", "reverse", "fill", "contains", "linear_search", "binary_search",
    "equal", "simple_equal", "prefix_length", "has_prefix", "has_suffix", "min", "max", "min_max", "sum", "product", "is_sorted", "count", "any_of",
    "all_of", "none_of", "swap", "rotate_left", "rotate_right", "zero"],
  "core:mem": ["zero_slice", "copy", "copy_non_overlapping", "set", "compare"],
};
const QUIET_BUILTINS = new Set(["len", "cap", "copy", "min", "max", "copy_slice", "size_of"]);

export interface StackBuf {
  count: Expr;
  elem: Expr;
}

/**
 * -opt: `x := make([]T, N)` with a constant N and a matching `defer delete(x)` in the same block
 * becomes `__x_buf: [N]T; x := __x_buf[:]`, when `x` can't outlive the proc: it is only indexed,
 * measured, looped over, or passed to procs that don't keep it. Up to 4 KB in a proc a goroutine
 * can reach, 64 KB elsewhere.
 */
export function stackBuffers(body: Block, an: Analyzer, facts: { addressed: Set<LocalSym>; assigned: Map<LocalSym, Node[]>; freed: Map<LocalSym, Node[]> }): void {
  if (A(body)._noStackBuffer) return;
  const visit = (n: Node): void => {
    if (n.k === "Block") block(n);
    for (const c of kids(n)) if (c.k !== "ProcLit") visit(c);
  };
  const block = (b: Block) => {
    for (const s of b.stmts) {
      const c = candidate(s, an);
      if (!c) continue;
      const free = b.stmts.slice(b.stmts.indexOf(s) + 1).find((d) => isDeleteOf(d, c.sym));
      if (!free) continue;
      const note = (label: string, why: string) => an.hint(s, label, `${c.sym.name}: ${why}`);
      if ((facts.freed.get(c.sym) ?? []).length !== 1) { note("no stack buffer", "freed more than once"); continue; }
      if (facts.assigned.has(c.sym) || facts.addressed.has(c.sym) || c.sym.refCaptured) { note("no stack buffer", "it is assigned or its address is taken"); continue; }
      const size = Number(c.n) * sizeOf(an, { t: "node", node: c.elem, scope: A(c.elem)._scope ?? c.sym.scope });
      const goroutine = reachedByGoroutine(an).has(body);
      const cap = goroutine ? CAP_GOROUTINE : CAP;
      if (size > cap) { note("no stack buffer", `~${size} bytes is over the ${cap / 1024} KB limit${goroutine ? " for a proc a goroutine can reach" : ""}`); continue; }
      const why = escapes(an, body, c.sym, 0, new Set(), free);
      if (why) { note("no stack buffer", why); continue; }
      A(s)._stackBuf = { count: c.count, elem: c.elem } satisfies StackBuf;
      A(free)._stackFree = c.sym.name;
      note("stack buffer", `${c.n} elements (~${size} bytes) on the stack instead of the heap; the defer's delete goes away`);
    }
  };
  visit(body);
}

function candidate(s: Stmt, an: Analyzer): { sym: LocalSym; count: Expr; elem: Expr; n: bigint } | undefined {
  if (s.k !== "ValueDecl" || s.isConst || s.type || s.names.length !== 1 || s.values.length !== 1 || A(s)._pre?.length || A(s)._orReturn) return undefined;
  const call = s.values[0];
  if (call.k !== "Call" || call.fn.k !== "Ident" || call.fn.name !== "make" || A(call.fn)._sym || call.args.length !== 2) return undefined;
  const [t, count] = call.args;
  if (t.k !== "TypeExpr" || t.what !== "slice" || !t.parts[1] || count.k === "FieldValue") return undefined;
  const sym: LocalSym | undefined = A(s)._syms?.[0];
  if (!sym || sym.name === "_") return undefined;
  const n = constant(an, count);
  return n !== undefined && n > 0n ? { sym, count, elem: t.parts[1], n } : undefined;
}

/** The value of an integer expression made only of literals and constants. */
function constant(an: Analyzer, e: Expr): bigint | undefined {
  let ok = true;
  const check = (n: Node) => {
    if (n.k === "Ident") {
      const sym: Sym | undefined = A(n)._sym;
      if (!sym || !((sym.kind === "global" || sym.kind === "local") && sym.isConst)) ok = false;
    } else if (n.k === "Call" || n.k === "ProcLit") ok = false;
    if (ok) for (const c of kids(n)) check(c);
  };
  check(e);
  if (!ok) return undefined;
  try {
    const v = an.interp.evalIn(e, A(e)._scope ?? an.global);
    return v.k === "int" ? v.v : undefined;
  } catch {
    return undefined;
  }
}

function isDeleteOf(s: Stmt, sym: LocalSym): s is Extract<Stmt, { k: "Defer" }> {
  if (s.k !== "Defer" || s.stmt.k !== "ExprStmt") return false;
  const call = s.stmt.x;
  return call.k === "Call" && call.fn.k === "Ident" && call.fn.name === "delete" && !A(call.fn)._sym && call.args.length === 1 && call.args[0].k === "Ident" && A(call.args[0])._sym === sym;
}

function nameOf(e: Expr): string {
  return e.toks.slice(e.start, e.end).map((t) => t.text).join("");
}

function calleeLit(fn: Expr): ProcLit | undefined {
  while (fn.k === "Paren") fn = fn.x;
  const sym: Sym | undefined = fn.k === "Ident" ? A(fn)._sym : fn.k === "Selector" ? A(fn)._pkgMember : undefined;
  if (sym?.kind === "global" && sym.isConst) {
    const v = sym.decl.values[sym.index];
    return v ? unwrapProc(v) : undefined;
  }
  if (sym?.kind === "local" && sym.isConst && sym.value) return unwrapProc(sym.value);
  return undefined;
}

function quietCall(fn: Expr): boolean {
  if (fn.k === "Ident" && !A(fn)._sym) return QUIET_BUILTINS.has(fn.name);
  if (fn.k === "Selector" && fn.x.k === "Ident") {
    const pkg: Sym | undefined = A(fn.x)._sym;
    if (pkg?.kind !== "pkg" || pkg.target) return false;
    const q = QUIET[pkg.path];
    return q === true || (!!q && q.includes(fn.name));
  }
  return false;
}

/** Why `sym` (a slice in `root`) might outlive the frame, or undefined when it can't. */
function escapes(an: Analyzer, root: Node, sym: LocalSym, depth: number, seen: Set<string>, free?: Node): string | undefined {
  const stack: Node[] = [];
  let why: string | undefined;
  const at = (n: Node) => ` (line ${n.toks[n.start]?.pos.line ?? "?"})`;
  const visit = (n: Node): void => {
    if (why) return;
    if (n === free) return;
    if (n.k === "ProcLit") {
      for (const cap of (A(n)._captures ?? []) as CaptureSym[]) {
        let t: Sym = cap;
        while (t.kind === "capture") t = t.target;
        if (t === sym) why = `${sym.name} is captured by a closure${at(n)}`;
      }
      return;
    }
    if (n.k === "Ident" && A(n)._sym === sym) {
      why = use(n, stack);
      if (why && !/\(line \d+\)$/.test(why)) why += at(n);
      return;
    }
    stack.push(n);
    for (const c of kids(n)) visit(c);
    stack.pop();
  };
  const use = (n: Expr, up: Node[]): string | undefined => {
    const p = up[up.length - 1];
    if (p?.k === "Index" && p.x === n) {
      if (p.slice) return `${sym.name} is sliced`;
      const g = up[up.length - 2];
      return g?.k === "Unary" && g.op === "&" ? `it takes &${sym.name}[i]` : undefined;
    }
    if (p?.k === "RangeFor" && p.x === n) return p.vals[0]?.byRef ? `'for &' over ${sym.name} takes its elements' addresses` : undefined;
    if (p?.k === "Call" && p.args.includes(n)) return passed(p, p.args.indexOf(n));
    switch (p?.k) {
      case "Return": return `${sym.name} is returned`;
      case "Assign": case "ValueDecl": return `${sym.name} is copied to another variable`;
      case "Unary": return p.op === "&" ? `it takes &${sym.name}` : `it uses ${p.op}${sym.name}`;
    }
    return `${sym.name} is used as a whole`;
  };
  const passed = (call: Call, i: number): string | undefined => {
    if (quietCall(call.fn)) return undefined;
    const lit = calleeLit(call.fn);
    const what = `${sym.name} is passed to '${nameOf(call.fn)}'${at(call)}`;
    if (!lit?.body || A(call)._closure) return `${what}, which may keep it`;
    if (call.args.slice(0, i + 1).some((a) => a.k === "FieldValue" || a.k === "Spread")) return `${what}, which may keep it`;
    const params: LocalSym[] = A(lit)._params ?? [];
    const param = params[i];
    const group = lit.sig.params.find((g) => g.names.some((x) => x.name === param?.name));
    if (!param || group?.names.some((x) => x.prefix) || (group?.type && nameOf(group.type).startsWith(".."))) return `${what}, which may keep it`;
    const key = `${nameOf(call.fn)}#${i}`;
    if (seen.has(key)) return undefined;
    if (depth >= MAX_DEPTH) return `${what}, too deep to follow`;
    seen.add(key);
    const inner = escapes(an, lit.body, param, depth + 1, seen);
    return inner ? `${what}, where ${inner}` : undefined;
  };
  visit(root);
  return why;
}

const reached = new WeakMap<Analyzer, Set<Node>>();

/** Bodies of the procs and closures a goroutine can run: everything, if a goroutine runs a closure value. */
function reachedByGoroutine(an: Analyzer): Set<Node> & { all?: boolean } {
  const done = reached.get(an);
  if (done) return done;
  const out = new Set<Node>() as Set<Node> & { all?: boolean };
  reached.set(an, out);
  const schedDir = dirname(schedSourcePath());
  const roots: Block[] = [];
  let all = false;
  const find = (n: Node): void => {
    if (n.k === "Call") {
      const sym: Sym | undefined = n.fn.k === "Selector" ? A(n.fn)._pkgMember : n.fn.k === "Ident" ? A(n.fn)._sym : undefined;
      if (sym?.kind === "global" && sym.name === "go" && sym.pkg.dir === schedDir) {
        const lit = n.args[0] && unwrapProc(n.args[0]);
        if (lit?.body) roots.push(lit.body);
        else all = true;
      }
    }
    for (const c of kids(n)) find(c);
  };
  for (const pkg of an.packages) if (pkg.dir !== schedDir) for (const f of pkg.files) f.stmts.forEach(find);
  if (all) {
    const every = (n: Node): void => {
      if (n.k === "ProcLit" && n.body) out.add(n.body);
      for (const c of kids(n)) every(c);
    };
    for (const pkg of an.packages) for (const f of pkg.files) f.stmts.forEach(every);
    return out;
  }
  const add = (b: Block): void => {
    if (out.has(b)) return;
    out.add(b);
    const visit = (n: Node): void => {
      if (n.k === "ProcLit") {
        if (n.body) add(n.body);
        return;
      }
      if (n.k === "Call") {
        const lit = calleeLit(n.fn);
        if (lit?.body) add(lit.body);
      }
      for (const c of kids(n)) visit(c);
    };
    for (const c of kids(b)) visit(c);
  };
  roots.forEach(add);
  return out;
}
