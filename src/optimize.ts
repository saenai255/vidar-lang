import { Block, Expr, File, Node, Stmt, children } from "./ast";
import { A, Analyzer, INT_TYPES } from "./analyzer";
import { fmtPlan } from "./fmtspec";
import { sizeOf, soaLocals } from "./soa";
import { stackBuffers } from "./stackbuf";
import type { LocalSym, Sym, Ty } from "./scope";

/**
 * -opt rewrites inside one procedure. Each is applied only where the procedure's own code proves
 * it changes nothing but speed; the results are annotations the emitter reads:
 * - `_noBounds` on a statement: every index in it is proven in bounds, so it gets `#no_bounds_check`
 * - `_allocGroup` / `_allocGrouped` / `_groupFree`: slices and pointers freed together, allocated together
 * - `_stackBuf` / `_stackFree`: a constant-size `make` freed by a defer, on the stack instead (stackbuf.ts)
 * - `_reserve` on a loop: dynamic arrays it appends to at most a known number of times, reserved before it
 * Each decision is also an `an.hint`, so -opt-report and the editor show it.
 */
export function optimizeProc(body: Block, an: Analyzer, closureCopies = false): void {
  const facts = collectFacts(body);
  provenIndexes(body, facts, an);
  stackBuffers(body, an, facts);
  allocGroups(body, facts, an);
  reserves(body, facts, an);
  soaLocals(body, an);
  if (!an.hints) return;
  walk(body, (n) => {
    if (n.k !== "Call") return;
    if (fmtPlan(an, n)) an.hint(n, "fmt inlined", "a compiled format: writes each piece directly, no format parsing or `any` boxing at run time");
    // copies made for closure literals call those directly
    else if (A(n)._closure && !A(n)._closureSpec && !closureCopies) an.hint(n, "no direct call", "a call through a closure value: an indirect call that can't be inlined");
  });
}

/** Runs `optimizeProc` on every proc in `files` without emitting them, for the hints. */
export function optimizeAll(an: Analyzer, files: File[]): void {
  const visit = (n: Node): void => {
    if (n.k === "ProcLit") {
      if (n.comptime) return;
      if (n.body && !A(n)._optimized) {
        A(n)._optimized = true;
        optimizeProc(n.body, an, !!A(n)._closureCopies);
      }
    }
    for (const c of kids(n)) visit(c);
  };
  for (const f of files) f.stmts.forEach(visit);
}

interface Facts {
  /** locals whose address is taken, or that a closure captures by reference */
  addressed: Set<LocalSym>;
  /** assignments to each local as a whole */
  assigned: Map<LocalSym, Node[]>;
  /** `delete(x)` and `free(x)` calls on each local */
  freed: Map<LocalSym, Node[]>;
}

/** Child nodes plus the code macros expanded to and the statements they hoisted. */
export function kids(n: Node): Node[] {
  const out = children(n);
  const exp: Node | undefined = A(n)._expansion;
  if (exp) out.push(exp);
  const pre: Node[] | undefined = A(n)._pre;
  if (pre) out.push(...pre);
  return out;
}

/** Visits `n` and everything in it, except nested procedures (they get their own pass). */
function walk(n: Node, f: (n: Node) => boolean | void): void {
  if (f(n) === false) return;
  for (const c of kids(n)) if (c.k !== "ProcLit") walk(c, f);
}

function localOf(e: Expr | undefined): LocalSym | undefined {
  while (e?.k === "Paren") e = e.x;
  const sym: Sym | undefined = e?.k === "Ident" ? A(e)._sym : undefined;
  return sym?.kind === "local" ? sym : undefined;
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  m.set(k, [...(m.get(k) ?? []), v]);
}

/** What the procedure does to its locals; a closure capturing one by reference marks it `refCaptured`. */
function collectFacts(body: Block): Facts {
  const facts: Facts = { addressed: new Set(), assigned: new Map(), freed: new Map() };
  walk(body, (m) => {
    if (m.k === "Unary" && m.op === "&") {
      const s = localOf(m.x);
      if (s) facts.addressed.add(s);
    }
    if (m.k === "Assign") for (const l of m.lhs) {
      const s = localOf(l);
      if (s) push(facts.assigned, s, m);
    }
    if (m.k === "Call" && m.fn.k === "Ident" && !A(m.fn)._sym && (m.fn.name === "delete" || m.fn.name === "free")) {
      const s = localOf(m.args[0]);
      if (s) push(facts.freed, s, m);
    }
  });
  return facts;
}

