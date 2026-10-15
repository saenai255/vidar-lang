import { Block, Expr, Node, Stmt, children } from "./ast";
import { A, Analyzer, isStmt, matchType, nodeText, posOf } from "./analyzer";
import { closureEscape } from "./escape";
import { CompileError, ErrorFix, Token } from "./lexer";
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
  /** impl Clone's proc */
  clone?: GlobalSym;
  fields: { name: string; how: How; ty: Ty }[];
  /** a copy calls a clone: impl Clone, or (without impl Destroy) every field that needs it can be cloned */
  cloneable: boolean;
  /** what a moved-from local is set to: `{}` for a struct, `nil` for a union */
  zero: "{}" | "nil";
  /** impl Destroy for Box($T): the procs are generic, and so is `__Box_destroy` */
  generic: boolean;
}

/**
 * An ownership decision the editor shows as an inlay hint: a local destroyed at the end of its scope
 * (`drop`, merged per position), a copy that moves or clones, an old value destroyed on assignment,
 * or one of core's procs replaced by one that destroys what it drops.
 */
export interface OwnershipNote {
  kind: "drop" | "move" | "clone" | "drops-old" | "destroys";
  /** the hint goes before or after this token */
  tok: Token;
  side: "before" | "after";
  label: string;
  tooltip: string;
}

/** `impl Clone for T`, before it is checked against T's destructor. */
export interface CloneImpl {
  proc: GlobalSym;
  at: Token["pos"];
}

/** A call to a destructor, or `__vidar.destroy`, which finds out at run time (vidar_runtime/destroy.odin). */
export type How = { k: "call"; dtor: Destructor } | { k: "dispatch" };

/** What destroying a value of some type takes, and the type's name for messages. */
interface Owned {
  how: How;
  /** a copy is a clone (impl Clone), not an error */
  clone: boolean;
  name: string;
  /** `which has impl Destroy`, or `which holds a value with impl Destroy` */
  why: string;
}

