import { Block, Expr, Node, Stmt, children } from "./ast";
import { A, Analyzer, isStmt, nodeText, posOf } from "./analyzer";
import { CompileError, Token } from "./lexer";
import type { CaptureSym, GlobalSym, LocalSym, PackageInfo, Scope, Sym, Ty } from "./scope";

type ImplBlock = Extract<Stmt, { k: "ImplBlock" }>;
type ValueDecl = Extract<Stmt, { k: "ValueDecl" }>;

/**
 * How a named type is destroyed: its `impl Destroy` proc, then its fields that need destroying, last
 * field first. With fields, vidar writes `__T_destroy` next to the type, which does both.
 */
export interface Destructor {
  type: GlobalSym;
  proc?: GlobalSym;
  fields: { name: string; how: How }[];
  /** what a moved-from local is set to: `{}` for a struct, `nil` for a union */
  zero: "{}" | "nil";
}

/** A call to a destructor, or `__vidar.destroy`, which finds out at run time (vidar_runtime/destroy.odin). */
export type How = { k: "call"; dtor: Destructor } | { k: "dispatch" };

/** What destroying a value of some type takes, and the type's name for messages. */
interface Owned {
  how: How;
  name: string;
  /** `which has impl Destroy`, or `which holds a value with impl Destroy` */
  why: string;
}

/** A local that gets `defer ...(&name)` after its declaration. */
export interface DestroyDecl {
  sym: LocalSym;
  name: Token;
  how: How;
}

/** A returned local, set to its zero value once the result is copied, so its defer destroys nothing. */
export interface DestroyMove {
  x: Expr;
  zero: string;
}

/** The name code calls to destroy a value of `d`'s type, and the global that decides how it is qualified. */
export function destructorName(d: Destructor): { owner: GlobalSym; name: string } {
  return d.fields.length || !d.proc ? { owner: d.type, name: `__${d.type.odinName}_destroy` } : { owner: d.proc, name: d.proc.odinName };
}

/**
 * `impl Destroy for T` when no `Destroy` is in scope: the built-in one. It is resolved here instead of
 * as an interface, so it may live in any package (the type's own), and nothing is dispatched.
 */
export function resolveDestroyImpl(an: Analyzer, s: ImplBlock, scope: Scope, pkg: PackageInfo): void {
  const named = (e: Expr) => e.k === "Ident" || e.k === "Selector";
  if (s.target.k === "Call") throw new CompileError("impl Destroy for a parametric type is not supported yet; implement it for a named struct or union", posOf(s.target));
  if (!named(s.target)) throw new CompileError("impl Destroy targets must be named struct or union types", posOf(s.target));
  an.expr(s.target, scope);
  const t = an.resolveName(s.target, scope, null);
  const decl = t?.kind === "global" && t.isConst && !t.decl.type ? t.decl.values[t.index] : undefined;
  if (t?.kind !== "global" || (decl?.k !== "StructType" && decl?.k !== "UnionType"))
    throw new CompileError(`'${nodeText(s.target)}' is not a struct or union type; impl Destroy is for named structs and unions`, posOf(s.target));
  if (decl.polyParams) throw new CompileError(`'${t.name}' is parametric; impl Destroy for a parametric type is not supported yet`, posOf(s.target));
  if (t.pkg.unit !== pkg.unit) throw new CompileError(`impl Destroy for '${t.name}' must be in package '${t.pkg.name}', where '${t.name}' is declared`, posOf(s));
  if (an.destructors.has(t)) throw new CompileError(`'${t.name}' already implements Destroy`, posOf(s));
  const usage = `impl Destroy binds one method: impl Destroy for ${t.name} { destroy = ${t.name.toLowerCase()}_destroy }, with ${t.name.toLowerCase()}_destroy :: proc(x: ^${t.name})`;
  if (s.bindings.length !== 1 || s.bindings[0].name !== "destroy") {
    const other = s.bindings.find((b) => b.name !== "destroy");
    throw new CompileError(other ? `'${other.name}' is not a method of Destroy; ${usage}` : usage, other ? s.toks[other.tok].pos : posOf(s));
  }
  const b = s.bindings[0];
  if (!named(b.value)) throw new CompileError(usage, posOf(b.value));
  an.expr(b.value, scope);
  const p = an.resolveName(b.value, scope, null);
  const lit = p?.kind === "global" && p.isConst ? p.decl.values[p.index] : undefined;
  if (p?.kind !== "global" || lit?.k !== "ProcLit" || !lit.body || lit.comptime || lit.captures) throw new CompileError(usage, posOf(b.value));
  if (p.pkg.unit !== pkg.unit) throw new CompileError(`'${nodeText(b.value)}' must be declared in package '${pkg.name}' (or a package in an import cycle with it)`, posOf(b.value));
  if (p.isPrivate && !t.isPrivate) throw new CompileError(`'${p.name}' is private, but other packages destroy their '${t.name}' values with it; remove @(private)`, posOf(b.value));
  const params = lit.sig.params.reduce((n, x) => n + Math.max(1, x.names.length), 0);
  const recv = lit.sig.params[0]?.type ? nodeText(lit.sig.params[0].type).replace(/\s+/g, "") : "";
  if (params !== 1 || recv !== `^${nodeText(s.target).replace(/\s+/g, "")}` || lit.sig.results.length)
    throw new CompileError(`'${p.name}' must take one parameter of type ^${nodeText(s.target)} and return nothing to implement destroy`, posOf(b.value));
  an.destructors.set(t, { type: t, proc: p, fields: [], zero: decl.k === "StructType" ? "{}" : "nil" });
}

