import type { Token } from "../lexer";
import { Block, Expr, Node, Param, Stmt, children } from "../ast";
import { A, AnonFieldType, IfaceMethod, nodeText } from "../analyzer";
import { Parser } from "../parser";
import { ATTRIBUTE_DOCS, BUILTIN_PROC_DOCS, BUILTIN_TYPE_DOCS, COMPTIME_BUILTIN_DOCS, CONTEXT_FIELD_DOCS, KEYWORD_DOCS, MACRO_KIND_DOCS, ODIN_CONSTANT_DOCS } from "./docs";
import { type Program as Analysis, emitProgram, schedSourcePath } from "../project";
import { CaptureSym, GlobalSym, LocalSym, Scope, Sym, Ty } from "../scope";
import { Member, MemberMiss, membersOf, resolveMembers } from "../members";

/** 0-based position, as in LSP. */
export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface Location {
  file: string;
  range: Range;
}

export interface Ref {
  file: string;
  range: Range;
  sym: Sym;
  decl: boolean;
}

export type SymbolKind = "namespace" | "function" | "macro" | "struct" | "interface" | "enum" | "union" | "type" | "constant" | "variable" | "impl" | "field" | "method";

export interface DocSymbol {
  name: string;
  detail?: string;
  kind: SymbolKind;
  range: Range;
  selectionRange: Range;
  children: DocSymbol[];
}

export type CompletionKind = "namespace" | "function" | "macro" | "struct" | "interface" | "type" | "constant" | "variable" | "field" | "method" | "keyword";

export interface Completion {
  label: string;
  kind: CompletionKind;
  detail?: string;
  insertText?: string;
}

const KEYWORDS = [
  "package", "import", "proc", "struct", "union", "enum", "bit_set", "map", "dynamic", "distinct", "using", "when", "if", "else",
  "for", "in", "not_in", "switch", "case", "break", "continue", "fallthrough", "defer", "return", "cast", "transmute", "auto_cast",
  "or_else", "or_return", "or_break", "or_continue", "context", "nil", "true", "false",
  "closure", "quote", "take", "interface", "impl", "catch", "errdefer", "unreachable",
];
const BUILTIN_TYPES = ["int", "uint", "i8", "i16", "i32", "i64", "u8", "u16", "u32", "u64", "f16", "f32", "f64", "bool", "string", "cstring", "rune", "rawptr", "typeid", "any", "byte", "uintptr"];
const MACRO_KINDS = ["Expr", "Stmt", "Type", "Ident"];

// ---- positions ----

export function tokRange(t: Token): Range {
  const start = { line: t.pos.line - 1, character: t.pos.col - 1 };
  return { start, end: { line: start.line, character: start.character + t.text.length } };
}

function nodeRange(n: Node): Range {
  const first = n.toks[n.start];
  const last = n.toks[Math.max(n.start, n.end - 1)];
  return { start: tokRange(first).start, end: tokRange(last).end };
}

function contains(r: Range, p: Position): boolean {
  const after = p.line > r.start.line || (p.line === r.start.line && p.character >= r.start.character);
  const before = p.line < r.end.line || (p.line === r.end.line && p.character <= r.end.character);
  return after && before;
}

function before(a: Position, b: Position): boolean {
  return a.line < b.line || (a.line === b.line && a.character < b.character);
}

function sliceText(toks: Token[], start: number, end: number): string {
  return toks.slice(start, end).map((t, i) => (i ? t.pre : "") + t.text).join("");
}

// ---- the reference index ----

/** Names declared inside quoted code: each expansion gets its own renamed copy. */
const quoteLocals = new WeakSet<Sym>();
/** `v` in `switch v in x`. */
const switchVars = new WeakSet<Sym>();
/** `err` in `stmt catch err { ... }`. */
const catchErrs = new WeakSet<Sym>();

/** Follows captures back to the variable they capture. */
export function canonical(sym: Sym): Sym {
  let s: Sym = sym;
  while (s.kind === "capture") s = s.target;
  return s;
}

export function declToken(sym: Sym): Token | undefined {
  switch (sym.kind) {
    case "global": return sym.decl.toks[sym.decl.names[sym.index].tok];
    case "local": return sym.declTok;
    case "capture": return declToken(canonical(sym));
    case "pkg": return sym.stmt.toks[sym.stmt.aliasTok >= 0 ? sym.stmt.aliasTok : sym.stmt.pathTok];
  }
}

export function allFiles(a: Analysis) {
  return a.packages.flatMap((p) => p.files);
}

/** A field or enum member at a position: its declaration (`decl`) or a use the analyzer resolved. */
export interface MemberRef {
  file: string;
  range: Range;
  member: Member;
  decl: boolean;
}

export class Index {
  readonly refs: Ref[] = [];
  readonly members: MemberRef[] = [];
  /** member uses that couldn't be resolved, which make renaming a member of that name unsafe */
  readonly memberMisses: MemberMiss[] = [];
  private seen = new Set<string>();
  private memberSeen = new Set<string>();
  private lines = new Map<string, string[]>();

  constructor(readonly a: Analysis) {
    for (const s of a.sources) this.lines.set(s.path, s.text.split("\n"));
    try {
      this.memberMisses = resolveMembers(a).misses;
    } catch {
      // no member uses: hover and definition fall back to what the node lookup finds
    }
    for (const f of allFiles(a)) for (const s of f.stmts) this.visit(s);
    for (const g of this.globals()) {
      const t = declToken(g);
      if (t) this.add(t, g, true);
    }
  }