/** A local (or #owned parameter) that gets `defer ...(&name)` after its declaration. */
export interface DestroyDecl {
  sym: LocalSym;
  name: Token;
  how: How;
  /** `v, ok := m[k]` or `v, ok := u.(T)`: v is a copy, made a clone right after */
  clone?: How;
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

/** The name code calls to clone a value of `d`'s type (when it is cloneable). */
export function cloneName(d: Destructor): { owner: GlobalSym; name: string } {
  return d.clone ? { owner: d.clone, name: d.clone.odinName } : { owner: d.type, name: `__${d.type.odinName}_clone` };
}

/**
 * `impl Destroy for T` and `impl Clone for T` when no `Destroy` (or `Clone`) is in scope: the built-in
 * ones. They are resolved here instead of as interfaces, so they may live in any package (the type's
 * own), and nothing is dispatched.
 */
export function resolveDestroyImpl(an: Analyzer, s: ImplBlock, scope: Scope, pkg: PackageInfo, iface: "Destroy" | "Clone"): void {
  const named = (e: Expr) => e.k === "Ident" || e.k === "Selector";
  const generic = s.target.k === "Call";
  const head = s.target.k === "Call" ? s.target.fn : s.target;
  if (!named(head)) throw new CompileError(`impl ${iface} targets must be named struct or union types, or parametric ones: impl ${iface} for Box($T)`, posOf(s.target));
  an.expr(s.target, scope);
  const t = an.resolveName(head, scope, null);
  const decl = t?.kind === "global" && t.isConst && !t.decl.type ? t.decl.values[t.index] : undefined;
  if (t?.kind !== "global" || (decl?.k !== "StructType" && decl?.k !== "UnionType"))
    throw new CompileError(`'${nodeText(head)}' is not a struct or union type; impl ${iface} is for named structs and unions`, posOf(s.target));
  const pattern = decl.polyParams ? `${t.name}(${decl.polyParams.flatMap((p) => p.names.map((n) => "$" + n.name)).join(", ")})` : "";
  if (!generic && decl.polyParams) throw new CompileError(`'${t.name}' is parametric; implement ${iface} for every instance: impl ${iface} for ${pattern}`, posOf(s.target));
  if (s.target.k === "Call") {
    if (!decl.polyParams) throw new CompileError(`'${t.name}' is not parametric: impl ${iface} for ${t.name}`, posOf(s.target));
    if (!s.target.args.every((a) => a.k === "Poly")) throw new CompileError(`impl ${iface} for one instance of a parametric type is not supported; implement it for every instance: impl ${iface} for ${pattern}`, posOf(s.target));
  }
  if (t.pkg.unit !== pkg.unit) throw new CompileError(`impl ${iface} for '${t.name}' must be in package '${t.pkg.name}', where '${t.name}' is declared`, posOf(s));
  if (iface === "Destroy" ? an.destructors.has(t) : an.clones.has(t)) throw new CompileError(`'${t.name}' already implements ${iface}`, posOf(s));
  const method = iface === "Destroy" ? "destroy" : "clone";
  const target = nodeText(s.target).replace(/\s+/g, "");
  const lower = t.name.toLowerCase();
  const usage =
    iface === "Destroy"
      ? `impl Destroy binds one method: impl Destroy for ${nodeText(s.target)} { destroy = ${lower}_destroy }, with ${lower}_destroy :: proc(x: ^${nodeText(s.target)})`
      : `impl Clone binds one method: impl Clone for ${nodeText(s.target)} { clone = ${lower}_clone }, with ${lower}_clone :: proc(x: ${nodeText(s.target)}) -> ${nodeText(s.target).replace(/\$/g, "")}`;
  if (s.bindings.length !== 1 || s.bindings[0].name !== method) {
    const other = s.bindings.find((b) => b.name !== method);
    throw new CompileError(other ? `'${other.name}' is not a method of ${iface}; ${usage}` : usage, other ? s.toks[other.tok].pos : posOf(s));
  }
  const b = s.bindings[0];
  if (!named(b.value)) throw new CompileError(usage, posOf(b.value));
  an.expr(b.value, scope);
  const p = an.resolveName(b.value, scope, null);
  const lit = p?.kind === "global" && p.isConst ? p.decl.values[p.index] : undefined;
  if (p?.kind !== "global" || lit?.k !== "ProcLit" || !lit.body || lit.comptime || lit.captures) throw new CompileError(usage, posOf(b.value));
  if (p.pkg.unit !== pkg.unit) throw new CompileError(`'${nodeText(b.value)}' must be declared in package '${pkg.name}' (or a package in an import cycle with it)`, posOf(b.value));
  if (p.isPrivate && !t.isPrivate) throw new CompileError(`'${p.name}' is private, but other packages ${iface === "Destroy" ? "destroy" : "copy"} their '${t.name}' values with it; remove @(private)`, posOf(b.value));
  const params = lit.sig.params.reduce((n, x) => n + Math.max(1, x.names.length), 0);
  const recv = lit.sig.params[0]?.type ? nodeText(lit.sig.params[0].type).replace(/\s+/g, "") : "";
  const want = iface === "Destroy" ? `^${target}` : target;
  const takes = recv === want || (generic && recv.includes("$") && matchType(recv, want));
  if (params !== 1 || !takes || lit.sig.results.length !== (iface === "Destroy" ? 0 : 1))
    throw new CompileError(
      iface === "Destroy"
        ? `'${p.name}' must take one parameter of type ^${nodeText(s.target)} and return nothing to implement destroy`
        : `'${p.name}' must take one parameter of type ${nodeText(s.target)} and return the copy to implement clone`,
      posOf(b.value),
    );
  if (iface === "Clone") an.clones.set(t, { proc: p, at: posOf(s) });
  else an.destructors.set(t, { type: t, proc: p, fields: [], cloneable: false, zero: decl.k === "StructType" ? "{}" : "nil", generic });
}

/**
 * Named structs whose fields need destroying get a destructor too (after their own impl, if any).
 * Repeated until nothing changes, since a struct can hold one that only now turned out to need it.
 * Then impl Clone is attached, and which types can be cloned is worked out the same way.
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
          // a parametric struct only with an impl of its own: its instances are otherwise destroyed by their type info
          if (v.k === "StructType" && sym?.kind === "global" && (!v.polyParams || an.destructors.has(sym))) structs.push(sym);
        });
    }
  };
  for (const pkg of an.packages) for (const f of pkg.files) collect(f.stmts);
  const fieldsOf = (sym: GlobalSym): Destructor["fields"] => {
    const st = sym.decl.values[sym.index] as Extract<Expr, { k: "StructType" }>;
    const fields: Destructor["fields"] = [];
    for (const f of st.fields) {
      if (!f.type) continue;
      const ty: Ty = { t: "node", node: f.type, scope: A(f.type)._scope ?? sym.scope };
      const o = ownedOf(an, ty);
      const how: How | undefined = o?.how ?? (st.polyParams && mentionsPoly(an, ty) ? { k: "dispatch" } : undefined);
      if (how) for (const n of f.names) if (n.name !== "_") fields.push({ name: n.name, how, ty });
    }
    return fields.reverse();
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (const sym of structs) {
      const fields = fieldsOf(sym);
      const d = an.destructors.get(sym);
      if (d ? d.fields.length !== fields.length : fields.length) {
        if (d) d.fields = fields;
        else an.destructors.set(sym, { type: sym, fields, cloneable: false, zero: "{}", generic: false });
        changed = true;
      }
    }
  }
  for (const [t, c] of an.clones) {
    const d = an.destructors.get(t);
    if (!d) throw new CompileError(`impl Clone for '${t.name}' needs impl Destroy for it too: a type that is never destroyed can already be copied`, c.at);
    d.clone = c.proc;
  }
  // a helper that destroys or clones a field at run time
  if ([...an.destructors.values()].some((d) => d.fields.some((f) => f.how.k === "dispatch"))) an.destroyDispatch = true;
  // a struct can be cloned when each of its fields can, unless its own impl Destroy makes it move-only
  for (let changed = true; changed; ) {
    changed = false;
    for (const d of an.destructors.values()) {
      const can = !!d.clone || (!d.proc && d.fields.length > 0 && d.fields.every((f) => f.how.k === "dispatch" ? !!ownedOf(an, f.ty)?.clone : f.how.dtor.cloneable));
      if (can !== d.cloneable) {
        d.cloneable = can;
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
  // held values: destroyed at run time, and cloned there when each of them can be
  const dispatch = (parts: Expr[]): Owned | undefined => {
    const held = parts.map(inner).filter((o) => !!o);
    return held.length ? { how: { k: "dispatch" }, clone: held.every((o) => o.clone), name: nodeText(n), why: HOLDS } : undefined;
  };
  switch (n.k) {
    case "Paren":
      return inner(n.x);
    case "Ident":
    case "Selector":
      return ownedOfSym(an, symOf(an, n, scope), depth);
    case "StructType":
      return n.polyParams ? undefined : dispatch(n.fields.flatMap((f) => (f.type ? [f.type] : [])));
    case "UnionType":
      return n.polyParams ? undefined : dispatch(n.variants);
    case "TypeExpr":
      if ((n.what === "array" || n.what === "inferred") && n.parts[1]) return dispatch([n.parts[1]]);
      // a dynamic array or a map owns its elements: destroying it destroys them and frees its memory
      if (n.what === "dynamic" && !n.parts[0] && n.parts[1]) return dispatch([n.parts[1]]);
      if (n.what === "map" && n.parts[0] && n.parts[1]) {
        const o = dispatch([n.parts[0], n.parts[1]]);
        return o && { ...o, clone: false };
      }
      return undefined;
    case "Call": {
      // an instance of a parametric type with impl Destroy: its generic procs take every instance
      const head = n.fn.k === "Ident" || n.fn.k === "Selector" ? symOf(an, n.fn, scope) : undefined;
      const d = head?.kind === "global" ? an.destructors.get(head) : undefined;
      if (d?.generic) return { how: { k: "call", dtor: d }, clone: d.cloneable, name: nodeText(n), why: d.proc ? HAS : HOLDS };
      // `Maybe(File)`, or an instance of a parametric type (yours or core's) holding one
      return dispatch(n.args.map((a) => (a.k === "FieldValue" ? a.value : a)));
    }
  }
  return undefined;
}

function ownedOfSym(an: Analyzer, sym: Sym | undefined, depth: number): Owned | undefined {
  if (sym?.kind === "global") {
    const d = an.destructors.get(sym);
    if (d && !d.generic) return { how: { k: "call", dtor: d }, clone: d.cloneable, name: sym.name, why: d.proc ? HAS : HOLDS };
    const v = sym.isConst && !sym.decl.type ? sym.decl.values[sym.index] : undefined;
    // an alias, or a union holding a destructible variant (destroyed by the variant it holds)
    if (v && (v.k === "Ident" || v.k === "Selector" || v.k === "Paren" || v.k === "UnionType" || v.k === "Call")) {
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
  // a type's own destroy and clone procs copy its values as they are
  const raw = new Set<GlobalSym>();
  for (const d of an.destructors.values()) for (const p of [d.proc, d.clone]) if (p) raw.add(p);
  for (const pkg of an.packages) for (const f of pkg.files) for (const s of f.stmts) guard(() => new Checker(an, guard, raw).top(s));
}

/** Types that hold their elements by value but can't hold destructible ones yet. */
const CONTAINERS: Record<string, string> = {
  matrix: "a matrix",
  distinct: "a distinct type",
};

/** Core's procs on dynamic arrays and maps that drop elements: rewritten to `__vidar.destroy_<name>`, which destroys them first. */
const DROPPING = new Set(["clear", "resize", "ordered_remove", "unordered_remove", "remove_range"]);
/** ...and the ones that return what they remove: rewritten the same way when the result is thrown away. */
const REMOVING = new Set(["pop", "pop_front", "delete_key"]);
/** Core's procs that move values into a dynamic array. */
const ADDING = new Set(["append", "append_elem", "append_elems", "non_zero_append", "inject_at", "inject_at_elem", "inject_at_elems"]);
/** Core's procs that overwrite or copy elements without destroying the old ones, and what to write instead. */
const OVERWRITING: Record<string, string> = {
  assign_at: "a[i] = v (after resize, if the array is too short)",
  assign_at_elem: "a[i] = v (after resize, if the array is too short)",
  assign_at_elems: "a[i] = v for each value",
  map_insert: "m[k] = v",
  map_upsert: "m[k] = v",
  map_entry: "m[k] = v",
  non_zero_resize: "resize, which leaves the new elements zero",
  copy: "a loop that assigns a clone of each element, or move!s it",
  copy_slice: "a loop that assigns a clone of each element, or move!s it",
};

/** A dynamic array, map or slice, the type of its elements, and its keys' for a map. */
interface Container {
  kind: "dynamic" | "map" | "slice";
  elem: Ty;
  key?: Ty;
  name: string;
}

/** How a proc uses one of its locals, for last-use moves. */
interface Uses {
  refs: Expr[];
  /** read later than its position says: in a defer, through a pointer, or by a closure */
  escapes: boolean;
}

class Checker {
  /** owned locals of each proc being walked, innermost last */
  private owned: Set<LocalSym>[] = [];
  /** the named results of each proc being walked */
  private results: Set<Sym>[] = [];
  /** fresh values whose owner is the statement they are in: declarations, assignments, returns */
  private consumed = new Set<Expr>();
  /** the statements being walked, innermost last: run-time copy checks go before them */
  private stmts: Stmt[] = [];
  /** inside an impl's destroy or clone proc, where copies are left alone */
  private raw = false;
  /** the procs being walked, innermost last */
  private procs: Extract<Expr, { k: "ProcLit" }>[] = [];
  /** the blocks being walked, innermost last: where their locals are destroyed */
  private blocks: Block[] = [];
  private uses = new Map<Node, Map<Sym, Uses>>();

