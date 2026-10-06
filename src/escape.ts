import { dirname } from "node:path";
import { Block, Expr, Node, children } from "./ast";
import { A, Analyzer, nodeText, posOf, unwrapProc } from "./analyzer";
import { schedSourcePath } from "./project";
import type { CaptureSym, GlobalSym, LocalSym, PackageInfo, Sym } from "./scope";

type ProcLit = Extract<Expr, { k: "ProcLit" }>;
type Call = Extract<Expr, { k: "Call" }>;

/** What one procedure body does with its locals. */
interface Body {
  parents: Map<Node, Node>;
  uses: Map<LocalSym, Expr[]>;
  /** locals a closure literal in the body captures */
  captured: Set<LocalSym>;
  /** proc literals directly in the body */
  lits: ProcLit[];
  /** holds code vidar doesn't analyze, so any local may escape */
  opaque: boolean;
}

/**
 * -opt: where each closure literal's environment lives. One by-reference capture is the env
 * pointer itself (`_envInPtr`); an env whose closure provably doesn't outlive the statement that
 * creates it goes on the creating procedure's stack (`_envOnStack`); the rest stay on the heap.
 */
export function closureEnvs(an: Analyzer, packages: PackageInfo[]): void {
  const esc = new Escapes(an);
  for (const pkg of packages)
    for (const f of pkg.files)
      for (const s of f.stmts) {
        if (s.k !== "ValueDecl") continue;
        const syms: GlobalSym[] = A(s)._syms ?? [];
        s.values.forEach((v, i) => {
          const lit = unwrapProc(v);
          if (lit?.body && !lit.comptime && syms[i]) esc.proc(lit.body, syms[i]);
        });
      }
}

class Escapes {
  private bodies = new Map<Block, Body>();
  /** why a callee's parameter escapes ("" when it doesn't) */
  private params = new Map<LocalSym, string>();
  private inProgress: LocalSym[] = [];
  private schedDir = dirname(schedSourcePath());

  constructor(private an: Analyzer) {}

  private hint(owner: GlobalSym, lit: ProcLit, label: string, why: string): void {
    if (owner.pkg.dir !== this.schedDir) this.an.hint(lit, label, why);
  }

  proc(body: Block, owner: GlobalSym): void {
    const b = this.scan(body);
    for (const lit of b.lits) {
      if (lit.captures && A(lit)._captures?.length) this.decide(lit, b, owner);
      if (lit.body) this.proc(lit.body, owner);
    }
  }

  private decide(lit: ProcLit, b: Body, owner: GlobalSym): void {
    if (A(lit)._envDecided || A(lit)._inlined) return;
    A(lit)._envDecided = true;
    const caps: CaptureSym[] = A(lit)._captures;
    if (caps.length === 1 && caps[0].byRef) {
      A(lit)._envInPtr = true;
      return this.hint(owner, lit, "env in pointer", "its one capture is by reference, so the pointer is the env (no allocation)");
    }
    const why = b.opaque
      ? "the procedure has code vidar doesn't analyze"
      : caps.some((c) => c.target.kind === "local" && c.target.isConst)
        ? "it captures a constant"
        : this.leaksEnv(lit)
          ? "its body takes the address of a capture"
          : this.escapes(lit, b);
    if (why) return this.hint(owner, lit, "no stack env", `env on the heap: ${why}`);
    A(lit)._envOnStack = true;
    this.hint(owner, lit, "stack env", "the closure doesn't outlive this call, so its env is a stack temporary");
  }

  /** Whether a pointer into the closure's env could outlive a call to it. */
  private leaksEnv(lit: ProcLit): boolean {
    const own = new Set<Sym>((A(lit)._captures as CaptureSym[]).filter((c) => !c.byRef));
    const inEnv = (e: Expr): boolean => {
      while (e.k === "Selector" || e.k === "Index" || e.k === "Paren") e = e.x;
      return e.k === "Ident" && own.has(A(e)._sym);
    };
    let leaks = false;
    const visit = (n: Node) => {
      if (n.k === "ProcLit") {
        leaks ||= ((A(n)._captures as CaptureSym[] | undefined) ?? []).some((c) => c.byRef && own.has(c.target));
        return;
      }
      if (n.k === "Unary" && n.op === "&") leaks ||= inEnv(n.x);
      if (n.k === "Index" && n.slice) leaks ||= inEnv(n.x);
      if (n.k === "ArrowCall") leaks ||= inEnv(n.x);
      if (n.k === "RangeFor" && n.vals.some((v) => v.byRef)) leaks ||= inEnv(n.x);
      if (n.k === "Using") leaks ||= n.x.some(inEnv);
      const exp: Node | undefined = A(n)._expansion;
      const kids = (n.k === "MacroCall" || n.k === "ExprStmt") && exp ? [exp] : children(n);
      for (const c of [...kids, ...((A(n)._pre as Node[] | undefined) ?? [])]) visit(c);
    };
    visit(lit.body!);
    return leaks;
  }

