import { dirname } from "node:path";
import { Expr, Node, children } from "../ast";
import { A } from "../analyzer";
import { Token, lex } from "../lexer";
import { PRELUDE_PATH } from "../prelude";
import { type Program as Analysis, schedSourcePath } from "../project";
import { GlobalSym, LocalSym, PackageInfo, Sym, Ty } from "../scope";
import { type Index, type Range, canonical, tokRange } from "./features";

/**
 * Semantic tokens: what the analyzer knows about each name, for highlighting that a TextMate
 * grammar can't do (interfaces, closures, captures, macros). Built from the reference index,
 * so a name gets a token only where the analyzer (or the index's lexical pass) resolved it.
 */

export const TOKEN_TYPES = [
  "namespace", "type", "interface", "struct", "enum", "enumMember", "typeParameter",
  "function", "method", "parameter", "variable", "property", "macro",
] as const;

/** `captured`, `byRef` and `closure` are custom; the extension maps them to theme scopes. */
export const TOKEN_MODIFIERS = ["declaration", "readonly", "captured", "byRef", "closure", "async", "defaultLibrary"] as const;

export type TokenType = (typeof TOKEN_TYPES)[number];
export type TokenModifier = (typeof TOKEN_MODIFIERS)[number];

export const LEGEND = { tokenTypes: [...TOKEN_TYPES] as string[], tokenModifiers: [...TOKEN_MODIFIERS] as string[] };

export interface SemanticToken {
  line: number;
  character: number;
  length: number;
  type: TokenType;
  modifiers: TokenModifier[];
}

interface Kind {
  type: TokenType;
  modifiers: TokenModifier[];
}

const TYPE_NODES = new Set(["StructType", "UnionType", "EnumType", "InterfaceType", "ProcType", "ClosureType", "TypeExpr"]);

/** The symbol a type name or alias refers to, when it is a declared one. */
function symOf(e: Expr): Sym | undefined {
  const a = A(e);
  return a._sym ?? a._pkgMember;
}

/** Whether `ty` is a closure type, following named aliases (`Op :: closure(int) -> int`). */
function isClosureTy(ty: Ty | undefined, depth = 0): boolean | undefined {
  if (!ty || depth > 8) return undefined;
  if (ty.t === "sig") return ty.closure;
  if (ty.t !== "node") return undefined;
  return isClosureNode(ty.node, depth);
}

function isClosureNode(n: Expr, depth: number): boolean | undefined {
  if (n.k === "ClosureType") return true;
  if (n.k === "ProcType") return false;
  if (n.k === "ProcLit") return !!n.captures;
  if (n.k === "Paren") return isClosureNode(n.x, depth + 1);
  if (n.k === "Ident" || n.k === "Selector") {
    const s = symOf(n);
    if (s?.kind !== "global" || !s.isConst) return undefined;
    const v = s.decl.values[s.index];
    return v && (v.k === "ClosureType" || v.k === "ProcType") ? isClosureNode(v, depth + 1) : undefined;
  }
  return undefined;
}

/** A callable value's kind: `closure` true or false, or undefined when it isn't one (or isn't known). */
function callable(ty: Ty | undefined): Kind | undefined {
  const c = isClosureTy(ty);
  if (c === undefined) return undefined;
  return { type: "function", modifiers: c ? ["closure"] : [] };
}

export class SemanticTokens {
  private schedDir: string | undefined;
  private memo = new Map<Sym, Kind | undefined>();

  constructor() {
    try {
      this.schedDir = dirname(schedSourcePath());
    } catch {}
  }

  private library(pkg: PackageInfo): boolean {
    return pkg.dir === PRELUDE_PATH || pkg.dir === this.schedDir;
  }

  kindOf(sym: Sym, depth = 0): Kind | undefined {
    if (this.memo.has(sym)) return this.memo.get(sym);
    let k: Kind | undefined;
    try {
      k = this.compute(sym, depth);
    } catch {
      k = undefined;
    }
    this.memo.set(sym, k);
    return k;
  }

  private compute(sym: Sym, depth: number): Kind | undefined {
    switch (sym.kind) {
      case "pkg":
        return { type: "namespace", modifiers: sym.target && this.library(sym.target) ? ["defaultLibrary"] : [] };
      case "global":
        return this.global(sym, depth);
      case "local":
        return this.local(sym);
      case "capture": {
        const base = this.kindOf(canonical(sym), depth + 1) ?? { type: "variable", modifiers: [] };
        const mods: TokenModifier[] = base.modifiers.filter((m) => m !== "readonly" && m !== "declaration");
        mods.push("captured");
        // by-value captures are copies the closure can't write to
        mods.push(sym.byRef ? "byRef" : "readonly");
        return { type: base.type === "parameter" ? "variable" : base.type, modifiers: mods };
      }
    }
  }

