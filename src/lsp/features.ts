import type { Token } from "../lexer";
import { Block, Expr, Node, Param, Stmt, children } from "../ast";
import { A, AnonFieldType, IfaceMethod, nodeText } from "../analyzer";
import type { Program as Analysis } from "../project";
import type { CaptureSym, GlobalSym, LocalSym, Scope, Sym, Ty } from "../scope";

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
  "closure", "comptime", "quote", "interface", "impl", "catch", "errdefer", "unreachable",
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

export class Index {
  readonly refs: Ref[] = [];
  private seen = new Set<string>();
  private lines = new Map<string, string[]>();

  constructor(readonly a: Analysis) {
    for (const s of a.sources) this.lines.set(s.path, s.text.split("\n"));
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

  private visit(n: Node): void {
    const a = A(n);
    for (const p of (a._pre as Stmt[] | undefined) ?? []) this.visit(p);
    switch (n.k) {
      case "Ident":
        if (a._sym) this.add(n.toks[n.start], a._sym, false);
        break;
      case "Selector":
        if (a._pkgMember) this.add(n.toks[n.end - 1], a._pkgMember, false);
        break;
      case "Import":
        if (a._sym) {
          const t = declToken(a._sym);
          if (t) this.add(t, a._sym, true);
        }
        break;
      case "MacroCall": {
        const parts: Sym[] | undefined = a._partSyms;
        if (parts) parts.forEach((s, i) => this.add(n.toks[n.start + 2 * i], s, false));
        else if (a._macroSym) this.add(n.toks[n.start], a._macroSym, false);
        if (a._expansion) this.visit(a._expansion);
        return;
      }
      case "ExprStmt":
        if (a._expansion) {
          for (const s of (a._expansion as Block).stmts) this.visit(s);
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
        for (const p of (a._params as LocalSym[] | undefined) ?? []) if (p.declTok) this.add(p.declTok, p, true);
        for (const c of (a._captures as CaptureSym[] | undefined) ?? []) if (c.declTok) this.add(c.declTok, c, false);
        break;
      case "RangeFor":
        for (const s of (a._syms as LocalSym[] | undefined) ?? []) if (s.declTok) this.add(s.declTok, s, true);
        break;
    }
    for (const c of children(n)) this.visit(c);
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
  }
  return { scope, depth };
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

export function describe(a: Analysis, sym: Sym): string {
  const code = (s: string) => "```odin\n" + s + "\n```";
  switch (sym.kind) {
    case "global": {
      const notes = [`*${declKindLabel(sym)}* \`${qualified(sym)}\``];
      if (sym.odinName !== sym.name) notes.push(`Odin name: \`${sym.odinName}\` (package \`${sym.pkg.name}\` is merged into \`${sym.pkg.unit.name}\` because of an import cycle)`);
      if (sym.isPrivate) notes.push(`private to package \`${sym.pkg.name}\``);
      const v = sym.decl.values[sym.index];
      const impls = (iface: GlobalSym) => a.analyzer.impls.filter((i) => i.iface === iface);
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
      const what = sym.declKind === "param" ? "parameter" : sym.declKind === "range" ? "loop variable" : sym.isConst ? "constant" : "local variable";
      const notes = [`*${what}*`];
      if (sym.boxed) notes.push("captured by reference, so it lives on the heap");
      return code(`${sym.name}: ${typeName(a, sym.ty, true)}`) + "\n\n" + notes.join(" · ");
    }
    case "capture": {
      const root = canonical(sym) as LocalSym;
      return code(`${sym.name}: ${typeName(a, root.ty, true)}`) + `\n\n*captured ${sym.byRef ? "by reference" : "by value (a copy made when the closure was created)"}*`;
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
  /** vidar could not infer the symbol's type */
  untyped?: boolean;
}

export function hover(a: Analysis, index: Index, file: string, p: Position): HoverResult | undefined {
  const ref = index.refAt(file, p);
  if (ref) {
    const local = ref.sym.kind === "local" || ref.sym.kind === "capture";
    return { markdown: describe(a, ref.sym), range: ref.range, untyped: local && !symType(a, canonical(ref.sym)) };
  }
  const member = memberAt(a, file, p);
  if (member) return { markdown: member.markdown, range: member.range };
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

// ---- navigation ----

export function definition(a: Analysis, index: Index, file: string, p: Position): Location | undefined {
  const ref = index.refAt(file, p);
  if (ref) {
    const t = declToken(ref.sym);
    return t && { file: t.pos.file, range: tokRange(t) };
  }
  return memberAt(a, file, p)?.target;
}

export function references(index: Index, file: string, p: Position, includeDecl = true): Location[] {
  const ref = index.refAt(file, p);
  if (!ref) return [];
  return index.refsTo(ref.sym).filter((r) => includeDecl || !r.decl).map((r) => ({ file: r.file, range: r.range }));
}

export function rename(index: Index, file: string, p: Position, newName: string): { edits: Location[]; error?: string } {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(newName)) return { edits: [], error: `'${newName}' is not a valid identifier` };
  const ref = index.refAt(file, p);
  if (!ref) return { edits: [], error: "nothing to rename here" };
  if (!declToken(ref.sym)) return { edits: [], error: "this symbol is not declared in the workspace" };
  return { edits: index.refsTo(ref.sym).map((r) => ({ file: r.file, range: r.range })) };
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
  if (/comptime\s+proc\s*\([^)]*$/.test(lineText) || /->\s*\w*$/.test(lineText)) {
    for (const k of MACRO_KINDS) out.push({ label: k, kind: "type", detail: "macro parameter kind" });
  }
  return out;
}
