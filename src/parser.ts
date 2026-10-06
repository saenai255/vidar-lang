import { CompileError, Pos, Token } from "./lexer";
import type { Block, Capture, Case, Expr, File, Param, ProcSig, Stmt } from "./ast";

const BINARY_PREC: Record<string, number> = {
  "..=": 2, "..<": 2,
  "||": 3,
  "&&": 4,
  "==": 5, "!=": 5, "<": 5, ">": 5, "<=": 5, ">=": 5,
  "+": 6, "-": 6, "|": 6, "~": 6, in: 6, not_in: 6,
  "*": 7, "/": 7, "%": 7, "%%": 7, "&": 7, "&~": 7, "<<": 7, ">>": 7,
};

const ASSIGN_OPS = new Set(["=", "+=", "-=", "*=", "/=", "%=", "%%=", "&=", "|=", "~=", "&~=", "<<=", ">>=", "&&=", "||="]);

const PREFIX_DIRECTIVES = new Set([
  "#force_inline", "#force_no_inline", "#type", "#soa", "#simd", "#sparse", "#partial", "#row_major",
  "#column_major", "#relative", "#no_bounds_check", "#bounds_check",
]);

const STMT_DIRECTIVES = new Set(["#no_type_assert", "#type_assert", "#partial", "#no_bounds_check", "#bounds_check", "#unroll", "#reverse", "#force_inline", "#force_no_inline"]);

const ALWAYS_STMT_DIRECTIVES = new Set(["#no_bounds_check", "#bounds_check", "#no_type_assert", "#type_assert"]);

const STMT_KEYWORDS = new Set(["for", "switch", "if", "when"]);

export interface ParseOptions {
  comptimeDepth?: number;
  /** the body of a `do!` or `comptime!` block: `take value` is a statement */
  take?: boolean;
}

type NodeOf<K extends string> = Extract<Expr | Stmt, { k: K }>;

export class Parser {
  private i = 0;
  private noLit = false;
  private typeCtx = false;
  private comptime: number;
  private take: boolean;

  constructor(private toks: Token[], opts: ParseOptions = {}) {
    this.comptime = opts.comptimeDepth ?? 0;
    this.take = opts.take ?? false;
  }

  // ---- token helpers ----

  private get cur(): Token {
    return this.toks[this.i];
  }

  private peek(n = 1): Token {
    return this.toks[Math.min(this.i + n, this.toks.length - 1)];
  }

  private isOp(text: string, t = this.cur): boolean {
    return t.kind === "op" && t.text === text;
  }

  private isKw(text: string, t = this.cur): boolean {
    return t.kind === "kw" && t.text === text;
  }

  private eatOp(text: string): boolean {
    if (this.isOp(text)) {
      this.i++;
      return true;
    }
    return false;
  }

  private expectOp(text: string): Token {
    if (!this.isOp(text)) throw this.err(`expected '${text}'`);
    return this.toks[this.i++];
  }

  private err(msg: string, t = this.cur): CompileError {
    const found = t.kind === "eof" ? "end of input" : t.kind === "semi" ? "newline" : `'${t.text}'`;
    return new CompileError(`${msg}, found ${found}`, t.pos);
  }

  private ident(): { name: string; tok: number } {
    if (this.cur.kind !== "ident") throw this.err("expected identifier");
    return { name: this.cur.text, tok: this.i++ };
  }

  private skipSemis(): void {
    while (this.cur.kind === "semi") this.i++;
  }

  private node<K extends string>(k: K, start: number, fields: object): NodeOf<K> {
    return { k, toks: this.toks, start, end: this.i, ...fields } as unknown as NodeOf<K>;
  }

  private withLit<T>(allow: boolean, f: () => T): T {
    const saved = this.noLit;
    this.noLit = !allow;
    try {
      return f();
    } finally {
      this.noLit = saved;
    }
  }

  get pos(): Pos {
    return this.cur.pos;
  }

  atEnd(): boolean {
    return this.cur.kind === "eof";
  }

  expectEnd(): void {
    this.skipSemis();
    if (!this.atEnd()) throw this.err("unexpected token");
  }

  /** Skips a balanced bracket group starting at the current token. */
  private skipBalanced(): void {
    const open = this.cur.text;
    const close = open === "(" ? ")" : open === "[" ? "]" : "}";
    let depth = 0;
    for (;;) {
      const t = this.cur;
      if (t.kind === "eof") throw this.err(`unbalanced '${open}'`);
      this.i++;
      if (t.kind === "op" && t.text === open) depth++;
      else if (t.kind === "op" && t.text === close && --depth === 0) return;
    }
  }

  // ---- file & statements ----

  /**
   * With `errors`, a broken top-level declaration is recorded and skipped: parsing
   * resumes at the next line that starts in column 1, so the rest of the file still
   * gets analyzed (used by the language server).
   */
  parseFile(path: string, errors?: CompileError[]): File {
    const stmts: Stmt[] = [];
    this.skipSemis();
    while (!this.atEnd()) {
      const start = this.i;
      try {
        stmts.push(this.parseStmt());
      } catch (err) {
        if (!errors || !(err instanceof CompileError)) throw err;
        errors.push(err);
        const line = this.toks[start].pos.line;
        this.i = start + 1;
        // an unclosed bracket suppresses newline semicolons, so resume at the next line-start token
        const closer = () => this.cur.kind === "op" && [")", "]", "}"].includes(this.cur.text);
        while (!this.atEnd() && !(this.cur.pos.col === 1 && this.cur.pos.line > line && this.cur.kind !== "semi" && !closer())) this.i++;
        this.noLit = false;
        this.typeCtx = false;
      }
      this.skipSemis();
    }
    return { path, toks: this.toks, stmts };
  }