  /** Only tokens that really appear at their position in the source (macro expansions copy positions). */
  private add(t: Token, sym: Sym, decl: boolean): void {
    const line = this.lines.get(t.pos.file)?.[t.pos.line - 1];
    if (line === undefined || line.substr(t.pos.col - 1, t.text.length) !== t.text) return;
    const key = `${t.pos.file}:${t.pos.line}:${t.pos.col}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.refs.push({ file: t.pos.file, range: tokRange(t), sym, decl });
  }

  private addMember(t: Token | undefined, member: Member, decl: boolean): void {
    const line = t && this.lines.get(t.pos.file)?.[t.pos.line - 1];
    if (!t || line === undefined || line.substr(t.pos.col - 1, t.text.length) !== t.text) return;
    const key = `${t.pos.file}:${t.pos.line}:${t.pos.col}`;
    if (this.memberSeen.has(key)) return;
    this.memberSeen.add(key);
    this.members.push({ file: t.pos.file, range: tokRange(t), member, decl });
  }

  private visit(n: Node): void {
    const a = A(n);
    for (const p of (a._pre as Stmt[] | undefined) ?? []) this.visit(p);
    if (a._member) this.addMember(n.k === "FieldValue" ? n.toks[n.start] : n.toks[n.end - 1], a._member, false);
    switch (n.k) {
      case "Ident":
        if (a._sym) this.add(n.toks[n.start], a._sym, false);
        break;
      case "Selector":
        if (a._pkgMember) this.add(n.toks[n.end - 1], a._pkgMember, false);
        break;
      case "EnumType":
        for (const m of membersOf(n)) this.addMember(m.tok, m, true);
        break;
      case "Import":
        if (a._sym) {
          const t = declToken(a._sym);
          if (t) this.add(t, a._sym, true);
        }
        break;
      case "MacroCall":
        if (a._expansion) this.visit(a._expansion);
        this.macroCall(n, a._scope);
        return;
      case "ExprStmt":
        if (a._expansion) {
          for (const s of (a._expansion as Block).stmts) this.visit(s);
          if (n.x.k === "MacroCall") this.macroCall(n.x, A(n.x)._scope);
          return;
        }
        break;
      case "ValueDecl":
        ((a._syms as Sym[] | undefined) ?? []).forEach((s) => {
          const t = declToken(s);
          if (t) this.add(t, s, true);
        });
        break;
      case "ProcLit":
        if (n.comptime) {
          this.lexical(n, a._scope ?? this.a.analyzer.global);
          return;
        }
        for (const p of [...((a._params as LocalSym[] | undefined) ?? []), ...((a._results as LocalSym[] | undefined) ?? [])]) if (p.declTok) this.add(p.declTok, p, true);
        for (const c of (a._captures as CaptureSym[] | undefined) ?? []) if (c.declTok) this.add(c.declTok, c, false);
        break;
      case "RangeFor":
        for (const s of (a._syms as LocalSym[] | undefined) ?? []) if (s.declTok) this.add(s.declTok, s, true);
        break;
      case "Catch":
        if (a._errSym) {
          catchErrs.add(a._errSym);
          this.add(n.toks[n.errTok], a._errSym, true);
        }
        break;
      case "Switch":
        if (a._switchSym) {
          switchVars.add(a._switchSym);
          this.add(n.toks[n.typeSwitchVar!.tok], a._switchSym, true);
        }
        break;
      case "Poly":
        if (a._polySym) this.add(n.toks[n.start + 1], a._polySym, true);
        break;
      case "StructType":
      case "UnionType":
        for (const s of (a._polyParams as LocalSym[] | undefined) ?? []) if (s.declTok) this.add(s.declTok, s, true);
        if (n.k === "StructType" && !a._anonFields) for (const m of membersOf(n)) this.addMember(m.tok, m, true);
        break;
      case "InterfaceType":
        for (const m of (a._methods as IfaceMethod[] | undefined) ?? []) {
          const t = n.toks[n.methods.find((x) => x.name === m.name)!.tok];
          this.add(t, m.sym, false);
        }
        break;
      case "ImplBlock": {
        const iface = A(n.iface)._sym ?? A(n.iface)._pkgMember;
        if (iface?.kind !== "global") break;
        let methods: IfaceMethod[] = [];
        try {
          methods = this.a.analyzer.allMethods(iface);
        } catch {}
        for (const b of n.bindings) {
          const m = methods.find((x) => x.name === b.name);
          if (m) this.add(n.toks[b.tok], m.sym, false);
        }
        break;
      }
    }
    for (const c of children(n)) this.visit(c);
  }

  /** The macro's name, and arguments the expansion does not keep (types, names only inspected at compile time). */
  private macroCall(n: Extract<Node, { k: "MacroCall" }>, scope: Scope | undefined): void {
    const a = A(n);
    const parts: Sym[] | undefined = a._partSyms;
    if (parts) parts.forEach((s, i) => this.add(n.toks[n.start + 2 * i], s, false));
    else if (a._macroSym) this.add(n.toks[n.start], a._macroSym, false);
    else if (scope) this.lexical(n, scope);
    a._argNodes = [];
    if (scope) for (const arg of n.args) this.lexTokens(arg, scope, n);
  }

  // ---- code the analyzer does not resolve: comptime procs and macro arguments ----

  /** Resolves `name` as seen at `at`: locals declared later in the same file are skipped. */
  private lookup(name: string, scope: Scope, at: Token): Sym | undefined {
    for (let s: Scope | null = scope; s; s = s.parent) {
      const sym = s.syms.get(name);
      if (!sym) continue;
      const t = sym.kind === "local" || sym.kind === "capture" ? sym.declTok : undefined;
      if (t && t.pos.file === at.pos.file && (t.pos.line > at.pos.line || (t.pos.line === at.pos.line && t.pos.col > at.pos.col))) continue;
      return sym;
    }
    return undefined;
  }

  private resolve(t: Token, scope: Scope, only?: (s: Sym) => boolean): void {
    const sym = this.lookup(t.text, scope, t);
    if (sym && (!only || only(sym))) this.add(t, sym, false);
  }

  private declare(t: Token, scope: Scope, init: Partial<LocalSym>): LocalSym {
    const sym: LocalSym = { kind: "local", name: t.text, ctx: scope.ctx ?? { closure: false }, isConst: false, scope, refCaptured: false, declKind: "decl", declTok: t, ...init };
    if (sym.name !== "_") scope.syms.set(sym.name, sym);
    this.add(t, sym, true);
    return sym;
  }

  private typeOf(e: Expr, scope: Scope): Ty | undefined {
    try {
      return this.a.analyzer.typeOf(e, scope);
    } catch {
      return undefined;
    }
  }

  private lexical(n: Node, scope: Scope): void {
    switch (n.k) {
      case "Ident":
        this.resolve(n.toks[n.start], scope);
        return;
      case "Selector": {
        const head = n.x.k === "Ident" ? this.lookup(n.x.name, scope, n.x.toks[n.x.start]) : undefined;
        if (head?.kind !== "pkg") return this.lexical(n.x, scope);
        this.add(n.x.toks[n.x.start], head, false);
        const member = head.target?.scope.syms.get(n.name);
        if (member) this.add(n.toks[n.end - 1], member, false);
        return;
      }
      case "MacroCall": {
        const head = this.lookup(n.path[0], scope, n.toks[n.start]);
        if (head) this.add(n.toks[n.start], head, false);
        const member = n.path.length > 1 && head?.kind === "pkg" ? head.target?.scope.syms.get(n.path[1]) : undefined;
        if (member) this.add(n.toks[n.start + 2], member, false);
        A(n)._argNodes = [];
        for (const arg of n.args) this.lexTokens(arg, scope, n);
        return;
      }
      case "Quote":
        this.lexTokens(n.body, scope);
        return;
      case "ProcLit": {
        const root = new Scope(scope, null, { closure: !!n.captures });
        for (const c of n.captures ?? []) this.resolve(n.toks[c.tok], scope);
        const declare = (params: Param[], named: boolean) => {
          for (const p of params) {
            if (p.type) this.lexical(p.type, root);
            if (p.value) this.lexical(p.value, root);
            if (named) for (const nm of p.names) this.declare(n.toks[nm.tok], root, { declKind: "param", ty: p.type ? { t: "node", node: p.type, scope: root } : undefined });
          }
        };
        declare(n.sig.params, !n.sig.unnamed);
        declare(n.sig.results, !n.sig.resultsUnnamed);
        if (n.body) this.lexical(n.body, root);
        return;
      }
      case "Block": {
        const inner = n.inline ? scope : new Scope(scope);
        A(n)._scope ??= inner;
        for (const s of n.stmts) this.lexical(s, inner);
        return;
      }
      case "ValueDecl":
        if (n.type) this.lexical(n.type, scope);
        for (const v of n.values) this.lexical(v, scope);
        n.names.forEach((nm, i) => {
          const v = n.values.length === n.names.length ? n.values[i] : undefined;
          const ty: Ty | undefined = n.type ? { t: "node", node: n.type, scope } : v && this.typeOf(v, scope);
          this.declare(n.toks[nm.tok], scope, { isConst: n.isConst, ty, value: n.isConst ? v : undefined });
        });
        return;
      case "RangeFor": {
        this.lexical(n.x, scope);
        const inner = new Scope(scope);
        for (const v of n.vals) this.declare(n.toks[v.tok], inner, { declKind: "range" });
        this.lexical(n.body, inner);
        return;
      }
      case "If":
      case "For":
      case "Switch": {
        const inner = new Scope(scope);
        if (n.init) this.lexical(n.init, inner);
        if (n.k === "If") {
          this.lexical(n.cond, inner);
          this.lexical(n.then, inner);
          if (n.else) this.lexical(n.else, inner);
        } else if (n.k === "For") {
          if (n.cond) this.lexical(n.cond, inner);
          if (n.post) this.lexical(n.post, inner);
          this.lexical(n.body, inner);
        } else {
          if (n.tag) this.lexical(n.tag, inner);
          if (n.typeSwitchVar) switchVars.add(this.declare(n.toks[n.typeSwitchVar.tok], inner, { declKind: "other" }));
          for (const c of n.cases) {
            c.exprs.forEach((e) => this.lexical(e, inner));
            const caseScope = new Scope(inner);
            for (const b of c.body) this.lexical(b, caseScope);
          }
        }
        return;
      }
      case "Catch": {
        this.lexical(n.stmt, scope);
        if (!n.body) return;
        const inner = new Scope(scope);
        if (n.errName) catchErrs.add(this.declare(n.toks[n.errTok], inner, { declKind: "other" }));
        this.lexical(n.body, inner);
        return;
      }
    }
    for (const c of children(n)) this.lexical(c, scope);
  }

  /**
   * Raw tokens: an argument of macro call `call` (parsed when possible, and kept on the call so completion
   * finds its scopes), or else a quote body, where only `$name` and `$(...)` are compile-time code.
   */
  private lexTokens(toks: Token[], scope: Scope, call?: Node): void {
    const quote = !call;
    if (call) {
      const end = toks[toks.length - 1]?.kind === "eof" ? toks : [...toks, { kind: "eof" as const, text: "", pre: "", pos: toks[toks.length - 1]?.pos }];
      for (const parse of [(p: Parser) => p.parseExpr(), (p: Parser) => p.parseBlock(), (p: Parser) => p.parseType()]) {
        let node: Node;
        try {
          const p = new Parser(end, { comptimeDepth: 1, take: true });
          node = parse(p);
          p.expectEnd();
        } catch {
          continue;
        }
        A(call)._argNodes.push(node);
        return this.lexical(node, scope);
      }
    }
    const declared = new Map<string, LocalSym>();
    const quoteScope = new Scope(scope);
    let splice = 0;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      const prev = toks[i - 1];
      if (t.kind === "op" && t.text === "(" && (splice || (quote && prev?.text === "$"))) splice++;
      else if (t.kind === "op" && t.text === ")" && splice) splice--;
      if (t.kind !== "ident" || prev?.text === ".") continue;
      if (!quote || splice || prev?.text === "$") {
        this.resolve(t, scope);
        continue;
      }
      const local = declared.get(t.text);
      if (local) {
        this.add(t, local, false);
        continue;
      }
      const next = toks[i + 1]?.text;
      const loopVar = (prev?.text === "for" || (prev?.text === "," && toks[i - 3]?.text === "for")) && (next === "in" || next === ",");
      if (((next === ":=" || next === ":" || next === "::") && prev?.text !== "case") || loopVar) {
        const sym: LocalSym = { kind: "local", name: t.text, ctx: { closure: false }, isConst: next === "::", scope: quoteScope, refCaptured: false, declKind: loopVar ? "range" : "decl", declTok: t };
        declared.set(t.text, sym);
        quoteLocals.add(sym);
        this.add(t, sym, true);
        continue;
      }
      this.resolve(t, scope, (s) => s.kind === "global" || s.kind === "pkg");
    }
  }

  globals(): Sym[] {
    return this.a.packages.flatMap((p) => [...p.scope.syms.values()]);
  }

  refAt(file: string, p: Position): Ref | undefined {
    return this.refs.find((r) => r.file === file && contains(r.range, p));
  }

  refsTo(sym: Sym): Ref[] {
    const target = canonical(sym);
    return this.refs.filter((r) => canonical(r.sym) === target);
  }

  memberAt(file: string, p: Position): MemberRef | undefined {
    return this.members.find((r) => r.file === file && contains(r.range, p));
  }

  usesOf(member: Member): MemberRef[] {
    return this.members.filter((r) => r.member === member);
  }
}

// ---- node lookup ----

function fileOf(a: Analysis, file: string) {
  for (const p of a.packages) {
    const f = p.files.find((x) => x.path === file);
    if (f) return { file: f, pkg: p };
  }
  return undefined;
}

/** Innermost nodes containing `p`, outermost first. */
function nodesAt(a: Analysis, file: string, p: Position): Node[] {
  const f = fileOf(a, file)?.file;
  if (!f) return [];
  const path: Node[] = [];
  let level: Node[] = f.stmts;
  for (;;) {
    const hit = level.find((n) => n.end > n.start && n.toks === f.toks && contains(nodeRange(n), p));
    if (!hit) return path;
    path.push(hit);
    level = children(hit);
  }
}

/** The innermost analyzed scope around `p`. */
export function scopeAt(a: Analysis, file: string, p: Position): { scope: Scope; depth: number } {
  const f = fileOf(a, file);
  let scope = (f && f.pkg.fileScopes.get(f.file)) ?? a.analyzer.global;
  let depth = 0;
  for (const n of nodesAt(a, file, p)) {
    const s: Scope | undefined = A(n)._scope;
    if (s && (n.k === "Block" || n.k === "ImplBlock")) {
      scope = s;
      depth++;
    }
    let inner: { scope: Scope; depth: number } | undefined;
    for (const x of generated(n)) {
      const found = generatedScopeAt(x, file, p);
      if (found && found.depth > (inner?.depth ?? 0)) inner = found;
    }
    if (inner) {
      scope = inner.scope;
      depth += inner.depth;
    }
  }
  return { scope, depth };
}

/** Code the analyzer made from `n` (macro expansions, hoisted statements): not children, but scopes live there. */
function generated(n: Node): Node[] {
  const a = A(n);
  return [...(a._expansion ? [a._expansion as Node] : []), ...((a._pre as Stmt[] | undefined) ?? []), ...((a._argNodes as Node[] | undefined) ?? [])];
}

/** Where the tokens of `n` that come from `file` start and end. */
function spanIn(n: Node, file: string): Range | undefined {
  if (n.k === "Block" && n.end <= n.start) {
    const spans = n.stmts.map((s) => spanIn(s, file)).filter((r): r is Range => !!r);
    return spans.length ? { start: spans[0].start, end: spans[spans.length - 1].end } : undefined;
  }
  const toks = n.toks.slice(n.start, n.end).filter((t) => t.pos.file === file);
  return toks.length ? { start: tokRange(toks[0]).start, end: tokRange(toks[toks.length - 1]).end } : undefined;
}

/** The innermost analyzed block around `p` inside generated code, by the source positions its tokens keep. */
function generatedScopeAt(root: Node, file: string, p: Position): { scope: Scope; depth: number } | undefined {
  let best: { scope: Scope; depth: number } | undefined;
  const visit = (n: Node, depth: number) => {
    const s: Scope | undefined = A(n)._scope;
    if (n.k === "Block" && s) {
      const span = spanIn(n, file);
      if (!span || !contains(span, p)) return;
      best = { scope: s, depth: ++depth };
    }
    for (const c of [...children(n), ...generated(n)]) visit(c, depth);
  };
  visit(root, 0);
  return best;
}

// ---- types ----

/** `multiline` lays out anonymous struct types one field per line (for hovers). */
function typeName(a: Analysis, ty: Ty | undefined, multiline = false): string {
  if (!ty) return "?";
  if (ty.t === "untyped") return ty.kind === "int" ? "int" : ty.kind === "float" ? "f64" : ty.kind;
  if (ty.t === "ptr") return `^${typeName(a, ty.elem, multiline)}`;
  if (ty.t === "sig") return `${ty.closure ? "closure" : "proc"}${sigText(ty.sig.params, ty.sig.results)}`;
  return typeText(ty.node, multiline);
}

function typeText(node: Expr, multiline = false, indent = ""): string {
  const fields: AnonFieldType[] | undefined = A(node)._anonFields;
  if (!fields) return nodeText(node);
  if (!multiline) return `struct { ${fields.map((f) => `${f.name}: ${f.type ? typeText(f.type) : f.text}`).join(", ")} }`;
  const width = Math.max(...fields.map((f) => f.name.length));
  const lines = fields.map((f) => `${indent}\t${`${f.name}:`.padEnd(width + 1)} ${f.type ? typeText(f.type, true, indent + "\t") : f.text},\n`);
  return `struct {\n${lines.join("")}${indent}}`;
}

function sigText(params: Param[], results: Param[]): string {
  const text = (e: Expr | undefined) => (e ? sliceText(e.toks, e.start, e.end) : "");
  const ps = params.map((p) => (p.names.length ? `${p.names.map((n) => n.name).join(", ")}: ` : "") + text(p.type)).join(", ");
  const rs = results.map((r) => text(r.type)).join(", ");
  return `(${ps})${rs ? ` -> ${results.length > 1 ? `(${rs})` : rs}` : ""}`;
}

/** Struct or interface definition behind a type, following pointers and aliases. */
function shape(a: Analysis, ty: Ty | undefined): Extract<Expr, { k: "StructType" | "InterfaceType" }> | undefined {
  let n = a.analyzer.normalize(ty);
  if (n?.t === "ptr") n = a.analyzer.normalize(n.elem);
  if (n?.t === "node" && (n.node.k === "StructType" || n.node.k === "InterfaceType")) return n.node;
  return undefined;
}

function chainType(a: Analysis, chain: string, scope: Scope): Ty | undefined {
  const [head, ...rest] = chain.split(".");
  const sym = a.analyzer.lookup(head, scope, null);
  let ty = symType(a, sym);
  for (const f of rest) ty = a.analyzer.fieldOf(ty, f);
  return ty;
}

function symType(a: Analysis, sym: Sym | undefined): Ty | undefined {
  if (!sym) return undefined;
  if (sym.kind === "local") return sym.ty;
  if (sym.kind === "capture") return symType(a, canonical(sym));
  if (sym.kind === "global") {
    if (sym.decl.type) return { t: "node", node: sym.decl.type, scope: sym.scope };
    const v = sym.decl.values[sym.index];
    return v ? a.analyzer.typeOf(v, sym.scope) : undefined;
  }
  return undefined;
}

// ---- hover ----

function declKindLabel(sym: GlobalSym): string {
  const v = sym.decl.values[sym.index];
  if (v?.k === "ProcLit") return v.comptime ? "macro (comptime proc)" : A(v)._ifaceMethod ? "interface method" : "proc";
  if (v?.k === "InterfaceType") return "interface";
  if (v?.k === "StructType") return "struct";
  if (v?.k === "EnumType") return "enum";
  if (v?.k === "UnionType") return "union";
  return sym.isConst ? "constant" : "variable";
}

function declSnippet(sym: GlobalSym): string {
  const d = sym.decl;
  const v = d.values[sym.index];
  let end = d.end;
  if (v?.k === "ProcLit" && v.body) end = v.body.start;
  const text = sliceText(d.toks, d.start, end).trimEnd();
  const lines = text.split("\n");
  return lines.length > 16 ? [...lines.slice(0, 15), "\t..."].join("\n") : text;
}

function qualified(sym: GlobalSym): string {
  return `${sym.pkg.name}.${sym.name}`;
}

function localKind(sym: LocalSym): string {
  if (switchVars.has(sym)) return "type switch variable";
  if (catchErrs.has(sym)) return "error caught by `catch` (the call's last result)";
  if (sym.declKind === "param") return sym.isConst && !sym.ty ? "polymorphic parameter (set from the arguments at each use)" : "parameter";
  if (sym.declKind === "range") return "loop variable";
  return sym.isConst ? "constant" : "local variable";
}

function localDecl(a: Analysis, sym: LocalSym): string {
  if (sym.ty) return `${sym.name}: ${typeName(a, sym.ty, true)}`;
  if (sym.isConst && sym.value) {
    const text = nodeText(sym.value);
    if (text.length <= 80) return `${sym.name} :: ${text}`;
  }
  return sym.declKind === "param" && sym.isConst ? `$${sym.name}` : sym.name;
}

export function describe(a: Analysis, sym: Sym): string {
  const code = (s: string) => "```odin\n" + s + "\n```";
  switch (sym.kind) {
    case "global": {
      const notes = [`*${declKindLabel(sym)}* \`${qualified(sym)}\``];
      if (sym.odinName !== sym.name) notes.push(`Odin name: \`${sym.odinName}\` (package \`${sym.pkg.name}\` is merged into \`${sym.pkg.unit.name}\` because of an import cycle)`);
      if (sym.isPrivate) notes.push(`private to package \`${sym.pkg.name}\``);
      const v = sym.decl.values[sym.index];
      const extendsOrIs = (x: GlobalSym, iface: GlobalSym) => {
        try {
          return x === iface || a.analyzer.ancestorsOf(x).includes(iface);
        } catch {
          return x === iface;
        }
      };
      // implied impls repeat an impl of an extending interface
      const impls = (iface: GlobalSym) => a.analyzer.impls.filter((i) => !i.implied && extendsOrIs(i.iface, iface));
      const target = (i: { node: { target: Expr } }) => `\`${sliceText(i.node.target.toks, i.node.target.start, i.node.target.end)}\``;
      if (v?.k === "InterfaceType") {
        const found = impls(sym).map(target);
        notes.push(found.length ? `implemented by ${found.join(", ")}` : "no implementations yet");
      }
      const method: IfaceMethod | undefined = v && A(v)._ifaceMethod;
      if (method) {
        const found = impls(method.iface).map((i) => `\`${i.methods.get(method.name)!.name}\` (${target(i)})`);
        notes.push(`method of \`${method.iface.name}\``, found.length ? `implemented by ${found.join(", ")}` : "no implementations yet");
      }
      return code(declSnippet(sym)) + "\n\n" + notes.join(" · ");
    }
    case "local": {
      const notes = [`*${localKind(sym)}*`];
      if (quoteLocals.has(sym)) notes.push("declared in quoted code: each expansion renames it, so it never clashes with the caller's names");
      if (switchVars.has(sym)) notes.push("in each `case`, it has that case's type");
      if (sym.refCaptured) notes.push("captured by reference");
      if (!sym.ty && !switchVars.has(sym) && !sym.isConst) notes.push("type not known to vidar");
      return code(localDecl(a, sym)) + "\n\n" + notes.join(" · ");
    }
    case "capture": {
      const root = canonical(sym) as LocalSym;
      return code(localDecl(a, { ...root, name: sym.name })) + `\n\n*captured ${sym.byRef ? "by reference" : "by value (a copy made when the closure was created)"}*`;
    }
    case "pkg": {
      const head = code(`import ${sym.stmt.alias ? sym.stmt.alias + " " : ""}"${sym.path}"`);
      if (!sym.target) return head + "\n\n*Odin package (collection import)*";
      const members = [...sym.target.scope.syms.values()].filter((m) => !(m.kind === "global" && m.isPrivate));
      const cycle = sym.target.unit.merged ? ` · in an import cycle, merged into \`${sym.target.unit.name}\`` : "";
      return head + `\n\n*package* \`${sym.target.name}\` · ${members.length} public member(s)${cycle}`;
    }
  }
}