  constructor(
    private an: Analyzer,
    private guard: (f: () => void) => void,
    private rawProcs: Set<GlobalSym>,
  ) {}

  top(s: Stmt): void {
    const syms: (Sym | undefined)[] = s.k === "ValueDecl" && s.isConst ? (A(s)._syms ?? []) : [];
    this.raw = syms.some((x) => x?.kind === "global" && this.rawProcs.has(x));
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
    const block = s.k === "Block" && !s.inline;
    if (block) this.blocks.push(s);
    try {
      this.stmt(s);
    } finally {
      this.stmts.pop();
      if (block) this.blocks.pop();
    }
  }

  /** What a destroy or clone of `how` calls, for hints and hovers. */
  private named(how: How, what: "destroy" | "clone"): string {
    if (how.k === "dispatch") return what === "destroy" ? "`__vidar.destroy`, which finds what the type needs at run time" : "`__vidar.clone`, which finds what the type needs at run time";
    return `\`${(what === "destroy" ? destructorName : cloneName)(how.dtor).name}\``;
  }

  private note(kind: OwnershipNote["kind"], tok: Token | undefined, side: OwnershipNote["side"], label: string, tooltip: string): void {
    if (tok && !this.raw) this.an.ownership.push({ kind, tok, side, label, tooltip });
  }

  /** A local destroyed when the innermost block ends: a `drop` hint after it, and a hover note. */
  private dropAtEnd(sym: LocalSym, how: How, body?: Block): void {
    const block = body ?? this.blocks[this.blocks.length - 1];
    const end = block?.toks[block.end - 1];
    if (!end) return;
    const by = this.named(how, "destroy");
    this.an.destroyedLocals.set(sym, `destroyed at the end of its scope (line ${end.pos.line}), and on every return, break or continue out of it, by ${by}`);
    this.note("drop", end, "after", sym.name, `'${sym.name}' is destroyed here by ${by}, unless it has moved out (a moved local is zero, and its destroy does nothing)`);
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
    // `for f in files` borrows each element, as a by-value parameter does: Odin won't let it be assigned or addressed
  }

  /** A call statement whose results are thrown away: a destructible one would never be destroyed. */
  private dropped(e: Expr): void {
    while (e.k === "Paren" || e.k === "Postfix") e = e.x;
    if (e.k !== "Call") return;
    if (this.removed(e)) return;
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
        // a capture by value borrows, as a by-value parameter does: the closure must not outlive the proc
        const outer = this.procs[this.procs.length - 1];
        let escape: string | undefined;
        for (const c of e.captures ? ((A(e)._captures as CaptureSym[] | undefined) ?? []) : []) {
          if (c.byRef) continue;
          const ty = symTy(c.target);
          const o = ownedOf(this.an, ty);
          const unsure = !o && this.unsure(ty) && c.target.kind === "local";
          if (!o && !unsure) continue;
          escape ??= outer && closureEscape(this.an, outer, e);
          if (!escape) continue;
          if (o) throw new CompileError(`this closure borrows '${c.name}', a ${o.name} ${o.why.replace("which ", "that ")}, and ${escape}, but '${c.name}' is destroyed when its scope ends. Share it through an Rc (vidar:rc) instead`, c.declTok?.pos ?? posOf(e));
          // generic code: checked at run time, as a copy
          this.check(c.name);
        }
        if (!e.body) return this.kids(e);
        this.procs.push(e);
        this.owned.push(this.ownedParams(e));
        this.results.push(new Set(((A(e)._results as Sym[] | undefined) ?? []).filter(Boolean)));
        const stmts = this.stmts;
        this.stmts = [];
        try {
          this.kids(e);
        } finally {
          this.procs.pop();
          this.owned.pop();
          this.results.pop();
          this.stmts = stmts;
        }
        return;
      }
      case "MacroCall": {
        const exp: Expr | undefined = A(e)._expansion;
        if (exp) {
          if (this.consumed.has(e)) this.consume(exp);
          const take = takeOf(exp);
          if (take) {
            this.moved(take);
            this.an.destroyDispatch = true;
          }
          this.expr(exp);
        }
        return;
      }
      case "TypeExpr": {
        const what = CONTAINERS[e.what] ?? (e.what === "dynamic" && e.parts[0] ? "a fixed-capacity dynamic array" : undefined);
        if (what) for (const p of e.parts) if (p) this.contained(p, what);
        if (e.what === "map" && e.parts[0]) this.mapKey(e.parts[0]);
        break;
      }
      case "Directive":
        if (e.name === "#soa" && e.x?.k === "TypeExpr" && e.x.parts[1]) this.contained(e.x.parts[1], "an #soa array");
        break;
      case "Call":
        this.call(e);
        break;
      case "CompoundLit":
        if (e.elems.length) this.sliceLit(e);
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

  /** `#owned` parameters: a local copy of each is destroyed when the proc returns, unless it moves out. */
  private ownedParams(e: Extract<Expr, { k: "ProcLit" }>): Set<LocalSym> {
    const names = new Set(e.sig.params.flatMap((p) => p.names.filter((n) => n.prefix === "#owned").map((n) => n.name)));
    const out = new Set<LocalSym>();
    if (!names.size) return out;
    const decls: { name: string; how: How }[] = [];
    for (const sym of (A(e)._params as LocalSym[] | undefined) ?? []) {
      if (sym.isConst || !names.has(sym.name)) continue;
      const o = ownedOf(this.an, sym.ty);
      if (!o && !this.unsure(sym.ty)) continue;
      const how: How = o?.how ?? { k: "dispatch" };
      if (how.k === "dispatch") this.an.destroyDispatch = true;
      decls.push({ name: sym.name, how });
      out.add(sym);
      if (e.body) this.dropAtEnd(sym, how, e.body);
    }
    if (decls.length) A(e)._destroyOwned = decls;
    return out;
  }

