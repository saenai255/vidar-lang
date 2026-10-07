import type { Token } from "./lexer";
import { Expr, Node, Param, Stmt, children } from "./ast";
import { A, Analyzer } from "./analyzer";
import type { Program } from "./project";
import type { Scope, Sym, Ty } from "./scope";

/**
 * Field and enum-member uses, for the language server: `x.field` (through pointers, `using` fields and
 * `#soa` containers), `Enum.Member`, field names in typed literals, and `.Member` where the expected type
 * is known (declarations, assignments, comparisons, `case`, call arguments, returns, literal elements,
 * indexes of enumerated arrays). Built on the analyzer's type inference after a program is analyzed;
 * the compiler never runs it, so generated code can't depend on it.
 *
 * Each resolved node gets `_member` (a `Member`); a use whose receiver or expected type vidar couldn't
 * infer goes in `MemberInfo.misses`, so a rename can refuse instead of missing it.
 */

type StructType = Extract<Expr, { k: "StructType" }>;
type EnumType = Extract<Expr, { k: "EnumType" }>;
type ProcLit = Extract<Expr, { k: "ProcLit" }>;

export interface Member {
  kind: "field" | "enumMember";
  /** the struct or enum declaring it */
  owner: StructType | EnumType;
  name: string;
  /** the name's token in the declaration */
  tok: Token;
  /** the field's type, as written */
  type?: Expr;
  /** index into the enum's members */
  index?: number;
}

export interface MemberMiss {
  kind: "field" | "enumMember";
  name: string;
  tok: Token;
  why: string;
}

export interface MemberInfo {
  misses: MemberMiss[];
}

const canonical = new WeakMap<Node, Map<string, Member>>();

/** The one `Member` object for `name` in `owner`, so uses compare by identity. */
export function memberOf(owner: StructType | EnumType, name: string): Member | undefined {
  let byName = canonical.get(owner);
  if (!byName) {
    byName = new Map();
    canonical.set(owner, byName);
    if (owner.k === "StructType") {
      for (const f of owner.fields) for (const n of f.names) if (!byName.has(n.name)) byName.set(n.name, { kind: "field", owner, name: n.name, tok: owner.toks[n.tok], type: f.type });
    } else {
      owner.members.forEach((m, index) => byName!.set(m.name, { kind: "enumMember", owner, name: m.name, tok: owner.toks[m.tok], index }));
    }
  }
  return byName.get(name);
}

/** Every field or member an owner declares. */
export function membersOf(owner: StructType | EnumType): Member[] {
  const names = owner.k === "StructType" ? owner.fields.flatMap((f) => f.names.map((n) => n.name)) : owner.members.map((m) => m.name);
  return names.map((n) => memberOf(owner, n)!).filter((m, i, all) => all.indexOf(m) === i);
}

const done = new WeakMap<Program, MemberInfo>();

/** Resolves every member use in the program once; later calls return the same result. */
export function resolveMembers(p: Program): MemberInfo {
  let info = done.get(p);
  if (!info) {
    info = new Resolver(p.analyzer).run(p.packages.flatMap((x) => x.files.flatMap((f) => f.stmts)));
    done.set(p, info);
  }
  return info;
}

const COMPARE = new Set(["==", "!=", "<", ">", "<=", ">="]);

class Resolver {
  private misses: MemberMiss[] = [];
  private procs: ProcLit[] = [];
  /** procs in which a `using` makes fields plain names */
  private usingProcs = new Set<ProcLit | null>();
  /** a type switch variable's type in the current `case` */
  private caseTypes = new Map<Sym, Ty>();
  /** types of untyped locals the analyzer couldn't infer and this pass can (`err := Error.None`) */
  private inferred = new Map<Sym, Ty>();
  private seen = new WeakSet<Node>();

  constructor(private an: Analyzer) {}

  run(stmts: Stmt[]): MemberInfo {
    for (const s of stmts) this.visit(s);
    return { misses: this.misses };
  }

  private miss(kind: MemberMiss["kind"], name: string, tok: Token | undefined, why: string): void {
    if (tok) this.misses.push({ kind, name, tok, why });
  }