  parseStmtList(): Stmt[] {
    const stmts: Stmt[] = [];
    this.skipSemis();
    while (!this.atEnd()) {
      stmts.push(this.parseStmt());
      this.skipSemis();
    }
    return stmts;
  }

  private endStmt(): void {
    if (this.cur.kind === "semi") {
      this.i++;
      return;
    }
    if (this.isOp("}") || this.isOp(")") || this.atEnd() || this.isKw("case")) return;
    throw this.err("expected end of statement");
  }

  parseBlock(): Block {
    const start = this.i;
    this.expectOp("{");
    const stmts: Stmt[] = [];
    this.withLit(true, () => {
      this.skipSemis();
      while (!this.isOp("}")) {
        if (this.atEnd()) throw this.err("unterminated block", this.toks[start]);
        stmts.push(this.parseStmt());
        this.skipSemis();
      }
    });
    this.i++;
    return this.node("Block", start, { stmts });
  }

  private parseBody(): Block {
    if (this.isKw("do")) {
      const start = this.i++;
      const stmt = this.withLit(true, () => this.parseStmtNoSemi());
      return this.node("Block", start, { stmts: [stmt] });
    }
    return this.parseBlock();
  }

  parseStmt(): Stmt {
    const s = this.parseStmtNoSemi();
    this.endStmt();
    return s;
  }

  private parseStmtNoSemi(): Stmt {
    const start = this.i;
    const t = this.cur;
    if (t.kind === "semi") return this.node("Empty", start, {});
    const attrs: string[] = [];
    while (this.isOp("@")) {
      const aStart = this.i++;
      if (this.isOp("(")) this.skipBalanced();
      else this.ident();
      attrs.push(this.toks.slice(aStart, this.i).map((x) => x.text).join(""));
      this.skipSemis();
    }
    if (attrs.length) {
      const s = this.parseStmtNoSemi();
      if (s.k !== "ValueDecl" && s.k !== "RawStmt" && s.k !== "Import") throw new CompileError("attributes must precede a declaration", t.pos);
      if (s.k === "ValueDecl") s.attrs = attrs;
      s.start = start;
      return s;
    }
    if (t.kind === "kw") {
      switch (t.text) {
        case "package": {
          this.i++;
          const id = this.ident();
          return this.node("Package", start, { name: id.name, nameTok: id.tok });
        }
        case "import": {
          this.i++;
          let alias: string | null = null;
          let aliasTok = -1;
          if (this.cur.kind === "ident") {
            const id = this.ident();
            alias = id.name;
            aliasTok = id.tok;
          }
          if (this.cur.kind !== "string") throw this.err("expected import path string");
          const pathTok = this.i++;
          const raw = this.toks[pathTok].text;
          return this.node("Import", start, { alias, aliasTok, path: raw.slice(1, -1), pathTok });
        }
        case "foreign":
          if (this.isKw("import", this.peek())) return this.rawToSemi(start);
          while (!this.isOp("{")) {
            if (this.cur.kind === "semi" || this.atEnd()) throw this.err("expected foreign block");
            this.i++;
          }
          this.skipBalanced();
          return this.node("RawStmt", start, {});
        case "if":
          return this.parseIf();
        case "when": {
          this.i++;
          const cond = this.withLit(false, () => this.parseExpr());
          const then = this.parseBody();
          const els = this.parseElse(() => (this.isKw("when") ? this.parseStmtNoSemi() : this.parseBody()));
          return this.node("When", start, { cond, then, else: els });
        }
        case "for":
          return this.parseFor();
        case "switch":
          return this.parseSwitch();
        case "defer": {
          this.i++;
          const stmt = this.parseStmtNoSemi();
          return this.node("Defer", start, { stmt });
        }
        case "return": {
          this.i++;
          const results = this.atStmtEnd() ? [] : this.parseExprList();
          return this.node("Return", start, { results });
        }
        case "break":
        case "continue":
          this.i++;
          if (this.cur.kind === "ident") this.i++;
          return this.node("Branch", start, { op: t.text });
        case "fallthrough":
          this.i++;
          return this.node("Branch", start, { op: t.text });
        case "using": {
          this.i++;
          const x = this.parseExprList();
          return this.node("Using", start, { x });
        }
      }
    }
    if (this.isOp("{")) return this.parseBlock();
    if (this.isImplDecl()) return this.parseImpl();
    if (t.kind === "directive" && STMT_DIRECTIVES.has(t.text) && (ALWAYS_STMT_DIRECTIVES.has(t.text) || STMT_KEYWORDS.has(this.peek().text) || this.isOp("{", this.peek()) || (this.peek().kind === "ident" && this.isOp(":", this.peek(2))))) {
      this.i++;
      const stmt = this.parseStmtNoSemi();
      return this.node("DirectiveStmt", start, { name: t.text, stmt });
    }
    if (t.kind === "ident" && this.isOp(":", this.peek()) && (STMT_KEYWORDS.has(this.peek(2).text) && this.peek(2).kind === "kw" || this.isOp("{", this.peek(2)) || (this.peek(2).kind === "directive" && STMT_DIRECTIVES.has(this.peek(2).text)))) {
      this.i += 2;
      const stmt = this.parseStmtNoSemi();
      return this.node("Labeled", start, { label: t.text, stmt });
    }
    if (this.isTake()) {
      this.i++;
      const results = this.parseExprList();
      return this.node("Take", start, { results });
    }
    if (this.isErrDefer()) {
      this.i++;
      const stmt = this.parseStmtNoSemi();
      return this.node("ErrDefer", start, { stmt });
    }
    const simple = this.parseSimpleStmt();
    return this.cur.kind === "ident" && this.cur.text === "catch" ? this.parseCatch(start, simple) : simple;
  }