  /** move!(x): x is left zero, so it must be a variable this proc owns, a field or an element. */
  private moved(e: Expr): void {
    const sym: Sym | undefined = e.k === "Ident" ? A(e)._sym : undefined;
    if (sym?.kind === "local" && sym.declKind === "param" && !this.owned.some((o) => o.has(sym)))
      throw new CompileError(`'${e.k === "Ident" ? e.name : ""}' is a parameter, which is borrowed, so it can't be moved; declare it #owned to take it over`, posOf(e), sym.declTok && { code: "destroy-owned", name: sym.name, at: sym.declTok.pos });
    if (sym?.kind === "capture") throw new CompileError(`a closure can't move '${sym.name}' out of the proc that owns it`, posOf(e));
    if (sym?.kind === "local" && sym.declKind === "range")
      throw new CompileError(`'${sym.name}' is a loop value, which borrows each element, so it can't be moved; loop over pointers and move the element: for &${sym.name} in ..., then move!(${sym.name}^)`, posOf(e));
    if (!this.place(e)) throw new CompileError(`move! takes a variable, field or element, which it leaves zero: '${nodeText(e)}' is a value already`, posOf(e));
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

  /** A map keyed by a destructible type: its keys are copied to compare with, so they can't be. */
  private mapKey(t: Expr): void {
    const scope: Scope | undefined = A(t)._scope;
    const o = scope && ownedOf(this.an, { t: "node", node: t, scope });
    if (o) throw new CompileError(`a map key can't be a ${o.name}, ${o.why}: the map compares copies of its keys. Key it by a plain value, such as a name or an id`, posOf(t));
  }

  /** `[]File{...}`: a slice is a view, so nothing would destroy the elements. */
  private sliceLit(e: Extract<Expr, { k: "CompoundLit" }>): void {
    const s = this.stmts[this.stmts.length - 1];
    const declared = s?.k === "ValueDecl" && s.type && s.values.includes(e) ? s.type : undefined;
    const t = e.type ?? declared;
    const scope: Scope | undefined = t && (A(t)._scope ?? A(e)._scope);
    const c = scope ? this.containerOf({ t: "node", node: t!, scope }) : undefined;
    const o = c?.kind === "slice" ? ownedOf(this.an, c.elem) : undefined;
    if (o) throw new CompileError(`nothing would destroy the ${o.name} values in this slice literal: a slice is a view, which doesn't own its elements. Use a fixed array, [?]${nodeText(c!.elem.t === "node" ? c!.elem.node : e)}{...}, or a dynamic array`, posOf(e));
  }

  /** The dynamic array, map or slice `ty` is (or points to). */
  private containerOf(ty: Ty | undefined): Container | undefined {
    let n = this.an.normalize(ty);
    if (n?.t === "ptr") n = this.an.normalize(n.elem);
    if (n?.t !== "node" || n.node.k !== "TypeExpr") return undefined;
    const t = n.node;
    const scope = n.scope;
    const at = (x: Expr): Ty => ({ t: "node", node: x, scope: A(x)._scope ?? scope });
    if (((t.what === "dynamic" && !t.parts[0]) || t.what === "slice") && t.parts[1]) return { kind: t.what as "dynamic" | "slice", elem: at(t.parts[1]), name: nodeText(t) };
    if (t.what === "map" && t.parts[0] && t.parts[1]) return { kind: "map", key: at(t.parts[0]), elem: at(t.parts[1]), name: nodeText(t) };
    return undefined;
  }

  /** What destroying the container's elements takes: a known destroy, one found at run time, or nothing. */
  private holds(c: Container): { o?: Owned; unsure: boolean } | undefined {
    const tys = c.key ? [c.elem, c.key] : [c.elem];
    const o = tys.map((t) => ownedOf(this.an, t)).find(Boolean);
    if (o) return { o, unsure: false };
    return tys.some((t) => mentionsPoly(this.an, t)) ? { unsure: true } : undefined;
  }

  /** A call to core's proc becomes a call to `__vidar.<proc>`, which destroys what the original drops. */
  private rewrite(e: Extract<Expr, { k: "Call" }>, proc: string): void {
    A(e.fn)._destroyFn = proc;
    this.an.destroyDispatch = true;
    const what = proc === "destroy_delete" ? "destroys the elements, frees the memory and leaves it empty" : "destroys what it drops";
    this.note("destroys", e.toks[e.end - 1], "after", what.split(",")[0], `vidar calls \`__vidar.${proc}\` here, which ${what}`);
  }

  /** `pop(&a)`, `pop_front(&a)` or `delete_key(&m, k)` as a statement: what it removes is destroyed. */
  private removed(e: Extract<Expr, { k: "Call" }>): boolean {
    if (e.fn.k !== "Ident" || A(e.fn)._sym || !e.args[0]) return false;
    const name = e.fn.name;
    const safe = name === "pop_safe" || name === "pop_front_safe";
    if (!REMOVING.has(name) && !safe) return false;
    const c = this.containerOf(this.typeOf(e.args[0]));
    const h = c && c.kind !== "slice" ? this.holds(c) : undefined;
    if (!h) return false;
    if (safe) {
      if (h.o) throw new CompileError(`the ${h.o.name} that ${name}() returns is thrown away, so it would never be destroyed; keep it: x, ok := ${nodeText(e)}, or call ${name.replace("_safe", "")}`, posOf(e));
      return false;
    }
    this.rewrite(e, `destroy_${name}`);
    this.consumed.add(e);
    return true;
  }

  /** Core's procs on dynamic arrays, maps and slices of destructible values. */
  private builtin(e: Extract<Expr, { k: "Call" }>, name: string): void {
    const a0 = e.args[0];
    if (!a0 || a0.k === "FieldValue") return;
    if (name === "new_clone") {
      this.copied(a0, "new_clone would copy it");
      this.consumed.add(a0);
      return;
    }
    if (name === "make") {
      const scope: Scope | undefined = A(a0)._scope ?? A(e)._scope;
      const c = scope ? this.containerOf({ t: "node", node: a0, scope }) : undefined;
      const o = c?.kind === "slice" ? ownedOf(this.an, c.elem) : undefined;
      if (o) throw new CompileError(`nothing would destroy the ${o.name} values this makes: a slice is a view, which doesn't own its elements. Make a dynamic array, which does: make([dynamic]${c!.elem.t === "node" ? nodeText(c!.elem.node) : o.name}, n)`, posOf(e));
      return;
    }
    const c = this.containerOf(this.typeOf(a0));
    // the values move in, whether or not vidar can tell the array's type
    if (ADDING.has(name)) {
      for (const a of e.args.slice(1)) {
        if (a.k === "Spread") {
          const o = c && ownedOf(this.an, c.elem);
          if (o && !this.raw)
            throw new CompileError(`${name} would copy each ${o.name} in '${nodeText(a.x)}', ${o.why}, and both copies would be destroyed; ${name} them one at a time, each a new value, a clone or move!(x)`, posOf(a));
          continue;
        }
        const v = a.k === "FieldValue" ? a.value : a;
        this.copied(v, `${name} would copy it`, `Move it there with move!(${nodeText(v)}), or ${name} a new value`);
        this.consume(v);
      }
      return;
    }
    if (!c) return;
    const h = this.holds(c);
    if (!h) return;
    const fix = OVERWRITING[name];
    if (fix && h.o && !this.raw) throw new CompileError(`${name} would overwrite or copy ${h.o.name} values without destroying the old ones, and ${h.o.name} ${h.o.why.replace("which ", "")}; write ${fix}`, posOf(e));
    if (name === "delete") return this.deleted(e, c, h);
    if (DROPPING.has(name) && c.kind !== "slice") this.rewrite(e, `destroy_${name}`);
  }

  /** `delete(x)` of a dynamic array or map destroys its elements too, and leaves x empty for its own destroy. */
  private deleted(e: Extract<Expr, { k: "Call" }>, c: Container, h: { o?: Owned; unsure: boolean }): void {
    const a0 = e.args[0];
    if (c.kind === "slice") {
      if (h.o)
        throw new CompileError(`'${nodeText(a0)}' is a ${c.name}, a view that doesn't own its elements, so delete would free ${h.o.name} values without destroying them. Keep them in a dynamic array, which destroys them`, posOf(e));
      return;
    }
    const p = this.place(a0);
    if (!p) throw new CompileError(`delete destroys a ${c.name}'s elements and leaves it empty, so it takes the variable or field that holds it: '${nodeText(a0)}' is a value`, posOf(a0));
    let root = p;
    while (root.k === "Paren" || (root.k === "Selector" && !A(root)._pkgMember)) root = root.x;
    const sym: Sym | undefined = root.k === "Ident" ? A(root)._sym : undefined;
    const ptr = this.an.normalize(this.typeOf(root))?.t === "ptr";
    if (sym?.kind === "local" && sym.declKind === "param" && !ptr && !this.owned.some((o) => o.has(sym)))
      throw new CompileError(`'${sym.name}' is a parameter, which is borrowed, so '${nodeText(a0)}' can't be deleted here: its owner destroys it. Declare it #owned to take it over`, posOf(a0), sym.declTok && { code: "destroy-owned", name: sym.name, at: sym.declTok.pos });
    this.rewrite(e, "destroy_delete");
    A(a0)._destroyAddr = true;
  }

  /**
   * `queue.Queue(File)`: an instance of a type from an Odin package (by convention, its types are
   * capitalized). Its procs copy and drop values without destroying them, and its buffer can keep
   * stale copies, so it can't hold destructible ones.
   */
  private odinInstance(e: Extract<Expr, { k: "Call" }>): void {
    const fn = e.fn;
    if (fn.k !== "Selector" || fn.x.k !== "Ident" || !/^[A-Z]/.test(fn.name)) return;
    const scope: Scope | undefined = A(e)._scope;
    const pkg = A(fn.x)._sym ?? (scope && this.an.lookup(fn.x.name, scope, null));
    if (pkg?.kind !== "pkg" || pkg.target) return;
    for (const a of e.args) {
      const t = a.k === "FieldValue" ? a.value : a;
      const o = scope && ownedOf(this.an, { t: "node", node: t, scope: A(t)._scope ?? scope });
      if (o)
        throw new CompileError(`${nodeText(e)} can't hold a ${o.name}, ${o.why}: the procs of "${pkg.path}" copy and drop values without destroying them. Hold pointers (^${o.name}), or keep the values in a dynamic array`, posOf(e));
    }
  }

  private call(e: Extract<Expr, { k: "Call" }>): void {
    if (e.fn.k === "Ident" && !A(e.fn)._sym) return this.builtin(e, e.fn.name);
    this.odinInstance(e);
    // an `#owned` parameter takes over a new value, or a clone (a copy of a move-only one is an error)
    const scope: Scope | undefined = A(e)._scope;
    let ft: Ty | undefined;
    try {
      ft = scope && this.an.normalize(this.an.typeOf(e.fn, scope));
    } catch {
      return;
    }
    if (ft?.t !== "sig") return;
    const params = ft.sig.params.flatMap((p) => (p.names.length ? p.names.map((n) => ({ name: n.name, owned: n.prefix === "#owned" })) : [{ name: "", owned: false }]));
    if (!params.some((p) => p.owned)) return;
    e.args.forEach((a, i) => {
      const param = a.k === "FieldValue" ? params.find((p) => p.name === a.name) : params[i];
      if (!param?.owned) return;
      const v = a.k === "FieldValue" ? a.value : a;
      this.copied(v, `passing it to #owned parameter '${param.name}' would copy it`, `Move it there with move!(${nodeText(v)}), or pass a new value`);
      this.consume(v);
    });
  }

  /**
   * `e` copies a destructible value out of a variable, field or element: an error, or, when its type
   * is only known at run time, a check there (`__vidar.check_copy`, and an `#assert` for the types
   * the file can name).
   */
  private copied(e: Expr, why: string, fix?: string): void {
    if (this.raw) return;
    const p = this.place(e);
    if (!p) return;
    const ty = this.typeOf(e);
    const o = ownedOf(this.an, ty);
    // the last use of a local moves it instead: no clone, and the local's destroy finds it zero
    if ((o?.clone || (!o && this.unsure(ty) && this.owned.length)) && this.lastUse(p)) {
      A(p)._destroyTake = true;
      this.an.destroyDispatch = true;
      const sym: LocalSym = A(p.k === "Paren" ? p.x : p)._sym;
      const was = this.an.destroyedLocals.get(sym);
      if (was) this.an.destroyedLocals.set(sym, `${was} · its last use moves it out (line ${posOf(p).line}), so that destroy finds it zero`);
      this.note("move", e.toks[e.start], "before", "move", `the last use of '${nodeText(p)}': its value moves here instead of being cloned, and '${nodeText(p)}' is left zero`);
      return;
    }
    if (o?.clone) {
      // impl Clone: the copy is a clone, which the new owner destroys
      A(e)._destroyClone = o.how;
      if (o.how.k === "dispatch") this.an.destroyDispatch = true;
      this.note("clone", e.toks[e.start], "before", "clone", `a copy of the ${o.name} in '${nodeText(p)}', made by ${this.named(o.how, "clone")}: '${nodeText(p)}' is read later, so it can't move`);
      return;
    }
    if (o) {
      const text = nodeText(p);
      throw new CompileError(`'${text}' is a ${o.name}, ${o.why}, and ${why}; both copies would be destroyed. ${fix ?? `Borrow it with &${text}`}`, posOf(e), this.moveFix(p));
    }
    if (this.unsure(ty) && this.owned.length && this.check(p)) A(e)._destroyClone = { k: "dispatch" } satisfies How;
  }

  /**
   * Whether `p` is a local this proc owns that is never read after it: no later reference, none in a
   * defer, behind a pointer or in a closure, and no loop around `p` that the local was declared before.
   */
  private lastUse(p: Expr): boolean {
    while (p.k === "Paren") p = p.x;
    const sym: Sym | undefined = p.k === "Ident" ? A(p)._sym : undefined;
    const proc = this.procs[this.procs.length - 1];
    if (sym?.kind !== "local" || !proc?.body || !this.owned[this.owned.length - 1]?.has(sym) || !sym.declTok) return false;
    const decl = p.toks.indexOf(sym.declTok);
    const u = this.usesIn(proc).get(sym);
    if (decl < 0 || !u || u.escapes) return false;
    if (u.refs.some((r) => r !== p && (r.toks !== p.toks || r.start > p.start))) return false;
    // the other references in this statement are read after the copy, or written (`h = h`)
    const s = this.stmts[this.stmts.length - 1];
    if (!s || u.refs.some((r) => r !== p && r.start >= s.start && r.end <= s.end)) return false;
    return !this.stmts.some((x) => (x.k === "For" || x.k === "RangeFor") && (x.toks !== p.toks || x.start > decl));
  }

  private usesIn(proc: Extract<Expr, { k: "ProcLit" }>): Map<Sym, Uses> {
    let out = this.uses.get(proc);
    if (out) return out;
    const uses = (out = new Map<Sym, Uses>());
    this.uses.set(proc, uses);
    const get = (sym: Sym): Uses => {
      let u = uses.get(sym);
      if (!u) uses.set(sym, (u = { refs: [], escapes: false }));
      return u;
    };
    const root = (e: Expr): Sym | undefined => {
      while (e.k === "Paren" || e.k === "Index" || (e.k === "Selector" && !A(e)._pkgMember)) e = e.x;
      return e.k === "Ident" ? A(e)._sym : undefined;
    };
    const escape = (e: Expr) => {
      const sym = root(e);
      if (sym) get(sym).escapes = true;
    };
    const walk = (n: Node, deferred: boolean): void => {
      if (n.k === "ProcLit" && n !== proc) {
        for (const c of (A(n)._captures as CaptureSym[] | undefined) ?? []) get(c.target).escapes = true;
        return;
      }
      if (n.k === "Ident") {
        const sym: Sym | undefined = A(n)._sym;
        if (sym) {
          const u = get(sym);
          u.refs.push(n);
          if (deferred) u.escapes = true;
        }
      }
      if (n.k === "Unary" && n.op === "&") escape(n.x);
      if (n.k === "RangeFor" && n.vals.some((v) => v.byRef)) escape(n.x);
      if (n.k === "Using") n.x.forEach(escape);
      const d = deferred || n.k === "Defer" || n.k === "ErrDefer";
      for (const c of children(n)) walk(c, d);
      const exp: Node | undefined = A(n)._expansion;
      if (exp) walk(exp, d);
    };
    walk(proc.body!, false);
    return uses;
  }

  /** The quick fix for a copy of `p`: `move!(p)`, or `#owned` on the borrowed parameter it reads. */
  private moveFix(p: Expr): ErrorFix | undefined {
    let root = p;
    while (root.k === "Paren" || root.k === "Index" || (root.k === "Selector" && !A(root)._pkgMember)) root = root.x;
    const sym: Sym | undefined = root.k === "Ident" ? A(root)._sym : undefined;
    if (sym?.kind === "capture" || (sym?.kind === "local" && sym.declKind === "range")) return undefined;
    if (sym?.kind === "local" && sym.declKind === "param" && !this.owned.some((o) => o.has(sym)))
      return sym.declTok && root === p ? { code: "destroy-owned", name: sym.name, at: sym.declTok.pos } : undefined;
    const s = span(p);
    return s && { code: "destroy-move", ...s };
  }

  /** A copy checked when the program runs, and by Odin for the move-only types this file can name. */
  private check(place: Expr | string): boolean {
    if (this.raw) return false;
    const s = this.stmts[this.stmts.length - 1];
    if (!s || A(s)._isInit) return false;
    ((A(s)._destroyChecks ??= []) as (Expr | string)[]).push(place);
    this.an.destroyDispatch = true;
    return true;
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
    // `v, ok := m[k]`, `v, ok := u.(T)`: v copies the element or variant, and ok is a bool
    let commaOk: Expr | undefined = s.names.length === 2 && s.values.length === 1 ? s.values[0] : undefined;
    while (commaOk?.k === "Paren") commaOk = commaOk.x;
    if (commaOk && !(commaOk.k === "TypeAssert" || (commaOk.k === "Index" && !commaOk.slice))) commaOk = undefined;
    syms.forEach((sym, i) => {
      if (commaOk && i === 1) return;
      const name = s.names[i];
      const at = s.toks[name.tok].pos;
      const v = s.values.length === s.names.length ? s.values[i] : undefined;
      const ty = sym.ty ?? (commaOk && this.typeOf(commaOk));
      const o = ownedOf(this.an, ty);
      if (!o) {
        if (!this.unsure(ty) || name.name === "_") return;
        // only known at run time: destroyed through __vidar.destroy, which does nothing for most types
        if (A(s)._isInit) return this.unknownInit(name.name, s.values.length === s.names.length ? s.values[i] : s.values[0], at);
        if (v) this.copied(v, "");
        out.push({ sym, name: s.toks[name.tok], how: { k: "dispatch" }, clone: commaOk && !this.raw ? { k: "dispatch" } : undefined });
        this.owned[this.owned.length - 1].add(sym);
        this.an.destroyDispatch = true;
        this.dropAtEnd(sym, { k: "dispatch" });
        if (commaOk && !this.raw) this.note("clone", commaOk.toks[commaOk.start], "before", "clone", `'${name.name}' is a clone of the value in '${nodeText(commaOk)}', made by ${this.named({ k: "dispatch" }, "clone")}`);
        return;
      }
      if (name.name === "_") throw new CompileError(`'_' would throw away a ${o.name} without destroying it; give it a name`, at);
      let clone: How | undefined;
      if (commaOk && !this.raw) {
        const ok = s.names[1].name;
        if (!o.clone || A(s)._isInit)
          throw new CompileError(`'${name.name}' would be a copy of the ${o.name} in '${nodeText(commaOk)}', ${o.why}, and both copies would be destroyed; take a pointer: ${name.name}, ${ok} := &${nodeText(commaOk)}`, at, {
            code: "destroy-pointer",
            at: commaOk.toks[commaOk.start].pos,
          });
        clone = o.how;
      }
      if (A(s)._isInit) throw new CompileError(`'${name.name}' is a ${o.name}, ${o.why}; declare it before the statement, not in its initializer`, at);
      if (v) this.copied(v, `'${name.name} := ${nodeText(v)}' would copy it`);
      if (o.how.k === "call") {
        const owner = destructorName(o.how.dtor).owner;
        if (!reaches(sym.scope, owner))
          throw new CompileError(`'${name.name}' is a ${o.name}, destroyed by '${destructorName(o.how.dtor).name}' in package '${owner.pkg.name}'; import that package in this file so the cleanup can call it`, at);
      } else this.an.destroyDispatch = true;
      out.push({ sym, name: s.toks[name.tok], how: o.how, clone });
      this.owned[this.owned.length - 1].add(sym);
      this.dropAtEnd(sym, o.how);
      if (clone && commaOk) this.note("clone", commaOk.toks[commaOk.start], "before", "clone", `'${name.name}' is a clone of the ${o.name} in '${nodeText(commaOk)}', made by ${this.named(clone, "clone")}`);
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
    this.note("drops-old", l.toks[l.end - 1], "after", "drops old", `the old value of '${nodeText(l)}' is destroyed by ${this.named(o.how, "destroy")} once the new one is stored`);
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
        this.note("move", x.toks[x.start], "before", "move", `'${sym.name}' moves out to the caller, which destroys it; it is left zero here`);
        continue;
      }
      if (sym && results?.has(sym)) continue;
      this.copied(r, "returning it would copy it", "Only a local declared in this proc can be returned: it moves out");
    }
    if (moved.length) A(s)._destroyMove = moved;
  }
}

/** Where `e`'s source starts and ends, when it is all in one file. */
function span(e: Expr): { start: Token["pos"]; end: Token["pos"] } | undefined {
  const toks = e.toks.slice(e.start, e.end);
  const first = toks[0], last = toks[toks.length - 1];
  if (!first || toks.some((t) => t.pos.file !== first.pos.file)) return undefined;
  const lines = last.text.split("\n");
  return { start: first.pos, end: { file: last.pos.file, line: last.pos.line + lines.length - 1, col: (lines.length > 1 ? 1 : last.pos.col) + lines[lines.length - 1].length } };
}

/** The variable `move!(x)` moves out of: its expansion is `__vidar.take(&x)`. */
function takeOf(e: Expr): Expr | undefined {
  while (e.k === "Paren") e = e.x;
  if (e.k !== "Call" || e.fn.k !== "Selector" || e.fn.name !== "take" || e.fn.x.k !== "Ident" || e.fn.x.name !== "__vidar" || A(e.fn.x)._sym) return undefined;
  const a = e.args[0];
  return a?.k === "Unary" && a.op === "&" ? a.x : undefined;
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
// its type info (fields, array elements, union variants, what a dynamic array or map holds) the first
// time a value of it is destroyed.
package vidar_runtime

import "base:intrinsics"
import "base:runtime"
import "core:sync"

Destroy_Plan :: struct {
	destroy:   proc(rawptr),
	// impl Clone: writes a clone of the value at src to dst
	clone:     proc(dst, src: rawptr),
	move_only: bool,
	parts:     []Destroy_Part,
	// a union: the plan of each variant, and where its tag is
	variants:  []^Destroy_Plan,
	tag_size:  int,
	tag_off:   uintptr,
	no_nil:    bool,
	// a dynamic array or a map: its elements (a map's values) and a map's keys are destroyed, then its memory freed
	container:  Destroy_Container,
	elem:       ^Destroy_Plan,
	key:        ^Destroy_Plan,
	elem_size:  uintptr,
	elem_align: int,
	map_info:   ^runtime.Map_Info,
}

Destroy_Container :: enum u8 { None, Dynamic, Map }

Destroy_Part :: struct {
	plan:   ^Destroy_Plan,
	offset: uintptr,
	count:  int,
	stride: uintptr,
}

// impl Destroy for a parametric type, found by the file that declares it and its name
@(private="file")
Generic_Destroy :: struct {
	file, name: string,
	destroy:    proc(rawptr),
	clone:      proc(dst, src: rawptr),
}

@(private="file") destroy_plans: map[typeid]^Destroy_Plan
@(private="file") generic_destroys: [dynamic]Generic_Destroy
@(private="file") destroy_lock: sync.Mutex
@(private="file") nothing_to_destroy: Destroy_Plan
// a plan being made: a type that holds itself (through a dynamic array or map) contributes nothing to its own
@(private="file") plan_in_progress: Destroy_Plan

// a type with impl Destroy and no impl Clone: copies stop the program
register_destroy :: proc "contextless" ($T: typeid, $destroy: proc(^T)) {
	add_plan(T, Destroy_Plan{destroy = transmute(proc(rawptr))destroy, move_only = true})
}

// a type with impl Destroy and impl Clone (or one derived from its fields)
register_clone :: proc "contextless" ($T: typeid, $destroy: proc(^T), $clone: proc(T) -> T) {
	add_plan(T, Destroy_Plan{destroy = transmute(proc(rawptr))destroy, clone = proc(dst, src: rawptr) { (^T)(dst)^ = clone((^T)(src)^) }})
}

@(private="file")
add_plan :: proc "contextless" ($T: typeid, plan: Destroy_Plan) {
	context = runtime.default_context()
	context.allocator = runtime.heap_allocator()
	sync.guard(&destroy_lock)
	destroy_plans[T] = new_clone(plan)
}

// impl Destroy for a parametric type, whose procs exist only per instance: generic code stops on its
// instances, unless the type's package also gives procs that take any instance (vidar:rc does)
register_generic :: proc "contextless" (file, name: string, destroy: proc(rawptr) = nil, clone: proc(dst, src: rawptr) = nil) {
	context = runtime.default_context()
	context.allocator = runtime.heap_allocator()
	sync.guard(&destroy_lock)
	for &g in generic_destroys {
		if g.file == file && g.name == name {
			if destroy != nil do g.destroy, g.clone = destroy, clone
			return
		}
	}
	append(&generic_destroys, Generic_Destroy{file, name, destroy, clone})
}

// nil when a value of the type holds nothing to destroy
@(private="file")
plan_for :: proc(ti: ^runtime.Type_Info) -> ^Destroy_Plan {
	if p, ok := destroy_plans[ti.id]; ok do return nil if p == &nothing_to_destroy || p == &plan_in_progress else p
	destroy_plans[ti.id] = &plan_in_progress
	plan := new(Destroy_Plan)
	parts: [dynamic]Destroy_Part
	#partial switch v in ti.variant {
	case runtime.Type_Info_Named:
		// an instance, Box($T=int), of a parametric type with impl Destroy
		if v.loc != nil {
			for g in generic_destroys {
				if g.file != v.loc.file_path || len(v.name) <= len(g.name) || v.name[:len(g.name)] != g.name || v.name[len(g.name)] != '(' do continue
				if g.destroy == nil do generic_unknown(ti)
				plan^ = {destroy = g.destroy, clone = g.clone, move_only = g.clone == nil}
				destroy_plans[ti.id] = plan
				return plan
			}
		}
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
	case runtime.Type_Info_Dynamic_Array:
		if p := plan_for(v.elem); p != nil {
			plan.container, plan.elem, plan.elem_size, plan.elem_align, plan.move_only = .Dynamic, p, uintptr(v.elem_size), v.elem.align, p.move_only
		}
	case runtime.Type_Info_Map:
		k, val := plan_for(v.key), plan_for(v.value)
		if k != nil || val != nil {
			// a map is never cloned
			plan.container, plan.key, plan.elem, plan.map_info, plan.move_only = .Map, k, val, v.map_info, true
		}
	}
	if len(parts) == 0 && plan.variants == nil && plan.container == .None {
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
	switch plan.container {
	case .None:
	case .Dynamic:
		a := (^runtime.Raw_Dynamic_Array)(p)
		for i := a.len - 1; i >= 0; i -= 1 do run_plan(plan.elem, rawptr(uintptr(a.data) + uintptr(i) * plan.elem_size))
		_ = runtime.mem_free_with_size(a.data, a.cap * int(plan.elem_size), a.allocator)
		a.data, a.len, a.cap = nil, 0, 0
	case .Map:
		m := (^runtime.Raw_Map)(p)
		if runtime.map_data(m^) == 0 do return
		ks, vs, hs, _, _ := runtime.map_kvh_data_dynamic(m^, plan.map_info)
		for i in 0..<uintptr(runtime.map_cap(m^)) {
			if !runtime.map_hash_is_valid(hs[i]) do continue
			if plan.elem != nil do run_plan(plan.elem, rawptr(runtime.map_cell_index_dynamic(vs, plan.map_info.vs, i)))
			if plan.key != nil do run_plan(plan.key, rawptr(runtime.map_cell_index_dynamic(ks, plan.map_info.ks, i)))
		}
		_ = runtime.map_free_dynamic(m^, plan.map_info)
		m.data, m.len = 0, 0
	}
}

@(private="file")
clone_plan :: proc(plan: ^Destroy_Plan, dst, src: rawptr) {
	if plan.destroy != nil {
		plan.clone(dst, src)
		return
	}
	for part in plan.parts {
		for i in 0..<part.count {
			at := part.offset + uintptr(i) * part.stride
			clone_plan(part.plan, rawptr(uintptr(dst) + at), rawptr(uintptr(src) + at))
		}
	}
	if plan.variants != nil {
		at := rawptr(uintptr(src) + plan.tag_off)
		tag: int
		switch plan.tag_size {
		case 1: tag = int((^u8)(at)^)
		case 2: tag = int((^u16)(at)^)
		case 4: tag = int((^u32)(at)^)
		case 8: tag = int((^u64)(at)^)
		}
		i := tag if plan.no_nil else tag - 1
		if i >= 0 && i < len(plan.variants) && plan.variants[i] != nil do clone_plan(plan.variants[i], dst, src)
	}
	// a dynamic array: new memory from the same allocator, each element a clone (a map is move-only)
	if plan.container == .Dynamic {
		s, d := (^runtime.Raw_Dynamic_Array)(src), (^runtime.Raw_Dynamic_Array)(dst)
		d^ = {allocator = s.allocator}
		if s.len == 0 do return
		bytes, err := runtime.mem_alloc_bytes(s.len * int(plan.elem_size), plan.elem_align, s.allocator)
		if err != nil do panic("vidar: out of memory cloning a dynamic array")
		d.data, d.len, d.cap = raw_data(bytes), s.len, s.len
		for i in 0..<uintptr(s.len) {
			at, from := rawptr(uintptr(d.data) + i * plan.elem_size), rawptr(uintptr(s.data) + i * plan.elem_size)
			intrinsics.mem_copy_non_overlapping(at, from, plan.elem_size)
			clone_plan(plan.elem, at, from)
		}
	}
}

@(private="file", cold)
generic_unknown :: proc "contextless" (ti: ^runtime.Type_Info) -> ! {
	runtime.print_string("vidar: generic code destroyed or copied a ")
	runtime.print_type(ti)
	runtime.print_string(", but it only knows it as a type parameter, and impl Destroy for a parametric type works only where the code names the type\\n")
	runtime.trap()
}

// destroys a value whose type the code can't name
destroy :: #force_inline proc(p: ^$T) {
	when intrinsics.type_is_struct(T) || intrinsics.type_is_union(T) || intrinsics.type_is_array(T) || intrinsics.type_is_enumerated_array(T) || intrinsics.type_is_dynamic_array(T) || intrinsics.type_is_map(T) {
		if plan := plan_of(T); plan != nil do run_plan(plan, p)
	}
}

// a copy of a value whose type the code can't name: stops the program when the type can't be copied
check_copy :: #force_inline proc "contextless" ($T: typeid, loc := #caller_location) {
	when intrinsics.type_is_struct(T) || intrinsics.type_is_union(T) || intrinsics.type_is_array(T) || intrinsics.type_is_enumerated_array(T) || intrinsics.type_is_dynamic_array(T) || intrinsics.type_is_map(T) {
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

// a copy of a value whose type the code can't name: a clone, or a stop when the type can't be copied
clone :: #force_inline proc(x: $T, loc := #caller_location) -> T {
	when intrinsics.type_is_struct(T) || intrinsics.type_is_union(T) || intrinsics.type_is_array(T) || intrinsics.type_is_enumerated_array(T) || intrinsics.type_is_dynamic_array(T) || intrinsics.type_is_map(T) {
		if plan := plan_of(T); plan != nil {
			if plan.move_only do copied(type_info_of(T), loc)
			src, dst := x, x
			clone_plan(plan, &dst, &src)
			return dst
		}
	}
	return x
}

// core's procs on dynamic arrays and maps, destroying the elements they drop
destroy_delete :: proc{destroy_delete_dynamic, destroy_delete_map}

// delete(a): destroys the elements, frees the memory and leaves a empty, so its own destroy does nothing
destroy_delete_dynamic :: proc(a: ^$A/[dynamic]$E, loc := #caller_location) {
	destroy(a)
	delete(a^, loc)
	r := (^runtime.Raw_Dynamic_Array)(a)
	r.data, r.len, r.cap = nil, 0, 0
}

destroy_delete_map :: proc(m: ^$M/map[$K]$V, loc := #caller_location) {
	destroy(m)
	delete(m^, loc)
	r := (^runtime.Raw_Map)(m)
	r.data, r.len = 0, 0
}

destroy_clear :: proc{destroy_clear_dynamic, destroy_clear_map}

destroy_clear_dynamic :: proc(a: ^$A/[dynamic]$E) {
	for i := len(a) - 1; i >= 0; i -= 1 do destroy(&a[i])
	clear(a)
}

destroy_clear_map :: proc(m: ^$M/map[$K]$V) {
	for k, &v in m {
		destroy(&v)
		key := k
		destroy(&key)
	}
	clear(m)
}

destroy_resize :: proc(a: ^$A/[dynamic]$E, #any_int length: int, loc := #caller_location) -> runtime.Allocator_Error {
	for i := len(a) - 1; i >= max(length, 0); i -= 1 do destroy(&a[i])
	return resize(a, length, loc)
}

destroy_ordered_remove :: proc(a: ^$A/[dynamic]$E, #any_int index: int, loc := #caller_location) {
	runtime.bounds_check_error_loc(loc, index, len(a))
	destroy(&a[index])
	ordered_remove(a, index, loc)
}

destroy_unordered_remove :: proc(a: ^$A/[dynamic]$E, #any_int index: int, loc := #caller_location) {
	runtime.bounds_check_error_loc(loc, index, len(a))
	destroy(&a[index])
	unordered_remove(a, index, loc)
}

destroy_remove_range :: proc(a: ^$A/[dynamic]$E, #any_int lo, hi: int, loc := #caller_location) {
	runtime.slice_expr_error_lo_hi_loc(loc, lo, hi, len(a))
	for i := hi - 1; i >= lo; i -= 1 do destroy(&a[i])
	remove_range(a, lo, hi, loc)
}

destroy_pop :: proc(a: ^$A/[dynamic]$E, loc := #caller_location) {
	v := pop(a, loc)
	destroy(&v)
}

destroy_pop_front :: proc(a: ^$A/[dynamic]$E, loc := #caller_location) {
	v := pop_front(a, loc)
	destroy(&v)
}

destroy_delete_key :: proc(m: ^$M/map[$K]$V, key: K) {
	k, v := delete_key(m, key)
	destroy(&v)
	destroy(&k)
}

// move!(x): x's value, leaving x zero
take :: #force_inline proc "contextless" (p: ^$T) -> T {
	v := p^
	intrinsics.mem_zero(p, size_of(T))
	return v
}

// a local moved out by return: left zero, so its defer destroys nothing
forget :: #force_inline proc "contextless" (p: ^$T) {
	intrinsics.mem_zero(p, size_of(T))
}
`;
