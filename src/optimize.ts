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

function nonNegative(e: Expr): boolean {
  return e.k === "Lit" && e.kind === "int" && !e.toks[e.start].text.startsWith("-");
}

/** Index variables proven in bounds for an array: `for i in 0..<len(a)`, `for x, i in a`, `for i := 0; i < len(a); i += 1`. */
function loopProof(s: Node, facts: Facts): { array: LocalSym; index: LocalSym } | undefined {
  if (s.k === "RangeFor") {
    const syms: LocalSym[] = A(s)._syms ?? [];
    if (A(s)._pool) return undefined;
    const x = s.x;
    if (x.k === "Binary" && x.op === "..<" && nonNegative(x.x)) {
      const array = isLen(x.y);
      return stable(array, s.body, facts) && syms[0] ? { array, index: syms[0] } : undefined;
    }
    const array = localOf(x);
    return stable(array, s.body, facts) && syms[1] && s.vals[1].name !== "_" && !s.vals[1].byRef ? { array, index: syms[1] } : undefined;
  }
  if (s.k === "For" && s.init?.k === "ValueDecl" && s.init.names.length === 1 && s.init.values.length === 1 && nonNegative(s.init.values[0])) {
    const index = (A(s.init)._syms as LocalSym[] | undefined)?.[0];
    const cond = s.cond;
    const post = s.post;
    if (!index || cond?.k !== "Binary" || cond.op !== "<" || localOf(cond.x) !== index) return undefined;
    if (post?.k !== "Assign" || post.op !== "+=" || localOf(post.lhs[0]) !== index || !nonNegative(post.rhs[0])) return undefined;
    if (facts.addressed.has(index) || (facts.assigned.get(index) ?? []).some((a) => a !== post)) return undefined;
    const array = isLen(cond.y);
    return stable(array, s.body, facts) ? { array, index } : undefined;
  }
  return undefined;
}

/** Marks the statements of loop bodies whose every index is proven in bounds. */
function provenIndexes(body: Block, facts: Facts, an: Analyzer): void {
  const proofs: { array: LocalSym; index: LocalSym }[] = [];
  const proven = (e: Extract<Expr, { k: "Index" }>) =>
    !e.slice && e.indices.length === 1 && proofs.some((p) => localOf(e.x) === p.array && localOf(e.indices[0] ?? undefined) === p.index);
  /** whether every index in `n` is proven, and whether it has any */
  const check = (n: Node): { all: boolean; any: boolean } => {
    let all = true;
    let any = false;
    walk(n, (m) => {
      if (m.k !== "Index") return;
      any = true;
      if (!proven(m)) all = false;
    });
    return { all, any };
  };
  const stmts = (list: Stmt[]) => list.forEach(stmt);
  let loops = 0;
  const stmt = (s: Stmt): void => {
    const proof = loopProof(s, facts);
    if (proof) proofs.push(proof);
    const loop = s.k === "For" || s.k === "RangeFor";
    if (loop) loops++;
    try {
      if (proof || proofs.length) {
        const inner = s.k === "Labeled" || s.k === "DirectiveStmt" ? s.stmt : s;
        const body = inner.k === "For" || inner.k === "RangeFor" ? inner.body : null;
        // the loop header itself isn't covered: mark statements inside it
        if (body) {
          if (inner !== s) stmt(inner);
          else stmts(body.stmts);
          return;
        }
        const { all, any } = check(s);
        if (all && any && proofs.length) {
          A(s)._noBounds = true;
          an.hint(s, "unchecked", "every index here is proven in bounds by its loop, so it gets #no_bounds_check");
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
      if (proof) proofs.pop();
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