  /** `or_return <value>`: a value on the same line, not something that ends the expression. */
  private startsOrReturnValue(kw: Token): boolean {
    const t = this.cur;
    if (t.kind === "semi" || t.kind === "eof" || t.pos.line !== kw.pos.line) return false;
    // in Odin, `f() or_return - 1` subtracts from the result
    if (t.kind === "op" && (t.text === "-" || t.text === "&"))
      throw this.err(`ambiguous '${t.text}' after 'or_return': write 'or_return (${t.text}...)' to return it as the error, or '(f() or_return) ${t.text} ...' for the operator`);
    if (t.kind === "op") return [".", "(", "!"].includes(t.text);
    if (t.kind === "kw") return ["cast", "transmute", "auto_cast"].includes(t.text);
    return !(t.kind === "ident" && (t.text === "catch" || t.text === "else"));
  }

  private isTake(): boolean {
    if (!this.take || this.cur.kind !== "ident" || this.cur.text !== "take") return false;
    const n = this.peek();
    if (n.kind === "semi" || n.kind === "eof") return false;
    return !(n.kind === "op" && [":", "::", ":=", "=", ".", "[", ",", "->", "^", "+=", "-=", "*=", "/="].includes(n.text));
  }

  private isErrDefer(): boolean {
    if (this.cur.kind !== "ident" || this.cur.text !== "errdefer") return false;
    const n = this.peek();
    if (n.kind === "semi" || n.kind === "eof" || n.pos.line !== this.cur.pos.line) return false;
    return !(n.kind === "op" && [":", "::", ":=", "=", "(", ".", "[", ",", "->", "^", "+=", "-=", "*=", "/="].includes(n.text));
  }

  private parseCatch(start: number, stmt: Stmt): Stmt {
    this.i++;
    let errName: string | null = null;
    let errTok = -1;
    if (this.cur.kind === "ident" && this.cur.text === "unreachable" && !this.isOp("{", this.peek()) && !this.isKw("do", this.peek())) {
      this.i++;
      return this.node("Catch", start, { stmt, errName, errTok, unreachable: true, body: null });
    }
    if (this.cur.kind === "ident") {
      errTok = this.i;
      errName = this.ident().name;
    }
    if (!this.isOp("{") && !this.isKw("do")) throw this.err("expected '{' or 'do' after catch");
    const body = this.withLit(true, () => this.parseBody());
    return this.node("Catch", start, { stmt, errName, errTok, unreachable: false, body });
  }

  private atStmtEnd(): boolean {
    return this.cur.kind === "semi" || this.isOp("}") || this.atEnd() || this.isKw("case");
  }

  private rawToSemi(start: number): Stmt {
    while (this.cur.kind !== "semi" && !this.atEnd()) this.i++;
    return this.node("RawStmt", start, {});
  }

  private parseElse(parseTail: () => Stmt): Stmt | null {
    if (this.cur.kind === "semi" && this.isKw("else", this.peek())) this.i++;
    if (!this.isKw("else")) return null;
    this.i++;
    return parseTail();
  }

  parseSimpleStmt(): Stmt {
    const start = this.i;
    const lhs = this.parseExprList();
    if (this.isOp("!") && this.isOp("::", this.peek()) && lhs.length === 1 && lhs[0].k === "Ident") throw this.err("comptime procs are declared as name :: proc!(...) { ... }");
    if (this.isOp("::") && this.isKw("proc", this.peek()) && this.isOp("!", this.peek(2)) && lhs.length === 1 && lhs[0].k === "Ident")
      return this.parseComptimeDecl(start, lhs[0]);
    const t = this.cur;
    if (t.kind === "op" && (t.text === ":" || t.text === "::" || t.text === ":=")) {
      const names = lhs.map((e) => {
        if (e.k !== "Ident") throw new CompileError("expected a name on the left side of a declaration", e.toks[e.start].pos);
        return { name: e.name, tok: e.start };
      });
      this.i++;
      let type: Expr | null = null;
      let values: Expr[] = [];
      let isConst = t.text === "::";
      if (t.text === ":") {
        if (!this.isOp("=") && !this.isOp(":")) type = this.parseType();
        if (this.eatOp("=")) values = this.parseExprList();
        else if (this.eatOp(":")) {
          isConst = true;
          values = this.parseExprList();
        }
      } else values = this.parseExprList();
      return this.node("ValueDecl", start, { names, type, values, isConst, attrs: [] });
    }
    if (t.kind === "op" && ASSIGN_OPS.has(t.text)) {
      this.i++;
      const rhs = this.parseExprList();
      return this.node("Assign", start, { lhs, op: t.text, rhs });
    }
    if (lhs.length !== 1) throw this.err("expected ':=', '=' or ':' after expression list");
    return this.node("ExprStmt", start, { x: lhs[0] });
  }

  /** `name :: proc!(...) { ... }`: a comptime proc, invoked as `name!(...)`. */
  private parseComptimeDecl(start: number, name: Extract<Expr, { k: "Ident" }>): Stmt {
    this.i++;
    const value = this.parseProc(true);
    if (value.k !== "ProcLit" || value.captures || !value.body) throw new CompileError(`'${name.name}!' must be a proc with a body`, value.toks[value.start].pos);
    return this.node("ValueDecl", start, { names: [{ name: name.name, tok: name.start }], type: null, values: [value], isConst: true, attrs: [] });
  }

  private isImplDecl(): boolean {
    const t = this.cur;
    if (t.kind !== "ident" || t.text !== "impl" || this.peek().kind !== "ident") return false;
    for (let j = this.i + 2; j < this.toks.length; j++) {
      const x = this.toks[j];
      if (x.kind === "semi" || x.kind === "eof" || this.isOp("{", x)) return false;
      if (this.isKw("for", x)) return true;
    }
    return false;
  }