/**
 * Named structs whose fields need destroying get a destructor too (after their own impl, if any).
 * Repeated until nothing changes, since a struct can hold one that only now turned out to need it.
 */
function deriveDestructors(an: Analyzer): void {
  const structs: GlobalSym[] = [];
  const collect = (stmts: Stmt[]) => {
    for (const s of stmts) {
      if (s.k === "When") {
        collect(s.then.stmts);
        if (s.else) collect([s.else]);
      } else if (s.k === "Block") collect(s.stmts);
      else if (s.k === "ValueDecl" && s.isConst)
        s.values.forEach((v, i) => {
          const sym: GlobalSym | undefined = A(s)._syms?.[i];
          if (v.k === "StructType" && !v.polyParams && sym?.kind === "global") structs.push(sym);
        });
    }
  };
  for (const pkg of an.packages) for (const f of pkg.files) collect(f.stmts);
  for (let changed = true; changed; ) {
    changed = false;
    for (const sym of structs) {
      const st = sym.decl.values[sym.index] as Extract<Expr, { k: "StructType" }>;
      const fields: Destructor["fields"] = [];
      for (const f of st.fields) {
        const o = f.type && ownedOf(an, { t: "node", node: f.type, scope: A(f.type)._scope ?? sym.scope });
        if (o) for (const n of f.names) if (n.name !== "_") fields.push({ name: n.name, how: o.how });
      }
      fields.reverse();
      const d = an.destructors.get(sym);
      if (d ? d.fields.length !== fields.length : fields.length) {
        if (d) d.fields = fields;
        else an.destructors.set(sym, { type: sym, fields, zero: "{}" });
        changed = true;
      }
    }
  }
}

/** How a value of type `ty` is destroyed, if it needs to be (not knowing `$T`: see `mentionsPoly`). */
export function ownedOf(an: Analyzer, ty: Ty | undefined, depth = 0): Owned | undefined {
  if (ty?.t !== "node" || depth > 16) return undefined;
  const n = ty.node;
  const scope = ty.scope;
  const inner = (node: Expr) => ownedOf(an, { t: "node", node, scope: A(node)._scope ?? scope }, depth + 1);
  const dispatch = (): Owned => ({ how: { k: "dispatch" }, name: nodeText(n), why: HOLDS });
  switch (n.k) {
    case "Paren":
      return inner(n.x);
    case "Ident":
    case "Selector":
      return ownedOfSym(an, symOf(an, n, scope), depth);
    case "StructType":
      return !n.polyParams && n.fields.some((f) => f.type && inner(f.type)) ? dispatch() : undefined;
    case "UnionType":
      return !n.polyParams && n.variants.some((v) => inner(v)) ? dispatch() : undefined;
    case "TypeExpr":
      return (n.what === "array" || n.what === "inferred") && n.parts[1] && inner(n.parts[1]) ? dispatch() : undefined;
    case "Call":
      // `Maybe(File)`, or an instance of a parametric type (yours or core's) holding one
      return n.args.some((a) => inner(a.k === "FieldValue" ? a.value : a)) ? dispatch() : undefined;
  }
  return undefined;
}