export interface HoverResult {
  markdown: string;
  range: Range;
  /** a generic answer: ols (which sees the generated Odin) may know more, so ask it first */
  weak?: boolean;
}

export function hover(a: Analysis, index: Index, file: string, p: Position): HoverResult | undefined {
  const ref = index.refAt(file, p);
  const expansion = macroExpansionAt(a, file, p);
  if (ref && expansion) return { markdown: describe(a, ref.sym) + "\n\n---\n\n" + expansion, range: ref.range };
  if (ref) {
    const caseTy = switchVars.has(ref.sym) ? caseType(a, file, p) : undefined;
    if (caseTy) return { markdown: "```odin\n" + `${ref.sym.name}: ${nodeText(caseTy)}` + "\n```\n\n*type switch variable* · has this type in this `case`", range: ref.range };
    const local = ref.sym.kind === "local" || ref.sym.kind === "capture";
    return { markdown: describe(a, ref.sym), range: ref.range, weak: local && !symType(a, canonical(ref.sym)) };
  }
  const resolved = index.memberAt(file, p);
  if (resolved) return { markdown: memberHover(a, resolved.member).markdown, range: resolved.range };
  const member = memberAt(a, file, p);
  if (member) return { markdown: member.markdown, range: member.range };
  const t = tokenHover(a, file, p);
  return t && { markdown: t.markdown, range: t.range, weak: t.weak };
}