  private get proc(): ProcLit | null {
    return this.procs[this.procs.length - 1] ?? null;
  }

  // ---- types ----

  private normalize(ty: Ty | undefined): Ty | undefined {
    try {
      return this.an.normalize(ty);
    } catch {
      return undefined;
    }
  }

  /** The struct or enum behind a type: through aliases, pointers and parametric instances (`Box(int)`). */
  private shapeIn(ty: Ty | undefined, depth = 0): { node: StructType | EnumType; scope: Scope } | undefined {
    let n = this.normalize(ty);
    if (n?.t === "ptr") n = this.normalize(n.elem);
    if (n?.t !== "node" || depth > 8) return undefined;
    const node = n.node;
    if (node.k === "StructType" || node.k === "EnumType") return { node, scope: n.scope };
    if (node.k === "Call") return this.shapeIn({ t: "node", node: node.fn, scope: n.scope }, depth + 1);
    return undefined;
  }

  private shape(ty: Ty | undefined): StructType | EnumType | undefined {
    return this.shapeIn(ty)?.node;
  }

  /** Whether vidar can't see what a type is (unknown, or a `$T`), so a field on it might be any struct's. */
  private opaque(ty: Ty | undefined): boolean {
    let n = this.normalize(ty);
    if (n?.t === "ptr") n = this.normalize(n.elem);
    if (!n) return true;
    if (n.t !== "node") return false;
    if (n.node.k === "Poly") return true;
    if (n.node.k === "Ident") {
      const sym = this.an.lookup(n.node.name, n.scope, null);
      return sym?.kind === "local" || sym?.kind === "capture";
    }
    return false;
  }

  /** A field by name, also through `using` fields; the struct must be a declared (not anonymous) one. */
  private field(ty: Ty | undefined, name: string, depth = 0): { member?: Member; ty?: Ty } {
    const found = this.shapeIn(ty);
    const s = found?.node;
    if (s?.k !== "StructType" || depth > 8 || A(s)._anonFields) return {};
    const scope = found!.scope;
    const own = memberOf(s, name);
    if (own) return { member: own, ty: own.type && { t: "node", node: own.type, scope } };
    for (const f of s.fields) {
      if (!f.type || !f.names.some((x) => x.prefix?.includes("using"))) continue;
      const inner = this.field({ t: "node", node: f.type, scope }, name, depth + 1);
      if (inner.member) return inner;
    }
    return {};
  }

  /** The element type of a container, also of `#soa` ones and bit sets. */
  private elem(ty: Ty | undefined): Ty | undefined {
    let n = this.normalize(ty);
    if (n?.t === "ptr") n = this.normalize(n.elem);
    if (n?.t === "node" && n.node.k === "Directive" && n.node.x) return this.elem({ t: "node", node: n.node.x, scope: n.scope });
    if (n?.t === "node" && n.node.k === "TypeExpr" && n.node.what === "bit_set" && n.node.parts[0]) return { t: "node", node: n.node.parts[0], scope: n.scope };
    try {
      return n && this.an.elemOf(n);
    } catch {
      return undefined;
    }
  }

  /** The analyzer's type of `e`, plus what this pass knows better: fields through `using`, `#soa`, `case` types. */
  private typeOf(e: Expr): Ty | undefined {
    const scope = A(e)._scope;
    switch (e.k) {
      case "Paren":
        return this.typeOf(e.x);
      case "Ternary":
        return this.typeOf(e.a) ?? this.typeOf(e.b);
      case "Ident": {
        let sym: Sym | undefined = A(e)._sym;
        if (sym && this.caseTypes.has(sym)) return this.caseTypes.get(sym);
        while (sym?.kind === "capture") sym = sym.target;
        if (sym && this.inferred.has(sym)) return this.inferred.get(sym);
        // ODIN_OS, ODIN_ARCH, ...: Odin's enums, never one of ours
        if (!sym && scope && /^ODIN_/.test(e.name)) return { t: "node", node: e, scope };
        break;
      }
      case "Selector":
        if (this.enumHead(e)) return { t: "node", node: e.x, scope };
        // `context.allocator`, `os.args`: Odin's types, never one of ours (stands for itself, an unresolved type)
        if (scope && this.odinRooted(e)) return { t: "node", node: e, scope };
        if (!A(e)._pkgMember) {
          const recv = this.typeOf(e.x);
          const f = recv && this.field(recv, e.name);
          if (f?.member) return f.ty;
        }
        break;
      case "Index":
        if (!e.slice) {
          const t = this.typeOf(e.x);
          const el = t && this.elem(t);
          if (el) return el;
        }
        break;
      case "Deref": {
        const t = this.normalize(this.typeOf(e.x));
        if (t?.t === "ptr") return t.elem;
        break;
      }
    }
    if (!scope) return undefined;
    try {
      return this.an.typeOf(e, scope);
    } catch {
      return undefined;
    }
  }