function ownedOfSym(an: Analyzer, sym: Sym | undefined, depth: number): Owned | undefined {
  if (sym?.kind === "global") {
    const d = an.destructors.get(sym);
    if (d) return { how: { k: "call", dtor: d }, name: sym.name, why: d.proc ? HAS : HOLDS };
    const v = sym.isConst && !sym.decl.type ? sym.decl.values[sym.index] : undefined;
    // an alias, or a union holding a destructible variant (destroyed by the variant it holds)
    if (v && (v.k === "Ident" || v.k === "Selector" || v.k === "Paren" || v.k === "UnionType")) {
      const o = ownedOf(an, { t: "node", node: v, scope: sym.scope }, depth + 1);
      return o && { ...o, name: sym.name };
    }
  }
  // a type declared inside a proc
  if (sym?.kind === "local" && sym.isConst && sym.value) {
    const o = ownedOf(an, { t: "node", node: sym.value, scope: sym.scope }, depth + 1);
    return o && { ...o, name: sym.name };
  }
  return undefined;
}

const HAS = "which has impl Destroy";
const HOLDS = "which holds a value with impl Destroy";

function symOf(an: Analyzer, n: Expr, scope: Scope): Sym | undefined {
  if (n.k === "Ident") return A(n)._sym ?? an.lookup(n.name, scope, null);
  if (n.k === "Selector") return A(n)._pkgMember ?? an.resolveName(n, scope, null);
  return undefined;
}

/** Whether a type mentions a polymorphic parameter (`T`, `$T`): the analyzer doesn't substitute them. */
function mentionsPoly(an: Analyzer, ty: Ty): boolean {
  if (ty.t === "ptr") return false;
  if (ty.t !== "node") return false;
  const scope = ty.scope;
  const walk = (n: Node): boolean => {
    if (n.k === "Poly") return true;
    if (n.k === "Unary" && (n as Extract<Expr, { k: "Unary" }>).op === "^") return false;
    if (n.k === "Ident") {
      const sym = A(n)._sym ?? an.lookup((n as Extract<Expr, { k: "Ident" }>).name, scope, null);
      if (sym?.kind === "local" && sym.isConst && sym.declKind === "param") return true;
    }
    return children(n).some(walk);
  };
  return walk(ty.node);
}

/** Runs after analysis, when some type has impl Destroy: the rules, and what the emitter adds. */
export function checkDestroys(an: Analyzer, guard: (f: () => void) => void): void {
  guard(() => deriveDestructors(an));
  for (const pkg of an.packages) for (const f of pkg.files) for (const s of f.stmts) guard(() => new Checker(an, guard).top(s));
}

/** Types that hold their elements by value but can't hold destructible ones yet. */
const CONTAINERS: Record<string, string> = {
  slice: "a slice",
  dynamic: "a dynamic array",
  map: "a map",
  matrix: "a matrix",
  distinct: "a distinct type",
};

class Checker {
  /** owned locals of each proc being walked, innermost last */
  private owned: Set<LocalSym>[] = [];
  /** the named results of each proc being walked */
  private results: Set<Sym>[] = [];
  /** fresh values whose owner is the statement they are in: declarations, assignments, returns */
  private consumed = new Set<Expr>();
  /** the statements being walked, innermost last: run-time copy checks go before them */
  private stmts: Stmt[] = [];

  constructor(
    private an: Analyzer,
    private guard: (f: () => void) => void,
  ) {}

  top(s: Stmt): void {
    this.node(s);
  }

  private globalDecl(s: ValueDecl): void {
    s.names.forEach((n, i) => {
      const v = s.values[i];
      const ty = s.type ? { t: "node" as const, node: s.type, scope: A(s.type)._scope as Scope } : v ? this.typeOf(v) : undefined;
      const o = ownedOf(this.an, ty);
      if (o) throw new CompileError(`'${n.name}' is a ${o.name}, ${o.why}; package-level variables can't hold one yet`, s.toks[n.tok].pos);
    });
  }

  private typeOf(e: Expr): Ty | undefined {
    const scope: Scope | undefined = A(e)._scope;
    if (!scope) return undefined;
    try {
      return this.an.typeOf(e, scope) ?? this.an.typeOfDeep(e, scope);
    } catch {
      return undefined;
    }
  }

  private ownedOf(e: Expr): Owned | undefined {
    return ownedOf(this.an, this.typeOf(e));
  }

  /** A value whose type is only known at run time: generic code, or a type vidar can't tell. */
  private unsure(ty: Ty | undefined): boolean {
    return !ty || mentionsPoly(this.an, ty);
  }

  private node(n: Node): void {
    if (isStmt(n)) this.guard(() => this.withStmt(n as Stmt));
    else this.expr(n as Expr);
  }

  private withStmt(s: Stmt): void {
    this.stmts.push(s);
    try {
      this.stmt(s);
    } finally {
      this.stmts.pop();
    }
  }

