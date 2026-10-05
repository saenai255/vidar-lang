import type { Token } from "./lexer";

/**
 * Every node remembers the token range it was parsed from, so unchanged code is
 * re-emitted byte-for-byte. Fields starting with `_` are analysis annotations and
 * are never treated as children.
 */
interface Base {
  toks: Token[];
  start: number;
  end: number;
}

type N<K extends string, F> = Base & { k: K } & F;

export interface Param {
  names: { name: string; tok: number; prefix?: string }[];
  type?: Expr;
  value?: Expr;
}

export interface ProcSig {
  params: Param[];
  /** true when parameters were written as bare types, e.g. proc(int, string) */
  unnamed: boolean;
  results: Param[];
  resultsUnnamed: boolean;
}

export interface Capture {
  name: string;
  tok: number;
  byRef: boolean;
}

export type Expr =
  | N<"Ident", { name: string }>
  | N<"Lit", { kind: "int" | "float" | "imag" | "string" | "rune" | "undef" }>
  | N<"Unary", { op: string; x: Expr }>
  | N<"Binary", { op: string; x: Expr; y: Expr }>
  | N<"Ternary", { cond: Expr; a: Expr; b: Expr }>
  | N<"Paren", { x: Expr }>
  | N<"Call", { fn: Expr; args: Expr[] }>
  | N<"FieldValue", { name: string; value: Expr }>
  | N<"Spread", { x: Expr }>
  | N<"Selector", { x: Expr; name: string }>
  | N<"ImplicitSelector", { name: string }>
  | N<"Index", { x: Expr; indices: (Expr | null)[]; slice: boolean }>
  | N<"Deref", { x: Expr }>
  | N<"TypeAssert", { x: Expr; type: Expr | null }>
  | N<"ArrowCall", { x: Expr; name: string; args: Expr[] }>
  /** `or_return`, `or_break`, `or_continue`; `value` is the extension `or_return <error to return>` */
  | N<"Postfix", { op: string; x: Expr; value: Expr | null }>
  | N<"CompoundLit", { type: Expr | null; elems: Expr[] }>
  | N<"Cast", { op: string; type: Expr | null; x: Expr }>
  | N<"ProcLit", { sig: ProcSig; body: Block | null; captures: Capture[] | null; comptime: boolean; _ctx?: unknown }>
  | N<"ProcType", { sig: ProcSig }>
  | N<"ProcGroup", { procs: Expr[] }>
  | N<"ClosureType", { sig: ProcSig }>
  | N<"StructType", { fields: Param[]; polyParams: Param[] | null; extra: Expr[] }>
  | N<"UnionType", { variants: Expr[]; polyParams: Param[] | null }>
  | N<"InterfaceType", { methods: { name: string; tok: number }[] }>
  | N<"EnumType", { base: Expr | null; members: { name: string; value: Expr | null }[] }>
  | N<"TypeExpr", { what: string; parts: (Expr | null)[] }>
  | N<"Poly", { name: string; spec: Expr | null }>
  | N<"Directive", { name: string; args: Expr[] | null; x: Expr | null }>
  | N<"Raw", {}>
  /** `blockArg`: the last argument was written as a trailing block, `name!(...) { ... }` or `name! { ... }` */
  | N<"MacroCall", { path: string[]; args: Token[][]; blockArg: boolean; _expansion?: Expr }>
  | N<"Quote", { kind: "expr" | "stmt"; body: Token[] }>;

export interface Block extends Base {
  k: "Block";
  stmts: Stmt[];
  /** synthesized from a statement macro: no braces, lives in the enclosing scope */
  inline?: boolean;
}

export type Stmt =
  | Block
  | N<"ValueDecl", { names: { name: string; tok: number }[]; type: Expr | null; values: Expr[]; isConst: boolean; attrs: string[] }>
  | N<"Assign", { lhs: Expr[]; op: string; rhs: Expr[] }>
  | N<"ExprStmt", { x: Expr; _expansion?: Block }>
  | N<"If", { init: Stmt | null; cond: Expr; then: Block; else: Stmt | null }>
  | N<"When", { cond: Expr; then: Block; else: Stmt | null }>
  | N<"For", { init: Stmt | null; cond: Expr | null; post: Stmt | null; body: Block }>
  | N<"RangeFor", { vals: { name: string; tok: number; byRef: boolean }[]; x: Expr; body: Block }>
  | N<"Switch", { init: Stmt | null; tag: Expr | null; typeSwitchVar: { name: string; tok: number } | null; cases: Case[] }>
  | N<"Return", { results: Expr[] }>
  | N<"Branch", { op: string }>
  | N<"Defer", { stmt: Stmt }>
  | N<"Using", { x: Expr[] }>
  | N<"Labeled", { label: string; stmt: Stmt }>
  | N<"DirectiveStmt", { name: string; stmt: Stmt }>
  | N<"Package", { name: string; nameTok: number }>
  | N<"Import", { alias: string | null; aliasTok: number; path: string; pathTok: number }>
  | N<"ImplBlock", { iface: Expr; target: Expr; bindings: { name: string; tok: number; value: Expr }[] }>
  /** `stmt catch err { ... }` / `stmt catch unreachable`: stmt is a declaration, assignment or call */
  | N<"Catch", { stmt: Stmt; errName: string | null; errTok: number; unreachable: boolean; body: Block | null }>
  /** `errdefer stmt`: a defer that only runs when the procedure returns a failure */
  | N<"ErrDefer", { stmt: Stmt }>
  /** `go f(args)`: runs the call on a new goroutine */
  | N<"Go", { call: Expr }>
  /** `ch <- value` */
  | N<"Send", { ch: Expr; value: Expr }>
  | N<"Select", { cases: SelectCase[] }>
  | N<"RawStmt", {}>
  | N<"Empty", {}>;

export interface Case extends Base {
  k: "Case";
  exprs: Expr[];
  body: Stmt[];
}

/** One `select` arm; `comm` is null for the default `case:`, else a receive or a send. */
export interface SelectCase extends Base {
  k: "SelectCase";
  comm: Stmt | null;
  body: Stmt[];
}

export type Node = Expr | Stmt | Case | SelectCase;

export interface File {
  path: string;
  toks: Token[];
  stmts: Stmt[];
}

/** Child nodes of `n`, found structurally (annotation fields are skipped). */
export function children(n: Node): Node[] {
  const out: Node[] = [];
  const visit = (v: unknown) => {
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const x of v) visit(x);
      return;
    }
    const o = v as Record<string, unknown>;
    if ("text" in o && "pre" in o) return;
    if (typeof o.k === "string" && "toks" in o) {
      out.push(o as unknown as Node);
      return;
    }
    for (const [key, x] of Object.entries(o)) if (key !== "toks" && !key.startsWith("_")) visit(x);
  };
  for (const [key, v] of Object.entries(n)) {
    if (key === "toks" || key.startsWith("_")) continue;
    visit(v);
  }
  return out;
}