/** past this many lines, an expansion on hover is cut */
const EXPANSION_LINES = 40;

const expansionCache = new WeakMap<Analysis, Map<Node, string[]>>();

/** The code a macro call writes, when `p` is on the call's name; from emitting the whole program once per analysis. */
function macroExpansionAt(a: Analysis, file: string, p: Position): string | undefined {
  const call = nodesAt(a, file, p).reverse().find((n): n is Extract<Expr, { k: "MacroCall" }> => {
    if (n.k !== "MacroCall") return false;
    for (let i = n.start; i < n.end && n.toks[i].text !== "!"; i++) if (contains(tokRange(n.toks[i]), p)) return true;
    return false;
  });
  if (!call || a.errors.length) return undefined;
  let expansions = expansionCache.get(a);
  if (!expansions) {
    expansions = new Map();
    try {
      emitProgram(a, expansions);
    } catch {
      // the hover still shows the macro itself
    }
    expansionCache.set(a, expansions);
  }
  const pieces = (expansions.get(call) ?? []).map((t) => t.replace(/^\s*\n|\s+$/g, "")).filter(Boolean);
  if (!pieces.length) return undefined;
  const lines = pieces.map(dedent).join("\n").split("\n");
  const cut = lines.length > EXPANSION_LINES ? [...lines.slice(0, EXPANSION_LINES), `// ... ${lines.length - EXPANSION_LINES} more lines`] : lines;
  return "*expands to*\n```odin\n" + cut.join("\n") + "\n```";
}

