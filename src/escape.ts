import { basename } from "path";
import { Expr, Node, Stmt, children } from "./ast";
import { A, Analyzer, nodeText, posOf, unwrapProc } from "./analyzer";
import { CompileError } from "./lexer";
import { SCHED_IMPORT } from "./sched";
import type { CaptureSym, Ctx, LocalSym, Sym } from "./scope";

type ProcLit = Extract<Expr, { k: "ProcLit" }>;
type Call = Extract<Expr, { k: "Call" }>;

/** A closure literal holding `&x` of a local of the proc it is made in. */
interface Dangling {
  lit: ProcLit;
  cap: CaptureSym;
}

/** How a value leaves a proc: `what` happens at `at`, and then, for a call, what the callee does with it. */
interface Esc {
  what: string;
  at: Node;
  then?: Esc | "go";
}

/** What a proc does with each of its parameters (indexed like `A(lit)._params`). */
interface Summary {
  /** how the parameter escapes, when it does */
  esc: (Esc | undefined)[];
  /** the parameter is returned: the call's result holds what was passed */
  ret: boolean[];
}

type Summaries = Map<ProcLit, Summary>;

interface State {
  /** every proc body checked, with its frame */
  procs: Map<ProcLit, Ctx>;
  sums?: Summaries;
  /** `main` of the main package: its frame lasts as long as the program */
  mains?: Set<ProcLit>;
}

const states = new WeakMap<Analyzer, State>();

function stateOf(an: Analyzer): State {
  let s = states.get(an);
  if (!s) states.set(an, (s = { procs: new Map() }));
  return s;
}

/** `line 12`, or `file.vidar:12` when `at` is in another file than `file`. */
function where(at: Node, file: string): string {
  const pos = posOf(at);
  return pos.file === file ? `line ${pos.line}` : `${basename(pos.file)}:${pos.line}`;
}

function describe(e: Esc, file: string): string {
  const then = e.then === "go" ? ", which runs it on a goroutine that can outlive this proc" : e.then ? `, where it ${describe(e.then, file)}` : "";
  return `${e.what} (${where(e.at, file)})${then}`;
}

const danglingIn = (ctx: Ctx) => (lit: ProcLit): Dangling | undefined => {
  const cap = ((A(lit)._captures ?? []) as CaptureSym[]).find((c) => {
    if (!c.byRef) return false;
    // `&x` of a by-value capture points into this closure's copy of its environment
    return c.target.kind === "local" ? c.target.ctx === ctx : !c.target.byRef && c.target.ctx === ctx;
  });
  return cap && { lit, cap };
};

const danglingSource = (ctx: Ctx) => {
  const dangling = danglingIn(ctx);
  return (e: Expr): Dangling | undefined => (e.k === "ProcLit" && e.captures ? dangling(e) : undefined);
};

function danglingError(d: Dangling, esc: Esc, file: string): CompileError {
  const name = d.cap.name;
  return new CompileError(
    `this closure captures &${name} and ${describe(esc, file)}, but '${name}' lives in this proc's frame and is gone once it returns. Capture a pointer from new_clone(${name}) instead`,
    d.cap.declTok?.pos ?? posOf(d.lit),
  );
}

/**
 * A closure literal that captures `&x` of one of the proc's locals or parameters points into the
 * proc's frame. It is an error for it to outlive the proc: to be returned (directly, through a
 * local or a named result, or inside a struct literal), stored through a pointer, a slice or into a
 * global, or appended to something the proc doesn't own. Values it goes through locally are
 * followed here; calls it is passed to are checked by `checkCallEscapes` once every proc is known.
 */
export function checkEscapes(an: Analyzer, p: ProcLit, ctx: Ctx): void {
  stateOf(an).procs.set(p, ctx);
  const file = posOf(p).file;
  walk<Dangling>(an, p, ctx, danglingSource(ctx), (d, esc) => {
    throw danglingError(d, esc, file);
  });
}

/**
 * Once every proc body has been analyzed: summarizes what each proc does with its parameters, to a
 * fixed point over the call graph, then reports `&x` closures that escape through a call (passed to
 * `sched.go`, or to a parameter its proc lets escape). Escapes found without calls were already
 * reported by `checkEscapes`.
 */
export function checkCallEscapes(an: Analyzer, guard: (f: () => void) => void): void {
  const st = stateOf(an);
  const sums = summarize(an, st);
  for (const [p, ctx] of st.procs) {
    if (st.mains!.has(p)) continue;
    guard(() => {
      const first = (s: Summaries | undefined): Map<ProcLit, { d: Dangling; esc: Esc }> => {
        const found = new Map<ProcLit, { d: Dangling; esc: Esc }>();
        walk<Dangling>(an, p, ctx, danglingSource(ctx), (d, esc) => void (found.has(d.lit) || found.set(d.lit, { d, esc })), s);
        return found;
      };
      const local = first(undefined);
      for (const [lit, f] of first(sums)) if (!local.has(lit)) throw danglingError(f.d, f.esc, posOf(p).file);
    });
  }
}

/**
 * How the interface value `value` (made from a plain value in `p`'s frame) would outlive `p`, by
 * the same rules as a closure holding `&x`: "is returned (line 12)", or undefined when it doesn't.
 * Follows calls once `checkCallEscapes` has run.
 */
export function ifaceEscape(an: Analyzer, p: ProcLit, ctx: Ctx, value: Expr): string | undefined {
  const st = stateOf(an);
  const sums = st.mains?.has(p) ? undefined : st.sums;
  let found: string | undefined;
  walk<true>(an, p, ctx, (e) => (e === value || undefined), (_, esc) => void (found ??= describe(esc, posOf(p).file)), sums);
  return found;
}