  // ---- uses ----

  private visit(n: Node): void {
    if (this.seen.has(n)) return;
    this.seen.add(n);
    const a = A(n);
    for (const p of (a._pre as Stmt[] | undefined) ?? []) this.visit(p);
    switch (n.k) {
      case "ProcLit":
        if (n.comptime) return this.unanalyzed(n);
        this.procs.push(n);
        if ([...n.sig.params, ...n.sig.results].some((p) => p.names.some((x) => x.prefix?.includes("using")))) this.usingProcs.add(n);
        try {
          this.kids(n);
        } finally {
          this.procs.pop();
        }
        return;
      case "Using":
        this.usingProcs.add(this.proc);
        break;
      case "Ident":
        if (!a._sym && a._scope && this.usingProcs.has(this.proc)) this.miss("field", n.name, n.toks[n.start], "a `using` in the proc may make it a field");
        break;
      case "Selector":
        this.selector(n);
        break;
      case "ImplicitSelector":
        if (!a._member && !a._expected) this.miss("enumMember", n.name, n.toks[n.end - 1], "the type it is used as isn't known to vidar");
        break;
      case "CompoundLit":
        if (n.type && A(n.type)._scope) this.literal(n, { t: "node", node: n.type, scope: A(n.type)._scope });
        break;
      case "ValueDecl":
        if (n.type && A(n.type)._scope) for (const v of n.values) this.expect(v, { t: "node", node: n.type, scope: A(n.type)._scope });
        if (!n.type && n.values.length === n.names.length) {
          (a._syms as Sym[] | undefined)?.forEach((s, i) => {
            const t = s.kind === "local" && !s.ty ? this.typeOf(n.values[i]) : undefined;
            if (t) this.inferred.set(s, t);
          });
        }
        break;
      case "Ternary":
        this.expect(n.a, this.typeOf(n.b));
        this.expect(n.b, this.typeOf(n.a));
        break;
      case "Postfix": {
        // `or_return .Err`: the proc's last result
        const p = this.proc;
        const scope = n.value && A(n.value)._scope;
        const count = p ? p.sig.results.reduce((c, r) => c + Math.max(1, r.names.length), 0) : 0;
        if (p && scope && count) this.expect(n.value, this.an.resultTy({ t: "sig", closure: false, sig: p.sig, scope }, count - 1));
        break;
      }
      case "Assign":
        n.rhs.forEach((r, i) => {
          if (n.lhs.length === n.rhs.length) this.expect(r, this.typeOf(n.lhs[i]));
        });
        break;
      case "Binary":
        if (COMPARE.has(n.op)) {
          this.expect(n.y, this.typeOf(n.x));
          this.expect(n.x, this.typeOf(n.y));
        } else if (n.op === "in" || n.op === "not_in") {
          const set = this.typeOf(n.y);
          this.expect(n.x, set && this.elem(set));
        }
        break;
      case "Index": {
        // [Color]T: an enumerated array
        const t = this.normalize(this.typeOf(n.x));
        const key = t?.t === "node" && t.node.k === "TypeExpr" && t.node.what === "array" ? t.node.parts[0] : undefined;
        if (key && t?.t === "node") for (const i of n.indices) if (i) this.expect(i, { t: "node", node: key, scope: t.scope });
        break;
      }
      case "Switch":
        return this.switchStmt(n);
      case "Return": {
        const p = this.proc;
        const scope = n.results.map((r) => A(r)._scope).find(Boolean);
        if (p && scope) n.results.forEach((r, i) => this.expect(r, this.an.resultTy({ t: "sig", closure: false, sig: p.sig, scope }, i)));
        break;
      }
      case "Call":
        this.call(n);
        break;
      case "MacroCall":
        if (a._expansion) this.visit(a._expansion);
        return;
      case "ExprStmt":
        if (a._expansion) {
          this.visit(a._expansion);
          return;
        }
        break;
    }
    this.kids(n);
  }