  private parseImpl(): Stmt {
    const start = this.i++;
    const iface = this.parseType();
    if (!this.isKw("for")) throw this.err("expected 'for' in impl declaration");
    this.i++;
    const target = this.parseType();
    this.expectOp("{");
    const bindings: { name: string; tok: number; value: Expr }[] = [];
    this.skipSemis();
    while (!this.isOp("}")) {
      if (this.atEnd()) throw this.err("unterminated impl block", this.toks[start]);
      const id = this.ident();
      if (!this.eatOp("=")) throw this.err("impl blocks bind methods to procs: impl I for T { method = t_method, ... }");
      bindings.push({ ...id, value: this.parseExpr() });
      this.skipSemis();
      if (!this.eatOp(",")) break;
      this.skipSemis();
    }
    this.expectOp("}");
    return this.node("ImplBlock", start, { iface, target, bindings });
  }

  private parseInterface(): Expr {
    const start = this.i++;
    this.expectOp("{");
    const methods: { name: string; tok: number }[] = [];
    this.skipSemis();
    while (!this.isOp("}")) {
      const id = this.ident();
      if (this.isOp(":")) throw this.err(`interfaces list method names: Name :: interface { ${id.name}, ... }, with each method declared as ${id.name} :: proc(x: Name, ...) ---`);
      methods.push(id);
      this.skipSemis();
      if (!this.eatOp(",")) break;
      this.skipSemis();
    }
    this.expectOp("}");
    return this.node("InterfaceType", start, { methods });
  }

  private parseIf(): Stmt {
    const start = this.i++;
    let init: Stmt | null = null;
    let cond: Expr;
    const first = this.withLit(false, () => this.parseSimpleStmt());
    if (this.cur.kind === "semi" && this.cur.text === ";") {
      this.i++;
      init = first;
      cond = this.withLit(false, () => this.parseExpr());
    } else {
      if (first.k !== "ExprStmt") throw new CompileError("expected condition", first.toks[first.start].pos);
      cond = first.x;
    }
    const then = this.parseBody();
    const els = this.parseElse(() => (this.isKw("if") ? this.parseIf() : this.parseBody()));
    return this.node("If", start, { init, cond, then, else: els });
  }

  private findInKeyword(): boolean {
    let depth = 0;
    for (let j = this.i; j < this.toks.length; j++) {
      const t = this.toks[j];
      if (t.kind === "op" && (t.text === "(" || t.text === "[")) depth++;
      else if (t.kind === "op" && (t.text === ")" || t.text === "]")) depth--;
      else if (depth === 0 && (t.kind === "semi" || this.isOp("{", t) || this.isKw("do", t) || t.kind === "eof")) return false;
      else if (depth === 0 && this.isKw("in", t)) return true;
    }
    return false;
  }

  private parseFor(): Stmt {
    const start = this.i++;
    if (this.isOp("{") || this.isKw("do")) {
      return this.node("For", start, { init: null, cond: null, post: null, body: this.parseBody() });
    }
    if (this.findInKeyword()) {
      const vals: { name: string; tok: number; byRef: boolean }[] = [];
      while (!this.isKw("in")) {
        const byRef = this.eatOp("&");
        vals.push({ ...this.ident(), byRef });
        if (!this.eatOp(",")) break;
      }
      if (!this.isKw("in")) throw this.err("expected 'in'");
      this.i++;
      const x = this.withLit(false, () => this.parseExpr());
      return this.node("RangeFor", start, { vals, x, body: this.parseBody() });
    }
    return this.withLit(false, () => {
      let init: Stmt | null = null;
      let cond: Expr | null = null;
      let post: Stmt | null = null;
      const first = this.cur.kind === "semi" ? null : this.parseSimpleStmt();
      if (this.cur.kind === "semi" && this.cur.text === ";") {
        this.i++;
        init = first;
        if (!(this.cur.kind === "semi")) cond = this.parseExpr();
        if (!(this.cur.kind === "semi" && this.cur.text === ";")) throw this.err("expected ';' in for statement");
        this.i++;
        if (!this.isOp("{") && !this.isKw("do")) post = this.parseSimpleStmt();
      } else if (first) {
        if (first.k !== "ExprStmt") throw new CompileError("expected loop condition", first.toks[first.start].pos);
        cond = first.x;
      }
      this.noLit = false;
      return this.node("For", start, { init, cond, post, body: this.parseBody() });
    });
  }

  private parseSwitch(): Stmt {
    const start = this.i++;
    let init: Stmt | null = null;
    let tag: Expr | null = null;
    let typeSwitchVar: { name: string; tok: number } | null = null;
    this.withLit(false, () => {
      if (this.isOp("{")) return;
      if ((this.cur.kind === "ident" && this.isKw("in", this.peek())) || (this.isOp("&") && this.isKw("in", this.peek(2)))) {
        this.eatOp("&");
        typeSwitchVar = this.ident();
        this.i++;
        tag = this.parseExpr();
        return;
      }
      const first = this.cur.kind === "semi" ? null : this.parseSimpleStmt();
      if (this.cur.kind === "semi" && this.cur.text === ";") {
        this.i++;
        init = first;
        if (!this.isOp("{")) tag = this.parseExpr();
      } else if (first) {
        if (first.k !== "ExprStmt") throw new CompileError("expected switch tag", first.toks[first.start].pos);
        tag = first.x;
      }
    });
    this.expectOp("{");
    const cases: Case[] = [];
    this.skipSemis();
    while (!this.isOp("}")) {
      const cStart = this.i;
      if (!this.isKw("case")) throw this.err("expected 'case'");
      this.i++;
      const exprs = this.isOp(":") ? [] : this.withLit(true, () => this.parseExprList());
      this.expectOp(":");
      const body: Stmt[] = [];
      this.withLit(true, () => {
        this.skipSemis();
        while (!this.isKw("case") && !this.isOp("}")) {
          body.push(this.parseStmt());
          this.skipSemis();
        }
      });
      cases.push({ k: "Case", toks: this.toks, start: cStart, end: this.i, exprs, body });
    }
    this.i++;
    return this.node("Switch", start, { init, tag, typeSwitchVar, cases });
  }