  private kids(n: Node): void {
    for (const c of children(n)) this.node(c);
  }

  private stmt(s: Stmt): void {
    switch (s.k) {
      // the values first, so errors inside them come before the statement's own
      case "ValueDecl":
        s.values.forEach((v) => this.consume(v));
        this.kids(s);
        if (!s.isConst) this.owned.length ? this.localDecl(s) : this.globalDecl(s);
        return;
      case "Assign":
        if (s.op === "=") s.rhs.forEach((r) => this.consume(r));
        this.kids(s);
        this.assign(s);
        return;
      case "Return":
        s.results.forEach((r) => this.consume(r));
        this.kids(s);
        this.ret(s);
        return;
      case "RangeFor":
        this.rangeFor(s);
        break;
      case "ExprStmt": {
        const exp: Block | undefined = A(s)._expansion;
        if (exp) {
          for (const x of exp.stmts) this.node(x);
          return;
        }
        this.dropped(s.x);
        break;
      }
    }
    this.kids(s);
  }

  private rangeFor(s: Extract<Stmt, { k: "RangeFor" }>): void {
    // an iterator proc: `for x in next(&it)` gets a new value each time round
    const iter = s.x.k === "Call" ? this.ownedOf(s.x) : undefined;
    if (iter) throw new CompileError(`each ${iter.name} that ${nodeText(s.x.k === "Call" ? s.x.fn : s.x)}() returns to this loop would never be destroyed; loop with for { x, ok := ...; if !ok do break } instead`, posOf(s.x));
    const syms: LocalSym[] = A(s)._syms ?? [];
    const v = syms[0];
    if (!v || s.vals[0]?.byRef) return;
    const o = ownedOf(this.an, v.ty);
    if (o) throw new CompileError(`'${v.name}' would be a copy of each ${o.name}, ${o.why}; loop over pointers: for &${v.name} in ...`, v.declTok?.pos ?? posOf(s));
    // checked at run time, at the top of the body
    if (this.unsure(v.ty) && v.name !== "_") {
      A(s)._destroyRangeCheck = v.name;
      this.an.destroyDispatch = true;
    }
  }

  /** A call statement whose results are thrown away: a destructible one would never be destroyed. */
  private dropped(e: Expr): void {
    while (e.k === "Paren" || e.k === "Postfix") e = e.x;
    if (e.k !== "Call") return;
    const scope: Scope | undefined = A(e)._scope;
    const ft = scope && this.an.normalize(this.an.typeOf(e.fn, scope));
    if (ft?.t !== "sig") return;
    for (let i = 0; ; i++) {
      const r = this.an.resultTy(ft, i);
      if (!r) break;
      const o = ownedOf(this.an, r);
      if (o) throw new CompileError(`the ${o.name} that ${nodeText(e.fn)}() returns is thrown away, so it would never be destroyed; keep it: x := ${nodeText(e)}`, posOf(e));
    }
    this.consumed.add(e);
  }

  private expr(e: Expr): void {
    switch (e.k) {
      case "ProcLit": {
        if (e.captures) {
          for (const c of (A(e)._captures as CaptureSym[] | undefined) ?? []) {
            if (c.byRef) continue;
            const ty = symTy(c.target);
            const o = ownedOf(this.an, ty);
            if (o) throw new CompileError(`'${c.name}' is a ${o.name}, ${o.why}; a closure can't hold a copy of it. Capture &${c.name}`, c.declTok?.pos ?? posOf(e));
            if (this.unsure(ty) && c.target.kind === "local") this.check(c.name);
          }
        }
        if (!e.body) return this.kids(e);
        this.owned.push(new Set());
        this.results.push(new Set(((A(e)._results as Sym[] | undefined) ?? []).filter(Boolean)));
        const stmts = this.stmts;
        this.stmts = [];
        try {
          this.kids(e);
        } finally {
          this.owned.pop();
          this.results.pop();
          this.stmts = stmts;
        }
        return;
      }
      case "MacroCall": {
        const exp: Expr | undefined = A(e)._expansion;
        if (exp) {
          if (this.consumed.has(e)) this.consumed.add(exp);
          this.expr(exp);
        }
        return;
      }
      case "TypeExpr": {
        const what = CONTAINERS[e.what];
        if (what) for (const p of e.parts) if (p) this.contained(p, what);
        break;
      }
      case "Call":
        this.call(e);
        break;
      case "CompoundLit":
        // the elements move into the literal: a fresh value is fine, a copy of a variable is not
        for (const el of e.elems) {
          const v = el.k === "FieldValue" ? el.value : el;
          this.copied(v, `'${nodeText(e)}' would copy it`);
          this.consume(v);
        }
        break;
    }
    this.fresh(e);
    this.kids(e);
  }

