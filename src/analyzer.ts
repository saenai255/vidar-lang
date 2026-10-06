import { CompileError, Pos, Token } from "./lexer";
import { Block, Expr, File, Node, Param, ProcSig, Stmt, children } from "./ast";
import { Parser } from "./parser";
import { CaptureSym, Ctx, GlobalSym, LocalSym, PackageInfo, PkgSym, Scope, Sym, Ty } from "./scope";
import { CallSpan, Interp, NotConstant, Val, joinTokens, respace, valueToTokens, tokensOf } from "./comptime";

/** Annotation accessor: analysis results live in `_`-prefixed fields on nodes. */
export const A = (n: object) => n as Record<string, any>;

type ProcLit = Extract<Expr, { k: "ProcLit" }>;
type ValueDecl = Extract<Stmt, { k: "ValueDecl" }>;
type MacroCall = Extract<Expr, { k: "MacroCall" }>;
type ComptimeExpr = Extract<Expr, { k: "Comptime" }>;
type ImplBlock = Extract<Stmt, { k: "ImplBlock" }>;
type Selector = Extract<Expr, { k: "Selector" }>;
type CompoundLit = Extract<Expr, { k: "CompoundLit" }>;

/** An anonymous struct literal's fields: each is a hoisted temp, or a nested anonymous literal. */
export interface AnonField {
  name: string;
  temp?: string;
  nested?: CompoundLit;
}

/** A field of an anonymous struct type, for tooling: `text` spells the type, also when it isn't inferred. */
export interface AnonFieldType {
  name: string;
  tok: Token;
  type: Expr | undefined;
  text: string;
}

/** A hoisted field value; `pre` is the source whitespace before the field, to keep it on its line. */
export interface AnonTemp {
  name: string;
  value: Expr;
  pre: string;
}

/** `{ name = value, ... }` with no type in front. */
export function isAnonLit(e: Expr): e is CompoundLit {
  return e.k === "CompoundLit" && !e.type && e.elems.some((x) => x.k === "FieldValue");
}

export interface ImplInfo {
  node: ImplBlock;
  iface: GlobalSym;
  /** the package the impl block is written in */
  pkg: PackageInfo;
  /** suffix used in generated names */
  key: string;
  /** interface method name -> the proc bound to it */
  methods: Map<string, GlobalSym>;
}

/** `name :: proc(x: I, ...) ---` listed in `I :: interface { name, ... }`. */
export interface IfaceMethod {
  name: string;
  iface: GlobalSym;
  sym: GlobalSym;
  lit: ProcLit;
  /** the signature without the interface parameter */
  rest: ProcSig;
}

const INT_TYPES = new Set(["int", "uint", "i8", "i16", "i32", "i64", "i128", "u8", "u16", "u32", "u64", "u128", "uintptr", "byte",
  "i16le", "i32le", "i64le", "u16le", "u32le", "u64le", "i16be", "i32be", "i64be", "u16be", "u32be", "u64be"]);
const FLOAT_TYPES = new Set(["f16", "f32", "f64", "f16le", "f32le", "f64le", "f16be", "f32be", "f64be"]);
const MAX_EXPANSION_DEPTH = 64;

export function posOf(n: Node): Pos {
  return n.toks[n.start]?.pos ?? n.toks[0].pos;
}

export function nodeText(n: Node): string {
  return n.toks.slice(n.start, n.end).map((t, i) => (i ? t.pre.replace(/\s+/g, " ") : "") + t.text).join("").trim();
}

/** The name an import is known by: its alias, the imported package's name, or the last path element. */
export function importName(alias: string | null, path: string, target: PackageInfo | null): string {
  if (alias) return alias;
  if (target) return target.name;
  const last = path.replace(/^[\w]+:/, "").split("/").filter(Boolean).pop() ?? path;
  return last.replace(/\W/g, "_");
}

export class Analyzer {
  /** parent of every package scope; holds nothing */
  readonly global = new Scope(null);
  readonly interp = new Interp(this);
  /** tokens whose text is replaced in the output (prefixed names in merged import cycles, impl headers) */
  readonly tokText = new Map<Token, string>();
  private depth = 0;
  private stmtStack: Node[] = [];
  private macroCalls: MacroCall[] = [];
  private pendingImpls: { node: ImplBlock; scope: Scope; pkg: PackageInfo }[] = [];
  private pendingIfaces: { node: Extract<Expr, { k: "InterfaceType" }>; sym: GlobalSym }[] = [];
  private bodiless: { sym: GlobalSym; lit: ProcLit }[] = [];
  private resultStack: { sig: ProcSig; scope: Scope; proc: ProcLit }[] = [];
  private errCounter = 0;
  private anonCounter = 0;
  /** method declaration -> its interface method */
  readonly ifaceMethods = new Map<GlobalSym, IfaceMethod>();

  /** set when analyzing for tooling: errors are collected per statement instead of thrown */
  errors: CompileError[] | null = null;

  /** resolves an import path written in `fromDir` to a loaded vidar package, if it is one */
  resolveImport: (fromDir: string, path: string) => PackageInfo | null = () => null;

  private guard(f: () => void): void {
    if (!this.errors) return f();
    try {
      f();
    } catch (err) {
      if (!(err instanceof CompileError)) throw err;
      this.errors.push(err);
    }
  }

  run(packages: PackageInfo[]): void {
    for (const pkg of packages) {
      for (const f of pkg.files) {
        const fileScope = new Scope(pkg.scope);
        pkg.fileScopes.set(f, fileScope);
        this.guard(() => this.declareImports(f, fileScope, pkg));
        this.guard(() => this.declareAll(f.stmts, pkg.scope, pkg, fileScope));
      }
    }
    for (const p of this.pendingIfaces) this.guard(() => this.resolveIface(p.node, p.sym));
    for (const b of this.bodiless) this.guard(() => this.checkBodiless(b.sym, b.lit));
    for (const p of this.pendingImpls) this.guard(() => this.resolveImpl(p.node, p.scope, p.pkg));
    for (const pkg of packages) {
      for (const f of pkg.files) {
        const fileScope = pkg.fileScopes.get(f)!;
        for (const s of f.stmts) this.guard(() => this.topStmt(s, fileScope));
      }
    }
  }

  // ---- declarations ----

  private declareImports(f: File, scope: Scope, pkg: PackageInfo): void {
    for (const s of f.stmts) {
      if (s.k !== "Import") continue;
      const target = this.resolveImport(pkg.dir, s.path);
      const sym: PkgSym = { kind: "pkg", name: importName(s.alias, s.path, target), path: s.path, target, stmt: s };
      A(s)._sym = sym;
      if (sym.name !== "_") scope.syms.set(sym.name, sym);
    }
  }