  // ---- expressions ----

  parseExprList(): Expr[] {
    const list = [this.parseExpr()];
    while (this.eatOp(",") && !this.atStmtEnd()) list.push(this.parseExpr());
    return list;
  }

  parseExpr(): Expr {
    const start = this.i;
    let x = this.parseBinary(2);
    for (;;) {
      if (this.isOp("?")) {
        this.i++;
        const a = this.parseExpr();
        this.expectOp(":");
        const b = this.parseExpr();
        x = this.node("Ternary", start, { cond: x, a, b });
      } else if ((this.isKw("if") || this.isKw("when")) && !this.noLit) {
        this.i++;
        const cond = this.parseBinary(2);
        if (!this.isKw("else")) throw this.err("expected 'else' in ternary expression");
        this.i++;
        const b = this.parseExpr();
        x = this.node("Ternary", start, { cond, a: x, b });
      } else if (this.isKw("or_else")) {
        this.i++;
        const y = this.parseBinary(2);
        x = this.node("Binary", start, { op: "or_else", x, y });
      } else return x;
    }
  }

  private binaryOp(): string | undefined {
    const t = this.cur;
    if (t.kind === "op" && BINARY_PREC[t.text]) return t.text;
    if (t.kind === "kw" && (t.text === "in" || t.text === "not_in")) return t.text;
    return undefined;
  }

  private parseBinary(minPrec: number): Expr {
    const start = this.i;
    let x = this.parseUnary();
    for (;;) {
      const op = this.binaryOp();
      if (!op || BINARY_PREC[op] < minPrec) return x;
      this.i++;
      const y = this.parseBinary(BINARY_PREC[op] + 1);
      x = this.node("Binary", start, { op, x, y });
    }
  }

  parseType(): Expr {
    return this.withLit(false, () => {
      this.typeCtx = true;
      try {
        return this.parseUnary();
      } finally {
        this.typeCtx = false;
      }
    });
  }

  /** `closure(...)` followed by `->` is a closure type even outside a type position. */
  private closureTypeAhead(): boolean {
    let depth = 0;
    for (let j = this.i + 1; j < this.toks.length; j++) {
      const t = this.toks[j];
      if (this.isOp("(", t)) depth++;
      else if (this.isOp(")", t) && --depth === 0) return this.isOp("->", this.toks[j + 1]);
      else if (t.kind === "eof") return false;
    }
    return false;
  }

  private parseUnary(): Expr {
    const start = this.i;
    const t = this.cur;
    if (t.kind === "op" && ["-", "+", "!", "~", "&", "^"].includes(t.text)) {
      this.i++;
      const x = this.parseUnary();
      return this.node("Unary", start, { op: t.text, x });
    }
    if (this.isOp("..")) {
      this.i++;
      return this.node("Spread", start, { x: this.parseUnary() });
    }
    if (this.isKw("cast") || this.isKw("transmute")) {
      this.i++;
      this.expectOp("(");
      const type = this.withLit(true, () => this.parseType());
      this.expectOp(")");
      const x = this.parseUnary();
      return this.node("Cast", start, { op: t.text, type, x });
    }
    if (this.isKw("auto_cast")) {
      this.i++;
      return this.node("Cast", start, { op: "auto_cast", type: null, x: this.parseUnary() });
    }
    return this.parsePostfix(this.parsePrimary(), start);
  }

  private canTakeLiteral(x: Expr): boolean {
    return ["Ident", "Selector", "TypeExpr", "Call", "StructType", "UnionType", "EnumType", "Poly", "Directive", "Paren"].includes(x.k)
      || (x.k === "Index" && !x.slice);
  }