  /** A new destructible value that nothing owns: a call result or literal used as a temporary. */
  private fresh(e: Expr): void {
    if (this.consumed.has(e)) return;
    if (e.k !== "Call" && e.k !== "CompoundLit") return;
    if (e.k === "Call" && this.conversion(e)) return;
    const o = this.ownedOf(e);
    if (!o) return;
    throw new CompileError(`this ${o.name} is a temporary, so it would never be destroyed; declare it first: x := ${nodeText(e)}`, posOf(e));
  }

  private conversion(e: Extract<Expr, { k: "Call" }>): boolean {
    const scope: Scope | undefined = A(e)._scope;
    const sym = scope && (e.fn.k === "Ident" || e.fn.k === "Selector") ? symOf(this.an, e.fn, scope) : undefined;
    return !!sym && !!ownedOfSym(this.an, sym, 0);
  }

  /** `T` written inside a type that can't hold one yet. */
  private contained(t: Expr, what: string): void {
    const scope: Scope | undefined = A(t)._scope;
    if (!scope) return;
    const o = ownedOf(this.an, { t: "node", node: t, scope });
    if (o) throw new CompileError(`${what} can't hold a ${o.name} yet, since it has impl Destroy; hold a pointer (^${o.name})`, posOf(t));
  }

  private call(e: Extract<Expr, { k: "Call" }>): void {
    if (e.fn.k === "Ident" && !A(e.fn)._sym && e.fn.name === "new_clone" && e.args[0]) {
      this.copied(e.args[0], "new_clone would copy it");
      this.consumed.add(e.args[0]);
    }
  }

  /**
   * `e` copies a destructible value out of a variable, field or element: an error, or, when its type
   * is only known at run time, a check there (`__vidar.check_copy`, and an `#assert` for the types
   * the file can name).
   */
  private copied(e: Expr, why: string, fix?: string): void {
    const p = this.place(e);
    if (!p) return;
    const ty = this.typeOf(e);
    const o = ownedOf(this.an, ty);
    if (o) {
      const text = nodeText(p);
      throw new CompileError(`'${text}' is a ${o.name}, ${o.why}, and ${why}; both copies would be destroyed. ${fix ?? `Borrow it with &${text}`}`, posOf(e));
    }
    if (this.unsure(ty) && this.owned.length) this.check(p);
  }

  private check(place: Expr | string): void {
    const s = this.stmts[this.stmts.length - 1];
    if (!s || A(s)._isInit) return;
    ((A(s)._destroyChecks ??= []) as (Expr | string)[]).push(place);
    this.an.destroyDispatch = true;
  }

  /** The variable, field or element `e` reads its value from, if it does. */
  private place(e: Expr): Expr | undefined {
    switch (e.k) {
      case "Paren":
        return this.place(e.x);
      case "Ident": {
        const sym: Sym | undefined = A(e)._sym;
        if (!sym) return undefined;
        if (sym.kind === "capture") return e;
        if ((sym.kind === "local" || sym.kind === "global") && !sym.isConst) return e;
        return undefined;
      }
      case "Selector": {
        const member: GlobalSym | undefined = A(e)._pkgMember;
        if (member) return member.isConst ? undefined : e;
        return e;
      }
      case "Index":
        return e.slice ? undefined : e;
      case "Deref":
      case "TypeAssert":
        return e;
      case "Ternary":
        return this.place(e.a) ?? this.place(e.b);
      case "Cast":
        return this.place(e.x);
      case "Binary":
        return e.op === "or_else" ? this.place(e.y) : undefined;
      case "Postfix":
        return this.place(e.x);
      case "Call":
        return this.conversion(e) && e.args.length === 1 ? this.place(e.args[0]) : undefined;
      case "MacroCall": {
        const exp: Expr | undefined = A(e)._expansion;
        return exp && this.place(exp);
      }
    }
    return undefined;
  }

  /** Marks the values a statement takes ownership of, through parentheses, `or_return` and the like. */
  private consume(e: Expr): void {
    this.consumed.add(e);
    if (e.k === "Paren" || e.k === "Postfix" || e.k === "Cast") this.consume(e.x);
    else if (e.k === "Ternary") this.consume(e.a), this.consume(e.b);
    else if (e.k === "Binary" && e.op === "or_else") this.consume(e.x), this.consume(e.y);
    else if (e.k === "MacroCall" && A(e)._expansion) this.consume(A(e)._expansion);
    else if (e.k === "Call" && this.conversion(e) && e.args.length === 1) this.consume(e.args[0]);
  }