  private kids(n: Node): void {
    for (const c of children(n)) {
      try {
        this.visit(c);
      } catch {
        // a use the analyzer couldn't type: skip it
      }
    }
  }

  private selector(n: Extract<Expr, { k: "Selector" }>): void {
    const a = A(n);
    if (a._pkgMember || !a._scope) return;
    const nameTok = n.toks[n.end - 1];
    // `Enum.Member`
    const head = this.enumHead(n);
    if (head) {
      const m = memberOf(head, n.name);
      if (m) a._member = m;
      return;
    }
    if (this.odinRooted(n) || (n.x.k === "Ident" && A(n.x)._sym?.kind === "pkg")) return;
    const recv = this.typeOf(n.x);
    const f = this.field(recv, n.name);
    if (f.member) a._member = f.member;
    else if (this.opaque(recv)) this.miss("field", n.name, nameTok, `the type of \`${textOf(n.x)}\` isn't known to vidar`);
  }

  /** `context.a.b` or `pkg.a.b` of an Odin package: no calls or indexes on the way. */
  private odinRooted(e: Expr): boolean {
    let x = e;
    while (x.k === "Selector") x = x.x;
    if (x.k !== "Ident" || x === e) return false;
    const sym: Sym | undefined = A(x)._sym;
    return (x.name === "context" && !sym) || (sym?.kind === "pkg" && !sym.target);
  }

  /** The enum `x` names in `x.Member`. */
  private enumHead(n: Extract<Expr, { k: "Selector" }>): EnumType | undefined {
    const scope = A(n)._scope ?? A(n.x)._scope;
    if (A(n)._pkgMember || !scope || (n.x.k !== "Ident" && n.x.k !== "Selector") || this.isValue(n.x)) return undefined;
    const head = this.shape({ t: "node", node: n.x, scope });
    return head?.k === "EnumType" ? head : undefined;
  }

  /** Whether a name denotes a variable rather than a type. */
  private isValue(e: Expr): boolean {
    const sym: Sym | undefined = A(e)._sym ?? A(e)._pkgMember;
    if (!sym) return false;
    if (sym.kind === "local" || sym.kind === "capture") return !(sym.kind === "local" && sym.isConst);
    return sym.kind === "global" && !sym.isConst;
  }

  /** `e` is used where a value of type `ty` is wanted. */
  private expect(e: Expr | null | undefined, ty: Ty | undefined): void {
    if (!e || !ty) return;
    switch (e.k) {
      case "Paren":
        return this.expect(e.x, ty);
      case "Ternary":
        this.expect(e.a, ty);
        return this.expect(e.b, ty);
      case "ImplicitSelector": {
        A(e)._expected = true;
        const s = this.shape(ty);
        if (s?.k === "EnumType") {
          const m = memberOf(s, e.name);
          if (m) A(e)._member = m;
        } else if (this.opaque(ty)) A(e)._expected = false;
        return;
      }
      case "CompoundLit":
        if (!e.type) this.literal(e, ty);
        return;
      case "Binary":
        // bit set operations: `{.A} | {.B}`
        if (["|", "&", "~", "-", "+"].includes(e.op)) {
          this.expect(e.x, ty);
          this.expect(e.y, ty);
        }
    }
  }