  private parsePostfix(x: Expr, start: number): Expr {
    for (;;) {
      const t = this.cur;
      if (this.isOp("(")) {
        this.i++;
        const args = this.withLit(true, () => this.parseCallArgs(")"));
        x = this.node("Call", start, { fn: x, args });
      } else if (this.isOp("[")) {
        this.i++;
        const indices: (Expr | null)[] = [];
        let slice = false;
        this.withLit(true, () => {
          if (this.isOp(":")) indices.push(null);
          else indices.push(this.parseExpr());
          if (this.eatOp(":")) {
            slice = true;
            indices.push(this.isOp("]") ? null : this.parseExpr());
          } else while (this.eatOp(",")) indices.push(this.parseExpr());
        });
        this.expectOp("]");
        x = this.node("Index", start, { x, indices, slice });
      } else if (this.isOp(".")) {
        this.i++;
        if (this.eatOp("(")) {
          const type = this.withLit(true, () => this.parseType());
          this.expectOp(")");
          x = this.node("TypeAssert", start, { x, type });
        } else if (this.eatOp("?")) {
          x = this.node("TypeAssert", start, { x, type: null });
        } else {
          const name = this.ident().name;
          x = this.node("Selector", start, { x, name });
        }
      } else if (this.isOp("^")) {
        this.i++;
        x = this.node("Deref", start, { x });
      } else if (this.isOp("->")) {
        this.i++;
        const name = this.ident().name;
        this.expectOp("(");
        const args = this.withLit(true, () => this.parseCallArgs(")"));
        x = this.node("ArrowCall", start, { x, name, args });
      } else if (this.isOp("{") && !this.noLit && this.canTakeLiteral(x)) {
        x = this.parseCompoundLit(start, x);
      } else if (t.kind === "kw" && (t.text === "or_return" || t.text === "or_break" || t.text === "or_continue")) {
        this.i++;
        if (t.text !== "or_return" && this.cur.kind === "ident") this.i++;
        const value = t.text === "or_return" && this.startsOrReturnValue(t) ? this.parseUnary() : null;
        x = this.node("Postfix", start, { op: t.text, x, value });
      } else if (this.isOp("!") && this.isOp("{", this.peek()) && (x.k === "Ident" || (x.k === "Selector" && x.x.k === "Ident"))) {
        // `name! { ... }`: a block macro, the block is its Stmt argument
        this.i++;
        x = this.node("MacroCall", start, { path: macroPath(x), args: [this.blockTokens()], blockArg: true });
      } else if (this.isOp("!") && this.isOp("(", this.peek()) && (x.k === "Ident" || (x.k === "Selector" && x.x.k === "Ident"))) {
        this.i += 2;
        const args = this.collectMacroArgs();
        // `name!(args) { ... }`: a trailing block on the same line is one more argument
        const trailing = this.isOp("{") && !this.noLit && this.cur.pos.line === this.toks[this.i - 1].pos.line;
        if (trailing) args.push(this.blockTokens());
        x = this.node("MacroCall", start, { path: macroPath(x), args, blockArg: trailing });
      } else return x;
    }
  }

  private parseCallArgs(close: string): Expr[] {
    const args: Expr[] = [];
    this.skipSemis();
    while (!this.isOp(close)) {
      const aStart = this.i;
      if (this.cur.kind === "ident" && this.isOp("=", this.peek())) {
        const name = this.cur.text;
        this.i += 2;
        const value = this.parseExpr();
        args.push(this.node("FieldValue", aStart, { name, value }));
      } else args.push(this.parseExpr());
      this.skipSemis();
      if (!this.eatOp(",")) break;
      this.skipSemis();
    }
    this.skipSemis();
    this.expectOp(close);
    return args;
  }

  private parseCompoundLit(start: number, type: Expr | null): Expr {
    this.expectOp("{");
    const elems: Expr[] = [];
    this.withLit(true, () => {
      this.skipSemis();
      while (!this.isOp("}")) {
        const eStart = this.i;
        if (this.cur.kind === "ident" && this.isOp("=", this.peek())) {
          const name = this.cur.text;
          this.i += 2;
          elems.push(this.node("FieldValue", eStart, { name, value: this.parseExpr() }));
        } else {
          const e = this.parseExpr();
          if (this.eatOp("=")) elems.push(this.node("Binary", eStart, { op: "=", x: e, y: this.parseExpr() }));
          else elems.push(e);
        }
        this.skipSemis();
        if (!this.eatOp(",")) break;
        this.skipSemis();
      }
    });
    this.expectOp("}");
    return this.node("CompoundLit", start, { type, elems });
  }

  /** A balanced `{ ... }` as macro-argument tokens (braces included). */
  private blockTokens(): Token[] {
    const from = this.i;
    this.skipBalanced();
    return [...this.toks.slice(from, this.i), { kind: "eof", text: "", pre: "", pos: this.toks[this.i - 1].pos }];
  }

  private collectMacroArgs(): Token[][] {
    const args: Token[][] = [];
    let cur: Token[] = [];
    let depth = 0;
    const eof = (t: Token): Token => ({ kind: "eof", text: "", pre: "", pos: t.pos });
    for (;;) {
      const t = this.cur;
      if (t.kind === "eof") throw this.err("unterminated macro call");
      this.i++;
      if (t.kind === "op" && (t.text === "(" || t.text === "[" || t.text === "{")) depth++;
      else if (t.kind === "op" && (t.text === ")" || t.text === "]" || t.text === "}")) {
        if (depth === 0) {
          if (cur.some((x) => x.kind !== "semi")) args.push([...cur, eof(t)]);
          return args;
        }
        depth--;
      } else if (t.kind === "op" && t.text === "," && depth === 0) {
        args.push([...cur, eof(t)]);
        cur = [];
        continue;
      }
      cur.push(t);
    }
  }

  private parsePrimary(): Expr {
    const start = this.i;
    const t = this.cur;
    if (t.kind !== "ident" && !(t.kind === "op" && ["^", "[", "("].includes(t.text))) this.typeCtx = false;
    switch (t.kind) {
      case "ident": {
        const typeCtx = this.typeCtx;
        this.typeCtx = false;
        if (t.text === "comptime" && this.isKw("proc", this.peek()))
          throw this.err("comptime procs are declared as name :: proc!(...) { ... }");
        if (t.text === "closure" && this.isOp("(", this.peek()) && (typeCtx || this.closureTypeAhead())) {
          this.i++;
          const sig = this.parseSignature();
          return this.node("ClosureType", start, { sig });
        }
        if (t.text === "interface" && this.isOp("{", this.peek())) return this.parseInterface();
        if (t.text === "quote" && this.comptime > 0 && (this.isOp("(", this.peek()) || this.isOp("{", this.peek()))) return this.parseQuote();
        this.i++;
        return this.node("Ident", start, { name: t.text });
      }
      case "int":
      case "float":
      case "imag":
      case "string":
      case "rune":
        this.i++;
        return this.node("Lit", start, { kind: t.kind });
      case "directive":
        return this.parseDirective();
      case "kw":
        return this.parseKeywordExpr();
      case "op":
        break;
      default:
        throw this.err("expected expression");
    }
    switch (t.text) {
      case "(": {
        this.i++;
        const x = this.withLit(true, () => this.parseExpr());
        this.expectOp(")");
        return this.node("Paren", start, { x });
      }
      case "{":
        return this.withLit(true, () => this.parseCompoundLit(start, null));
      case ".": {
        this.i++;
        const name = this.ident().name;
        return this.node("ImplicitSelector", start, { name });
      }
      case "---":
        this.i++;
        return this.node("Lit", start, { kind: "undef" });
      case "$": {
        this.i++;
        const name = this.ident().name;
        const spec = this.eatOp("/") ? this.parseType() : null;
        return this.node("Poly", start, { name, spec });
      }
      case "[":
        return this.parseArrayType();
    }
    throw this.err("expected expression");
  }