  private global(sym: GlobalSym, depth: number): Kind | undefined {
    const lib: TokenModifier[] = this.library(sym.pkg) ? ["defaultLibrary"] : [];
    const v = sym.decl.values[sym.index];
    const withLib = (type: TokenType, ...mods: TokenModifier[]): Kind => ({ type, modifiers: [...mods, ...lib] });
    switch (v?.k) {
      case "ProcLit":
        if (v.comptime) return withLib("macro");
        if (A(v)._ifaceMethod) return withLib("method");
        if (v.captures) return withLib("function", "closure");
        // goroutines start through vidar:sched's `go`
        return sym.pkg.dir === this.schedDir && sym.name === "go" ? withLib("function", "async") : withLib("function");
      case "ProcGroup":
        return withLib("function");
      case "InterfaceType":
        return withLib("interface");
      case "StructType":
        return withLib("struct");
      case "EnumType":
        return withLib("enum");
      case "UnionType":
      case "ProcType":
      case "TypeExpr":
        return withLib("type");
      case "ClosureType":
        return withLib("type", "closure");
      case "Ident":
      case "Selector":
        if (sym.isConst && depth < 8) {
          // an alias: `Name :: other_name`
          const target = symOf(v);
          if (target && target !== sym) {
            const k = this.kindOf(target, depth + 1);
            if (k) return { type: k.type, modifiers: [...k.modifiers.filter((m) => m !== "declaration" && m !== "defaultLibrary"), ...lib] };
          }
        }
        break;
    }
    if (v && TYPE_NODES.has(v.k)) return withLib("type");
    const ty: Ty | undefined = sym.decl.type ? { t: "node", node: sym.decl.type, scope: sym.scope } : undefined;
    const fn = callable(ty);
    if (fn) return { type: "function", modifiers: [...fn.modifiers, ...(sym.isConst ? ["readonly" as const] : []), ...lib] };
    return withLib("variable", ...(sym.isConst ? ["readonly" as const] : []));
  }

  private local(sym: LocalSym): Kind {
    const ro: TokenModifier[] = sym.isConst ? ["readonly"] : [];
    if (sym.declKind === "param" && sym.isConst) {
      // `$T` and `$T: typeid` name types; `$N: int` is a compile-time value
      const ty = sym.ty;
      if (!ty || (ty.t === "node" && ty.node.k === "Ident" && ty.node.name === "typeid")) return { type: "typeParameter", modifiers: [] };
    }
    if (sym.isConst && sym.value) {
      const v = sym.value;
      if (v.k === "ProcLit") return { type: v.comptime ? "macro" : "function", modifiers: v.captures ? ["closure"] : [] };
      if (v.k === "StructType") return { type: "struct", modifiers: [] };
      if (v.k === "EnumType") return { type: "enum", modifiers: [] };
      if (v.k === "InterfaceType") return { type: "interface", modifiers: [] };
      if (TYPE_NODES.has(v.k)) return { type: "type", modifiers: v.k === "ClosureType" ? ["closure"] : [] };
    }
    const fn = callable(sym.ty);
    if (fn) return { type: "function", modifiers: [...fn.modifiers, ...ro] };
    return { type: sym.declKind === "param" ? "parameter" : "variable", modifiers: ro };
  }
}

const isGenerated = (text: string) => text.startsWith("__") || text === "_" || !/^[\p{L}_]/u.test(text);

function fileTokens(a: Analysis, file: string): { toks: Token[]; stmts: Node[] } | undefined {
  for (const p of a.packages) {
    const f = p.files.find((x) => x.path === file);
    if (f) return { toks: f.toks, stmts: f.stmts };
  }
  // the file didn't parse: lex it, to still find macro calls
  const src = a.sources.find((s) => s.path === file);
  if (!src) return undefined;
  try {
    return { toks: lex(src.text, file), stmts: [] };
  } catch {
    return undefined;
  }
}

