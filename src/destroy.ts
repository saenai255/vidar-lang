import { Block, Expr, Node, Stmt, children } from "./ast";
import { A, Analyzer, isStmt, nodeText, posOf } from "./analyzer";
import { CompileError, Token } from "./lexer";
import type { CaptureSym, GlobalSym, LocalSym, PackageInfo, Scope, Sym, Ty } from "./scope";

type ImplBlock = Extract<Stmt, { k: "ImplBlock" }>;
type ValueDecl = Extract<Stmt, { k: "ValueDecl" }>;

/** `impl Destroy for T { destroy = p }`: `p(&x)` runs when a local `x` of type `T` goes out of scope. */
export interface Destructor {
  type: GlobalSym;
  proc: GlobalSym;
  /** what a moved-from local is set to: `{}` for a struct, `nil` for a union */
  zero: "{}" | "nil";
}

/** A local that gets `defer proc(&name)` after its declaration. */
export interface DestroyDecl {
  sym: LocalSym;
  name: Token;
  dtor: Destructor;
}

/** A returned local, set to its zero value once the result is copied, so its defer destroys nothing. */
export interface DestroyMove {
  x: Expr;
  zero: string;
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
  an.destructors.set(t, { type: t, proc: p, zero: decl.k === "StructType" ? "{}" : "nil" });
}

/** The destructor of a type: a type with impl Destroy, or an alias of one. */
export function destructorOf(an: Analyzer, ty: Ty | undefined, depth = 0): Destructor | undefined {
  if (ty?.t !== "node" || depth > 16) return undefined;
  let n = ty.node;
  while (n.k === "Paren") n = n.x;
  if (n.k !== "Ident" && n.k !== "Selector") return undefined;
  return destructorOfSym(an, symOf(an, n, ty.scope), depth);
}

function destructorOfSym(an: Analyzer, sym: Sym | undefined, depth = 0): Destructor | undefined {
  if (sym?.kind === "global") {
    const d = an.destructors.get(sym);
    if (d) return d;
    const v = sym.isConst && !sym.decl.type ? sym.decl.values[sym.index] : undefined;
    if (v && (v.k === "Ident" || v.k === "Selector" || v.k === "Paren")) return destructorOf(an, { t: "node", node: v, scope: sym.scope }, depth + 1);
  }
  if (sym?.kind === "local" && sym.isConst && sym.value) return destructorOf(an, { t: "node", node: sym.value, scope: sym.scope }, depth + 1);
  return undefined;
}

function symOf(an: Analyzer, n: Expr, scope: Scope): Sym | undefined {
  if (n.k === "Ident") return A(n)._sym ?? an.lookup(n.name, scope, null);
  if (n.k === "Selector") return A(n)._pkgMember ?? an.resolveName(n, scope, null);
  return undefined;
}