/** Code whose first line starts where the call was: the later lines lose the indentation they all share. */
function dedent(text: string): string {
  const [first, ...rest] = text.split("\n");
  const tabs = (l: string) => l.match(/^\t*/)![0].length;
  const common = Math.min(...rest.filter((l) => l.trim()).map(tabs));
  return [first.replace(/^\t+/, ""), ...rest.map((l) => l.slice(Math.min(common, tabs(l))))].join("\n");
}

/** Inside `case T:` of a type switch: `T` (only when the case lists one type). */
function caseType(a: Analysis, file: string, p: Position): Expr | undefined {
  const at = fileOf(a, file)?.file.toks.find((t) => t.pos.file === file && contains(tokRange(t), p));
  const f = fileOf(a, file)?.file;
  if (!at || !f) return undefined;
  const path = pathTo(f.stmts, at);
  for (let i = path.length - 1; i > 0; i--) {
    const c = path[i];
    if (c.k === "Case" && path[i - 1].k === "Switch" && (path[i - 1] as Extract<Stmt, { k: "Switch" }>).typeSwitchVar) return c.exprs.length === 1 ? c.exprs[0] : undefined;
  }
  return undefined;
}

function anonFieldHover(f: AnonFieldType): { markdown: string; target: Location } {
  const note = f.type ? "*field of an anonymous struct*" : "*field of an anonymous struct* · type inferred by Odin";
  return { markdown: "```odin\n" + `${f.name}: ${f.type ? typeText(f.type, true) : f.text}` + "\n```\n\n" + note, target: { file: f.tok.pos.file, range: tokRange(f.tok) } };
}

/** A field name inside an anonymous struct literal: `{ name = value }`. */
function anonFieldAt(a: Analysis, file: string, p: Position): { markdown: string; range: Range; target: Location } | undefined {
  for (const n of nodesAt(a, file, p).reverse()) {
    if (n.k !== "FieldValue") continue;
    const tok = n.toks[n.start];
    if (!contains(tokRange(tok), p)) return undefined;
    const lit = nodesAt(a, file, p).find((x) => x.k === "CompoundLit" && x.elems.includes(n));
    const ty: Ty | undefined = lit && A(lit)._anonTy;
    const fields: AnonFieldType[] | undefined = ty?.t === "node" ? A(ty.node)._anonFields : undefined;
    const f = fields?.find((x) => x.name === n.name);
    return f && { ...anonFieldHover(f), range: tokRange(tok) };
  }
  return undefined;
}

/** `x.field` and `x->method` under the cursor. */
function memberAt(a: Analysis, file: string, p: Position): { markdown: string; range: Range; target?: Location } | undefined {
  const field = anonFieldAt(a, file, p);
  if (field) return field;
  for (const n of nodesAt(a, file, p).reverse()) {
    if (n.k !== "Selector" && n.k !== "ArrowCall") continue;
    const nameTok = n.k === "Selector" ? n.toks[n.end - 1] : n.toks.slice(n.start, n.end).find((t, i, arr) => arr[i - 1]?.text === "->");
    if (!nameTok || !contains(tokRange(nameTok), p)) continue;
    const scope: Scope = A(n)._scope ?? a.analyzer.global;
    const def = shape(a, a.analyzer.typeOf(n.x, scope));
    if (!def) return undefined;
    if (def.k === "StructType") {
      const anon = (A(def)._anonFields as AnonFieldType[] | undefined)?.find((f) => f.name === n.name);
      if (anon) return { ...anonFieldHover(anon), range: tokRange(nameTok) };
      for (const f of def.fields) {
        const name = f.names.find((x) => x.name === n.name);
        if (name && f.type) {
          const t = def.toks[name.tok];
          return {
            markdown: "```odin\n" + `${n.name}: ${sliceText(f.type.toks, f.type.start, f.type.end)}` + "\n```\n\n*field*",
            range: tokRange(nameTok),
            target: { file: t.pos.file, range: tokRange(t) },
          };
        }
      }
    }
    return undefined;
  }
  return undefined;
}

// ---- hover for names the reference index does not cover ----

interface TokenHover {
  markdown: string;
  range: Range;
  weak?: boolean;
  target?: Location;
}

const md = (sig: string | undefined, text: string) => (sig ? "```odin\n" + sig + "\n```\n\n" : "") + text;

/** The token at `p` in `file`, with its index in the file's tokens. */
function tokenAt(a: Analysis, file: string, p: Position): { f: { toks: Token[]; stmts: Stmt[] }; i: number } | undefined {
  const f = fileOf(a, file)?.file;
  if (!f) return undefined;
  const i = f.toks.findIndex((t) => t.pos.file === file && (t.kind === "ident" || t.kind === "kw") && contains(tokRange(t), p));
  return i < 0 ? undefined : { f, i };
}

/** Nodes whose tokens include `tok`, outermost first; descends into parsed macro arguments too. */
function pathTo(stmts: Node[], tok: Token): Node[] {
  const path: Node[] = [];
  const has = (n: Node) => {
    const i = n.toks.indexOf(tok, n.start);
    return i >= 0 && i < n.end;
  };
  let level: Node[] = stmts;
  for (;;) {
    const hit = level.find(has);
    if (!hit) return path;
    path.push(hit);
    level = [...children(hit), ...((A(hit)._argNodes as Node[] | undefined) ?? [])];
  }
}

function scopeOf(a: Analysis, path: Node[], file: string, p: Position): Scope {
  for (let i = path.length - 1; i >= 0; i--) {
    const s: Scope | undefined = A(path[i])._scope;
    if (s) return s;
  }
  return scopeAt(a, file, p).scope;
}