  private localDecl(s: ValueDecl): void {
    const syms: LocalSym[] = A(s)._syms ?? [];
    const out: DestroyDecl[] = [];
    syms.forEach((sym, i) => {
      const name = s.names[i];
      const at = s.toks[name.tok].pos;
      const v = s.values.length === s.names.length ? s.values[i] : undefined;
      const o = ownedOf(this.an, sym.ty);
      if (!o) {
        if (!this.unsure(sym.ty) || name.name === "_") return;
        // only known at run time: destroyed through __vidar.destroy, which does nothing for most types
        if (A(s)._isInit) return this.unknownInit(name.name, s.values.length === s.names.length ? s.values[i] : s.values[0], at);
        if (v) this.copied(v, "");
        out.push({ sym, name: s.toks[name.tok], how: { k: "dispatch" } });
        this.owned[this.owned.length - 1].add(sym);
        this.an.destroyDispatch = true;
        return;
      }
      if (name.name === "_") throw new CompileError(`'_' would throw away a ${o.name} without destroying it; give it a name`, at);
      if (A(s)._isInit) throw new CompileError(`'${name.name}' is a ${o.name}, ${o.why}; declare it before the statement, not in its initializer`, at);
      if (v) this.copied(v, `'${name.name} := ${nodeText(v)}' would copy it`);
      if (o.how.k === "call") {
        const owner = destructorName(o.how.dtor).owner;
        if (!reaches(sym.scope, owner))
          throw new CompileError(`'${name.name}' is a ${o.name}, destroyed by '${destructorName(o.how.dtor).name}' in package '${owner.pkg.name}'; import that package in this file so the cleanup can call it`, at);
      } else this.an.destroyDispatch = true;
      out.push({ sym, name: s.toks[name.tok], how: o.how });
      this.owned[this.owned.length - 1].add(sym);
    });
    if (out.length) A(s)._destroyDecl = out;
  }

  /** In an `if`/`for`/`switch` initializer there is nowhere to put a defer: only obvious cases are caught. */
  private unknownInit(name: string, v: Expr | undefined, at: CompileError["pos"]): void {
    if (!v) return;
    const holder = this.holder(v);
    if (holder) throw new CompileError(`vidar can't tell the type of '${name}', and its value involves '${nodeText(holder)}', which has impl Destroy; declare it before the statement, with its type: ${name}: T = ...`, at);
  }

  /**
   * A part of `e` that is, or names, a destructible type, looking only through the parts whose type
   * vidar can't tell either (`f` in `abs(f)`, not in `min(len(f.name), 3)`), and not into procs.
   */
  private holder(e: Node): Expr | undefined {
    if (e.k === "ProcLit") return undefined;
    if (!isStmt(e)) {
      const x = e as Expr;
      if (x.k === "Ident" || x.k === "Selector") {
        const scope: Scope | undefined = A(x)._scope;
        if (scope && ownedOfSym(this.an, symOf(this.an, x, scope), 0)) return x;
      }
      if (x.k === "MacroCall" && A(x)._expansion) return this.holder(A(x)._expansion);
      const ty = this.typeOf(x);
      if (ownedOf(this.an, ty)) return x;
      if (ty && !mentionsPoly(this.an, ty)) return undefined;
    }
    for (const c of children(e)) {
      const h = this.holder(c);
      if (h) return h;
    }
    return undefined;
  }