  private parseDirective(): Expr {
    const start = this.i;
    const name = this.toks[this.i++].text;
    if (PREFIX_DIRECTIVES.has(name) && !this.isOp("(")) {
      const x = this.parseUnary();
      return this.node("Directive", start, { name, args: null, x });
    }
    if (this.isOp("(")) {
      this.i++;
      const args = this.withLit(true, () => this.parseCallArgs(")"));
      if (PREFIX_DIRECTIVES.has(name)) {
        const x = this.parseUnary();
        return this.node("Directive", start, { name, args, x });
      }
      return this.node("Directive", start, { name, args, x: null });
    }
    return this.node("Directive", start, { name, args: null, x: null });
  }

  private parseArrayType(): Expr {
    const start = this.i++;
    let what = "array";
    let len: Expr | null = null;
    if (this.isOp("]")) what = "slice";
    else if (this.isOp("?") && this.isOp("]", this.peek())) {
      this.i++;
      what = "inferred";
    } else if (this.isKw("dynamic")) {
      this.i++;
      what = "dynamic";
      if (this.cur.kind === "semi") {
        this.i++;
        len = this.withLit(true, () => this.parseExpr());
      }
    } else if (this.isOp("^") && this.isOp("]", this.peek())) {
      this.i++;
      what = "multipointer";
    } else len = this.withLit(true, () => this.parseExpr());
    this.expectOp("]");
    const elem = this.parseType();
    return this.node("TypeExpr", start, { what, parts: [len, elem] });
  }

  private parseKeywordExpr(): Expr {
    const start = this.i;
    const t = this.cur;
    switch (t.text) {
      case "proc":
        if (this.isOp("!", this.peek())) throw this.err("comptime procs are declared as name :: proc!(...) { ... }");
        return this.parseProc(false);
      case "struct":
        return this.parseStruct();
      case "union": {
        this.i++;
        const polyParams = this.isOp("(") ? this.parseParamList() : null;
        this.skipTypeDirectives();
        if (this.isKw("where")) this.parseWhere();
        this.expectOp("{");
        const variants: Expr[] = [];
        this.skipSemis();
        while (!this.isOp("}")) {
          variants.push(this.parseType());
          this.skipSemis();
          if (!this.eatOp(",")) break;
          this.skipSemis();
        }
        this.expectOp("}");
        return this.node("UnionType", start, { variants, polyParams });
      }
      case "enum": {
        this.i++;
        const base = this.isOp("{") ? null : this.parseType();
        this.expectOp("{");
        const members: { name: string; value: Expr | null }[] = [];
        this.skipSemis();
        while (!this.isOp("}")) {
          const name = this.ident().name;
          const value = this.eatOp("=") ? this.withLit(true, () => this.parseExpr()) : null;
          members.push({ name, value });
          this.skipSemis();
          if (!this.eatOp(",")) break;
          this.skipSemis();
        }
        this.expectOp("}");
        return this.node("EnumType", start, { base, members });
      }
      case "bit_set": {
        this.i++;
        this.expectOp("[");
        const elem = this.withLit(true, () => this.parseExpr());
        let backing: Expr | null = null;
        if (this.cur.kind === "semi") {
          this.i++;
          backing = this.parseType();
        }
        this.expectOp("]");
        return this.node("TypeExpr", start, { what: "bit_set", parts: [elem, backing] });
      }
      case "bit_field": {
        this.i++;
        while (!this.isOp("{")) this.i++;
        this.skipBalanced();
        return this.node("Raw", start, {});
      }
      case "map": {
        this.i++;
        this.expectOp("[");
        const key = this.withLit(true, () => this.parseType());
        this.expectOp("]");
        const value = this.parseType();
        return this.node("TypeExpr", start, { what: "map", parts: [key, value] });
      }
      case "matrix": {
        this.i++;
        this.expectOp("[");
        const rows = this.withLit(true, () => this.parseExpr());
        this.expectOp(",");
        const cols = this.withLit(true, () => this.parseExpr());
        this.expectOp("]");
        return this.node("TypeExpr", start, { what: "matrix", parts: [rows, cols, this.parseType()] });
      }
      case "distinct": {
        this.i++;
        return this.node("TypeExpr", start, { what: "distinct", parts: [this.parseType()] });
      }
      case "typeid": {
        this.i++;
        const spec = this.eatOp("/") ? this.parseType() : null;
        return this.node("TypeExpr", start, { what: "typeid", parts: [spec] });
      }
    }
    throw this.err("expected expression");
  }

  private skipSemiBefore(kw: string): void {
    if (this.cur.kind === "semi" && this.isKw(kw, this.peek())) this.i++;
  }

  private skipTypeDirectives(): void {
    while (this.cur.kind === "directive") {
      this.i++;
      if (this.isOp("(")) this.skipBalanced();
    }
  }

  private parseWhere(): void {
    this.i++;
    this.withLit(false, () => this.parseExprList());
  }