// ---- bounds checks ----

/** `x` keeps its length while `body` runs: a local or parameter nothing can reach through a pointer. */
function stable(x: LocalSym | undefined, body: Node, facts: Facts): x is LocalSym {
  if (!x || x.refCaptured || facts.addressed.has(x) || x.declKind === "other") return false;
  for (const a of facts.assigned.get(x) ?? []) if (contains(body, a)) return false;
  return true;
}

function contains(root: Node, target: Node): boolean {
  let found = false;
  walk(root, (n) => {
    if (n === target) found = true;
    return !found;
  });
  return found;
}

function isLen(e: Expr | null): LocalSym | undefined {
  if (e?.k !== "Call" || e.fn.k !== "Ident" || e.fn.name !== "len" || A(e.fn)._sym || e.args.length !== 1) return undefined;
  return localOf(e.args[0]);
}

/**
 * A loop's index `i` and the range it covers, `lo..<hi` with a step of 1 unless `step1` is false:
 * `for i in lo..<hi`, `for x, i in a` (hi is `len(a)`), `for i := lo; i < hi; i += c`.
 * `hiLen`/`hiMinus`: hi is `len(hiLen) - hiMinus`.
 */
interface LoopRange {
  index: LocalSym;
  lo: bigint;
  step1: boolean;
  hiLen?: LocalSym;
  hiMinus: bigint;
  /** a range's `hi`, which a check before the loop can wrap */
  hi?: Expr;
  /** the array of `for x, i in a`, which a check before the loop can wrap */
  over?: Expr;
  body: Block;
}

function intLit(e: Expr | null | undefined): bigint | undefined {
  while (e?.k === "Paren") e = e.x;
  if (e?.k !== "Lit" || e.kind !== "int") return undefined;
  const t = e.toks[e.start].text.replace(/_/g, "");
  return /^\d+$/.test(t) ? BigInt(t) : undefined;
}

/** `len(a)` or `len(a) - k` with a literal k */
function lenMinus(e: Expr | null): { array: LocalSym; minus: bigint } | undefined {
  while (e?.k === "Paren") e = e.x;
  const array = isLen(e);
  if (array) return { array, minus: 0n };
  if (e?.k !== "Binary" || e.op !== "-") return undefined;
  const k = intLit(e.y);
  const a = isLen(e.x);
  return a && k !== undefined ? { array: a, minus: k } : undefined;
}

function loopRange(s: Node, facts: Facts): LoopRange | undefined {
  if (s.k === "RangeFor") {
    const syms: LocalSym[] = A(s)._syms ?? [];
    if (A(s)._pool) return undefined;
    const x = s.x;
    if (x.k === "Binary" && x.op === "..<") {
      const lo = intLit(x.x);
      if (lo === undefined || !syms[0] || s.vals[0].name === "_") return undefined;
      const len = lenMinus(x.y);
      const hiLen = len && stable(len.array, s.body, facts) ? len.array : undefined;
      return { index: syms[0], lo, step1: true, hiLen, hiMinus: hiLen ? len!.minus : 0n, hi: x.y, body: s.body };
    }
    const array = localOf(x);
    if (!stable(array, s.body, facts) || !syms[1] || s.vals[1].name === "_" || s.vals[1].byRef) return undefined;
    return { index: syms[1], lo: 0n, step1: true, hiLen: array, hiMinus: 0n, over: x, body: s.body };
  }
  if (s.k === "For" && s.init?.k === "ValueDecl" && s.init.names.length === 1 && s.init.values.length === 1) {
    const lo = intLit(s.init.values[0]);
    const index = (A(s.init)._syms as LocalSym[] | undefined)?.[0];
    const cond = s.cond;
    const post = s.post;
    if (lo === undefined || !index || cond?.k !== "Binary" || cond.op !== "<" || localOf(cond.x) !== index) return undefined;
    const step = post?.k === "Assign" && post.op === "+=" && localOf(post.lhs[0]) === index ? intLit(post.rhs[0]) : undefined;
    if (step === undefined) return undefined;
    if (facts.addressed.has(index) || (facts.assigned.get(index) ?? []).some((a) => a !== post)) return undefined;
    const len = lenMinus(cond.y);
    if (!len || !stable(len.array, s.body, facts)) return undefined;
    return { index, lo, step1: step === 1n, hiLen: len.array, hiMinus: len.minus, body: s.body };
  }
  return undefined;
}