/** The name a type is declared under: `Name :: struct { ... }`. */
function declaredName(path: Node[], node: Node): string | undefined {
  for (let i = path.length - 1; i >= 0; i--) {
    const d = path[i];
    if (d.k !== "ValueDecl") continue;
    const at = d.values.indexOf(node as Expr);
    return at >= 0 ? d.names[at]?.name : undefined;
  }
  return undefined;
}

function fieldDeclHover(def: Extract<Expr, { k: "StructType" }>, name: string, owner: string | undefined): Omit<TokenHover, "range"> | undefined {
  for (const f of def.fields) {
    const n = f.names.find((x) => x.name === name);
    if (!n) continue;
    const t = def.toks[n.tok];
    const type = f.type ? nodeText(f.type) : f.value ? `type of ${nodeText(f.value)}` : "?";
    return { markdown: md(`${name}: ${type}`, owner ? `*field of struct* \`${owner}\`` : "*field of an anonymous struct*"), target: { file: t.pos.file, range: tokRange(t) } };
  }
  return undefined;
}

function enumMemberHover(def: Extract<Expr, { k: "EnumType" }>, index: number, owner: string | undefined): Omit<TokenHover, "range"> {
  const m = def.members[index];
  const value = m.value ? nodeText(m.value) : def.members.slice(0, index + 1).every((x) => !x.value) ? String(index) : undefined;
  const t = def.toks[m.tok];
  const name = owner ? `${owner}.${m.name}` : `.${m.name}`;
  return { markdown: md(value !== undefined ? `${name} = ${value}` : name, owner ? `*enum member of* \`${owner}\`` : "*enum member*"), target: { file: t.pos.file, range: tokRange(t) } };
}

const ownerNames = new WeakMap<Analysis, Map<Node, string>>();

/** The name a struct or enum is declared under, at file scope or as a local constant. */
function ownerName(a: Analysis, owner: Node): string | undefined {
  let names = ownerNames.get(a);
  if (!names) {
    names = new Map();
    const found = names;
    const visit = (n: Node) => {
      if (n.k === "ValueDecl" && n.isConst) {
        n.values.forEach((v, i) => {
          while (v.k === "Directive" && v.x) v = v.x;
          if (n.names[i] && !found.has(v)) found.set(v, n.names[i].name);
        });
      }
      for (const c of children(n)) visit(c);
    };
    for (const f of allFiles(a)) for (const s of f.stmts) visit(s);
    ownerNames.set(a, names);
  }
  return names.get(owner);
}

function memberHover(a: Analysis, m: Member): Omit<TokenHover, "range"> {
  const owner = ownerName(a, m.owner);
  if (m.owner.k === "EnumType") return enumMemberHover(m.owner, m.index ?? 0, owner);
  return fieldDeclHover(m.owner, m.name, owner) ?? { markdown: md(m.name, "*field*") };
}

/** Enum declarations in the program that have a member called `name`. */
function enumsWith(a: Analysis, name: string): { sym: GlobalSym; def: Extract<Expr, { k: "EnumType" }>; index: number }[] {
  const out: { sym: GlobalSym; def: Extract<Expr, { k: "EnumType" }>; index: number }[] = [];
  for (const p of a.packages) {
    for (const sym of p.scope.syms.values()) {
      if (sym.kind !== "global") continue;
      const v = sym.decl.values[sym.index];
      const index = v?.k === "EnumType" ? v.members.findIndex((m) => m.name === name) : -1;
      if (index >= 0) out.push({ sym, def: v as Extract<Expr, { k: "EnumType" }>, index });
    }
  }
  return out;
}

/** The type a `{ ... }` literal without a type in front gets from where it is written. */
function literalType(a: Analysis, path: Node[], lit: Expr, scope: Scope): Ty | undefined {
  if (lit.k === "CompoundLit" && lit.type) return { t: "node", node: lit.type, scope };
  const at = path.indexOf(lit);
  const parent = path[at - 1];
  if (!parent) return undefined;
  if (parent.k === "ValueDecl" && parent.type) return { t: "node", node: parent.type, scope };
  if (parent.k === "FieldValue") {
    const outer = path[at - 2];
    return outer && a.analyzer.fieldOf(literalType(a, path, outer as Expr, scope), parent.name);
  }
  if (parent.k === "CompoundLit") return a.analyzer.elemOf(literalType(a, path, parent, scope) ?? { t: "untyped", kind: "int" });
  if (parent.k === "Return") {
    const proc = [...path.slice(0, at)].reverse().find((n) => n.k === "ProcLit") as Extract<Expr, { k: "ProcLit" }> | undefined;
    const i = parent.results.indexOf(lit);
    return proc && i >= 0 ? a.analyzer.resultTy({ t: "sig", closure: false, sig: proc.sig, scope }, i) : undefined;
  }
  if (parent.k === "Assign") {
    const i = parent.rhs.indexOf(lit);
    return i >= 0 && parent.lhs[i] ? a.analyzer.typeOf(parent.lhs[i], scope) : undefined;
  }
  return undefined;
}

const own = <T>(table: Record<string, T>, key: string): T | undefined => (Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined);

function builtinHover(name: string): Omit<TokenHover, "range"> | undefined {
  const type = own(BUILTIN_TYPE_DOCS, name);
  if (type) return { markdown: md(name, `*builtin type* · ${type}`) };
  const proc = own(BUILTIN_PROC_DOCS, name);
  if (proc) return { markdown: md(proc.sig, `*builtin proc* · ${proc.text}`), weak: true };
  const comptime = own(COMPTIME_BUILTIN_DOCS, name);
  if (comptime) return { markdown: md(comptime.sig, `*compile-time builtin* · ${comptime.text}`) };
  const kind = own(MACRO_KIND_DOCS, name);
  if (kind) return { markdown: md(name, `*macro kind* · ${kind}`) };
  const constant = own(ODIN_CONSTANT_DOCS, name);
  if (constant) return { markdown: md(constant.sig, `*builtin constant* · ${constant.text}`) };
  if (name === "_") return { markdown: md("_", "*blank identifier* · discards the value assigned to it") };
  return undefined;
}

/**
 * Hover for any identifier or keyword the reference index has nothing for: keywords and builtins,
 * declarations of fields and enum members, field names in literals, and members of Odin packages.
 */
