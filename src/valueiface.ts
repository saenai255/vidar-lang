import { Block, Expr, Node, Stmt } from "./ast";
import { A, Analyzer, IfaceMethod, ImplInfo, nodeText, posOf } from "./analyzer";
import { kids } from "./optimize";
import { sizeOf } from "./soa";
import type { GlobalSym, LocalSym, Sym } from "./scope";


/** an implementation bigger than this would make every element of the union that big */
export const MAX_VALUE_BYTES = 64;

/** -opt: a local `[dynamic]I` holding its implementations inline, as a union. */
export interface ValueIface {
  iface: GlobalSym;
  variants: ImplInfo[];
}

/** A method call on an element: `m(s, ...)` or `m(xs[i], ...)`. */
export interface ValueCall {
  iface: GlobalSym;
  method: IfaceMethod;
  receiver: Expr;
  args: Expr[];
}

/**
 * -opt: a local `[dynamic]I` (I an interface whose implementations are all known, without bases)
 * whose elements all come from `new_clone(value)` holds a union of the implementations instead,
 * stored inline: no allocation per element, and calls switch on the type instead of going through
 * a vtable. Only where nobody can tell the difference: each element is reachable only through the
 * array (every one is a fresh `new_clone`), and the array is only appended to, measured, cleared,
 * deleted, and used to call I's methods on its elements, in place (`for &s in xs`).
 */
export function valueInterfaces(body: Block, an: Analyzer): void {
  const visit = (n: Node): void => {
    if (n.k === "Block") for (const s of n.stmts) if (s.k === "ValueDecl") consider(s, body, an);
    for (const c of kids(n)) if (c.k !== "ProcLit") visit(c);
  };
  visit(body);
}

function consider(s: Extract<Stmt, { k: "ValueDecl" }>, body: Block, an: Analyzer): void {
  if (s.isConst || s.names.length !== 1 || A(s)._pre?.length) return;
  const sym: LocalSym | undefined = A(s)._syms?.[0];
  if (!sym || sym.refCaptured) return;
  // `xs: [dynamic]I`, `xs := make([dynamic]I, ...)` or `xs: [dynamic]I = make(...)`
  const make = s.values[0];
  const madeType = make?.k === "Call" && make.fn.k === "Ident" && make.fn.name === "make" && !A(make.fn)._sym ? make.args[0] : undefined;
  if (s.values.length > 1 || (s.values.length === 1 && !madeType)) return;
  const types = [s.type, madeType].filter((t): t is Expr => !!t);
  if (!types.length) return;
  const elem = (t: Expr) => (t.k === "TypeExpr" && t.what === "dynamic" && !t.parts[0] && t.parts[1] ? t.parts[1] : undefined);
  const elems = types.map(elem);
  if (elems.some((e) => !e)) return;
  const scope = A(s)._scope ?? sym.scope;
  const iface = an.ifaceOf({ t: "node", node: elems[0]!, scope: A(elems[0]!)._scope ?? scope });
  if (!iface) return;
  const no = (why: string) => an.hint(s, "no value interface", `${sym.name}: ${why}`);
  if (!an.isClosed(iface) || an.basesOf(iface).length || an.ancestorsOf(iface).length) return no(`'${iface.name}' extends or is extended by another interface, or has implementations outside what vidar sees`);
  const variants = an.variants(iface);
  if (!variants.length) return;
  for (const v of variants) {
    const target: Sym | undefined = A(v.node.target)._sym ?? A(v.node.target)._pkgMember;
    if (target?.kind !== "global") return no(`can't tell what '${nodeText(v.node.target)}' is`);
    const bytes = sizeOf(an, { t: "node", node: v.node.target, scope: target.scope });
    if (bytes > MAX_VALUE_BYTES) return no(`${nodeText(v.node.target)} is ~${bytes} bytes, more than ${MAX_VALUE_BYTES} to store inline`);
  }
  const methods = new Map(an.allMethods(iface).map((m) => [m.sym, m] as const));
  for (const v of variants) for (const [name, bound] of v.methods) {
    const value = bound.decl.values[bound.index];
    const lit = value?.k === "ProcLit" ? value : undefined;
    if (!lit || keepsReceiver(lit)) return no(`'${bound.name}' (${nodeText(v.node.target)}.${name}) uses its receiver other than through its fields, and could keep a pointer to it`);
  }
  const plan = uses(s, sym, iface, methods, body, an);
  if (typeof plan === "string") return no(plan);
  // commit: annotations the emitter reads
  for (const t of types) A(t)._valueIface = { iface, variants } satisfies ValueIface;
  for (const [arg, value] of plan.appends) A(arg)._valueOf = value;
  for (const loop of plan.loops) A(loop)._valueLoop = true;
  for (const [call, vc] of plan.calls) A(call)._valueCall = vc;
  an.hint(s, "value interface", `${sym.name} holds ${variants.map((v) => nodeText(v.node.target)).join(", ")} inline, as a union: no allocation per element, calls switch on the type instead of going through a vtable`);
}

function contains(root: Node, target: Node): boolean {
  if (root === target) return true;
  return kids(root).some((c) => contains(c, target));
}

interface Plan {
  appends: Map<Expr, Expr>;
  loops: Set<Node>;
  calls: Map<Node, ValueCall>;
}