/** `i`, `i + k` or `i - k` with a literal k: the local and the offset. */
function offsetIndex(e: Expr | null): { sym: LocalSym; off: bigint } | undefined {
  while (e?.k === "Paren") e = e.x;
  if (!e) return undefined;
  const sym = localOf(e);
  if (sym) return { sym, off: 0n };
  if (e.k !== "Binary" || (e.op !== "+" && e.op !== "-")) return undefined;
  const k = intLit(e.y);
  const l = localOf(e.x);
  if (l && k !== undefined) return { sym: l, off: e.op === "+" ? k : -k };
  const k2 = intLit(e.x);
  const r = localOf(e.y);
  return e.op === "+" && r && k2 !== undefined ? { sym: r, off: k2 } : undefined;
}

/** Locals declared inside `body`, which don't exist before the loop. */
function declaredIn(body: Block): Set<LocalSym> {
  const out = new Set<LocalSym>();
  walk(body, (n) => {
    for (const s of (A(n)._syms ?? []) as Sym[]) if (s?.kind === "local") out.add(s);
  });
  return out;
}

/** Indexes evaluated on every pass through `body`: in its own statements, not under an if, a loop, `&&`, `||` or `?:`. */
function unconditionalIndexes(body: Block): Extract<Expr, { k: "Index" }>[] {
  const out: Extract<Expr, { k: "Index" }>[] = [];
  const visit = (n: Node): void => {
    if (n.k === "ProcLit" || n.k === "Block" || COMPOUND.has(n.k) || n.k === "Defer" || n.k === "Case") return;
    if (n.k === "Index") out.push(n);
    if (n.k === "Binary" && (n.op === "&&" || n.op === "||")) return visit(n.x);
    if (n.k === "Ternary") return visit(n.cond);
    if (n.k === "Postfix" && n.op.startsWith("or_")) return visit(n.x);
    for (const c of kids(n)) visit(c);
  };
  for (const s of body.stmts) visit(s);
  return out;
}

/** An array whose length a check before the loop can take: a slice, dynamic array, fixed array or string. */
function measurable(an: Analyzer, x: LocalSym, at: Expr): boolean {
  const t = an.normalize(an.typeOf(at, A(at)._scope ?? an.global));
  if (t?.t !== "node") return false;
  if (t.node.k === "Ident") return t.node.name === "string";
  return t.node.k === "TypeExpr" && ["slice", "dynamic", "array"].includes(t.node.what) && x.declKind !== "other";
}

/** `for x, i in e` counts i from 0 by 1: e is a slice, dynamic array or fixed array (not a string, a map or a bit set). */
function indexedByPosition(an: Analyzer, e: Expr): boolean {
  const t = an.normalize(an.typeOf(e, A(e)._scope ?? an.global));
  return t?.t === "node" && t.node.k === "TypeExpr" && ["slice", "dynamic", "array"].includes(t.node.what);
}

/** `bounds_upto(hi, lo, len(counts)...)`, written before a loop */
export interface BoundsGuard {
  lo: string;
  /** the range's end, or the array `for x, i in over` goes over */
  hi: Expr | null;
  over: Expr | null;
  counts: Expr[];
}

interface Proof {
  range: LoopRange;
  /** arrays indexed by plain `i` on every pass, which one check before the loop covers */
  guardable: Map<LocalSym, Expr>;
  used: Map<LocalSym, Expr>;
}

/**
 * Marks the statements of loop bodies whose every index is proven in bounds: by the loop's range,
 * or, for an array indexed on every pass of a loop with no early exit, by one check before the
 * loop that fails the way the loop would have (`bounds_upto` in the runtime).
 */