  private declareAll(stmts: Stmt[], scope: Scope, pkg: PackageInfo, fileScope: Scope, inWhen = false): void {
    for (const s of stmts) {
      if (s.k === "When") {
        this.declareAll(s.then.stmts, scope, pkg, fileScope, true);
        let e = s.else;
        while (e) {
          if (e.k === "Block") {
            this.declareAll(e.stmts, scope, pkg, fileScope, true);
            break;
          }
          if (e.k !== "When") break;
          this.declareAll(e.then.stmts, scope, pkg, fileScope, true);
          e = e.else;
        }
        continue;
      }
      if (s.k === "ValueDecl") {
        const syms = s.names.map((n, index) => {
          const isPrivate = s.attrs.some((a) => /^@\(?private\b/.test(a));
          const exported = pkg.prefix && n.name !== "main" ? pkg.prefix + n.name : n.name;
          const sym: GlobalSym = { kind: "global", name: n.name, odinName: exported, pkg, isPrivate, isConst: s.isConst, decl: s, index, scope: fileScope };
          if (n.name === "_" || (inWhen && scope.syms.has(n.name))) return sym;
          if (scope.syms.has(n.name)) throw new CompileError(`'${n.name}' is already declared in package '${pkg.name}'`, s.toks[n.tok].pos);
          scope.syms.set(n.name, sym);
          if (sym.odinName !== n.name) this.tokText.set(s.toks[n.tok], sym.odinName);
          return sym;
        });
        A(s)._syms = syms;
        s.values.forEach((v, i) => {
          if (v.k === "InterfaceType") {
            A(v)._ifaceSym = syms[i];
            this.pendingIfaces.push({ node: v, sym: syms[i] });
          }
          if (v.k === "ProcLit" && !v.body && !v.comptime && s.isConst) this.bodiless.push({ sym: syms[i], lit: v });
        });
      } else if (s.k === "ImplBlock") {
        this.pendingImpls.push({ node: s, scope: fileScope, pkg });
        for (let i = s.start; i < s.end; i++) this.tokText.set(s.toks[i], "");
      }
    }
  }

  private topStmt(s: Stmt, scope: Scope): void {
    if (s.k === "ImplBlock") return;
    if (s.k === "When") {
      this.expr(s.cond, scope);
      for (const b of s.then.stmts) this.topStmt(b, scope);
      if (s.else) this.topStmt(s.else, scope);
      return;
    }
    if (s.k === "Block") {
      for (const b of s.stmts) this.topStmt(b, scope);
      return;
    }
    if (s.k === "Package" || s.k === "Import") return;
    if (s.k === "ValueDecl") {
      const anon = s.values.find(isAnonLit);
      if (anon && !s.type && !s.isConst) throw new CompileError("anonymous struct literals can only be declared inside a procedure", posOf(anon));
      if (s.type) this.expr(s.type, scope);
      this.withStmt(s, () => s.values.forEach((v) => this.expr(v, scope)));
      if (s.type) s.values.forEach((v) => this.convertTo(v, { t: "node", node: s.type!, scope }));
      return;
    }
    this.stmt(s, scope);
  }

  // ---- name resolution ----

  /** Resolves `name` from `scope`, enforcing closure capture rules. */
  lookup(name: string, scope: Scope, at: Node | null): Sym | undefined {
    let crossed = "none" as "none" | "plain" | "closure";
    for (let s: Scope | null = scope; s; s = s.parent) {
      const sym = s.syms.get(name);
      if (sym) {
        if (at && crossed !== "none" && (sym.kind === "local" || sym.kind === "capture")) {
          const isConst = sym.kind === "local" && sym.isConst;
          if (!isConst) {
            throw new CompileError(
              crossed === "closure"
                ? `'${name}' is a local of the enclosing procedure and is not captured; add it to the capture list: proc[${name}] or proc[&${name}]`
                : `'${name}' is a local of the enclosing procedure; nested procs cannot see it. Use a closure: proc[${name}](...) or proc[&${name}](...)`,
              posOf(at),
            );
          }
          if (crossed === "closure")
            throw new CompileError(`closure bodies are lifted to file scope and cannot use the local constant '${name}'; move it to file scope`, posOf(at));
        }
        return sym;
      }
      if (s.procRoot) crossed = s.procRoot.closure || crossed === "closure" ? "closure" : "plain";
    }
    return undefined;
  }

  /** `pkg.member` where `pkg` is an imported vidar package. */
  pkgMember(sel: Selector, scope: Scope, at: Node | null): { pkg: PkgSym; member: GlobalSym } | undefined {
    if (sel.x.k !== "Ident") return undefined;
    const p = this.lookup(sel.x.name, scope, null);
    if (p?.kind !== "pkg" || !p.target) return undefined;
    const member = p.target.scope.syms.get(sel.name);
    if (!member || member.kind !== "global") {
      if (at) throw new CompileError(`package '${p.name}' has no member '${sel.name}'`, posOf(at));
      return undefined;
    }
    if (at && member.isPrivate && scope.package !== member.pkg)
      throw new CompileError(`'${p.name}.${sel.name}' is private to package '${member.pkg.name}'`, posOf(at));
    return { pkg: p, member };
  }

  /** A name or `pkg.name` that denotes a package-level declaration. */
  resolveName(e: Expr, scope: Scope, at: Node | null): Sym | undefined {
    if (e.k === "Ident") return this.lookup(e.name, scope, at);
    if (e.k === "Selector") return this.pkgMember(e, scope, at)?.member;
    return undefined;
  }

  // ---- statements ----

  private withStmt<T>(s: Node, f: () => T): T {
    this.stmtStack.push(s);
    try {
      return f();
    } finally {
      this.stmtStack.pop();
    }
  }

  private block(b: Block, scope: Scope): void {
    A(b)._scope = scope;
    for (const s of b.stmts) this.guard(() => this.withStmt(s, () => this.stmt(s, scope)));
  }

  stmt(s: Stmt, scope: Scope): void {
    switch (s.k) {
      case "Block":
        this.block(s, s.inline ? scope : new Scope(scope));
        return;
      case "ValueDecl":
        this.localDecl(s, scope);
        return;
      case "ExprStmt":
        if (s.x.k === "Postfix" && s.x.value) this.hostOrReturn(s, s.x, scope);
        if (s.x.k === "MacroCall") {
          const call = s.x;
          this.nested(call, () => {
            const out = this.expandMacro(call, scope, "stmt");
            const stmts = Array.isArray(out) ? out : [this.exprStmtFrom(out)];
            const block: Block = { k: "Block", toks: stmts[0]?.toks ?? s.toks, start: 0, end: 0, stmts, inline: true };
            A(s)._expansion = block;
            this.block(block, scope);
          });
          return;
        }
        this.expr(s.x, scope);
        return;
      case "If":
      case "For":
      case "Switch": {
        const inner = new Scope(scope);
        if (s.init) A(s.init)._isInit = true;
        if (s.init) this.stmt(s.init, inner);
        if (s.k === "If") {
          this.expr(s.cond, inner);
          this.stmt(s.then, inner);
          if (s.else) this.stmt(s.else, inner);
        } else if (s.k === "For") {
          if (s.cond) this.expr(s.cond, inner);
          if (s.post) this.stmt(s.post, inner);
          this.stmt(s.body, inner);
        } else {
          if (s.tag) this.expr(s.tag, inner);
          if (s.typeSwitchVar) this.declareLocal(s.typeSwitchVar.name, inner, { declKind: "other" });
          for (const c of s.cases) {
            c.exprs.forEach((e) => this.expr(e, inner));
            const caseScope = new Scope(inner);
            for (const b of c.body) this.withStmt(b, () => this.stmt(b, caseScope));
          }
        }
        return;
      }
      case "RangeFor": {
        this.expr(s.x, scope);
        const inner = new Scope(scope);
        const iterTy = this.typeOf(s.x, scope);
        A(s)._syms = s.vals.map((v, i) =>
          this.declareLocal(v.name, inner, {
            declKind: "range",
            ty: i === 0 ? (iterTy && this.elemOf(iterTy)) : { t: "node", node: synthIdent("int", posOf(s)), scope: this.global },
            declTok: s.toks[v.tok],
          }),
        );
        this.stmt(s.body, inner);
        return;
      }
      case "Assign":
        if (s.rhs.length === 1 && s.rhs[0].k === "Postfix" && s.rhs[0].value) this.hostOrReturn(s, s.rhs[0], scope);
        s.lhs.forEach((e) => this.expr(e, scope));
        s.rhs.forEach((e) => this.expr(e, scope));
        if (s.op === "=" && s.lhs.length === s.rhs.length) s.rhs.forEach((r, i) => this.convertTo(r, this.typeOf(s.lhs[i], scope)));
        return;
      case "Return": {
        s.results.forEach((e) => this.expr(e, scope));
        const top = this.resultStack[this.resultStack.length - 1];
        if (top) s.results.forEach((r, i) => this.convertTo(r, this.resultTy({ t: "sig", closure: false, sig: top.sig, scope: top.scope }, i)));
        return;
      }
      case "ImplBlock":
        throw new CompileError("impl blocks can only be declared at file scope", posOf(s));
      case "Catch":
        this.catchStmt(s, scope);
        return;
      case "ErrDefer": {
        const top = this.errorResult(s);
        A(s)._errName = top;
        this.stmt(s.stmt, scope);
        return;
      }
      default:
        for (const c of children(s)) this.node(c, scope);
    }
  }

  private exprStmtFrom(e: Expr): Stmt {
    return { k: "ExprStmt", toks: e.toks, start: e.start, end: e.end, x: e };
  }

  private declareLocal(name: string, scope: Scope, init: Partial<LocalSym>): LocalSym {
    const sym: LocalSym = { kind: "local", name, ctx: scope.ctx ?? { closure: false }, isConst: false, scope, boxed: false, declKind: "decl", ...init };
    if (name !== "_") scope.syms.set(name, sym);
    return sym;
  }

  private localDecl(s: ValueDecl, scope: Scope): void {
    if (s.values.length === 1 && s.values[0].k === "Postfix" && s.values[0].value) this.hostOrReturn(s, s.values[0], scope);
    if (s.type) this.expr(s.type, scope);
    s.values.forEach((v) => this.expr(v, scope));
    if (s.type) s.values.forEach((v) => this.convertTo(v, { t: "node", node: s.type!, scope }));
    if (!s.type && !s.isConst && s.values.some(isAnonLit)) {
      if (A(s)._isInit) throw new CompileError("an anonymous struct literal cannot be declared in an if/for/switch initializer; declare it on its own line first", posOf(s));
      A(s)._anonTemps = s.values.flatMap((v) => (isAnonLit(v) ? this.anonLit(v, scope, `__anon${++this.anonCounter}`) : []));
    }
    const multi = s.values.length === 1 && s.names.length > 1 ? this.callSig(s.values[0], scope) : undefined;
    A(s)._syms = s.names.map((n, i) => {
      let ty: Ty | undefined;
      if (s.type) ty = { t: "node", node: s.type, scope };
      else if (s.values.length === s.names.length) ty = this.typeOf(s.values[i], scope);
      else if (multi?.t === "sig") ty = this.resultTy(multi, i);
      return this.declareLocal(n.name, scope, { isConst: s.isConst, ty, value: s.isConst ? s.values[i] : undefined, declTok: s.toks[n.tok] });
    });
  }

  // ---- expressions ----

  node(n: Node, scope: Scope): void {
    if (n.k === "Case") return;
    if (isStmt(n)) this.stmt(n as Stmt, scope);
    else this.expr(n as Expr, scope);
  }

  expr(e: Expr, scope: Scope): void {
    A(e)._scope = scope;
    switch (e.k) {
      case "Ident": {
        const sym = this.lookup(e.name, scope, e);
        if (sym) A(e)._sym = sym;
        return;
      }
      case "Selector": {
        const pm = this.pkgMember(e, scope, e);
        if (pm) {
          A(e.x)._sym = pm.pkg;
          A(e.x)._scope = scope;
          A(e)._pkgMember = pm.member;
          return;
        }
        this.expr(e.x, scope);
        return;
      }
      case "ProcLit":
        this.proc(e, scope);
        return;
      case "ProcType":
      case "ClosureType":
        this.sig(e.sig, new Scope(scope), false);
        return;
      case "StructType":
      case "UnionType": {
        const inner = new Scope(scope);
        if (e.polyParams) this.params(e.polyParams, inner, false);
        for (const c of children(e)) this.node(c, inner);
        return;
      }
      case "Poly":
        if (e.spec) this.expr(e.spec, scope);
        return;
      case "MacroCall": {
        this.nested(e, () => {
          const out = this.expandMacro(e, scope, "expr");
          if (Array.isArray(out)) throw new CompileError(`macro '${e.path.join(".")}' returns statements and can only be used as a statement`, posOf(e));
          A(e)._expansion = out;
          this.expr(out, scope);
        });
        return;
      }
      case "Call": {
        this.expr(e.fn, scope);
        e.args.forEach((a) => this.expr(a, scope));
        const fnSym = e.fn.k === "Ident" ? A(e.fn)._sym : e.fn.k === "Selector" ? A(e.fn)._pkgMember : undefined;
        const ifaceVal = fnSym?.kind === "global" ? fnSym.decl.values[fnSym.index] : undefined;
        if (ifaceVal?.k === "ProcLit" && ifaceVal.comptime)
          throw new CompileError(`'${fnSym!.name}' is a comptime proc: invoke it as a macro with '${fnSym!.name}!(...)', or fold it with 'comptime ${fnSym!.name}(...)' when every argument is a constant`, posOf(e));
        if (ifaceVal?.k === "InterfaceType") {
          A(e)._ifaceConv = fnSym;
          if (e.args.length === 1) this.requirePointer(e.args[0], fnSym);
          return;
        }
        if (e.fn.k === "Ident" && e.fn.name === "append" && !fnSym && e.args.length > 1) {
          const target = this.typeOf(e.args[0], scope);
          const elem = target && this.elemOf(target);
          e.args.slice(1).forEach((a) => this.convertTo(a, elem));
          return;
        }
        const ft = this.normalize(this.typeOf(e.fn, scope));
        if (ft?.t === "sig" && ft.closure) {
          if (e.args.some((a) => a.k === "FieldValue")) throw new CompileError("named arguments are not supported when calling closures", posOf(e));
          A(e)._closure = ft;
        }
        if (ft?.t === "sig") this.convertArgs(e.args, ft, fnSym?.kind === "global" && this.ifaceMethods.has(fnSym) ? 1 : 0);
        return;
      }
      case "CompoundLit": {
        for (const c of children(e)) this.node(c, scope);
        if (e.type) {
          const ty: Ty = { t: "node", node: e.type, scope };
          for (const el of e.elems) if (el.k === "FieldValue") this.convertTo(el.value, this.fieldOf(ty, el.name));
        }
        return;
      }
      case "Postfix":
        if (e.value && !A(e)._hosted)
          throw new CompileError("'or_return <value>' must be the whole right-hand side: x := f() or_return .Err, x = f() or_return .Err, or f() or_return .Err", posOf(e));
        this.expr(e.x, scope);
        if (e.value) this.expr(e.value, scope);
        return;
      case "ArrowCall": {
        this.expr(e.x, scope);
        e.args.forEach((a) => this.expr(a, scope));
        this.arrowCall(e, scope);
        return;
      }
      case "InterfaceType":
        if (!A(e)._ifaceSym) throw new CompileError("interfaces must be declared as named constants: Name :: interface { ... }", posOf(e));
        return;
      case "Comptime": {
        const out = this.foldComptime(e, scope);
        A(e)._expansion = out;
        this.expr(out, scope);
        return;
      }
      case "Quote":
        throw new CompileError("'quote' is only allowed inside comptime procs", posOf(e));
      default:
        for (const c of children(e)) this.node(c, scope);
    }
  }

  private proc(p: ProcLit, scope: Scope): void {
    if (p.comptime) return;
    const ctx: Ctx = { closure: !!p.captures };
    const root = new Scope(scope, null, ctx);
    if (p.captures) {
      A(p)._captures = p.captures.map((c) => {
        if (root.syms.has(c.name)) throw new CompileError(`'${c.name}' is captured twice`, p.toks[c.tok].pos);
        const target = this.lookup(c.name, scope, null);
        if (!target) throw new CompileError(`cannot capture unknown name '${c.name}'`, p.toks[c.tok].pos);
        if (target.kind === "global" || target.kind === "pkg" || (target.kind === "local" && target.isConst))
          throw new CompileError(`'${c.name}' is not a local variable; closures can use globals and constants without capturing them`, p.toks[c.tok].pos);
        if (target.kind === "local" && target.ctx !== scope.ctx)
          throw new CompileError(`'${c.name}' belongs to an outer procedure; capture it there first`, p.toks[c.tok].pos);
        if (c.byRef && target.kind === "local") {
          if (target.declKind === "other") throw new CompileError(`'${c.name}' cannot be captured by reference`, p.toks[c.tok].pos);
          target.boxed = true;
        }
        const sym: CaptureSym = { kind: "capture", name: c.name, byRef: c.byRef, target, ctx, declTok: p.toks[c.tok] };
        root.syms.set(c.name, sym);
        return sym;
      });
    }
    A(p)._params = this.sig(p.sig, root, true, p.toks);
    if (p.body) {
      this.resultStack.push({ sig: p.sig, scope: root, proc: p });
      try {
        this.stmt(p.body, new Scope(root));
      } finally {
        this.resultStack.pop();
      }
    }
  }

  private sig(sig: ProcSig, scope: Scope, declare: boolean, toks?: Token[]): LocalSym[] {
    const params = this.params(sig.params, scope, declare && !sig.unnamed, toks);
    this.params(sig.results, scope, declare && !sig.resultsUnnamed, toks);
    return params;
  }

  private params(params: Param[], scope: Scope, declare: boolean, toks?: Token[]): LocalSym[] {
    const out: LocalSym[] = [];
    for (const p of params) {
      if (p.type) {
        this.declarePolys(p.type, scope);
        this.expr(p.type, scope);
      }
      if (p.value) this.expr(p.value, scope);
      for (const n of p.names) {
        if (n.prefix?.includes("$")) {
          out.push(this.declareLocal(n.name, scope, { isConst: true, declKind: "param", declTok: toks?.[n.tok] }));
        } else if (declare) {
          const ty: Ty | undefined = p.type ? { t: "node", node: p.type, scope } : p.value ? this.typeOf(p.value, scope) : undefined;
          out.push(this.declareLocal(n.name, scope, { ty, declKind: "param", declTok: toks?.[n.tok] }));
        }
      }
    }
    return out;
  }

  private declarePolys(e: Expr, scope: Scope): void {
    if (e.k === "Poly") {
      if (!scope.syms.has(e.name)) this.declareLocal(e.name, scope, { isConst: true, declKind: "param" });
      return;
    }
    for (const c of children(e)) if (!isStmt(c) && c.k !== "Case") this.declarePolys(c as Expr, scope);
  }

  // ---- type inference (best effort, used for closure calls and typed macros) ----

  /** Unwraps aliases and parentheses down to a structural type. */
  normalize(ty: Ty | undefined, depth = 0): Ty | undefined {
    if (!ty || depth > 32) return ty;
    if (ty.t !== "node") return ty;
    const n = ty.node;
    switch (n.k) {
      case "Paren":
        return this.normalize({ ...ty, node: n.x }, depth + 1);
      case "ClosureType":
        return { t: "sig", closure: true, sig: n.sig, scope: ty.scope };
      case "ProcType":
        return { t: "sig", closure: false, sig: n.sig, scope: ty.scope };
      case "Unary":
        return n.op === "^" ? { t: "ptr", elem: { t: "node", node: n.x, scope: ty.scope } } : ty;
      case "TypeExpr":
        return n.what === "distinct" && n.parts[0] ? this.normalize({ ...ty, node: n.parts[0] }, depth + 1) : ty;
      case "Ident":
      case "Selector": {
        const target = this.typeDeclOf(this.resolveName(n, ty.scope, null));
        return target ? this.normalize(target, depth + 1) : ty;
      }
    }
    return ty;
  }

  private typeDeclOf(sym: Sym | undefined): Ty | undefined {
    if (sym?.kind === "global" && sym.isConst && !sym.decl.type) {
      const v = sym.decl.values[sym.index];
      if (v && isTypeExpr(v)) return { t: "node", node: v, scope: sym.scope };
    }
    if (sym?.kind === "local" && sym.isConst && sym.value && isTypeExpr(sym.value)) return { t: "node", node: sym.value, scope: sym.scope };
    return undefined;
  }

  /** The signature of the proc or closure a call expression invokes (for multi-value declarations). */
  private callSig(e: Expr, scope: Scope): Extract<Ty, { t: "sig" }> | undefined {
    if (e.k === "Postfix") return this.callSig(e.x, scope);
    if (e.k !== "Call") return undefined;
    const t = this.normalize(this.typeOf(e.fn, scope));
    return t?.t === "sig" ? t : undefined;
  }

  resultTy(sigTy: Extract<Ty, { t: "sig" }>, index: number): Ty | undefined {
    let i = 0;
    for (const r of sigTy.sig.results) {
      const count = Math.max(1, r.names.length);
      if (index < i + count) return r.type ? { t: "node", node: r.type, scope: sigTy.scope } : undefined;
      i += count;
    }
    return undefined;
  }

  fieldOf(ty: Ty | undefined, name: string): Ty | undefined {
    let n = this.normalize(ty);
    if (n?.t === "ptr") n = this.normalize(n.elem);
    if (n?.t !== "node" || n.node.k !== "StructType") return undefined;
    for (const f of n.node.fields) if (f.type && f.names.some((x) => x.name === name)) return { t: "node", node: f.type, scope: n.scope };
    return undefined;
  }

  elemOf(ty: Ty): Ty | undefined {
    let n = this.normalize(ty);
    if (n?.t === "ptr") n = this.normalize(n.elem);
    if (n?.t === "node" && n.node.k === "TypeExpr" && ["array", "slice", "dynamic", "inferred", "multipointer", "map"].includes(n.node.what)) {
      const elem = n.node.parts[1];
      return elem ? { t: "node", node: elem, scope: n.scope } : undefined;
    }
    return undefined;
  }

  typeOf(e: Expr, scope: Scope, depth = 0): Ty | undefined {
    if (depth > 32) return undefined;
    switch (e.k) {
      case "Lit":
        return e.kind === "undef" ? undefined : { t: "untyped", kind: e.kind === "imag" ? "float" : e.kind };
      case "Ident": {
        if (e.name === "true" || e.name === "false") return { t: "untyped", kind: "bool" };
        return this.symTy(A(e)._sym ?? this.lookup(e.name, scope, null), depth);
      }
      case "Paren":
        return this.typeOf(e.x, scope, depth + 1);
      case "Postfix":
        return this.typeOf(e.x, scope, depth + 1);
      case "Selector": {
        const member: GlobalSym | undefined = A(e)._pkgMember ?? this.pkgMember(e, scope, null)?.member;
        if (member) return this.symTy(member, depth);
        return this.fieldOf(this.typeOf(e.x, scope, depth + 1), e.name);
      }
      case "Index":
        if (e.slice) return this.typeOf(e.x, scope, depth + 1);
        return (() => {
          const t = this.typeOf(e.x, scope, depth + 1);
          return t && this.elemOf(t);
        })();
      case "Deref": {
        const t = this.normalize(this.typeOf(e.x, scope, depth + 1));
        return t?.t === "ptr" ? t.elem : undefined;
      }
      case "Unary": {
        if (e.op !== "&") return e.op === "!" ? { t: "untyped", kind: "bool" } : this.typeOf(e.x, scope, depth + 1);
        const t = this.typeOf(e.x, scope, depth + 1);
        return t && { t: "ptr", elem: t };
      }
      case "Binary": {
        if (["==", "!=", "<", ">", "<=", ">=", "&&", "||", "in", "not_in"].includes(e.op)) return { t: "untyped", kind: "bool" };
        const l = this.typeOf(e.x, scope, depth + 1);
        return l?.t === "untyped" ? this.typeOf(e.y, scope, depth + 1) ?? l : l;
      }
      case "Ternary":
        return this.typeOf(e.a, scope, depth + 1);
      case "CompoundLit":
        return e.type ? { t: "node", node: e.type, scope } : A(e)._anonTy;
      case "Cast":
      case "TypeAssert":
        return e.type ? { t: "node", node: e.type, scope } : undefined;
      case "ProcLit":
        return { t: "sig", closure: !!e.captures, sig: e.sig, scope };
      case "MacroCall":
        return A(e)._expansion ? this.typeOf(A(e)._expansion, scope, depth + 1) : undefined;
      case "Comptime":
        return this.typeOf(A(e)._expansion ?? e.x, scope, depth + 1);
      case "Call": {
        const fn = e.fn;
        if (fn.k === "Ident") {
          const sym = A(fn)._sym ?? this.lookup(fn.name, scope, null);
          if (!sym && (fn.name === "new" || fn.name === "make") && e.args[0]) {
            const t: Ty = { t: "node", node: e.args[0], scope };
            return fn.name === "new" ? { t: "ptr", elem: t } : t;
          }
          if (!sym && (fn.name === "len" || fn.name === "cap")) return { t: "node", node: synthIdent("int", posOf(e)), scope: this.global };
          if (!sym && fn.name === "new_clone" && e.args[0]) {
            const t = this.typeOf(e.args[0], scope, depth + 1);
            return t && { t: "ptr", elem: t };
          }
          if (!sym && (INT_TYPES.has(fn.name) || FLOAT_TYPES.has(fn.name) || ["string", "bool", "rune", "cstring"].includes(fn.name)))
            return { t: "node", node: fn, scope };
          const td = this.typeDeclOf(sym);
          if (td) return { t: "node", node: fn, scope };
        }
        const ft = this.normalize(this.typeOf(fn, scope, depth + 1));
        return ft?.t === "sig" ? this.resultTy(ft, 0) : undefined;
      }
    }
    return undefined;
  }

  private symTy(sym: Sym | undefined, depth: number): Ty | undefined {
    if (!sym) return undefined;
    switch (sym.kind) {
      case "local":
        return sym.ty;
      case "capture":
        return this.symTy(sym.target, depth + 1);
      case "global": {
        const d = sym.decl;
        if (d.type) return { t: "node", node: d.type, scope: sym.scope };
        const v = d.values[sym.index];
        if (!v || isTypeExpr(v)) return undefined;
        if (v.k === "ProcLit" && v.comptime) return undefined;
        return this.typeOf(v, sym.scope, depth + 1);
      }
    }
    return undefined;
  }

  /** Canonical spelling of a type for comparisons (undefined when unknown). */
  typeName(ty: Ty | undefined): string | undefined {
    const n = this.normalize(ty);
    if (!n) return undefined;
    if (n.t === "untyped") return `untyped ${n.kind}`;
    if (n.t === "ptr") {
      const inner = this.typeName(n.elem);
      return inner && `^${inner}`;
    }
    if (n.t === "sig") return undefined;
    const node = ty?.t === "node" ? ty.node : n.node;
    return nodeText(node).replace(/\s+/g, "");
  }

  /** true = compatible, false = definitely not, undefined = can't tell (defer to Odin). */
  compatible(from: Ty | undefined, to: Ty): boolean | undefined {
    const f = this.normalize(from);
    const toName = this.typeName(to);
    if (!f || !toName) return undefined;
    if (f.t === "untyped") {
      const base = toName;
      const known = INT_TYPES.has(base) || FLOAT_TYPES.has(base) || ["string", "bool", "rune", "cstring", "b8", "b16", "b32", "b64"].includes(base);
      if (!known) return undefined;
      switch (f.kind) {
        case "int": return INT_TYPES.has(base) || FLOAT_TYPES.has(base) || base === "rune";
        case "float": return FLOAT_TYPES.has(base);
        case "string": return base === "string" || base === "cstring";
        case "rune": return base === "rune" || INT_TYPES.has(base);
        case "bool": return base === "bool" || /^b\d+$/.test(base);
      }
    }
    const fromName = this.typeName(from);
    if (!fromName) return undefined;
    return fromName === toName ? true : undefined;
  }

  // ---- anonymous struct literals ----

  /**
   * `x := { a = 1, b = f() }` declares a struct type on the spot. Each field value is hoisted into
   * a temp, and the field types are `type_of` those temps, so Odin infers them (untyped constants
   * take their default types). Returns the temps in evaluation order.
   */
  private anonLit(e: CompoundLit, scope: Scope, prefix: string): AnonTemp[] {
    const temps: AnonTemp[] = [];
    const fields: AnonField[] = [];
    const types: AnonFieldType[] = [];
    for (const el of e.elems) {
      if (el.k !== "FieldValue") throw new CompileError("every element of an anonymous struct literal needs a field name: { name = value, ... }", posOf(el));
      if (fields.some((f) => f.name === el.name)) throw new CompileError(`field '${el.name}' is given twice`, posOf(el));
      const v = el.value;
      const tok = el.toks[el.start];
      if ((v.k === "Ident" && v.name === "nil") || (v.k === "Lit" && v.kind === "undef"))
        throw new CompileError(`the type of field '${el.name}' cannot be inferred from '${nodeText(v)}'; give the value a type, e.g. (^T)(nil)`, posOf(v));
      if (v.k === "CompoundLit" && !v.type) {
        if (!isAnonLit(v)) throw new CompileError(`the type of field '${el.name}' cannot be inferred; write the literal's type, e.g. T{...}`, posOf(v));
        temps.push(...this.anonLit(v, scope, `${prefix}_${el.name}`));
        fields.push({ name: el.name, nested: v });
        const type = this.tyNode(A(v)._anonTy, tok)!;
        types.push({ name: el.name, tok, type, text: nodeText(type) });
        continue;
      }
      const name = `${prefix}_${el.name}`;
      temps.push({ name, value: v, pre: tok.pre });
      fields.push({ name: el.name, temp: name });
      const type = this.tyNode(this.typeOf(v, scope), tok);
      types.push({ name: el.name, tok, type, text: type ? nodeText(type) : `type_of(${nodeText(v)})` });
    }
    A(e)._anon = fields;
    A(e)._anonTy = { t: "node", node: this.structNode(types, posOf(e)), scope } satisfies Ty;
    return temps;
  }

  /** A synthetic struct type for analysis and tooling (field names point at the literal). */
  private structNode(fields: AnonFieldType[], pos: Pos): Expr {
    const toks: Token[] = [{ kind: "kw", text: "struct", pre: "", pos }, { kind: "op", text: "{", pre: " ", pos }];
    const params: Param[] = fields.map((f, i) => {
      if (i) toks.push({ kind: "op", text: ",", pre: "", pos });
      const tok = toks.push({ ...f.tok, pre: " " }) - 1;
      toks.push({ kind: "op", text: ":", pre: "", pos }, { kind: "ident", text: f.text, pre: " ", pos });
      return { names: [{ name: f.name, tok }], type: f.type };
    });
    toks.push({ kind: "op", text: "}", pre: " ", pos });
    const node: Expr = { k: "StructType", fields: params, polyParams: null, extra: [], toks, start: 0, end: toks.length };
    A(node)._anonFields = fields;
    return node;
  }

  /** A type expression for an inferred type, when there is one. */
  private tyNode(ty: Ty | undefined, at: Token): Expr | undefined {
    if (!ty) return undefined;
    switch (ty.t) {
      case "node":
        return ty.node;
      case "untyped":
        return synthIdent({ int: "int", float: "f64", string: "string", rune: "rune", bool: "bool" }[ty.kind], at.pos);
      case "sig": {
        const text = `${ty.closure ? "closure" : "proc"}(${ty.sig.params.map((p) => (p.names.length ? p.names.map((n) => n.name).join(", ") + ": " : "") + (p.type ? nodeText(p.type) : "")).join(", ")})`
          + (ty.sig.results.length ? ` -> ${ty.sig.results.length > 1 ? "(" : ""}${ty.sig.results.map((r) => (r.type ? nodeText(r.type) : "")).join(", ")}${ty.sig.results.length > 1 ? ")" : ""}` : "");
        return { k: ty.closure ? "ClosureType" : "ProcType", sig: ty.sig, toks: [{ kind: "ident", text, pre: "", pos: at.pos }], start: 0, end: 1 };
      }
      case "ptr": {
        const elem = this.tyNode(ty.elem, at);
        return elem && { k: "Unary", op: "^", x: elem, toks: [{ kind: "ident", text: `^${nodeText(elem)}`, pre: "", pos: at.pos }], start: 0, end: 1 };
      }
    }
  }

  // ---- interfaces ----

  private ifaceOf(ty: Ty | undefined): GlobalSym | undefined {
    const n = this.normalize(ty);
    return n?.t === "node" && n.node.k === "InterfaceType" ? A(n.node)._ifaceSym : undefined;
  }

  /** Marks `e` for implicit conversion when it flows into an interface-typed slot. */
  convertTo(e: Expr, ty: Ty | undefined): void {
    const iface = this.ifaceOf(ty);
    if (!iface) return;
    if (e.k === "Ident" && e.name === "nil") return;
    if (e.k === "Lit" && e.kind === "undef") return;
    if (e.k === "CompoundLit" && !e.type) return;
    if (e.k === "Call" && A(e)._ifaceConv) return;
    if (this.ifaceOf(this.typeOf(e, this.global)) === iface && e.k !== "Unary") return;
    this.requirePointer(e, iface);
    A(e)._wrapIface = iface;
  }

  /** Interface values refer to their data; converting a plain value would hide a heap copy. */
  private requirePointer(e: Expr, iface: GlobalSym): void {
    const n = this.normalize(this.typeOf(e, this.global));
    const isValue = e.k === "CompoundLit" || (n?.t === "node" && (n.node.k === "StructType" || n.node.k === "UnionType"));
    if (!isValue) return;
    const text = nodeText(e);
    throw new CompileError(`'${text}' is a value; '${iface.name}' needs a pointer: &${text}, or new_clone(${text}) for a heap copy you own`, posOf(e));
  }

  private convertArgs(args: Expr[], ft: Extract<Ty, { t: "sig" }>, skip = 0): void {
    const params = ft.sig.params.flatMap((p) => (ft.sig.unnamed ? [{ name: "", type: p.type }] : p.names.map((n) => ({ name: n.name, type: p.type }))));
    args.forEach((a, i) => {
      if (i < skip) return;
      const param = a.k === "FieldValue" ? params.find((p) => p.name === a.name) : params[i];
      if (param?.type) this.convertTo(a.k === "FieldValue" ? a.value : a, { t: "node", node: param.type, scope: ft.scope });
    });
  }

  readonly impls: ImplInfo[] = [];

  private resolveIface(node: Extract<Expr, { k: "InterfaceType" }>, ifaceSym: GlobalSym): void {
    if (!node.methods.length) throw new CompileError(`interface '${ifaceSym.name}' has no methods`, posOf(node));
    const methods: IfaceMethod[] = [];
    for (const m of node.methods) {
      const pos = node.toks[m.tok].pos;
      if (methods.some((x) => x.name === m.name)) throw new CompileError(`'${m.name}' is listed twice in interface '${ifaceSym.name}'`, pos);
      const usage = `${m.name} :: proc(x: ${ifaceSym.name}, ...) ---`;
      const sym = ifaceSym.pkg.scope.syms.get(m.name);
      if (sym?.kind !== "global") throw new CompileError(`interface method '${m.name}' is not declared in package '${ifaceSym.pkg.name}'; declare it as ${usage}`, pos);
      const lit = sym.decl.values[sym.index];
      if (!sym.isConst || lit?.k !== "ProcLit" || lit.body || lit.comptime)
        throw new CompileError(`interface method '${m.name}' must be declared without a body: ${usage}`, pos);
      const first = lit.sig.params[0];
      if (!first?.type || this.resolveName(first.type, sym.scope, null) !== ifaceSym)
        throw new CompileError(`the first parameter of '${m.name}' must have type ${ifaceSym.name}`, first?.type ? posOf(first.type) : sym.decl.toks[sym.decl.names[sym.index].tok].pos);
      if (first.names.length > 1) throw new CompileError(`the first parameter of '${m.name}' must be the interface alone`, posOf(first.type));
      const method: IfaceMethod = { name: m.name, iface: ifaceSym, sym, lit, rest: { ...lit.sig, params: lit.sig.params.slice(1) } };
      methods.push(method);
      this.ifaceMethods.set(sym, method);
      A(lit)._ifaceMethod = method;
    }
    A(node)._methods = methods;
  }

  /** Outside foreign blocks, a proc without a body is an interface method. */
  private checkBodiless(sym: GlobalSym, lit: ProcLit): void {
    if (this.ifaceMethods.has(sym)) return;
    const pos = sym.decl.toks[sym.decl.names[sym.index].tok].pos;
    const first = lit.sig.params[0]?.type;
    const iface = first ? this.resolveName(first, sym.scope, null) : undefined;
    const ifaceNode = iface?.kind === "global" ? iface.decl.values[iface.index] : undefined;
    if (iface?.kind === "global" && ifaceNode?.k === "InterfaceType")
      throw new CompileError(`'${sym.name}' takes ${iface.name} first but is not listed in its interface: ${iface.name} :: interface { ..., ${sym.name} }`, pos);
    throw new CompileError(`'${sym.name}' has no body; only interface methods are declared with '---' (first parameter: the interface)`, pos);
  }

  private resolveImpl(s: ImplBlock, scope: Scope, pkg: PackageInfo): void {
    const pos = posOf(s);
    if (s.iface.k !== "Ident" && s.iface.k !== "Selector") throw new CompileError(`'${nodeText(s.iface)}' is not an interface`, posOf(s.iface));
    this.expr(s.iface, scope);
    const ifaceSym = this.resolveName(s.iface, scope, null);
    const ifaceNode = ifaceSym?.kind === "global" ? ifaceSym.decl.values[ifaceSym.index] : undefined;
    if (ifaceSym?.kind !== "global" || ifaceNode?.k !== "InterfaceType") throw new CompileError(`'${nodeText(s.iface)}' is not an interface`, posOf(s.iface));
    if (ifaceSym.pkg.unit !== pkg.unit)
      throw new CompileError(`impl of '${nodeText(s.iface)}' must be in package '${ifaceSym.pkg.name}' (or a package in an import cycle with it)`, pos);
    if (s.target.k !== "Ident" && s.target.k !== "Selector") throw new CompileError("impl targets must be named types", posOf(s.target));
    this.expr(s.target, scope);
    const t = this.resolveName(s.target, scope, null);
    if (t && t.kind !== "global") throw new CompileError(`'${nodeText(s.target)}' is not a type`, posOf(s.target));
    const key = `${pkg.unit.merged ? pkg.name + "_" : ""}${nodeText(s.target)}`.replace(/\W/g, "_");
    if (this.impls.some((x) => x.iface === ifaceSym && x.key === key)) throw new CompileError(`'${nodeText(s.target)}' already implements '${ifaceSym.name}'`, pos);

    const wanted: IfaceMethod[] = A(ifaceNode)._methods ?? [];
    const targetText = nodeText(s.target).replace(/\s+/g, "");
    const arity = (sig: ProcSig) => sig.params.reduce((n, p) => n + Math.max(1, p.names.length), 0);
    const methods = new Map<string, GlobalSym>();
    for (const b of s.bindings) {
      const at = s.toks[b.tok].pos;
      const want = wanted.find((m) => m.name === b.name);
      if (!want) throw new CompileError(`'${b.name}' is not a method of interface '${ifaceSym.name}'`, at);
      if (methods.has(b.name)) throw new CompileError(`'${b.name}' is bound twice`, at);
      const usage = `bind '${b.name}' to a proc declared with a body: ${b.name} = ${targetText.toLowerCase()}_${b.name}`;
      if (b.value.k !== "Ident" && b.value.k !== "Selector") throw new CompileError(usage, posOf(b.value));
      this.expr(b.value, scope);
      const sym = this.resolveName(b.value, scope, null);
      const lit = sym?.kind === "global" && sym.isConst ? sym.decl.values[sym.index] : undefined;
      if (sym?.kind !== "global" || lit?.k !== "ProcLit" || !lit.body || lit.comptime || lit.captures) throw new CompileError(usage, posOf(b.value));
      if (sym.pkg.unit !== pkg.unit) throw new CompileError(`'${nodeText(b.value)}' must be declared in package '${pkg.name}' (or a package in an import cycle with it)`, posOf(b.value));
      if (arity(lit.sig) !== arity(want.lit.sig))
        throw new CompileError(`'${sym.name}' must take ^${nodeText(s.target)} plus ${arity(want.rest)} parameter(s) to implement '${b.name}'`, posOf(b.value));
      const recv = lit.sig.params[0]?.type;
      if (!recv || nodeText(recv).replace(/\s+/g, "") !== `^${targetText}`)
        throw new CompileError(`the first parameter of '${sym.name}' must have type ^${nodeText(s.target)} to implement '${b.name}'`, posOf(b.value));
      methods.set(b.name, sym);
    }
    const missing = wanted.filter((m) => !methods.has(m.name)).map((m) => m.name);
    if (missing.length) throw new CompileError(`impl of '${ifaceSym.name}' for '${nodeText(s.target)}' is missing: ${missing.join(", ")}`, pos);
    const info: ImplInfo = { node: s, iface: ifaceSym, pkg, key, methods };
    this.impls.push(info);
    A(s)._impl = info;
  }

  // ---- error handling: `or_return <value>`, `catch`, `errdefer` ----

  /** `x := f() or_return .Err`: lowered at statement level, so it must be the whole right-hand side. */
  private hostOrReturn(s: Stmt, e: Extract<Expr, { k: "Postfix" }>, scope: Scope): void {
    const top = this.resultStack[this.resultStack.length - 1];
    if (!top) throw new CompileError("'or_return' can only be used inside a procedure", posOf(e));
    const count = top.sig.results.reduce((n, r) => n + Math.max(1, r.names.length), 0);
    if (!count) throw new CompileError("'or_return' needs a procedure that returns an error (or a bool)", posOf(e));
    if (s.k === "ValueDecl" && (s.type || s.isConst)) throw new CompileError("'or_return <value>' needs a plain 'x := f()' declaration (no type annotation)", posOf(e));
    A(e)._hosted = true;
    A(s)._orReturn = { postfix: e, results: count, errVar: `__err${++this.errCounter}` };
    if (s.k === "ExprStmt") A(s)._discard = this.leadingResults(e.x, scope);
  }

  /** How many results a bare call returns before its error (they are discarded); 0 when unknown. */
  private leadingResults(call: Expr, scope: Scope): number {
    const sig = this.callSig(call, scope);
    if (!sig) return 0;
    return Math.max(0, sig.sig.results.reduce((n, r) => n + Math.max(1, r.names.length), 0) - 1);
  }

  /** The name of the enclosing procedure's last (error) result; unnamed results get names for errdefer. */
  private errorResult(s: Extract<Stmt, { k: "ErrDefer" }>): string {
    const top = this.resultStack[this.resultStack.length - 1];
    if (!top || !top.sig.results.length) throw new CompileError("'errdefer' needs a procedure that returns an error (or a bool) as its last result", posOf(s));
    if (!top.sig.resultsUnnamed) {
      const last = top.sig.results[top.sig.results.length - 1];
      return last.names[last.names.length - 1].name;
    }
    A(top.proc)._nameResults = true;
    return "__err";
  }

  /** Statements that never fall through: the end of a catch block must leave the scope. */
  private diverges(s: Stmt | undefined): boolean {
    if (!s) return false;
    switch (s.k) {
      case "Return":
        return true;
      case "Branch":
        return s.op === "break" || s.op === "continue";
      case "Block":
        return this.diverges(s.stmts[s.stmts.length - 1]);
      case "If":
        return !!s.else && this.diverges(s.then) && this.diverges(s.else);
      case "ExprStmt": {
        const x = s.x;
        if (x.k !== "Call") return false;
        const name = x.fn.k === "Ident" ? x.fn.name : x.fn.k === "Selector" ? `${x.fn.x.k === "Ident" ? x.fn.x.name : ""}.${x.fn.name}` : "";
        return ["panic", "unreachable", "os.exit", "log.panic", "log.panicf", "fmt.panicf", "runtime.panic", "runtime.trap", "intrinsics.trap"].includes(name);
      }
    }
    return false;
  }

  private catchStmt(s: Extract<Stmt, { k: "Catch" }>, scope: Scope): void {
    const inner = s.stmt;
    const value = inner.k === "ValueDecl" ? (inner.values.length === 1 ? inner.values[0] : undefined)
      : inner.k === "Assign" ? (inner.rhs.length === 1 && inner.op === "=" ? inner.rhs[0] : undefined)
      : inner.k === "ExprStmt" ? inner.x : undefined;
    if (!value) throw new CompileError("'catch' goes after a call: x := f() catch err { ... }, x = f() catch ..., or f() catch ...", posOf(s));
    if (inner.k === "ValueDecl" && (inner.type || inner.isConst)) throw new CompileError("'catch' needs a plain 'x := f()' declaration (no type annotation)", posOf(s));
    if (!this.resultStack.length) throw new CompileError("'catch' can only be used inside a procedure", posOf(s));
    const errVar = `__err${++this.errCounter}`;
    A(s)._errVar = errVar;
    A(s)._value = value;
    if (inner.k === "ExprStmt") A(inner)._discard = this.leadingResults(value, scope);
    // the declared names take the call's leading results; the error is the extra last one
    this.stmt(inner, scope);
    if (!s.body) return;
    const sig = this.callSig(value, scope);
    const names = inner.k === "ValueDecl" ? inner.names.length : inner.k === "Assign" ? inner.lhs.length : 0;
    const errTy = sig ? this.resultTy(sig, names) : undefined;
    const bodyScope = new Scope(scope);
    if (s.errName) {
      const sym = this.declareLocal(s.errName, bodyScope, { ty: errTy, declTok: s.toks[s.errTok] });
      A(s)._errSym = sym;
    }
    this.stmt(s.body, bodyScope);
    if (inner.k !== "ExprStmt" && !this.diverges(s.body))
      throw new CompileError("a 'catch' block after a declaration or assignment must leave the scope (return, break, continue or panic), or the values would be used unset", posOf(s.body));
  }

  /** On interface values, methods are called as procs: `m(x, ...)`, not `x->m(...)`. */
  private arrowCall(e: Extract<Expr, { k: "ArrowCall" }>, scope: Scope): void {
    const n = this.normalize(this.typeOf(e.x, scope));
    const elem = n?.t === "ptr" ? this.normalize(n.elem) : n;
    if (elem?.t !== "node" || elem.node.k !== "InterfaceType") return;
    const x = nodeText(e.x);
    throw new CompileError(`call interface methods as procs: ${e.name}(${x}${e.args.length ? ", ..." : ""})`, posOf(e));
  }

  // ---- macros ----

  macroSym(call: MacroCall, scope: Scope): { sym: GlobalSym; lit: ProcLit } {
    let sym: Sym | undefined;
    if (call.path.length === 1) sym = this.lookup(call.path[0], scope, call);
    else {
      const p = this.lookup(call.path[0], scope, null);
      if (p?.kind !== "pkg" || !p.target) throw new CompileError(`'${call.path[0]}' is not an imported vidar package`, posOf(call));
      sym = p.target.scope.syms.get(call.path[1]);
      if (!sym) throw new CompileError(`package '${p.name}' has no member '${call.path[1]}'`, posOf(call));
      if (sym.kind === "global" && sym.isPrivate && scope.package !== sym.pkg)
        throw new CompileError(`'${call.path.join(".")}' is private to package '${sym.pkg.name}'`, posOf(call));
      A(call)._partSyms = [p, sym];
    }
    const lit = sym?.kind === "global" ? sym.decl.values[sym.index] : undefined;
    if (!sym || sym.kind !== "global" || !lit || lit.k !== "ProcLit" || !lit.comptime)
      throw new CompileError(`'${call.path.join(".")}' is not a comptime proc`, posOf(call));
    return { sym, lit };
  }

  /** Counts macro expansions that are still being analyzed, so self-expanding macros are caught. */
  private nested(call: MacroCall, f: () => void): void {
    if (++this.depth > MAX_EXPANSION_DEPTH) {
      this.depth--;
      throw new CompileError("macro expansion too deep (recursive macro?)", posOf(call));
    }
    try {
      f();
    } finally {
      this.depth--;
    }
  }

  /** Resolves a macro call and its arguments; `evalValue` evaluates constant arguments (default: in `scope`). */
  macroInvocation(call: MacroCall, scope: Scope, evalValue?: (e: Expr) => Val): { sym: GlobalSym; lit: ProcLit; args: Val[] } {
    const { sym, lit } = this.macroSym(call, scope);
    A(call)._macroSym = sym;
    A(call)._scope = scope;
    const params = lit.sig.params.flatMap((p) => p.names.map((n) => ({ name: n.name, type: p.type!, def: p.value })));
    const given = this.bindMacroArgs(call, params, sym);
    const args = params.map((p, i) => (given[i] ? this.macroArg(p.name, p.type, given[i]!, scope, sym, evalValue) : this.macroDefault(p.name, p.type, p.def!, sym)));
    return { sym, lit, args };
  }

  expandMacro(call: MacroCall, scope: Scope, position: "expr" | "stmt"): Expr | Stmt[] {
    const { sym, lit, args } = this.macroInvocation(call, scope);
    {
      let result: Val;
      this.macroCalls.push(call);
      try {
        result = this.interp.callComptime(sym, lit, args, posOf(call), scope);
      } catch (err) {
        if (err instanceof CompileError) {
          err.message = `in expansion of '${sym.name}!': ${err.message}`;
          err.pos ??= posOf(call);
        }
        throw err;
      } finally {
        this.macroCalls.pop();
      }
      return this.macroResult(result, lit, sym, scope, position, call);
    }
  }

  /** The code a `comptime expr` folds to. */
  private foldComptime(e: ComptimeExpr, scope: Scope): Expr {
    const pos = posOf(e);
    let v: Val;
    try {
      v = this.interp.evalAt(e.x, scope, pos);
    } catch (err) {
      if (err instanceof NotConstant) err.message = `comptime expression cannot be evaluated at compile time: ${err.message}`;
      else if (err instanceof CompileError) err.message = `in comptime expression: ${err.message}`;
      throw err;
    }
    if (v.k === "proc") throw new CompileError("comptime expression produced a proc, which is already a constant: drop 'comptime'", pos);
    const toks = respace(this.comptimeTokens(v, pos), this.callSpan(e));
    return this.parseTokens([...toks, eofTok(pos)], (p) => p.parseExpr());
  }

  private comptimeTokens(v: Val, pos: Pos): Token[] {
    const brace = (inner: Token[]): Token[] => [{ kind: "op", text: "{", pre: "", pos }, ...inner, { kind: "op", text: "}", pre: "", pos }];
    switch (v.k) {
      case "void":
        throw new CompileError("comptime expression has no value", pos);
      case "stmts":
        throw new CompileError("comptime expression produced statements, not an expression", pos);
      case "array":
        return brace(v.items.flatMap((x, i) => [...(i ? [{ kind: "op" as const, text: ",", pre: "", pos }] : []), ...this.comptimeTokens(x, pos)]));
      case "struct":
        return brace(
          [...v.fields].flatMap(([name, x], i) => [
            ...(i ? [{ kind: "op" as const, text: ",", pre: "", pos }] : []),
            { kind: "ident" as const, text: name, pre: " ", pos },
            { kind: "op" as const, text: "=", pre: " ", pos },
            ...this.comptimeTokens(x, pos),
          ]),
        );
    }
    return valueToTokens(v, pos, "expr");
  }

  private callSpan(call: MacroCall | ComptimeExpr): CallSpan {
    return { file: posOf(call).file, from: posOf(call).line, to: call.toks[call.end - 1].pos.line };
  }

  private paramKind(t: Expr): { kind: "Expr" | "Stmt" | "Type" | "Ident" | "value"; of?: Expr } {
    if (t.k === "Ident" && ["Expr", "Stmt", "Type", "Ident"].includes(t.name)) return { kind: t.name as "Expr" };
    if (t.k === "Call" && t.fn.k === "Ident" && t.fn.name === "Expr" && t.args.length === 1) return { kind: "Expr", of: t.args[0] };
    return { kind: "value" };
  }

  private parseTokens<T>(toks: Token[], f: (p: Parser) => T): T {
    const p = new Parser(toks);
    const out = f(p);
    p.expectEnd();
    return out;
  }

  /**
   * Matches call arguments to parameters: arguments fill parameters left to right, a trailing
   * block (`name!(...) { ... }`) always goes to the last parameter, and anything left over must
   * have a default.
   */
  private bindMacroArgs(call: MacroCall, params: { name: string; def?: Expr }[], sym: GlobalSym): (Token[] | undefined)[] {
    const given: (Token[] | undefined)[] = params.map(() => undefined);
    const positional = call.blockArg ? call.args.slice(0, -1) : call.args;
    const lastFree = call.blockArg ? params.length - 1 : params.length;
    const required = params.filter((p) => !p.def).length;
    if (positional.length > lastFree || (call.blockArg && !params.length))
      throw new CompileError(`macro '${sym.name}' expects ${required === params.length ? "" : "at most "}${params.length} argument(s) but got ${call.args.length}`, posOf(call));
    positional.forEach((a, i) => (given[i] = a));
    if (call.blockArg) given[params.length - 1] = call.args[call.args.length - 1];
    params.forEach((p, i) => {
      if (!given[i] && !p.def)
        throw new CompileError(`macro '${sym.name}' expects ${required === params.length ? "" : "at least "}${required} argument(s) but got ${call.args.length} (missing '${p.name}')`, posOf(call));
    });
    return given;
  }

  /** A parameter's default: for code parameters it's code (not evaluated), otherwise a compile-time value. */
  private macroDefault(name: string, type: Expr, def: Expr, macro: GlobalSym): Val {
    const { kind } = this.paramKind(type);
    const toks = def.toks.slice(def.start, def.end);
    if (kind === "Expr") return { k: "expr", toks, node: def, scope: macro.scope };
    if (kind === "Stmt") return { k: "stmts", toks };
    if (kind === "Type") return { k: "type", toks, node: def, scope: macro.scope };
    if (kind === "Ident") return { k: "ident", name: toks[0]?.text ?? name };
    return this.interp.evalIn(def, macro.scope);
  }

  private macroArg(name: string, type: Expr, toks: Token[], scope: Scope, macro: GlobalSym, evalValue?: (e: Expr) => Val): Val {
    const pos = toks[0].pos;
    const { kind, of } = this.paramKind(type);
    switch (kind) {
      case "Expr": {
        const node = this.parseTokens(toks, (p) => p.parseExpr());
        const ty = this.typeOf(node, scope);
        if (of) this.checkTyped(node, ty, { t: "node", node: of, scope: macro.scope }, scope, `argument '${name}'`, pos);
        return { k: "expr", toks: toks.slice(0, -1), node, ty, scope };
      }
      case "Stmt":
        return { k: "stmts", toks: toks.slice(0, -1) };
      case "Type": {
        const node = this.parseTokens(toks, (p) => p.parseType());
        return { k: "type", toks: toks.slice(0, -1), node, scope };
      }
      case "Ident":
        if (toks.length !== 2 || toks[0].kind !== "ident") throw new CompileError(`argument '${name}' must be an identifier`, pos);
        return { k: "ident", name: toks[0].text };
      case "value": {
        const node = this.parseTokens(toks, (p) => p.parseExpr());
        try {
          return evalValue ? evalValue(node) : this.interp.evalIn(node, scope);
        } catch (err) {
          if (err instanceof CompileError) err.message = `argument '${name}' of '${macro.name}!' must be a compile-time constant: ${err.message}`;
          throw err;
        }
      }
    }
  }

  /** Typed macro check: decided here when the types are known, otherwise emitted as an Odin compile-time check. */
  private checkTyped(node: Expr, ty: Ty | undefined, want: Ty, scope: Scope, what: string, pos: Pos): void {
    const ok = this.compatible(ty, want);
    if (ok === false || (ok === undefined && this.typeName(ty) && this.typeName(want) && this.normalize(ty)?.t !== "untyped" && this.isBasic(want))) {
      throw new CompileError(`${what} has type ${this.typeName(ty)} but the macro expects ${this.typeName(want)}`, pos);
    }
    if (ok) return;
    const owner = this.stmtStack[this.stmtStack.length - 1];
    if (!owner || !scope.ctx || want.t !== "node") return;
    const toks = [
      ...tokensOf("if false { __macro_typecheck :", pos), ...want.node.toks.slice(want.node.start, want.node.end).map((t) => ({ ...t, pre: " " })),
      ...tokensOf("= (", pos), ...node.toks.slice(node.start, node.end).map((t) => ({ ...t, pre: " ", text: t.kind === "semi" ? ";" : t.text })),
      ...tokensOf(") ; _ = __macro_typecheck }", pos), { kind: "eof" as const, text: "", pre: "", pos },
    ];
    const check = this.parseTokens([...respace(toks.slice(0, -1)), toks[toks.length - 1]], (p) => p.parseStmt());
    this.stmt(check, scope);
    (A(owner)._pre ??= []).push(check);
  }

  /** Declares `name := <toks>` just before the statement being analyzed; the result names it. */
  hoist(toks: Token[], scope: Scope | undefined, pos: Pos, name: string): Val {
    const owner = this.hoistTarget(scope, pos, `'${joinTokens(toks)}' must be evaluated once here; assign it to a variable first`);
    const decl = this.parseTokens([...respace([...tokensOf(`${name} :=`, pos), ...toks]), eofTok(pos)], (p) => p.parseStmt());
    this.stmt(decl, scope!);
    (A(owner)._pre ??= []).push(decl);
    return identVal(name, pos);
  }

  /** The statement code can be hoisted in front of; anywhere else, that could change when (or whether) it runs. */
  private hoistTarget(scope: Scope | undefined, pos: Pos, message: string): Node {
    const owner = this.stmtStack[this.stmtStack.length - 1];
    if (!owner || !scope?.ctx || !["ValueDecl", "Assign", "ExprStmt", "Return"].includes(owner.k)) throw new CompileError(message, pos);
    return owner;
  }

  /**
   * `do! { ...; return v }`: the block runs just before the current statement, as a labeled block
   * where each `return v` stores `v` and leaves it; the result names the stored value.
   */
  blockValue(type: Token[] | undefined, body: Token[], scope: Scope | undefined, pos: Pos, id: number): Val {
    const owner = this.hoistTarget(scope, pos, "do! can only be used in a declaration, an assignment, an expression statement or a return");
    const label = `__do${id}`;
    const result = `__do${id}_result`;
    const block = this.parseTokens([...body, eofTok(pos)], (p) => p.parseBlock());
    const returns: Extract<Stmt, { k: "Return" }>[] = [];
    const findReturns = (n: Node) => {
      if (n.k === "ProcLit") return;
      if (n.k === "Return") returns.push(n);
      children(n).forEach(findReturns);
    };
    block.stmts.forEach(findReturns);
    if (!returns.length) throw new CompileError("do!: the block needs a 'return value'", pos);
    for (const r of returns) if (r.results.length !== 1) throw new CompileError("do!: 'return' takes exactly one value", posOf(r));

    const snippet = (src: string, at: Pos, pre: string) => respace(tokensOf(src, at).filter((t) => t.kind !== "semi" || t.text === ";")).map((t, j) => (j ? t : { ...t, pre }));
    const toks: Token[] = snippet(`${label}:`, pos, "");
    let i = block.start;
    for (const r of returns) {
      const ret = r.toks[r.start];
      const before = block.toks.slice(i, r.start);
      // Odin rejects `do { ... }`
      const viaDo = before[before.length - 1]?.kind === "kw" && before[before.length - 1].text === "do";
      if (viaDo) before.pop();
      toks.push(...before, ...snippet(`{ ${result} =`, ret.pos, viaDo ? " " : ret.pre), ...slice(r.results[0]), ...snippet(`; break ${label} }`, ret.pos, ""));
      i = r.end;
    }
    const close = block.end - 1;
    toks.push(...block.toks.slice(i, close));
    const end = block.toks[close];
    const fellOff = block.stmts[block.stmts.length - 1]?.k !== "Return";
    // on the closing brace's line, so a panic points there
    if (fellOff) toks.push(...snippet("; __vidar.do_fell_off()", end.pos, end.pre));
    toks.push(fellOff ? { ...end, pre: " " } : end);
    const labeled = this.parseTokens([...toks, eofTok(pos)], (p) => p.parseStmt());

    const sym = this.declareLocal(result, scope!, {});
    this.stmt(labeled, scope!);
    const typeText = type ? joinTokens(type) : this.blockResultType(labeled, result, scope!, pos);
    const decl = this.parseTokens([...respace(tokensOf(`${result}: ${typeText}`, pos)), eofTok(pos)], (p) => p.parseStmt());
    this.stmt(decl, scope!);
    sym.ty = (A(decl)._syms as LocalSym[])[0].ty;
    (A(owner)._pre ??= []).push(decl, labeled);
    // the block already takes up the call's lines
    const call = this.macroCalls[this.macroCalls.length - 1];
    if (call) A(call)._linesHoisted = true;
    return identVal(result, pos);
  }

  /** The type of the values a `do!` block stores in `result`: the first typed one, else the default type of the untyped ones. */
  private blockResultType(labeled: Stmt, result: string, scope: Scope, pos: Pos): string {
    const types: Ty[] = [];
    const visit = (n: Node, sc: Scope) => {
      if (n.k === "ProcLit") return;
      if (n.k === "Block" && A(n)._scope) sc = A(n)._scope;
      if (n.k === "Assign" && n.lhs[0]?.k === "Ident" && n.lhs[0].name === result) {
        const ty = this.typeOf(n.rhs[0], sc);
        if (ty) types.push(ty);
      }
      children(n).forEach((c) => visit(c, sc));
    };
    visit(labeled, scope);
    const typed = types.find((t) => this.normalize(t)?.t !== "untyped");
    const cannot = () => new CompileError("do!: cannot infer the type of the result; give it as do!(T) { ... }", pos);
    if (typed) {
      if (typed.t === "node" && typed.scope.package !== scope.package) throw cannot();
      return this.typeName(typed) ?? (() => { throw cannot(); })();
    }
    const kinds = types.map((t) => this.normalize(t)).map((t) => (t?.t === "untyped" ? t.kind : ""));
    const kind = kinds.includes("float") ? "float" : kinds[0];
    const name = ({ int: "int", float: "f64", string: "string", rune: "rune", bool: "bool" } as Record<string, string>)[kind];
    if (!name) throw cannot();
    return name;
  }

  private isBasic(ty: Ty): boolean {
    const name = this.typeName(ty);
    return !!name && (INT_TYPES.has(name) || FLOAT_TYPES.has(name) || ["string", "bool", "rune", "cstring"].includes(name));
  }

  private macroResult(v: Val, lit: ProcLit, sym: GlobalSym, scope: Scope, position: "expr" | "stmt", call: MacroCall): Expr | Stmt[] {
    const where = `macro '${sym.name}!'`;
    const pos = posOf(call);
    const ret = lit.sig.results[0]?.type;
    if (!ret) {
      if (position !== "stmt") throw new CompileError(`${where} returns nothing and can only be used as a statement`, pos);
      return [];
    }
    const { kind, of } = this.paramKind(ret);
    if (kind === "Stmt") {
      if (position !== "stmt") throw new CompileError(`${where} returns Stmt and can only be used as a statement`, pos);
      const toks = respace(valueToTokens(v, pos, "stmt"), this.callSpan(call));
      return this.parseTokens([...toks, eofTok(pos)], (p) => p.parseStmtList());
    }
    if (kind === "Type" || kind === "Ident") throw new CompileError(`${where}: macros cannot return ${kind}`, pos);
    const toks = respace(valueToTokens(v, pos, "expr"), this.callSpan(call));
    const node = this.parseTokens([...toks, eofTok(pos)], (p) => p.parseExpr());
    if (of) this.checkTyped(node, this.typeOf(node, scope), { t: "node", node: of, scope: sym.scope }, scope, `result of ${where}`, pos);
    return node;
  }
}

export function eofTok(pos: Pos): Token {
  return { kind: "eof", text: "", pre: "", pos };
}

function identVal(name: string, pos: Pos): Val {
  return { k: "expr", toks: tokensOf(name, pos).filter((t) => t.kind !== "semi") };
}

function slice(n: { toks: Token[]; start: number; end: number }): Token[] {
  return n.toks.slice(n.start, n.end);
}

function synthIdent(name: string, pos: Pos): Expr {
  return { k: "Ident", name, toks: [{ kind: "ident", text: name, pre: "", pos }], start: 0, end: 1 };
}

const STMT_KINDS = new Set(["Catch", "ErrDefer", "ImplBlock", "Block", "ValueDecl", "Assign", "ExprStmt", "If", "When", "For", "RangeFor", "Switch", "Return", "Branch", "Defer", "Using", "Labeled", "DirectiveStmt", "Package", "Import", "RawStmt", "Empty"]);

export function isStmt(n: Node): boolean {
  return STMT_KINDS.has(n.k);
}

export function isTypeExpr(e: Expr): boolean {
  return ["StructType", "UnionType", "EnumType", "TypeExpr", "ProcType", "ClosureType", "InterfaceType", "Poly"].includes(e.k)
    || (e.k === "Unary" && e.op === "^" && isTypeExpr(e.x))
    || (e.k === "Paren" && isTypeExpr(e.x));
}