  /** Field names and element values of a literal of type `ty`. */
  private literal(lit: Extract<Expr, { k: "CompoundLit" }>, ty: Ty): void {
    const s = this.shape(ty);
    if (s?.k === "StructType" && !A(s)._anonFields) {
      const fields = s.fields.flatMap((f) => (f.names.length ? f.names.map((n) => n.name) : []));
      lit.elems.forEach((el, i) => {
        if (el.k === "FieldValue") {
          const f = this.field(ty, el.name);
          if (f.member) A(el)._member = f.member;
          this.expect(el.value, f.ty);
        } else if (fields[i]) this.expect(el, this.field(ty, fields[i]).ty);
      });
      return;
    }
    const elem = this.elem(ty);
    const n = this.normalize(ty);
    const key = n?.t === "node" && n.node.k === "TypeExpr" && n.node.what === "array" && n.node.parts[0] ? { t: "node" as const, node: n.node.parts[0], scope: n.scope } : undefined;
    for (const el of lit.elems) {
      if (el.k === "FieldValue") this.expect(el.value, elem);
      else if (el.k === "Binary" && el.op === "=" && key) {
        this.expect(el.x, key);
        this.expect(el.y, elem);
      } else this.expect(el, elem);
    }
  }

  private switchStmt(n: Extract<Stmt, { k: "Switch" }>): void {
    if (n.init) this.visit(n.init);
    if (n.tag) this.visit(n.tag);
    const tagTy = n.tag && !n.typeSwitchVar ? this.typeOf(n.tag) : undefined;
    const sym: Sym | undefined = A(n)._switchSym;
    for (const c of n.cases) {
      if (tagTy) for (const e of c.exprs) this.expect(e, tagTy);
      for (const e of c.exprs) this.visit(e);
      const scope = c.exprs.map((e) => A(e)._scope).find(Boolean);
      if (sym && c.exprs.length === 1 && scope) this.caseTypes.set(sym, { t: "node", node: c.exprs[0], scope });
      try {
        for (const b of c.body) this.visit(b);
      } finally {
        if (sym) this.caseTypes.delete(sym);
      }
    }
  }

  private call(n: Extract<Expr, { k: "Call" }>): void {
    const ft = this.normalize(this.typeOf(n.fn));
    if (ft?.t !== "sig") return;
    const params: { name?: string; ty?: Ty }[] = [];
    const typeOfParam = (p: Param): Ty | undefined => {
      if (p.type) return { t: "node", node: p.type.k === "Spread" ? p.type.x : p.type, scope: ft.scope };
      const scope = p.value && A(p.value)._scope;
      return p.value && scope ? this.an.typeOf(p.value, scope) : undefined;
    };
    for (const p of ft.sig.params) {
      const ty = typeOfParam(p);
      if (p.names.length) for (const nm of p.names) params.push({ name: nm.name, ty });
      else params.push({ ty });
    }
    const last = ft.sig.params[ft.sig.params.length - 1];
    const variadic = last?.type?.k === "Spread" ? typeOfParam(last) : undefined;
    n.args.forEach((arg, i) => {
      if (arg.k === "FieldValue") this.expect(arg.value, params.find((p) => p.name === arg.name)?.ty);
      else this.expect(arg, params[i]?.ty ?? (i >= params.length - 1 ? variadic : undefined));
    });
  }

  /** Code the analyzer doesn't analyze (comptime procs): every `.name` there could be any member. */
  private unanalyzed(n: Node): void {
    const toks = n.toks.slice(n.start, n.end);
    const scope: Scope | undefined = A(n)._scope ?? this.an.fileScopeAt(n);
    toks.forEach((t, i) => {
      if (t.kind !== "ident" || toks[i - 1]?.text !== ".") return;
      const owner = toks[i - 2];
      // `fmt.name`: a package member
      if (owner?.kind === "ident" && scope && toks[i - 3]?.text !== "." && this.an.lookup(owner.text, scope, null)?.kind === "pkg") return;
      this.miss("field", t.text, t, "it is in a comptime proc, which vidar doesn't type");
      this.miss("enumMember", t.text, t, "it is in a comptime proc, which vidar doesn't type");
    });
  }
}

function textOf(e: Expr): string {
  return e.toks.slice(e.start, e.end).map((t, i) => (i ? t.pre.replace(/\s+/g, " ") : "") + t.text).join("").trim();
}