function provenIndexes(body: Block, facts: Facts, an: Analyzer): void {
  const proofs: Proof[] = [];
  /** the proof covering `e`, and the guarded array it needs, if any */
  const proof = (e: Extract<Expr, { k: "Index" }>): { p: Proof; guard?: LocalSym } | undefined => {
    if (e.slice || e.indices.length !== 1) return undefined;
    const x = localOf(e.x);
    const idx = offsetIndex(e.indices[0]);
    if (!x || !idx) return undefined;
    for (const p of proofs) {
      const r = p.range;
      if (idx.sym !== r.index) continue;
      if (x === r.hiLen && idx.off <= r.hiMinus && r.lo + idx.off >= 0n) return { p };
      if (idx.off === 0n && p.guardable.has(x)) return { p, guard: x };
    }
    return undefined;
  };
  /** whether every index in `n` is proven, whether it has any, and the guards it needs */
  const check = (n: Node): { all: boolean; any: boolean; guards: { p: Proof; guard: LocalSym }[] } => {
    let all = true;
    let any = false;
    const guards: { p: Proof; guard: LocalSym }[] = [];
    walk(n, (m) => {
      if (m.k !== "Index") return;
      any = true;
      const pr = proof(m);
      if (!pr) all = false;
      else if (pr.guard) guards.push({ p: pr.p, guard: pr.guard });
    });
    return { all, any, guards };
  };
  const enter = (s: Node): Proof | undefined => {
    const range = loopRange(s, facts);
    if (!range) return undefined;
    const guardable = new Map<LocalSym, Expr>();
    const wrap = range.hi && simple(range.hi) && [...locals(range.hi)].every((l) => stable(l, range.body, facts));
    if (range.step1 && (wrap || (range.over && indexedByPosition(an, range.over))) && straight(range.body)) {
      const inner = declaredIn(range.body);
      for (const ix of unconditionalIndexes(range.body)) {
        const x = localOf(ix.x);
        const idx = offsetIndex(ix.indices[0] ?? null);
        if (!x || inner.has(x) || ix.slice || ix.indices.length !== 1 || idx?.sym !== range.index || idx.off !== 0n || x === range.hiLen) continue;
        if (stable(x, range.body, facts) && measurable(an, x, ix.x)) guardable.set(x, ix.x);
      }
    }
    return { range, guardable, used: new Map() };
  };
  const leave = (p: Proof, loop: Node) => {
    if (!p.used.size) return;
    const counts = [...p.used.values()];
    const names = [...p.used.keys()].map((x) => x.name).join(", ");
    A(loop)._boundsGuard = { lo: String(p.range.lo), hi: p.range.hi ?? null, over: p.range.over ?? null, counts } satisfies BoundsGuard;
    an.hint(loop, "bounds hoisted", `one check before the loop that ${names} ${p.used.size > 1 ? "are" : "is"} long enough for every index; the indexes inside are unchecked`);
  };
  const stmts = (list: Stmt[]) => list.forEach((s) => stmt(s));
  let loops = 0;
  /** `holder`: the statement the loop is written as, with its label or directive */
  const stmt = (s: Stmt, holder: Stmt = s): void => {
    const p = enter(s);
    if (p) proofs.push(p);
    const loop = s.k === "For" || s.k === "RangeFor";
    if (loop) loops++;
    try {
      if (p || proofs.length) {
        const inner = s.k === "Labeled" || s.k === "DirectiveStmt" ? s.stmt : s;
        const body = inner.k === "For" || inner.k === "RangeFor" ? inner.body : null;
        // the loop header itself isn't covered: mark statements inside it
        if (body) {
          if (inner !== s) stmt(inner, s);
          else stmts(body.stmts);
          return;
        }
        const { all, any, guards } = check(s);
        if (all && any && proofs.length) {
          for (const g of guards) g.p.used.set(g.guard, g.p.guardable.get(g.guard)!);
          A(s)._noBounds = true;
          an.hint(s, "unchecked", guards.length
            ? "every index here is proven in bounds, by its loop or by one check before it, so it gets #no_bounds_check"
            : "every index here is proven in bounds by its loop, so it gets #no_bounds_check");
          return;
        }
      }
      if (loops && !COMPOUND.has(s.k) && an.hints && checkedIndex(s, an))
        an.hint(s, "no bounds proof", "an index here isn't proven in bounds by its loop, so it keeps its bounds check");
      for (const c of kids(s)) {
        if (c.k === "Block") stmts(c.stmts);
        else if (c.k === "Case") stmts(c.body);
        else if (COMPOUND.has(c.k)) stmt(c as Stmt);
      }
    } finally {
      if (p) {
        proofs.pop();
        leave(p, holder);
      }
      if (loop) loops--;
    }
  };
  stmts(body.stmts);
}