/** Every use of `sym` is one the union form keeps the meaning of; the rewrites, or why not. */
function uses(decl: Node, sym: LocalSym, iface: GlobalSym, methods: Map<GlobalSym, IfaceMethod>, body: Block, an: Analyzer): Plan | string {
  const plan: Plan = { appends: new Map(), loops: new Set(), calls: new Map() };
  const loopVars = new Set<LocalSym>();
  const line = (n: Node) => ` (line ${posOf(n).line})`;
  const stack: Node[] = [];
  let why: string | undefined;

  const methodCall = (n: Node): { m: IfaceMethod; receiver: Expr; args: Expr[] } | undefined => {
    if (n.k === "Call" && !n.args.some((a) => a.k === "FieldValue" || a.k === "Spread")) {
      const fn: Sym | undefined = n.fn.k === "Ident" ? A(n.fn)._sym : n.fn.k === "Selector" ? A(n.fn)._pkgMember : undefined;
      const m = fn?.kind === "global" ? methods.get(fn) : undefined;
      if (m && n.args.length) return { m, receiver: n.args[0], args: n.args.slice(1) };
    }
    return undefined;
  };
  /** `new_clone(v)` of a value whose type is one of the implementations */
  const fresh = (a: Expr): Expr | undefined => {
    if (a.k !== "Call" || a.fn.k !== "Ident" || a.fn.name !== "new_clone" || A(a.fn)._sym || a.args.length !== 1) return undefined;
    const v = a.args[0];
    const bin = an.poolBin(iface, an.typeOf(v, A(v)._scope ?? an.global));
    return bin ? v : undefined;
  };
  const asReceiver = (e: Expr): boolean => {
    const p = stack[stack.length - 1];
    const call = p && methodCall(p);
    if (!call || call.receiver !== e) return false;
    plan.calls.set(p, { iface, method: call.m, receiver: call.receiver, args: call.args });
    return true;
  };

  const use = (n: Extract<Expr, { k: "Ident" }>): void => {
    // inside a loop over the array, an append or clear would move the elements `&s` points at
    if (stack.some((a) => plan.loops.has(a) && (a as Extract<Stmt, { k: "RangeFor" }>).x !== n && contains((a as Extract<Stmt, { k: "RangeFor" }>).body, n)))
      return void (why ??= `${sym.name} is used inside a loop over it${line(n)}`);
    const p = stack[stack.length - 1];
    const g = stack[stack.length - 2];
    // len(xs), cap(xs), delete(xs), clear(&xs), append(&xs, new_clone(v), ...)
    if (p?.k === "Call" && p.fn.k === "Ident" && !A(p.fn)._sym && p.args[0] === n && ["len", "cap", "delete"].includes(p.fn.name) && p.args.length === 1) return;
    if (p?.k === "Unary" && p.op === "&" && g?.k === "Call" && g.fn.k === "Ident" && !A(g.fn)._sym && g.args[0] === p) {
      if (g.fn.name === "clear" && g.args.length === 1) return;
      if (g.fn.name === "append" && g.args.length > 1) {
        for (const a of g.args.slice(1)) {
          const v = fresh(a);
          if (!v) return void (why ??= `${sym.name} gets a value that isn't a fresh new_clone of an implementation${line(a)}`);
          plan.appends.set(a, v);
        }
        return;
      }
    }
    // for s in xs, with s only a method receiver
    if (p?.k === "RangeFor" && p.x === n) {
      const v: LocalSym | undefined = A(p)._syms?.[0];
      if (A(p)._pool || p.vals[0]?.byRef || !v) return void (why ??= `a loop over ${sym.name} takes its elements by reference${line(p)}`);
      loopVars.add(v);
      plan.loops.add(p);
      return;
    }
    // m(xs[i], ...)
    if (p?.k === "Index" && p.x === n && !p.slice && p.indices.length === 1) {
      stack.pop();
      const ok = asReceiver(p);
      stack.push(p);
      if (ok) return;
    }
    why ??= `${sym.name} is used other than to append, loop over, index for a method call, len, clear or delete${line(n)}`;
  };

  const visit = (n: Node): void => {
    if (why) return;
    if (n.k === "ProcLit") {
      for (const c of (A(n)._captures ?? []) as Sym[]) {
        let t: Sym = c;
        while (t.kind === "capture") t = t.target;
        if (t === sym || loopVars.has(t as LocalSym)) why ??= `a closure captures it${line(n)}`;
      }
      return;
    }
    if (n.k === "Ident") {
      const s: Sym | undefined = A(n)._sym;
      if (s === sym && n !== (decl as Extract<Stmt, { k: "ValueDecl" }>).values[0]) use(n);
      else if (s?.kind === "local" && loopVars.has(s) && !asReceiver(n)) why ??= `a loop's element is used other than to call a method of '${iface.name}'${line(n)}`;
      return;
    }
    stack.push(n);
    for (const c of kids(n)) visit(c);
    stack.pop();
  };
  visit(body);
  return why ?? plan;
}

/**
 * Whether an impl method only reads and writes through its receiver (`self.f`, `self^`): with the
 * value inline in the array, a receiver pointer kept anywhere would dangle once the array grows.
 */
export function keepsReceiver(lit: Extract<Expr, { k: "ProcLit" }>): boolean {
  const recv = ((A(lit)._params ?? []) as LocalSym[])[0];
  if (!recv || !lit.body) return true;
  let kept = false;
  const stack: Node[] = [];
  const visit = (n: Node): void => {
    if (kept) return;
    if (n.k === "ProcLit") {
      for (const c of (A(n)._captures ?? []) as Sym[]) if ((c as { target?: Sym }).target === recv) kept = true;
      return;
    }
    if (n.k === "Ident" && A(n)._sym === recv) {
      const p = stack[stack.length - 1];
      if (!((p?.k === "Selector" && p.x === n) || (p?.k === "Deref" && p.x === n))) kept = true;
      return;
    }
    stack.push(n);
    for (const c of kids(n)) visit(c);
    stack.pop();
  };
  visit(lit.body);
  return kept;
}