  private assign(s: Extract<Stmt, { k: "Assign" }>): void {
    if (s.op !== "=") return;
    const lhs = s.lhs.map((l) => this.ownedOf(l));
    s.rhs.forEach((r, i) => {
      const l = s.lhs[i];
      if (l?.k === "Ident" && l.name === "_") {
        const o = this.ownedOf(r);
        if (o) throw new CompileError(`'_ = ${nodeText(r)}' would throw away a ${o.name} without destroying it`, posOf(r));
        return;
      }
      if (l && (lhs[i] || s.lhs.length === s.rhs.length)) this.copied(r, `'${nodeText(l)} = ${nodeText(r)}' would copy it`);
    });
    const o = lhs.find(Boolean);
    if (!o) return;
    if (s.lhs.length !== 1 || s.rhs.length !== 1) throw new CompileError(`assigning several values at once to a ${o.name}, ${o.why}, is not supported yet; assign them one by one`, posOf(s));
    const l = s.lhs[0];
    // the old value is read again before the assignment, so the target must have no side effects
    const simple = (e: Expr): boolean =>
      e.k === "Ident" ||
      ((e.k === "Paren" || e.k === "Deref" || e.k === "Selector") && simple(e.x)) ||
      (e.k === "Index" && !e.slice && simple(e.x) && e.indices.every((i) => !!i && (i.k === "Ident" || i.k === "Lit" || i.k === "ImplicitSelector")));
    if (!simple(l)) throw new CompileError(`'${nodeText(l)}' is a ${o.name}, ${o.why}; assigning to it is supported for variables, fields, p^ and elements indexed by a name or constant: assign through a variable first`, posOf(l));
    if (o.how.k === "dispatch") this.an.destroyDispatch = true;
    A(s)._destroyAssign = o.how;
  }

  private ret(s: Extract<Stmt, { k: "Return" }>): void {
    const owned = this.owned[this.owned.length - 1];
    const results = this.results[this.results.length - 1];
    const moved: DestroyMove[] = [];
    for (const r of s.results) {
      let x = r;
      while (x.k === "Paren") x = x.x;
      const sym: Sym | undefined = x.k === "Ident" ? A(x)._sym : undefined;
      if (sym?.kind === "local" && owned?.has(sym)) {
        const o = ownedOf(this.an, sym.ty);
        moved.push({ x, zero: o?.how.k === "call" ? o.how.dtor.zero : "" });
        continue;
      }
      if (sym && results?.has(sym)) continue;
      this.copied(r, "returning it would copy it", "Only a local declared in this proc can be returned: it moves out");
    }
    if (moved.length) A(s)._destroyMove = moved;
  }
}

/** Whether code in `scope` can name `sym`: it is in the same unit, or the file imports its package. */
function reaches(scope: Scope, sym: GlobalSym): boolean {
  for (let s: Scope | null = scope; s; s = s.parent) {
    if (s.pkg) return s.pkg.unit === sym.pkg.unit;
    for (const x of s.syms.values()) if (x.kind === "pkg" && x.target?.unit === sym.pkg.unit) return true;
  }
  return false;
}

function symTy(sym: LocalSym | CaptureSym): Ty | undefined {
  return sym.kind === "local" ? sym.ty : symTy(sym.target);
}