const COMPOUND = new Set(["If", "For", "RangeFor", "Switch", "Labeled", "DirectiveStmt", "When"]);

/** Whether `s` indexes anything that has a bounds check: not a map, not a constant into a fixed array. */
function checkedIndex(s: Node, an: Analyzer): boolean {
  let found = false;
  walk(s, (m) => {
    if (found || m.k !== "Index") return;
    const t = an.normalize(an.typeOf(m.x, an.global));
    const what = t?.t === "node" && t.node.k === "TypeExpr" ? t.node.what : undefined;
    if (what === "map") return;
    if (what === "array" && !m.slice && m.indices.every((i) => i?.k === "Lit")) return;
    found = true;
  });
  return found;
}

// ---- grouped allocations ----

export interface GroupMember {
  name: string;
  sym: LocalSym;
  /** element type of `make([]E, n)`, or the type of `new(T)` */
  elem: Expr;
  count: Expr | null;
  decl: Extract<Stmt, { k: "ValueDecl" }>;
  free: Extract<Stmt, { k: "Defer" }>;
}

export interface AllocGroup {
  members: GroupMember[];
  allocator: Expr | null;
}

/** `x := make([]E, n[, allocator])` or `x := new(T[, allocator])`. */
function allocation(s: Stmt): { name: string; sym: LocalSym; elem: Expr; count: Expr | null; allocator: Expr | null } | undefined {
  if (s.k !== "ValueDecl" || s.isConst || s.type || s.names.length !== 1 || s.values.length !== 1 || A(s)._pre?.length || A(s)._stackBuf) return undefined;
  const call = s.values[0];
  if (call.k !== "Call" || call.fn.k !== "Ident" || A(call.fn)._sym || call.args.some((a) => a.k === "FieldValue")) return undefined;
  const sym = (A(s)._syms as LocalSym[] | undefined)?.[0];
  if (!sym) return undefined;
  if (call.fn.name === "make" && (call.args.length === 2 || call.args.length === 3)) {
    const t = call.args[0];
    if (t.k !== "TypeExpr" || t.what !== "slice" || !t.parts[1]) return undefined;
    return { name: s.names[0].name, sym, elem: t.parts[1], count: call.args[1], allocator: call.args[2] ?? null };
  }
  if (call.fn.name === "new" && (call.args.length === 1 || call.args.length === 2)) {
    return { name: s.names[0].name, sym, elem: call.args[0], count: null, allocator: call.args[1] ?? null };
  }
  return undefined;
}

/** Evaluating it earlier changes nothing: names, literals, arithmetic, `len`, `size_of`. */
function simple(e: Expr): boolean {
  switch (e.k) {
    case "Ident": case "Lit": case "ImplicitSelector":
      return true;
    case "Paren": case "Unary": case "Selector":
      return simple(e.x);
    case "Binary":
      return simple(e.x) && simple(e.y);
    case "Call":
      return e.fn.k === "Ident" && !A(e.fn)._sym && ["len", "cap", "size_of", "align_of", "min", "max"].includes(e.fn.name) && e.args.every(simple);
  }
  return false;
}

function text(e: Expr | null): string {
  return e ? e.toks.slice(e.start, e.end).map((t) => t.text).join(" ") : "";
}

function mentions(e: Expr, syms: Set<LocalSym>): boolean {
  let found = false;
  walk(e, (n) => {
    const s = n.k === "Ident" ? A(n)._sym : undefined;
    if (s && syms.has(s)) found = true;
  });
  return found;
}

/**
 * Adjacent `x := make([]E, n)` / `p := new(T)` freed only by a `defer delete(x)` / `defer free(p)`
 * in the same block become one allocation, freed by the defer that runs last.
 */