/** Whether a type mentions a polymorphic parameter (`T`, `$T`): the analyzer doesn't substitute them. */
function mentionsPoly(an: Analyzer, ty: Ty): boolean {
  if (ty.t === "ptr") return mentionsPoly(an, ty.elem);
  if (ty.t !== "node") return false;
  const scope = ty.scope;
  const walk = (n: Node): boolean => {
    if (n.k === "Poly") return true;
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
  for (const pkg of an.packages) for (const f of pkg.files) for (const s of f.stmts) guard(() => new Checker(an, guard).top(s));
}

/** Types that hold their elements by value (pointers, `[^]T` and `typeid` don't). */
const CONTAINERS: Record<string, string> = {
  array: "an array",
  inferred: "an array",
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
      const d = destructorOf(this.an, ty);
      if (d) throw new CompileError(`'${n.name}' is a ${d.type.name}, which has impl Destroy; package-level variables can't hold one yet`, s.toks[n.tok].pos);
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

  private dtorOf(e: Expr): Destructor | undefined {
    return destructorOf(this.an, this.typeOf(e));
  }

  private node(n: Node): void {
    if (isStmt(n)) this.guard(() => this.stmt(n as Stmt));
    else this.expr(n as Expr);
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
      case "RangeFor": {
        // an iterator proc: `for x in next(&it)` gets a new value each time round
        const iter = s.x.k === "Call" ? this.dtorOf(s.x) : undefined;
        if (iter) throw new CompileError(`each ${iter.type.name} that ${nodeText(s.x.k === "Call" ? s.x.fn : s.x)}() returns to this loop would never be destroyed; loop with for { x, ok := ...; if !ok do break } instead`, posOf(s.x));
        for (const sym of (A(s)._syms as LocalSym[] | undefined) ?? []) {
          const d = destructorOf(this.an, sym.ty);
          if (d) throw new CompileError(`'${sym.name}' would be a copy of each ${d.type.name}, which has impl Destroy; loop over pointers: for &${sym.name} in ...`, sym.declTok?.pos ?? posOf(s));
          if (!sym.ty || mentionsPoly(this.an, sym.ty)) this.unknown(sym.name, s.x, sym.declTok?.pos ?? posOf(s));
        }
        break;
      }
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
      const d = destructorOf(this.an, r);
      if (d) throw new CompileError(`the ${d.type.name} that ${nodeText(e.fn)}() returns is thrown away, so it would never be destroyed; keep it: x := ${nodeText(e)}`, posOf(e));
    }
    this.consumed.add(e);
  }

  private expr(e: Expr): void {
    switch (e.k) {
      case "ProcLit": {
        if (e.captures) {
          for (const c of (A(e)._captures as CaptureSym[] | undefined) ?? []) {
            if (c.byRef) continue;
            const d = destructorOf(this.an, symTy(c.target));
            if (d) throw new CompileError(`'${c.name}' is a ${d.type.name}, which has impl Destroy; a closure can't hold a copy of it. Capture &${c.name}`, c.declTok?.pos ?? posOf(e));
          }
        }
        if (!e.body) return this.kids(e);
        this.owned.push(new Set());
        this.results.push(new Set(((A(e)._results as Sym[] | undefined) ?? []).filter(Boolean)));
        try {
          this.kids(e);
        } finally {
          this.owned.pop();
          this.results.pop();
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
      case "StructType":
        for (const f of e.fields) if (f.type) this.contained(f.type, "a struct field");
        break;
      case "UnionType":
        for (const v of e.variants) this.contained(v, "a union");
        break;
      case "TypeExpr": {
        const what = CONTAINERS[e.what];
        if (what) for (const p of e.parts) if (p) this.contained(p, what);
        break;
      }
      case "Call":
        this.call(e);
        break;
      case "CompoundLit":
        for (const el of e.elems) {
          const v = el.k === "FieldValue" ? el.value : el;
          const d = this.dtorOf(v);
          if (d) throw new CompileError(`'${nodeText(v)}' is a ${d.type.name}, which has impl Destroy; a struct or array can't hold one yet`, posOf(v));
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
    const d = this.dtorOf(e);
    if (!d) return;
    throw new CompileError(`this ${d.type.name} is a temporary, so it would never be destroyed; declare it first: x := ${nodeText(e)}`, posOf(e));
  }

  private conversion(e: Extract<Expr, { k: "Call" }>): boolean {
    const scope: Scope | undefined = A(e)._scope;
    const sym = scope && (e.fn.k === "Ident" || e.fn.k === "Selector") ? symOf(this.an, e.fn, scope) : undefined;
    return !!sym && !!destructorOfSym(this.an, sym);
  }

  /** `T` written inside another type. */
  private contained(t: Expr, what: string): void {
    const scope: Scope | undefined = A(t)._scope;
    if (!scope) return;
    const d = destructorOf(this.an, { t: "node", node: t, scope });
    if (d) throw new CompileError(`${what} can't hold a ${d.type.name} yet, since it has impl Destroy; hold a pointer (^${d.type.name})`, posOf(t));
  }

  private call(e: Extract<Expr, { k: "Call" }>): void {
    const scope: Scope | undefined = A(e)._scope;
    if (!scope) return;
    const fnSym = e.fn.k === "Ident" || e.fn.k === "Selector" ? symOf(this.an, e.fn, scope) : undefined;
    // a parametric type (`Box(File)`), or `Maybe(File)`
    const fnDecl = fnSym?.kind === "global" && fnSym.isConst ? fnSym.decl.values[fnSym.index] : undefined;
    if ((fnDecl?.k === "StructType" || fnDecl?.k === "UnionType") && fnDecl.polyParams) {
      for (const a of e.args) this.contained(a.k === "FieldValue" ? a.value : a, `'${nodeText(e.fn)}'`);
      return;
    }
    if (e.fn.k === "Ident" && !fnSym && e.fn.name === "Maybe") {
      for (const a of e.args) this.contained(a, "Maybe");
      return;
    }
    if (e.fn.k === "Ident" && !fnSym && e.fn.name === "new_clone" && e.args[0]) {
      this.copied(e.args[0], "new_clone would copy it");
      this.consumed.add(e.args[0]);
      return;
    }
    const ft = this.an.normalize(this.an.typeOf(e.fn, scope));
    if (ft?.t !== "sig") return;
    // a value passed to a generic parameter: the generic code isn't checked yet
    const params = ft.sig.params.flatMap((p) => (p.names.length ? p.names.map((n) => ({ name: n.name, type: p.type })) : [{ name: "", type: p.type }]));
    e.args.forEach((a, i) => {
      const p = a.k === "FieldValue" ? params.find((x) => x.name === a.name) : params[i];
      const v = a.k === "FieldValue" ? a.value : a;
      if (!p?.type || !mentionsPoly(this.an, { t: "node", node: p.type, scope: ft.scope })) return;
      if (p.type.k === "Unary" && p.type.op === "^") return;
      const d = this.dtorOf(v);
      if (d) throw new CompileError(`'${nodeText(v)}' is a ${d.type.name}, which has impl Destroy, and can't be passed to a generic parameter yet; pass a pointer`, posOf(v));
    });
  }

  /** An error when `e` copies a destructible value out of a variable, field or element. */
  private copied(e: Expr, why: string, fix?: string): void {
    const d = this.dtorOf(e);
    if (!d) return;
    const p = this.place(e);
    if (!p) return;
    const text = nodeText(p);
    throw new CompileError(`'${text}' is a ${d.type.name}, which has impl Destroy, and ${why}; both copies would be destroyed. ${fix ?? `Borrow it with &${text}`}`, posOf(e));
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
      const v = s.values.length === s.names.length ? s.values[i] : undefined;
      const ty = sym.ty;
      const d = destructorOf(this.an, ty);
      if (!d) {
        if (!ty || mentionsPoly(this.an, ty)) this.unknown(name.name, s.values.length === s.names.length ? s.values[i] : s.values[0], s.toks[name.tok].pos);
        return;
      }
      const at = s.toks[name.tok].pos;
      if (name.name === "_") throw new CompileError(`'_' would throw away a ${d.type.name} without destroying it; give it a name`, at);
      if (A(s)._isInit) throw new CompileError(`'${name.name}' is a ${d.type.name}, which has impl Destroy; declare it before the statement, not in its initializer`, at);
      if (v) this.copied(v, `'${name.name} := ${nodeText(v)}' would copy it`);
      if (!reaches(sym.scope, d.proc))
        throw new CompileError(`'${name.name}' is a ${d.type.name}, destroyed by '${d.proc.name}' in package '${d.proc.pkg.name}'; import that package in this file so the cleanup can call it`, at);
      out.push({ sym, name: s.toks[name.tok], dtor: d });
      this.owned[this.owned.length - 1].add(sym);
    });
    if (out.length) A(s)._destroyDecl = out;
  }

  /** A local whose type vidar can't tell: it must not be holding a destructible value. */
  private unknown(name: string, v: Expr | undefined, at: CompileError["pos"]): void {
    if (!v) return;
    const holder = this.holder(v);
    if (holder) throw new CompileError(`vidar can't tell the type of '${name}', and its value involves '${nodeText(holder)}', which has impl Destroy; write the type: ${name}: T = ...`, at);
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
        if (scope && destructorOfSym(this.an, symOf(this.an, x, scope))) return x;
      }
      if (x.k === "MacroCall" && A(x)._expansion) return this.holder(A(x)._expansion);
      const ty = this.typeOf(x);
      if (destructorOf(this.an, ty)) return x;
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
    const lhs = s.lhs.map((l) => this.dtorOf(l));
    s.rhs.forEach((r, i) => {
      const l = s.lhs[i];
      if (lhs[i] || (l && l.k === "Ident" && l.name === "_" && this.dtorOf(r))) {
        if (l?.k === "Ident" && l.name === "_") throw new CompileError(`'_ = ${nodeText(r)}' would throw away a ${this.dtorOf(r)!.type.name} without destroying it`, posOf(r));
        this.copied(r, `'${nodeText(l)} = ${nodeText(r)}' would copy it`);
      }
    });
    const d = lhs.find(Boolean);
    if (!d) return;
    if (s.lhs.length !== 1 || s.rhs.length !== 1) throw new CompileError(`assigning several values at once to a ${d.type.name}, which has impl Destroy, is not supported yet; assign them one by one`, posOf(s));
    const l = s.lhs[0];
    const simple = (e: Expr): boolean => e.k === "Ident" || (e.k === "Paren" && simple(e.x)) || (e.k === "Deref" && simple(e.x));
    if (!simple(l)) throw new CompileError(`'${nodeText(l)}' is a ${d.type.name}, which has impl Destroy; assigning to it here is not supported yet (only to a variable, or through a pointer variable: p^ = ...)`, posOf(l));
    A(s)._destroyAssign = d;
  }

  private ret(s: Extract<Stmt, { k: "Return" }>): void {
    const owned = this.owned[this.owned.length - 1];
    const results = this.results[this.results.length - 1];
    const moved: DestroyMove[] = [];
    for (const r of s.results) {
      const d = this.dtorOf(r);
      if (!d) continue;
      let x = r;
      while (x.k === "Paren") x = x.x;
      const sym: Sym | undefined = x.k === "Ident" ? A(x)._sym : undefined;
      if (sym?.kind === "local" && owned?.has(sym)) {
        moved.push({ x, zero: d.zero });
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
