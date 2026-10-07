import { Expr, Node, Stmt, children } from "./ast";
import { A, Analyzer, posOf } from "./analyzer";
import { CompileError } from "./lexer";
import type { CaptureSym, Ctx, LocalSym, Sym } from "./scope";

type ProcLit = Extract<Expr, { k: "ProcLit" }>;

/** A closure literal holding `&x` of a local of the proc it is made in. */
interface Dangling {
  lit: ProcLit;
  cap: CaptureSym;
}

/**
 * A closure literal that captures `&x` of one of the proc's locals or parameters points into the
 * proc's frame. It is an error for it to outlive the proc: to be returned (directly, through a
 * local or a named result, or inside a struct literal), stored through a pointer, a slice or into a
 * global, or appended to something the proc doesn't own. Values it goes through locally are
 * followed; calls it is passed to are not.
 */
export function checkEscapes(an: Analyzer, p: ProcLit, ctx: Ctx): void {
  const dangling = (lit: ProcLit): Dangling | undefined => {
    const cap = ((A(lit)._captures ?? []) as CaptureSym[]).find((c) => {
      if (!c.byRef) return false;
      // `&x` of a by-value capture points into this closure's copy of its environment
      return c.target.kind === "local" ? c.target.ctx === ctx : !c.target.byRef && c.target.ctx === ctx;
    });
    return cap && { lit, cap };
  };
  walk<Dangling>(an, p, ctx, (e) => (e.k === "ProcLit" && e.captures ? dangling(e) : undefined), (d, what, at) => {
    const name = d.cap.name;
    const line = posOf(at).line;
    throw new CompileError(
      `this closure captures &${name} and ${what} (line ${line}), but '${name}' lives in this proc's frame and is gone once it returns. Capture a pointer from new_clone(${name}) instead`,
      d.cap.declTok?.pos ?? posOf(d.lit),
    );
  });
}

/**
 * How the interface value `value` (made from a plain value in `p`'s frame) would outlive `p`, by
 * the same rules as a closure holding `&x`: "is returned (line 12)", or undefined when it doesn't.
 */
export function ifaceEscape(an: Analyzer, p: ProcLit, ctx: Ctx, value: Expr): string | undefined {
  let found: string | undefined;
  walk<true>(an, p, ctx, (e) => (e === value || undefined), (_, what, at) => void (found ??= `${what} (line ${posOf(at).line})`));
  return found;
}

/** Follows each value `source` picks out through `p`'s locals, calling `escaped` where one leaves the proc. */
function walk<T>(an: Analyzer, p: ProcLit, ctx: Ctx, source: (e: Expr) => T | undefined, escaped: (d: T, what: string, at: Node) => void): void {
  if (!p.body) return;
  const results = new Set<LocalSym>(A(p)._results ?? []);
  const held = new Map<LocalSym, T>();
  let report = false;

  const ownLocal = (s: Sym | undefined): s is LocalSym => s?.kind === "local" && s.ctx === ctx;

  /** The tracked value `e` evaluates to, or holds. */
  const carried = (e: Expr | null | undefined): T | undefined => {
    if (!e) return undefined;
    const d = source(e);
    if (d !== undefined) return d;
    switch (e.k) {
      case "Paren": return carried(e.x);
      case "Ident": {
        const s: Sym | undefined = A(e)._sym;
        return ownLocal(s) ? held.get(s) : undefined;
      }
      case "Ternary": return carried(e.a) ?? carried(e.b);
      case "FieldValue": return carried(e.value);
      case "CompoundLit": {
        for (const x of e.elems) {
          const d = carried(x);
          if (d) return d;
        }
        return undefined;
      }
      default: return undefined;
    }
  };

  const fail = (d: T, what: string, at: Node): void => {
    if (report) escaped(d, what, at);
  };

  const hold = (s: LocalSym, d: T, at: Node): void => {
    if (results.has(s)) return fail(d, "is returned", at);
    if (!held.has(s)) held.set(s, d);
  };

  /** `target = <d>`, or an append to `target`. */
  const store = (target: Expr, d: T, at: Node, appended = false): void => {
    const into = appended ? "is appended to" : "is stored in";
    let e = target;
    for (;;) {
      if (e.k === "Paren") e = e.x;
      else if (e.k === "Deref") return fail(d, `${into} memory behind a pointer`, at);
      else if (e.k === "Selector" || e.k === "Index") {
        if (e.k === "Selector" && A(e)._pkgMember) return fail(d, `${into} a global`, at);
        const scope = A(e.x)._scope;
        let t = scope ? an.normalize(an.typeOf(e.x, scope)) : undefined;
        if (t?.t === "ptr") return fail(d, `${into} memory behind a pointer`, at);
        t = t?.t === "node" ? t : undefined;
        if (t?.node.k === "TypeExpr" && ["slice", "multipointer"].includes(t.node.what)) return fail(d, `${into} a slice's elements`, at);
        e = e.x;
      } else break;
    }
    if (e.k !== "Ident") return;
    const s: Sym | undefined = A(e)._sym;
    if (s?.kind === "global") return fail(d, `${into} a global`, at);
    if (s?.kind === "capture" && s.byRef) return fail(d, `${into} a variable of an outer proc`, at);
    if (ownLocal(s)) hold(s, d, at);
  };

  const visit = (n: Node): void => {
    switch (n.k) {
      case "ProcLit": return; // its own frame, checked on its own
      case "ValueDecl": {
        const s = n as Extract<Stmt, { k: "ValueDecl" }>;
        const syms: LocalSym[] = A(s)._syms ?? [];
        if (!s.isConst && s.values.length === s.names.length)
          s.values.forEach((v, i) => {
            const d = carried(v);
            if (d && syms[i]) hold(syms[i], d, s);
          });
        break;
      }
      case "Assign":
        if (n.op === "=" && n.lhs.length === n.rhs.length)
          n.rhs.forEach((v, i) => {
            const d = carried(v);
            if (d) store(n.lhs[i], d, n);
          });
        break;
      case "Return":
        for (const r of n.results) {
          const d = carried(r);
          if (d) fail(d, "is returned", n);
        }
        break;
      case "Call":
        if (n.fn.k === "Ident" && n.fn.name === "append" && !A(n.fn)._sym && n.args.length > 1)
          for (const a of n.args.slice(1)) {
            const d = carried(a);
            if (!d) continue;
            const dst = n.args[0];
            if (dst.k === "Unary" && dst.op === "&") store(dst.x, d, n, true);
            else fail(d, "is appended to memory behind a pointer", n);
          }
        break;
    }
    for (const c of children(n)) visit(c);
  };

  // follow values through locals until nothing new is held, then report
  for (let size = -1; size !== held.size; ) {
    size = held.size;
    visit(p.body);
  }
  report = true;
  visit(p.body);
}