function allocGroups(body: Block, facts: Facts, an: Analyzer): void {
  const block = (b: Block) => {
    const defers = new Map<LocalSym, Extract<Stmt, { k: "Defer" }>>();
    for (const s of b.stmts) {
      if (s.k !== "Defer" || s.stmt.k !== "ExprStmt" || s.stmt.x.k !== "Call") continue;
      const call = s.stmt.x;
      const sym = localOf(call.args[0]);
      if (sym && call.fn.k === "Ident" && !A(call.fn)._sym && (call.fn.name === "delete" || call.fn.name === "free") && call.args.every((a) => a.k !== "FieldValue")) defers.set(sym, s);
    }
    let run: (GroupMember & { allocator: Expr | null })[] = [];
    const close = () => {
      if (run.length >= 2) {
        const group: AllocGroup = { members: run, allocator: run[0].allocator };
        A(run[0].decl)._allocGroup = group;
        for (const m of run.slice(1)) A(m.decl)._allocGrouped = run[0].name;
        const order = run.map((m) => b.stmts.indexOf(m.free));
        const last = run[order.indexOf(Math.min(...order))];
        for (const m of run) A(m.free)._groupFree = { group, keep: m === last };
        for (const m of run) an.hint(m.decl, "grouped alloc", `one allocation for ${run.map((x) => x.name).join(", ")}, freed by the defer that runs last`);
      }
      run = [];
    };
    for (const s of b.stmts) {
      const a = allocation(s);
      const free = a && defers.get(a.sym);
      const call = free && ((free.stmt as Extract<Stmt, { k: "ExprStmt" }>).x as Extract<Expr, { k: "Call" }>);
      const ok =
        a && free && call &&
        (call.fn as Extract<Expr, { k: "Ident" }>).name === (a.count ? "delete" : "free") &&
        text(call.args[1] ?? null) === text(a.allocator) &&
        (facts.freed.get(a.sym) ?? []).length === 1 &&
        !facts.addressed.has(a.sym) && !a.sym.refCaptured && !facts.assigned.has(a.sym) &&
        (!a.count || simple(a.count)) && (!a.allocator || simple(a.allocator)) &&
        b.stmts.indexOf(free) > b.stmts.indexOf(s);
      if (!ok) {
        close();
        continue;
      }
      const syms = new Set(run.map((m) => m.sym));
      if (run.length && (text(a.allocator) !== text(run[0].allocator) || (a.count && mentions(a.count, syms)) || (a.allocator && mentions(a.allocator, syms)))) close();
      run.push({ ...a, decl: s as GroupMember["decl"], free: free! });
    }
    close();
  };
  walk(body, (n) => {
    if (n.k === "Block") block(n);
  });
}

// ---- reserve before append loops ----

/** How many times a loop runs, computed before it: `hi - lo`, plus one when inclusive, or `len(of)`. */
export type TripCount = { lo: Expr | null; hi: Expr; inclusive: boolean; cast: boolean } | { of: Expr };

export interface Reserve {
  /** the first argument of the appends: `&xs`, or a pointer `p` */
  target: Expr;
  /** `xs`; null when appended to through a pointer */
  array: Expr | null;
  perIteration: number;
  trip: TripCount;
}

type Loop = Extract<Stmt, { k: "For" | "RangeFor" }>;

/** The local a place is rooted at: `x` in `x.f[i]^`. */
function rootOf(e: Expr): LocalSym | undefined {
  while (e.k === "Paren" || e.k === "Selector" || e.k === "Index" || e.k === "Deref") e = e.x;
  return localOf(e);
}

function builtin(n: Node, ...names: string[]): n is Extract<Expr, { k: "Call" }> {
  return n.k === "Call" && n.fn.k === "Ident" && !A(n.fn)._sym && names.includes(n.fn.name);
}

/** Nothing in `loop` but the `allowed` nodes can change `syms`: no assignment, `&`, `clear`, `resize` or `delete`. */
function untouched(loop: Node, syms: Set<LocalSym>, allowed: Set<Node>): boolean {
  if ([...syms].some((s) => s.refCaptured || s.declKind === "other")) return false;
  const hits = (e: Expr | undefined) => {
    const s = e && rootOf(e);
    return !!s && syms.has(s);
  };
  let ok = true;
  walk(loop, (n) => {
    if (allowed.has(n)) return false;
    if (n.k === "Assign" && n.lhs.some(hits)) ok = false;
    if (n.k === "Unary" && n.op === "&" && hits(n.x)) ok = false;
    if (builtin(n, "delete", "free", "clear", "resize") && hits(n.args[0])) ok = false;
    return ok;
  });
  return ok;
}

function usedOutside(root: Node, sym: LocalSym, allowed: Set<Node>): boolean {
  let used = false;
  walk(root, (n) => {
    if (allowed.has(n)) return false;
    if (n.k === "Ident" && A(n)._sym === sym) used = true;
  });
  return used;
}