  private parseStruct(): Expr {
    const start = this.i++;
    const polyParams = this.isOp("(") ? this.parseParamList() : null;
    this.skipTypeDirectives();
    this.skipSemiBefore("where");
    if (this.isKw("where")) this.parseWhere();
    this.skipTypeDirectives();
    this.expectOp("{");
    const fields: Param[] = [];
    this.skipSemis();
    while (!this.isOp("}")) {
      const names: { name: string; tok: number; prefix?: string }[] = [];
      for (;;) {
        let prefix: string | undefined;
        if (this.isKw("using") || this.cur.kind === "directive") prefix = this.toks[this.i++].text;
        names.push({ ...this.ident(), prefix });
        if (!this.eatOp(",")) break;
      }
      this.expectOp(":");
      const type = this.parseType();
      if (this.cur.kind === "string") this.i++;
      fields.push({ names, type });
      this.skipSemis();
      if (!this.eatOp(",")) break;
      this.skipSemis();
    }
    this.expectOp("}");
    return this.node("StructType", start, { fields, polyParams, extra: [] });
  }

  private parseProc(comptime: boolean, start = this.i): Expr {
    this.i += comptime ? 2 : 1;
    if (this.cur.kind === "string") this.i++;
    if (this.isOp("{")) {
      this.i++;
      const procs = this.withLit(true, () => this.parseCallArgs("}"));
      return this.node("ProcGroup", start, { procs });
    }
    let captures: Capture[] | null = null;
    if (this.isOp("[")) {
      this.i++;
      captures = [];
      while (!this.isOp("]")) {
        const byRef = this.eatOp("&");
        const id = this.ident();
        captures.push({ ...id, byRef });
        if (!this.eatOp(",")) break;
      }
      this.expectOp("]");
    }
    const sig = this.parseSignature();
    this.skipTypeDirectives();
    this.skipSemiBefore("where");
    if (this.isKw("where")) this.parseWhere();
    this.skipTypeDirectives();
    if (this.isOp("{")) {
      if (comptime) this.comptime++;
      try {
        const body = this.withLit(true, () => this.parseBlock());
        return this.node("ProcLit", start, { sig, body, captures, comptime });
      } finally {
        if (comptime) this.comptime--;
      }
    }
    if (this.isOp("---")) {
      this.i++;
      return this.node("ProcLit", start, { sig, body: null, captures, comptime });
    }
    if (captures) throw this.err("closure literal needs a body");
    if (comptime) throw this.err("comptime proc needs a body");
    return this.node("ProcType", start, { sig });
  }

  private parseSignature(): ProcSig {
    const { params, unnamed } = this.parseParamListInfo();
    return { params, unnamed, ...this.parseResults() };
  }

  private parseResults(): { results: Param[]; resultsUnnamed: boolean } {
    let results: Param[] = [];
    let resultsUnnamed = true;
    if (this.eatOp("->")) {
      if (this.isOp("!")) {
        this.i++;
      } else if (this.isOp("(")) {
        const r = this.parseParamListInfo();
        results = r.params;
        resultsUnnamed = r.unnamed;
      } else results = [{ names: [], type: this.parseType() }];
    }
    return { results, resultsUnnamed };
  }

  private parseParamList(): Param[] {
    return this.parseParamListInfo().params;
  }

  private hasNamedParams(from = this.i, startDepth = 0): boolean {
    let depth = startDepth;
    for (let j = from; j < this.toks.length; j++) {
      const t = this.toks[j];
      if (t.kind === "op" && (t.text === "(" || t.text === "[" || t.text === "{")) depth++;
      else if (t.kind === "op" && (t.text === ")" || t.text === "]" || t.text === "}")) {
        if (--depth === 0) return false;
      } else if (depth === 1 && t.kind === "op" && (t.text === ":" || t.text === ":=")) return true;
      else if (t.kind === "eof") return false;
    }
    return false;
  }

  private parseParamListInfo(): { params: Param[]; unnamed: boolean } {
    const named = this.hasNamedParams();
    this.expectOp("(");
    return { params: this.parseParamsBody(named), unnamed: !named };
  }

  /** Parses parameters up to and including the closing ')'. */
  private parseParamsBody(named: boolean): Param[] {
    const params: Param[] = [];
    this.withLit(true, () => {
      this.skipSemis();
      while (!this.isOp(")")) {
        if (!named) {
          params.push({ names: [], type: this.parseType() });
        } else {
          const names: { name: string; tok: number; prefix?: string }[] = [];
          for (;;) {
            let prefix = "";
            while (this.isKw("using") || this.cur.kind === "directive" || this.isOp("$")) prefix += this.toks[this.i++].text;
            names.push({ ...this.ident(), prefix: prefix || undefined });
            if (!this.eatOp(",")) break;
          }
          let type: Expr | undefined;
          let value: Expr | undefined;
          if (this.eatOp(":")) {
            type = this.parseType();
            if (this.eatOp("=")) value = this.parseExpr();
          } else if (this.eatOp(":=")) value = this.parseExpr();
          else throw this.err("expected ':' in parameter list");
          params.push({ names, type, value });
        }
        this.skipSemis();
        if (!this.eatOp(",")) break;
        this.skipSemis();
      }
    });
    this.expectOp(")");
    return params;
  }

  private parseQuote(): Expr {
    const start = this.i++;
    const open = this.cur.text;
    const bodyStart = this.i + 1;
    this.skipBalanced();
    const body = this.toks.slice(bodyStart, this.i - 1);
    return this.node("Quote", start, { kind: open === "(" ? "expr" : "stmt", body });
  }
}

function macroPath(x: Expr): string[] {
  return x.k === "Ident" ? [x.name] : x.k === "Selector" && x.x.k === "Ident" ? [x.x.name, x.name] : [];
}