/** `vidar_runtime/destroy.odin`, written when some value is destroyed or copy-checked at run time. */
export const DESTROY_RUNTIME = `// Generated by vidar: impl Destroy for generic code, and for values whose type vidar can't tell.
// Each package registers its types with impl Destroy at startup; any other type's plan is read from
// its type info (fields, array elements, union variants) the first time a value of it is destroyed.
package vidar_runtime

import "base:intrinsics"
import "base:runtime"
import "core:sync"

Destroy_Plan :: struct {
	destroy:   proc(rawptr),
	move_only: bool,
	parts:     []Destroy_Part,
	// a union: the plan of each variant, and where its tag is
	variants:  []^Destroy_Plan,
	tag_size:  int,
	tag_off:   uintptr,
	no_nil:    bool,
}

Destroy_Part :: struct {
	plan:   ^Destroy_Plan,
	offset: uintptr,
	count:  int,
	stride: uintptr,
}

@(private="file") destroy_plans: map[typeid]^Destroy_Plan
@(private="file") destroy_lock: sync.Mutex
@(private="file") nothing_to_destroy: Destroy_Plan

register_destroy :: proc "contextless" ($T: typeid, destroy: proc(^T), move_only: bool) {
	context = runtime.default_context()
	context.allocator = runtime.heap_allocator()
	sync.guard(&destroy_lock)
	plan := new(Destroy_Plan)
	plan.destroy = transmute(proc(rawptr))destroy
	plan.move_only = move_only
	destroy_plans[T] = plan
}

// nil when a value of the type holds nothing to destroy
@(private="file")
plan_for :: proc(ti: ^runtime.Type_Info) -> ^Destroy_Plan {
	if p, ok := destroy_plans[ti.id]; ok do return nil if p == &nothing_to_destroy else p
	plan := new(Destroy_Plan)
	parts: [dynamic]Destroy_Part
	#partial switch v in ti.variant {
	case runtime.Type_Info_Named:
		free(plan)
		inner := plan_for(v.base)
		destroy_plans[ti.id] = inner if inner != nil else &nothing_to_destroy
		return inner
	case runtime.Type_Info_Struct:
		for i := v.field_count - 1; i >= 0; i -= 1 {
			if p := plan_for(v.types[i]); p != nil {
				append(&parts, Destroy_Part{p, v.offsets[i], 1, 0})
				plan.move_only ||= p.move_only
			}
		}
	case runtime.Type_Info_Array:
		if p := plan_for(v.elem); p != nil {
			append(&parts, Destroy_Part{p, 0, v.count, uintptr(v.elem_size)})
			plan.move_only = p.move_only
		}
	case runtime.Type_Info_Enumerated_Array:
		if p := plan_for(v.elem); p != nil {
			append(&parts, Destroy_Part{p, 0, v.count, uintptr(v.elem_size)})
			plan.move_only = p.move_only
		}
	case runtime.Type_Info_Union:
		variants := make([]^Destroy_Plan, len(v.variants))
		some := false
		for x, i in v.variants {
			variants[i] = plan_for(x)
			if variants[i] != nil {
				some = true
				plan.move_only ||= variants[i].move_only
			}
		}
		if some {
			plan.variants, plan.tag_size, plan.tag_off, plan.no_nil = variants, v.tag_type.size, v.tag_offset, v.no_nil
		} else do delete(variants)
	}
	if len(parts) == 0 && plan.variants == nil {
		delete(parts)
		free(plan)
		destroy_plans[ti.id] = &nothing_to_destroy
		return nil
	}
	plan.parts = parts[:]
	destroy_plans[ti.id] = plan
	return plan
}

// the plan of T, looked up once per instantiation
plan_of :: #force_inline proc "contextless" ($T: typeid) -> ^Destroy_Plan {
	@(static) cached: ^Destroy_Plan
	@(static) known: bool
	if intrinsics.atomic_load_explicit(&known, .Acquire) do return cached
	return plan_slow(T, &cached, &known)
}

@(private="file", cold)
plan_slow :: proc "contextless" ($T: typeid, cached: ^^Destroy_Plan, known: ^bool) -> ^Destroy_Plan {
	context = runtime.default_context()
	context.allocator = runtime.heap_allocator()
	sync.guard(&destroy_lock)
	p := plan_for(type_info_of(T))
	cached^ = p
	intrinsics.atomic_store_explicit(known, true, .Release)
	return p
}

@(private="file")
run_plan :: proc(plan: ^Destroy_Plan, p: rawptr) {
	if plan.destroy != nil {
		plan.destroy(p)
		return
	}
	for part in plan.parts {
		for i := part.count - 1; i >= 0; i -= 1 do run_plan(part.plan, rawptr(uintptr(p) + part.offset + uintptr(i) * part.stride))
	}
	if plan.variants != nil {
		at := rawptr(uintptr(p) + plan.tag_off)
		tag: int
		switch plan.tag_size {
		case 1: tag = int((^u8)(at)^)
		case 2: tag = int((^u16)(at)^)
		case 4: tag = int((^u32)(at)^)
		case 8: tag = int((^u64)(at)^)
		}
		i := tag if plan.no_nil else tag - 1
		if i >= 0 && i < len(plan.variants) && plan.variants[i] != nil do run_plan(plan.variants[i], p)
	}
}

// destroys a value whose type the code can't name
destroy :: #force_inline proc(p: ^$T) {
	when intrinsics.type_is_struct(T) || intrinsics.type_is_union(T) || intrinsics.type_is_array(T) || intrinsics.type_is_enumerated_array(T) {
		if plan := plan_of(T); plan != nil do run_plan(plan, p)
	}
}

// a copy of a value whose type the code can't name: stops the program when the type can't be copied
check_copy :: #force_inline proc "contextless" ($T: typeid, loc := #caller_location) {
	when intrinsics.type_is_struct(T) || intrinsics.type_is_union(T) || intrinsics.type_is_array(T) || intrinsics.type_is_enumerated_array(T) {
		if plan := plan_of(T); plan != nil && plan.move_only do copied(type_info_of(T), loc)
	}
}

@(private="file", cold)
copied :: proc "contextless" (ti: ^runtime.Type_Info, loc: runtime.Source_Code_Location) -> ! {
	runtime.print_caller_location(loc)
	runtime.print_string(": a ")
	runtime.print_type(ti)
	runtime.print_string(" was copied, but its type has impl Destroy, so both copies would be destroyed\\n")
	runtime.trap()
}

// a local moved out by return: left zero, so its defer destroys nothing
forget :: #force_inline proc "contextless" (p: ^$T) {
	intrinsics.mem_zero(p, size_of(T))
}
`;