/** Field and enum member declarations, which the reference index doesn't record. */
function memberDecls(stmts: Node[], out: (t: Token, type: TokenType) => void): void {
  const visit = (n: Node) => {
    if (n.k === "StructType") for (const f of n.fields) for (const nm of f.names) out(n.toks[nm.tok], "property");
    if (n.k === "EnumType") for (const m of n.members) out(n.toks[m.tok], "enumMember");
    for (const c of children(n)) visit(c);
  };
  for (const s of stmts) {
    try {
      visit(s);
    } catch {}
  }
}

/** Every token in `file`, sorted by position. Never throws: a file the analyzer couldn't finish gets what is known. */
export function semanticTokens(a: Analysis, index: Index | undefined, file: string): SemanticToken[] {
  const byPos = new Map<string, SemanticToken>();
  const lines = a.sources.find((s) => s.path === file)?.text.split("\n");
  const put = (r: Range, text: string, k: Kind, decl = false) => {
    if (isGenerated(text) || r.start.line !== r.end.line) return;
    // only names that really appear in the source at that position (expansions copy positions)
    if (lines && lines[r.start.line]?.substr(r.start.character, text.length) !== text) return;
    const modifiers = [...new Set<TokenModifier>([...(decl ? ["declaration" as const] : []), ...k.modifiers])];
    byPos.set(`${r.start.line}:${r.start.character}`, { line: r.start.line, character: r.start.character, length: text.length, type: k.type, modifiers });
  };
  const sem = new SemanticTokens();
  if (index) {
    for (const ref of index.refs) {
      if (ref.file !== file) continue;
      const text = lines?.[ref.range.start.line]?.slice(ref.range.start.character, ref.range.end.character) ?? "";
      const k = sem.kindOf(ref.sym);
      if (k) put(ref.range, text, k, ref.decl);
    }
    // fields and enum members, at their declarations and every use the analyzer resolved
    for (const m of index.members) {
      if (m.file !== file) continue;
      put(m.range, m.member.name, { type: m.member.kind === "field" ? "property" : "enumMember", modifiers: [] }, m.decl);
    }
  }
  const f = fileTokens(a, file);
  if (f) {
    memberDecls(f.stmts, (t, type) => {
      if (t?.pos.file !== file) return;
      const r = tokRange(t);
      if (!byPos.has(`${r.start.line}:${r.start.character}`)) put(r, t.text, { type, modifiers: [] }, true);
    });
    // `name!` and `pkg.name!`: macro calls, and procs run at compile time
    for (let i = 0; i + 1 < f.toks.length; i++) {
      const t = f.toks[i];
      const bang = f.toks[i + 1];
      if (t.pos.file !== file || (t.kind !== "ident" && !(t.kind === "kw" && t.text !== "proc"))) continue;
      if (bang.kind !== "op" || bang.text !== "!" || bang.pre !== "" || f.toks[i - 1]?.text === "proc") continue;
      const r = tokRange(t);
      const prev = byPos.get(`${r.start.line}:${r.start.character}`);
      const lib = prev?.modifiers.includes("defaultLibrary") || (!prev && a.analyzer.global.syms.has(t.text)) ? (["defaultLibrary"] as TokenModifier[]) : [];
      put(r, t.text, { type: "macro", modifiers: lib });
    }
  }
  return [...byPos.values()].sort((x, y) => x.line - y.line || x.character - y.character);
}

/** LSP's relative encoding: five integers per token. */
export function encode(tokens: SemanticToken[]): number[] {
  const data: number[] = [];
  let line = 0;
  let char = 0;
  for (const t of tokens) {
    const dl = t.line - line;
    data.push(dl, dl ? t.character : t.character - char, t.length, TOKEN_TYPES.indexOf(t.type), t.modifiers.reduce((m, x) => m | (1 << TOKEN_MODIFIERS.indexOf(x)), 0));
    line = t.line;
    char = t.character;
  }
  return data;
}

export function inRange(t: SemanticToken, r: Range): boolean {
  const afterStart = t.line > r.start.line || (t.line === r.start.line && t.character + t.length > r.start.character);
  const beforeEnd = t.line < r.end.line || (t.line === r.end.line && t.character < r.end.character);
  return afterStart && beforeEnd;
}

/** The encoded tokens of `file` (in `range` when given); empty rather than an error when anything goes wrong. */
export function semanticTokensData(a: Analysis | undefined, index: Index | undefined, file: string, range?: Range): number[] {
  if (!a) return [];
  try {
    const all = semanticTokens(a, index, file);
    return encode(range ? all.filter((t) => inRange(t, range)) : all);
  } catch {
    return [];
  }
}