/** Every iteration runs the whole body: no break, continue, return or `or_*` in it. */
function straight(body: Block): boolean {
  let ok = true;
  walk(body, (n) => {
    if (n.k === "Branch" || n.k === "Return" || (n.k === "Postfix" && n.op.startsWith("or_"))) ok = false;
    return ok;
  });
  return ok;
}

function locals(e: Expr): Set<LocalSym> {
  const out = new Set<LocalSym>();
  walk(e, (n) => {
    const s = n.k === "Ident" ? localOf(n) : undefined;
    if (s) out.add(s);
  });
  return out;
}

function isZero(e: Expr): boolean {
  return e.k === "Lit" && e.kind === "int" && e.toks[e.start].text === "0";
}

function intKind(an: Analyzer, e: Expr): "int" | "other" | undefined {
  const name = an.typeName(an.typeOf(e, A(e)._scope ?? an.global));
  if (name === "int" || name === "untyped int") return "int";
  return name && name !== "uintptr" && (INT_TYPES.has(name) || name === "rune" || name === "untyped rune") ? "other" : undefined;
}

function interval(an: Analyzer, lo: Expr, hi: Expr, inclusive: boolean): TripCount | undefined {
  const kinds = [lo, hi].map((e) => intKind(an, e));
  if (!simple(lo) || !simple(hi) || kinds.includes(undefined)) return undefined;
  return { lo: isZero(lo) ? null : lo, hi, inclusive, cast: kinds.includes("other") };
}

/** The loop's trip count, and the locals it is computed from. */
function tripCount(loop: Loop, facts: Facts, an: Analyzer): { trip: TripCount; uses: Set<LocalSym> } | undefined {
  let trip: TripCount | undefined;
  if (loop.k === "RangeFor") {
    const x = loop.x;
    if (A(loop)._pool) return undefined;
    if (x.k === "Binary" && (x.op === "..<" || x.op === "..=")) trip = interval(an, x.x, x.y, x.op === "..=");
    else if (rootOf(x) && simple(x)) {
      const t = an.normalize(an.typeOf(x, A(x)._scope ?? an.global));
      const sized = t?.t === "node" && ((t.node.k === "TypeExpr" && ["array", "slice", "dynamic"].includes(t.node.what)) || an.typeName(t) === "string");
      if (sized) trip = { of: x };
    }
  } else if (loop.init?.k === "ValueDecl" && loop.init.names.length === 1 && loop.init.values.length === 1) {
    const index = (A(loop.init)._syms as LocalSym[] | undefined)?.[0];
    const { cond, post } = loop;
    if (!index || cond?.k !== "Binary" || (cond.op !== "<" && cond.op !== "<=") || localOf(cond.x) !== index) return undefined;
    const step = post?.k === "Assign" && post.op === "+=" && localOf(post.lhs[0]) === index && post.rhs[0].k === "Lit" && post.rhs[0].toks[post.rhs[0].start].text === "1";
    if (!step || facts.addressed.has(index) || index.refCaptured || (facts.assigned.get(index) ?? []).some((a) => a !== post)) return undefined;
    trip = interval(an, loop.init.values[0], cond.y, cond.op === "<=");
  }
  if (!trip) return undefined;
  const operands = "of" in trip ? [trip.of] : [trip.hi, ...(trip.lo ? [trip.lo] : [])];
  return { trip, uses: new Set(operands.flatMap((e) => [...locals(e)])) };
}

/** A `[dynamic]T` local `xs` appended to as `&xs`, or a `^[dynamic]T` local `p` appended to as `p`. */
function dynamicTarget(an: Analyzer, arg: Expr): { sym: LocalSym; byPointer: boolean; elem: Ty | undefined } | undefined {
  const byPointer = !(arg.k === "Unary" && arg.op === "&");
  const sym = localOf(arg.k === "Unary" && arg.op === "&" ? arg.x : arg);
  let t = an.normalize(sym?.ty);
  if (byPointer) t = t?.t === "ptr" ? an.normalize(t.elem) : undefined;
  if (!sym || t?.t !== "node" || t.node.k !== "TypeExpr" || t.node.what !== "dynamic") return undefined;
  const elem = t.node.parts[1];
  return { sym, byPointer, elem: elem ? { t: "node", node: elem, scope: t.scope } : undefined };
}