function tokenHover(a: Analysis, file: string, p: Position): TokenHover | undefined {
  const at = tokenAt(a, file, p);
  if (!at) return undefined;
  const { f, i } = at;
  const tok = f.toks[i];
  const range = tokRange(tok);
  const prev = f.toks[i - 1];
  const path = pathTo(f.stmts, tok);
  const node = path[path.length - 1];
  const done = (h: Omit<TokenHover, "range"> | undefined) => h && { ...h, range };

  if (node?.k === "Package" && node.nameTok === i) {
    const pkg = a.packages.find((x) => x.files.some((y) => y.toks === f.toks));
    const files = pkg?.files.length ?? 1;
    return done({ markdown: md(`package ${tok.text}`, `*package* · ${files} file${files === 1 ? "" : "s"}${pkg?.unit.merged ? ` · in an import cycle, merged into \`${pkg.unit.name}\`` : ""}`) });
  }

  // `@(name)` / `@(name = value)`
  for (let j = i - 1; j >= 1 && f.toks[j].text !== ")"; j--) {
    if (f.toks[j].text === "(" && f.toks[j - 1].text === "@") {
      const doc = own(ATTRIBUTE_DOCS, tok.text);
      return done({ markdown: md(`@(${tok.text})`, `*attribute*${doc ? ` · ${doc}` : ""}`) });
    }
  }

  if (prev?.text !== ".") {
    const doc = own(KEYWORD_DOCS, tok.text);
    if (doc && (tok.kind === "kw" || !node || node.k !== "FieldValue" || node.toks[node.start] !== tok)) {
      const sig = tok.text === "proc" && f.toks[i + 1]?.text === "!" ? "proc!" : doc.sig;
      return done({ markdown: md(sig, `*keyword* · ${doc.text}`) });
    }
  }

  for (let j = path.length - 1; j >= 0; j--) {
    const n = path[j];
    if (n.k === "StructType") {
      const field = n.fields.find((x) => x.names.some((y) => y.tok === i && n.toks === f.toks));
      if (field) return done(fieldDeclHover(n, tok.text, declaredName(path, n)));
    }
    if (n.k === "EnumType" && n.toks === f.toks) {
      const index = n.members.findIndex((m) => m.tok === i);
      if (index >= 0) return done(enumMemberHover(n, index, declaredName(path, n)));
    }
    if ((n.k === "ProcType" || n.k === "ClosureType" || n.k === "ProcLit") && n.toks === f.toks) {
      for (const [list, what] of [[n.sig.params, "parameter"], [n.sig.results, "named result"]] as const) {
        const param = list.find((x) => x.names.some((y) => y.tok === i));
        if (!param) continue;
        const kind = n.k === "ClosureType" ? "closure type" : n.k === "ProcType" ? "proc type" : "comptime proc";
        return done({ markdown: md(`${tok.text}: ${param.type ? nodeText(param.type) : "?"}`, `*${what} of a ${kind}*`) });
      }
    }
  }

  const scope = scopeOf(a, path, file, p);

  if (node?.k === "ImplicitSelector") {
    const found = enumsWith(a, node.name);
    if (found.length === 1) return done(enumMemberHover(found[0].def, found[0].index, found[0].sym.name));
    if (found.length > 1) return done({ markdown: md(`.${node.name}`, `*enum member* of ${found.map((x) => `\`${x.sym.name}\``).join(", ")} (the type comes from where it is used)`) });
    return done({ markdown: md(`.${node.name}`, "*enum member* · the enum type comes from where it is used"), weak: true });
  }

  if (node?.k === "FieldValue" && node.toks[node.start] === tok) {
    const parent = path[path.length - 2];
    if (parent?.k === "Call") return done({ markdown: md(`${node.name} = ${nodeText(node.value)}`, "*named argument*"), weak: true });
    const ty = parent && literalType(a, path, parent as Expr, scope);
    const def = shape(a, ty);
    if (def?.k === "StructType") {
      const h = fieldDeclHover(def, node.name, ty?.t === "node" ? nodeText(ty.node) : undefined);
      if (h) return done(h);
    }
    return done({ markdown: md(node.name, "*field name*"), weak: true });
  }

  if ((node?.k === "Selector" && node.toks[node.end - 1] === tok) || (node?.k === "ArrowCall" && prev?.text === "->")) {
    const x = node.x;
    if (x.k === "Ident" && x.name === "context" && !A(x)._sym && node.k === "Selector") {
      const doc = own(CONTEXT_FIELD_DOCS, tok.text);
      return done({ markdown: md(doc?.sig ?? tok.text, `*field of* \`context\`${doc ? ` · ${doc.text}` : ""}`), weak: !doc });
    }
    const head: Sym | undefined = x.k === "Ident" ? A(x)._sym ?? a.analyzer.lookup(x.name, scope, null) : undefined;
    if (head?.kind === "pkg") return done({ markdown: md(`${head.name}.${tok.text}`, `*member of Odin package* \`${head.path}\``), weak: true });
    let recv: Ty | undefined;
    try {
      recv = a.analyzer.typeOf(x, scope);
    } catch {}
    const xSym: Sym | undefined = x.k === "Ident" ? A(x)._sym : undefined;
    const caseTy = xSym && switchVars.has(xSym) ? caseType(a, file, tokRange(x.toks[x.start]).start) : undefined;
    if (caseTy) recv = { t: "node", node: caseTy, scope };
    const def = shape(a, recv);
    const anon = def && (A(def)._anonFields as AnonFieldType[] | undefined)?.find((fl) => fl.name === tok.text);
    if (anon) return done(anonFieldHover(anon));
    if (def?.k === "StructType" && node.k === "Selector") {
      const h = fieldDeclHover(def, tok.text, typeName(a, recv).replace(/^\^/, ""));
      if (h) return done(h);
    }
    const what = node.k === "ArrowCall" ? "method" : "field";
    if (def?.k === "InterfaceType" && node.k === "Selector") {
      return done({ markdown: md(`${nodeText(x)}.${tok.text}`, `*field of an interface value* · interface values are a data pointer (\`data\`) and a method table (\`__vtable\`)`) });
    }
    return done({ markdown: md(recv ? `${tok.text} (${what} of ${typeName(a, recv)})` : tok.text, `*${what}*`), weak: true });
  }

  // `pkg.name` in tokens that were never parsed (quoted code)
  const owner = prev?.text === "." && f.toks[i - 2]?.kind === "ident" ? a.analyzer.lookup(f.toks[i - 2].text, scope, null) : undefined;
  if (owner?.kind === "pkg") {
    const member = owner.target?.scope.syms.get(tok.text);
    if (member) return done({ markdown: describe(a, member) });
    return done({ markdown: md(`${owner.name}.${tok.text}`, `*member of Odin package* \`${owner.path}\``), weak: true });
  }

  const builtin = builtinHover(tok.text);
  if (builtin) return done(builtin);

  if (tok.kind === "ident") return done({ markdown: md(tok.text, "*identifier* · not declared in vidar code, so Odin resolves it"), weak: true });
  return undefined;
}

// ---- navigation ----

export function definition(a: Analysis, index: Index, file: string, p: Position): Location | undefined {
  const ref = index.refAt(file, p);
  if (ref) {
    const t = declToken(ref.sym);
    return t && { file: t.pos.file, range: tokRange(t) };
  }
  const member = index.memberAt(file, p)?.member;
  if (member) return { file: member.tok.pos.file, range: tokRange(member.tok) };
  return memberAt(a, file, p)?.target ?? tokenHover(a, file, p)?.target;
}

export function references(index: Index, file: string, p: Position, includeDecl = true): Location[] {
  const ref = index.refAt(file, p);
  const member = ref ? undefined : index.memberAt(file, p)?.member;
  const found: { file: string; range: Range; decl: boolean }[] = ref ? index.refsTo(ref.sym) : member ? index.usesOf(member) : [];
  return found.filter((r) => includeDecl || !r.decl).map((r) => ({ file: r.file, range: r.range }));
}

/** Renames a field or enum member: refused while some use of a member of that name couldn't be resolved. */
function renameMember(index: Index, member: Member, newName: string): { edits: RenameEdit[]; error?: string } {
  const decl = member.tok;
  if (!index.a.sources.some((s) => s.path === decl.pos.file) || decl.pos.file === schedSourcePath()) return { edits: [], error: "this symbol is not declared in the workspace" };
  const what = member.kind === "field" ? "field" : "enum member";
  const misses = index.memberMisses.filter((m) => m.kind === member.kind && m.name === member.name);
  if (misses.length) {
    const first = misses[0];
    const where = `${first.tok.pos.file.split(/[\\/]/).pop()}:${first.tok.pos.line}:${first.tok.pos.col}`;
    return { edits: [], error: `can't rename ${what} '${member.name}': vidar couldn't tell what ${misses.length === 1 ? "one use" : `${misses.length} uses`} of '.${member.name}' refer${misses.length === 1 ? "s" : ""} to, first at ${where} (${first.why})` };
  }
  return { edits: index.usesOf(member).map((r) => ({ file: r.file, range: r.range, text: newName })) };
}

export interface RenameEdit extends Location {
  text: string;
}