  /** Why the value of `e` may outlive the statement that computes it; "" when it can't. */
  private escapes(e: Expr, b: Body): string {
    let child: Node = e;
    let p = b.parents.get(e);
    while (p?.k === "Paren") {
      child = p;
      p = b.parents.get(p);
    }
    const line = ` (line ${posOf(child).line})`;
    if (!p) return `it is used where vidar can't follow it${line}`;
    if (p.k === "Call") return p.fn === child ? "" : this.passed(p, p.args.indexOf(child as Expr), b);
    if (p.k === "FieldValue") {
      const call = b.parents.get(p);
      if (call?.k === "Call" && call.args.includes(p)) return this.passed(call, p.name, b);
    }
    if (p.k === "ValueDecl" && !p.isConst && p.names.length === p.values.length) {
      const sym: LocalSym | undefined = A(p)._syms?.[p.values.indexOf(child as Expr)];
      if (sym) return this.local(sym, b);
    }
    if (p.k === "Return") return `it is returned${line}`;
    if (p.k === "Assign") return `it is assigned${line}`;
    if (p.k === "CompoundLit" || p.k === "FieldValue") return `it is stored in a literal${line}`;
    return `it is used where vidar can't follow it${line}`;
  }

  private local(sym: LocalSym, b: Body): string {
    if (sym.refCaptured || b.captured.has(sym)) return `'${sym.name}' is captured by a closure`;
    for (const use of b.uses.get(sym) ?? []) {
      const why = this.escapes(use, b);
      if (why) return why.replace(/^it /, `'${sym.name}' `);
    }
    return "";
  }

  /** Why an argument to `call` may escape; `at` is its position, or its name for `name = value`. */
  private passed(call: Call, at: number | string, b: Body): string {
    const name = nodeText(call.fn);
    const fn = call.fn.k === "Ident" ? A(call.fn)._sym : call.fn.k === "Selector" ? A(call.fn)._pkgMember : undefined;
    const lit = this.callee(fn);
    const params: LocalSym[] = lit ? A(lit)._params ?? [] : [];
    const names = lit ? lit.sig.params.flatMap((p) => p.names.map((n) => n.name)) : [];
    const i = typeof at === "string" ? names.indexOf(at) : call.args.some((a) => a.k === "Spread") ? -1 : at;
    const param = i >= 0 && params.length === names.length ? params[i] : undefined;
    if (!lit?.body || !param || param.name !== names[i]) return `it is passed to '${name}' (line ${posOf(call).line})`;
    const why = this.param(param, lit.body);
    return why && `it is passed to '${name}', where '${param.name}' ${why.replace(/^'[^']*' |^it /, "")}`;
  }

  /** A proc declaration with a body that a call to `sym` runs. */
  private callee(sym: Sym | undefined): ProcLit | undefined {
    let value: Expr | undefined;
    if (sym?.kind === "global" && sym.isConst && !this.an.whenDeclared.has(sym)) value = sym.decl.values[sym.index];
    if (sym?.kind === "local" && sym.isConst) value = sym.value;
    const lit = value && unwrapProc(value);
    return lit && !lit.captures && !lit.comptime && !lit.sig.unnamed ? lit : undefined;
  }

  private param(sym: LocalSym, body: Block): string {
    const known = this.params.get(sym);
    if (known !== undefined) return known;
    // a parameter passed back to its own procedure escapes only if it escapes elsewhere
    if (this.inProgress.includes(sym)) return this.inProgress[this.inProgress.length - 1] === sym ? "" : "is passed around recursively";
    const b = this.scan(body);
    this.inProgress.push(sym);
    let why: string;
    try {
      why = b.opaque ? "is used in code vidar doesn't analyze" : this.local(sym, b);
    } finally {
      this.inProgress.pop();
    }
    this.params.set(sym, why);
    return why;
  }

  private scan(body: Block): Body {
    const known = this.bodies.get(body);
    if (known) return known;
    const b: Body = { parents: new Map(), uses: new Map(), captured: new Set(), lits: [], opaque: false };
    const visit = (n: Node) => {
      if (n.k === "ProcLit") {
        b.lits.push(n);
        for (const c of (A(n)._captures as CaptureSym[] | undefined) ?? []) if (c.target.kind === "local") b.captured.add(c.target);
        return;
      }
      if (n.k === "Raw" || n.k === "RawStmt" || n.k === "Quote") b.opaque = true;
      if (n.k === "Ident") {
        const sym: Sym | undefined = A(n)._sym;
        if (sym?.kind === "local") b.uses.set(sym, [...(b.uses.get(sym) ?? []), n]);
      }
      const exp: Node | undefined = A(n)._expansion;
      if ((n.k === "MacroCall" || n.k === "ExprStmt") && exp) {
        b.parents.set(exp, n);
        visit(exp);
      } else if (n.k === "MacroCall") b.opaque = true;
      else
        for (const c of children(n)) {
          b.parents.set(c, n);
          visit(c);
        }
      for (const s of (A(n)._pre as Node[] | undefined) ?? []) visit(s);
    };
    visit(body);
    this.bodies.set(body, b);
    return b;
  }
}