/** an upper-bound reserve can't be undone, so it is only made for elements this small */
const SMALL_ELEM = 16;

interface Appends {
  target: Expr;
  byPointer: boolean;
  elem: Ty | undefined;
  /** values appended per iteration; the larger branch for appends under an `if` */
  per: number;
  args: Set<Node>;
  ok: boolean;
  conditional: boolean;
}

/** Appends to dynamic arrays in `list`, and those in `if` branches at any depth, counted by their larger branch. */
function appendsIn(an: Analyzer, list: Stmt[]): Map<LocalSym, Appends> {
  const found = new Map<LocalSym, Appends>();
  const merge = (from: Map<LocalSym, Appends>, into: Map<LocalSym, Appends>, combine: (a: number, b: number) => number) => {
    for (const [sym, f] of from) {
      const g = into.get(sym);
      if (!g) into.set(sym, { ...f, args: new Set(f.args) });
      else {
        g.per = combine(g.per, f.per);
        f.args.forEach((a) => g.args.add(a));
        g.ok &&= f.ok && f.byPointer === g.byPointer;
        g.conditional ||= f.conditional;
      }
    }
  };
  for (const st of list) {
    if (st.k === "If") {
      const branches = [appendsIn(an, st.then.stmts), appendsIn(an, st.else ? (st.else.k === "Block" ? st.else.stmts : [st.else]) : [])];
      const either = new Map<LocalSym, Appends>();
      for (const b of branches) merge(b, either, Math.max);
      for (const f of either.values()) f.conditional = true;
      merge(either, found, (a, b) => a + b);
      continue;
    }
    if (st.k !== "ExprStmt" || !builtin(st.x, "append") || !st.x.args[0]) continue;
    const t = dynamicTarget(an, st.x.args[0]);
    if (!t) continue;
    const values = st.x.args.slice(1);
    const ok = !!values.length && !values.some((v) => v.k === "Spread" || v.k === "FieldValue");
    merge(new Map([[t.sym, { target: st.x.args[0], byPointer: t.byPointer, elem: t.elem, per: values.length, args: new Set<Node>([st.x.args[0]]), ok, conditional: false }]]), found, (a, b) => a + b);
  }
  return found;
}

/**
 * A loop whose trip count is known before it starts, and that appends to a dynamic array in every
 * iteration, gets `reserve(&xs, len(xs) + count)` before it: one allocation instead of a doubling series.
 */
function reserves(body: Block, facts: Facts, an: Analyzer): void {
  const loop = (s: Stmt) => {
    let inner: Stmt = s;
    while (inner.k === "Labeled" || inner.k === "DirectiveStmt") inner = inner.stmt;
    if ((inner.k !== "For" && inner.k !== "RangeFor") || !straight(inner.body)) return;
    const count = tripCount(inner, facts, an);
    if (!count || !untouched(inner, count.uses, new Set())) return;
    const out: Reserve[] = [];
    for (const [sym, f] of appendsIn(an, inner.body.stmts)) {
      if (!f.ok || count.uses.has(sym) || !untouched(inner, new Set([sym]), f.args)) continue;
      // through a pointer, any other use of it could clear or resize the array
      if (f.byPointer && usedOutside(inner, sym, f.args)) continue;
      const size = f.elem ? sizeOf(an, f.elem) : Infinity;
      if (f.conditional && size > SMALL_ELEM) {
        an.hint(f.target, "not reserved", `${sym.name}: appended under an \`if\`, and its ${size}-byte elements are too big to reserve for every iteration`);
        continue;
      }
      const array = f.byPointer ? null : (f.target as Extract<Expr, { k: "Unary" }>).x;
      out.push({ target: f.target, array, perIteration: f.per, trip: count.trip });
      const per = `${f.per} append${f.per === 1 ? "" : "s"} per iteration`;
      an.hint(f.target, "reserved", f.conditional ? `${sym.name}: reserved before the loop for at most ${per}, since some are under an \`if\`` : `${sym.name}: reserved before the loop, ${per}`);
    }
    if (out.length) A(s)._reserve = out;
  };
  walk(body, (n) => {
    const list = n.toks !== body.toks ? null : n.k === "Case" ? n.body : n.k === "Block" && !n.inline && n.toks[n.start].text === "{" ? n.stmts : null;
    list?.forEach(loop);
  });
}