export function rename(index: Index, file: string, p: Position, newName: string): { edits: RenameEdit[]; error?: string } {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(newName)) return { edits: [], error: `'${newName}' is not a valid identifier` };
  const ref = index.refAt(file, p);
  const member = ref ? undefined : index.memberAt(file, p)?.member;
  if (member) return renameMember(index, member, newName);
  if (!ref) return { edits: [], error: "nothing to rename here" };
  const decl = declToken(ref.sym);
  if (!decl || !index.a.sources.some((s) => s.path === decl.pos.file) || decl.pos.file === schedSourcePath())
    return { edits: [], error: "this symbol is not declared in the workspace" };
  return {
    edits: index.refsTo(ref.sym).map((r) => {
      // `import "path"` has no name to replace: give it an alias
      if (r.decl && ref.sym.kind === "pkg" && !ref.sym.stmt.alias) return { file: r.file, range: { start: r.range.start, end: r.range.start }, text: `${newName} ` };
      return { file: r.file, range: r.range, text: newName };
    }),
  };
}

// ---- outline ----

function symbolKind(v: Expr | undefined, isConst: boolean): SymbolKind {
  switch (v?.k) {
    case "ProcLit": return v.comptime ? "macro" : "function";
    case "StructType": return "struct";
    case "InterfaceType": return "interface";
    case "EnumType": return "enum";
    case "UnionType": return "union";
    case "ProcType": case "ClosureType": case "TypeExpr": return "type";
  }
  return isConst ? "constant" : "variable";
}

export function documentSymbols(a: Analysis, file: string): DocSymbol[] {
  const f = fileOf(a, file)?.file;
  if (!f) return [];
  const conv = (s: Stmt): DocSymbol[] => {
    if (s.k === "ValueDecl") {
      return s.names.map((n, i) => {
        const v = s.values[i];
        const kids: DocSymbol[] = [];
        if (v?.k === "StructType") {
          for (const fld of v.fields) for (const fn of fld.names) {
            const r = tokRange(v.toks[fn.tok]);
            kids.push({ name: fn.name, kind: "field", range: r, selectionRange: r, children: [] });
          }
        }
        if (v?.k === "InterfaceType") {
          for (const m of v.methods) {
            const r = tokRange(v.toks[m.tok]);
            kids.push({ name: m.name, kind: "method", range: r, selectionRange: r, children: [] });
          }
        }
        return { name: n.name, kind: symbolKind(v, s.isConst), range: nodeRange(s), selectionRange: tokRange(s.toks[n.tok]), children: kids };
      });
    }
    if (s.k === "ImplBlock") {
      const name = `impl ${sliceText(s.iface.toks, s.iface.start, s.iface.end)} for ${sliceText(s.target.toks, s.target.start, s.target.end)}`;
      const kids = s.bindings.map((b): DocSymbol => {
        const r = tokRange(s.toks[b.tok]);
        return { name: `${b.name} = ${sliceText(b.value.toks, b.value.start, b.value.end)}`, kind: "method", range: r, selectionRange: r, children: [] };
      });
      return [{ name, kind: "impl", range: nodeRange(s), selectionRange: nodeRange(s.iface), children: kids }];
    }
    if (s.k === "When") return [...s.then.stmts.flatMap(conv), ...(s.else ? conv(s.else) : [])];
    if (s.k === "Block") return s.stmts.flatMap(conv);
    return [];
  };
  return f.stmts.flatMap(conv);
}

// ---- completion ----

function completionKind(sym: Sym): CompletionKind {
  switch (sym.kind) {
    case "pkg": return "namespace";
    case "capture": return "variable";
    case "local": return sym.isConst ? "constant" : "variable";
    case "global": {
      const k = symbolKind(sym.decl.values[sym.index], sym.isConst);
      return k === "enum" || k === "union" ? "type" : k === "impl" || k === "field" || k === "method" ? "variable" : k;
    }
  }
}

function item(a: Analysis, sym: Sym): Completion {
  const kind = completionKind(sym);
  const detail = sym.kind === "global" ? declKindLabel(sym) : sym.kind === "local" ? typeName(a, sym.ty) : sym.kind === "capture" ? `captured ${sym.byRef ? "by reference" : "by value"}` : `import "${sym.path}"`;
  if (kind === "macro") return { label: `${sym.name}!`, kind, detail, insertText: `${sym.name}!(` };
  return { label: sym.name, kind, detail };
}

function visibleFrom(sym: Sym, scope: Scope): boolean {
  return !(sym.kind === "global" && sym.isPrivate && scope.package !== sym.pkg);
}

/**
 * `lineText` is the current line up to the cursor. When the current analysis has no
 * scope for the cursor (e.g. the declaration being edited doesn't parse), `fallback`
 * (the last error-free analysis) is used.
 */
export function complete(cur: Analysis, fallback: Analysis | undefined, file: string, p: Position, lineText: string): Completion[] {
  let a = cur;
  let { scope, depth } = scopeAt(cur, file, p);
  if (fallback && fallback !== cur) {
    const fb = scopeAt(fallback, file, p);
    if (fb.depth > depth) {
      ({ scope, depth } = fb);
      a = fallback;
    }
  }

  const pkgRef = /\b([A-Za-z_]\w*)\.(\w*)$/.exec(lineText);
  const pkg = pkgRef ? a.analyzer.lookup(pkgRef[1], scope, null) : undefined;
  if (pkg?.kind === "pkg") {
    if (!pkg.target) return [];
    return [...pkg.target.scope.syms.values()].filter((m) => visibleFrom(m, scope)).map((m) => item(a, m));
  }

  const member = /([A-Za-z_][\w.]*)\s*(->|\.)(\w*)$/.exec(lineText);
  if (member) {
    const def = shape(a, chainType(a, member[1], scope));
    if (member[2] === "->") return [];
    const anon: AnonFieldType[] | undefined = def && A(def)._anonFields;
    if (anon) return anon.map((f) => ({ label: f.name, kind: "field" as const, detail: f.type ? typeText(f.type) : f.text }));
    if (def?.k === "StructType") {
      return def.fields.flatMap((f) => f.names.map((n) => ({ label: n.name, kind: "field" as const, detail: f.type ? sliceText(f.type.toks, f.type.start, f.type.end) : undefined })));
    }
    return [];
  }

  const out: Completion[] = [];
  const seen = new Set<string>();
  for (let s: Scope | null = scope; s; s = s.parent) {
    for (const sym of s.syms.values()) {
      if (seen.has(sym.name) || !visibleFrom(sym, scope)) continue;
      if (sym.kind === "local" && sym.declTok && (sym.declTok.pos.file !== file || !before({ line: sym.declTok.pos.line - 1, character: sym.declTok.pos.col - 1 }, p))) continue;
      seen.add(sym.name);
      out.push(item(a, sym));
    }
  }
  for (const k of KEYWORDS) if (!seen.has(k)) out.push({ label: k, kind: "keyword" });
  for (const t of BUILTIN_TYPES) if (!seen.has(t)) out.push({ label: t, kind: "type", detail: "builtin type" });
  if (/::\s*proc!\s*\([^)]*$/.test(lineText) || /->\s*\w*$/.test(lineText)) {
    for (const k of MACRO_KINDS) out.push({ label: k, kind: "type", detail: "macro parameter kind" });
  }
  return out;
}

export interface OptHint {
  position: Position;
  label: string;
  tooltip?: string;
}

/** The -opt decisions in `file` of an -opt analysis, each after its token; `all` adds the decisions against. */
export function optHints(a: Analysis, file: string, all: boolean): OptHint[] {
  const toks = a.packages.flatMap((p) => p.files).find((f) => f.path === file)?.toks;
  const out: OptHint[] = [];
  for (const h of a.analyzer.hints ?? []) {
    if (h.at.toks !== toks || (!all && /^not? /.test(h.label))) continue;
    const t = h.at.toks[h.tok];
    const lines = t.text.split("\n");
    const last = lines[lines.length - 1].length;
    out.push({ position: { line: t.pos.line - 2 + lines.length, character: lines.length > 1 ? last : t.pos.col - 1 + last }, label: h.label, tooltip: h.tooltip });
  }
  return out;
}