function summarize(an: Analyzer, st: State): Summaries {
  const sums: Summaries = new Map();
  st.mains = new Set();
  for (const pkg of an.packages) {
    if (pkg.name !== "main") continue;
    const sym = pkg.scope.syms.get("main");
    const v = sym?.kind === "global" ? sym.decl.values[sym.index] : undefined;
    const lit = v && unwrapProc(v);
    if (lit) st.mains.add(lit);
  }
  const params = new Map<ProcLit, LocalSym[]>();
  for (const p of st.procs.keys()) {
    const ps: LocalSym[] = A(p)._params ?? [];
    if (!ps.length) continue;
    params.set(p, ps);
    sums.set(p, { esc: ps.map(() => undefined), ret: ps.map(() => false) });
  }
  st.sums = sums;
  for (let changed = true; changed; ) {
    changed = false;
    for (const [p, ps] of params) {
      const sum = sums.get(p)!;
      const initial = new Map<LocalSym, LocalSym>();
      for (const s of ps) if (!s.isConst) initial.set(s, s);
      walk<LocalSym>(an, p, st.procs.get(p)!, () => undefined, (s, esc) => {
        const i = ps.indexOf(s);
        if (esc.what === "is returned" && !esc.then) {
          if (!sum.ret[i]) (sum.ret[i] = true), (changed = true);
        } else if (!sum.esc[i]) (sum.esc[i] = esc), (changed = true);
      }, sums, initial);
    }
  }
  return sums;
}

/** The proc literal a call goes to, when it is a named proc constant. */
function calleeLit(fn: Expr): ProcLit | undefined {
  while (fn.k === "Paren") fn = fn.x;
  const sym: Sym | undefined = fn.k === "Ident" ? A(fn)._sym : fn.k === "Selector" ? A(fn)._pkgMember : undefined;
  if (sym?.kind === "global" && sym.isConst) {
    const v = sym.decl.values[sym.index];
    return v ? unwrapProc(v) : undefined;
  }
  if (sym?.kind === "local" && sym.isConst && sym.value) return unwrapProc(sym.value);
  return undefined;
}

/** `sched.go` and `sched.go_*`: the closure runs on a goroutine that can outlive the caller. */
function isSchedGo(fn: Expr): boolean {
  if (fn.k !== "Selector" || fn.x.k !== "Ident") return false;
  const pkg: Sym | undefined = A(fn.x)._sym;
  return pkg?.kind === "pkg" && pkg.path === SCHED_IMPORT && (fn.name === "go" || fn.name.startsWith("go_"));
}

/** Calls `f` with each argument of `call` and the index of the parameter of `lit` it is passed to. */
function eachArg(lit: ProcLit, call: Call, f: (arg: Expr, param: number) => void): void {
  const ps: LocalSym[] = A(lit)._params ?? [];
  if (!ps.length || lit.sig.unnamed) return;
  const names = lit.sig.params.flatMap((p) => p.names.map((n) => ({ name: n.name, variadic: p.type?.k === "Spread" })));
  call.args.forEach((a, i) => {
    if (a.k === "Spread") return;
    let at = i;
    if (a.k === "FieldValue") at = names.findIndex((n) => n.name === a.name);
    else if (at >= names.length && names[names.length - 1]?.variadic) at = names.length - 1;
    if (at >= 0 && at < ps.length) f(a, at);
  });
}

/**
 * Follows each value `source` picks out through `p`'s locals, calling `escaped` where one leaves the
 * proc. With `sums`, calls are followed too: an argument passed to a parameter its proc lets escape
 * escapes, and a call returning a parameter holds what was passed to it. `initial` starts locals out
 * holding a value (a proc's own parameters, for its summary).
 */
function walk<T>(an: Analyzer, p: ProcLit, ctx: Ctx, source: (e: Expr) => T | undefined, escaped: (d: T, esc: Esc) => void, sums?: Summaries, initial?: Map<LocalSym, T>): void {
  if (!p.body) return;
  const results = new Set<LocalSym>(A(p)._results ?? []);
  const held = new Map<LocalSym, T>(initial);
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
      case "ProcLit": {
        // a closure holding a copy of a tracked value carries it
        if (!sums || !e.captures) return undefined;
        for (const c of (A(e)._captures ?? []) as CaptureSym[]) {
          const d = !c.byRef && ownLocal(c.target) ? held.get(c.target) : undefined;
          if (d) return d;
        }
        return undefined;
      }
      case "Call": {
        const lit = sums && calleeLit(e.fn);
        const sum = lit && sums.get(lit);
        if (!sum) return undefined;
        let found: T | undefined;
        eachArg(lit, e, (a, i) => void (sum.ret[i] && (found ??= carried(a))));
        return found;
      }
      default: return undefined;
    }
  };

  const fail = (d: T, what: string, at: Node, then?: Esc | "go"): void => {
    if (report) escaped(d, { what, at, then });
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

  /** A call that isn't `append`: what the callee does with each argument. */
  const call = (n: Call): void => {
    if (!sums) return;
    if (isSchedGo(n.fn)) {
      for (const a of n.args) {
        const d = carried(a);
        if (d) fail(d, `is passed to ${nodeText(n.fn)}`, n, "go");
      }
      return;
    }
    const lit = calleeLit(n.fn);
    const sum = lit && sums.get(lit);
    if (!sum) return; // proc values, foreign and core: procs are trusted
    eachArg(lit, n, (a, i) => {
      const esc = sum.esc[i];
      const d = esc && carried(a);
      if (d) fail(d, `is passed to ${nodeText(n.fn)}`, n, esc);
    });
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
        else call(n);
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
