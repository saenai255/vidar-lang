import { Block, Expr, Node, Stmt, children } from "./ast";
import { A } from "./analyzer";
import type { LocalSym, Sym } from "./scope";

/**
 * -opt rewrites inside one procedure. Each is applied only where the procedure's own code proves
 * it changes nothing but speed; the results are annotations the emitter reads:
 * - `_noBounds` on a statement: every index in it is proven in bounds, so it gets `#no_bounds_check`
 * - `_allocGroup` / `_allocGrouped` / `_groupFree`: slices and pointers freed together, allocated together
 */
export function optimizeProc(body: Block): void {
  const facts = collectFacts(body);
  provenIndexes(body, facts);
  allocGroups(body, facts);
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
function kids(n: Node): Node[] {
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
function provenIndexes(body: Block, facts: Facts): void {
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
  const stmt = (s: Stmt): void => {
    const proof = loopProof(s, facts);
    if (proof) proofs.push(proof);
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
          return;
        }
      }
      for (const c of kids(s)) {
        if (c.k === "Block") stmts(c.stmts);
        else if (c.k === "Case") stmts(c.body);
        else if (c.k === "If" || c.k === "For" || c.k === "RangeFor" || c.k === "Switch" || c.k === "Labeled" || c.k === "DirectiveStmt" || c.k === "When") stmt(c);
      }
    } finally {
      if (proof) proofs.pop();
    }
  };
  stmts(body.stmts);
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
  if (s.k !== "ValueDecl" || s.isConst || s.type || s.names.length !== 1 || s.values.length !== 1 || A(s)._pre?.length) return undefined;
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
function allocGroups(body: Block, facts: Facts): void {
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
