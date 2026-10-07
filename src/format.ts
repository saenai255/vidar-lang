import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CompileError, Token, lex } from "./lexer";

/*
 * `vidar fmt`: a token-based formatter. It only ever changes whitespace between tokens, and it
 * keeps every token on the line it was on, so line numbers (error locations, `call_site()`,
 * `dbg!`, the LSP's mapping to ols) stay the same. What it does:
 * - indents each line with tabs by bracket depth (`case` at its `switch`'s level, a line that
 *   continues an expression one deeper);
 * - strips trailing whitespace, and trailing blank lines at the end of the file;
 * - one space around binary and assignment operators and after commas, none inside `(...)` and
 *   `[...]`, before a comma, around `.`, or between a name and its call or index.
 * Spacing it isn't sure about is left as written, as is spacing inside `@(...)` attributes and
 * runs of spaces that align things. Comments stay where they are, reindented with their line.
 */

const OPENERS = new Set(["(", "[", "{"]);
const CLOSERS = new Set([")", "]", "}"]);
/** contextual keywords: they lex as names but aren't operands or callees */
const CONTEXTUAL = new Set(["take", "catch", "errdefer", "impl", "interface", "unreachable"]);
const ALWAYS_BINARY = new Set([
  "==", "!=", "<=", ">=", "&&", "||", "<<", ">>", "%%", "&~", "<", ">", "*", "/", "%", "|",
  "::", ":=", "=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "~=", "<<=", ">>=", "&&=", "||=", "%%=", "&~=",
]);
const MAYBE_UNARY = new Set(["+", "-", "&", "~"]);

interface Open {
  tok: Token;
  /** structural level of the line it was opened on */
  base: number;
  /** level of the lines inside it */
  inner: number;
  /** logical line it was opened on */
  lineId: number;
  attr: boolean;
  cast: boolean;
}

const isOp = (t: Token | undefined, ...texts: string[]) => t?.kind === "op" && texts.includes(t.text);
const autoSemi = (t: Token) => t.kind === "semi" && t.text === "";

/** Formats one `.vidar` (or `.odin`) source. Throws CompileError when it doesn't lex. */
export function format(src: string, file = "<input>"): string {
  const bom = src.startsWith("﻿") ? "﻿" : "";
  if (bom) src = src.slice(1);
  const crlf = src.includes("\r\n") && !/(^|[^\r])\n/.test(src);
  if (crlf) src = src.replace(/\r\n/g, "\n");
  const toks = lex(src, file);
  const out = formatTokens(toks);
  verify(toks, out, file);
  return bom + (crlf ? out.replace(/\n/g, "\r\n") : out);
}

function formatTokens(toks: Token[]): string {
  const stack: Open[] = [];
  let out = "";
  let lineId = 0;
  let struct = 0;
  let prev: Token | undefined;
  let prevIndex = -1;
  const castClose = new Set<Token>();

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (autoSemi(t)) continue;
    const eof = t.kind === "eof";
    const first = !prev;
    if (first || t.pre.includes("\n") || eof) {
      // a new line (or the end): work out its level
      let k = 0;
      for (let j = i; j < toks.length && CLOSERS.has(toks[j].text) && toks[j].kind === "op" && (j === i || !toks[j].pre.includes("\n")); j++) k++;
      k = Math.min(k, stack.length);
      const top = stack[stack.length - 1];
      let level: number;
      let commentLevel: number;
      if (eof) {
        level = commentLevel = 0;
      } else if (k > 0) {
        level = struct = stack[stack.length - k].base;
        commentLevel = top.inner;
      } else {
        level = struct = top?.inner ?? 0;
        if (t.kind === "kw" && t.text === "case" && top?.tok.text === "{") level = struct = Math.max(0, level - 1);
        commentLevel = level;
        const p = toks[i - 1];
        const continues =
          !first && (!top || top.tok.text === "{") && p && p.kind !== "semi" && !isOp(p, "{", ",", ":") && !(t.kind === "kw" && t.text === "case");
        if (continues || (t.kind === "kw" && t.text === "where")) level = commentLevel = struct + 1;
      }
      lineId++;
      out += trivia(t.pre, commentLevel, level, first, eof);
    } else {
      out += spacing(toks, i, prevIndex, t.pre, stack, castClose);
    }
    out += t.text;
    if (t.kind === "op" && OPENERS.has(t.text)) {
      const top = stack[stack.length - 1];
      const shared = top && top.lineId === lineId;
      const before = prevIndex >= 0 ? toks[prevIndex] : undefined;
      stack.push({
        tok: t,
        base: shared ? top.base : struct,
        inner: shared ? top.inner : struct + 1,
        lineId,
        attr: (t.text === "(" && isOp(before, "@")) || !!top?.attr,
        cast: t.text === "(" && before?.kind === "kw" && (before.text === "cast" || before.text === "transmute"),
      });
    } else if (t.kind === "op" && CLOSERS.has(t.text)) {
      const o = stack.pop();
      if (o?.cast) castClose.add(t);
    }
    prev = t;
    prevIndex = i;
  }
  if (out.trim() === "") return "";
  return out.replace(/[ \t\r\n]*$/, "") + "\n";
}

/** Whether toks[i] is an operator taking an operand on each side, so it gets a space on each side. */
function isBinary(toks: Token[], i: number, castClose?: Set<Token>): boolean {
  const t = toks[i];
  if (t.kind !== "op") return false;
  const p = toks[i - 1];
  if (!p || autoSemi(p)) return false;
  if (t.text === "/") {
    // `typeid/[]$E`, `$T/[]$E`: a specialization, written tight
    if (p.kind === "kw" && p.text === "typeid") return false;
    if (p.kind === "ident" && isOp(toks[i - 2], "$")) return false;
  }
  if (ALWAYS_BINARY.has(t.text)) return true;
  if (t.text === "->") return isOp(p, ")") && (t.pre !== "" || (toks[i + 1]?.pre ?? "") !== "");
  if (MAYBE_UNARY.has(t.text)) return operandEnd(p, castClose);
  return false;
}

function operandEnd(p: Token, castClose?: Set<Token>): boolean {
  if (p.kind === "ident") return !CONTEXTUAL.has(p.text);
  if (p.kind === "int" || p.kind === "float" || p.kind === "imag" || p.kind === "string" || p.kind === "rune") return true;
  if (p.kind === "op" && (p.text === ")" || p.text === "]")) return !castClose?.has(p);
  return false;
}

/** The whitespace between two tokens on one line. */
function spacing(toks: Token[], i: number, pi: number, pre: string, stack: Open[], castClose: Set<Token>): string {
  if (/[^ \t]/.test(pre)) return pre; // an inline /* comment */
  const t = toks[i];
  const p = toks[pi];
  const top = stack[stack.length - 1];
  if (top?.attr) return pre;
  const none = "";
  const space = pre === "" ? " " : pre;
  const op = (x: Token, ...s: string[]) => isOp(x, ...s);
  if (op(t, ",")) return none;
  if (t.kind === "semi") return p.kind === "kw" || p.kind === "semi" ? pre : none;
  if (op(p, ",")) return CLOSERS.has(t.text) && t.kind === "op" ? pre : space;
  if (p.kind === "semi") return space;
  if (op(p, "(", "[")) return none;
  if (op(t, ")", "]")) return none;
  if (isBinary(toks, i, castClose) || isBinary(toks, pi, castClose)) return space;
  if (op(p, ":") && top?.tok.text !== "[") {
    const pp = toks[pi - 1];
    if (pp && (pp.kind === "ident" || op(pp, ")"))) return space;
  }
  if (op(t, ".") && operandEnd(p) && p.kind !== "string" && p.kind !== "int" && p.kind !== "float") return none;
  if (op(p, ".") && t.kind === "ident") return none;
  if (op(t, "(", "[")) {
    if (p.kind === "ident" && !CONTEXTUAL.has(p.text)) return none;
    if (t.text === "(" && p.kind === "kw" && (p.text === "proc" || p.text === "cast" || p.text === "transmute")) return none;
  }
  return pre;
}

interface TriviaLine {
  lead: string;
  body: string;
  tail: string;
}

/** Splits a token's leading trivia into lines; block comments stay whole, even across lines. */
function triviaLines(pre: string): TriviaLine[] {
  const lines: TriviaLine[] = [];
  let pieces: string[] = [];
  const flush = () => {
    let a = 0;
    let b = pieces.length;
    while (a < b && /^[ \t\r]*$/.test(pieces[a])) a++;
    while (b > a && /^[ \t\r]*$/.test(pieces[b - 1])) b--;
    lines.push({ lead: pieces.slice(0, a).join(""), body: pieces.slice(a, b).join(""), tail: pieces.slice(b).join("") });
    pieces = [];
  };
  let i = 0;
  while (i < pre.length) {
    const c = pre[i];
    if (c === "\n") {
      flush();
      i++;
    } else if (c === " " || c === "\t" || c === "\r") {
      let j = i;
      while (j < pre.length && (pre[j] === " " || pre[j] === "\t" || pre[j] === "\r")) j++;
      pieces.push(pre.slice(i, j));
      i = j;
    } else if (pre.startsWith("/*", i)) {
      let depth = 0;
      let j = i;
      do {
        if (pre.startsWith("/*", j)) {
          depth++;
          j += 2;
        } else if (pre.startsWith("*/", j)) {
          depth--;
          j += 2;
        } else j++;
      } while (depth > 0 && j < pre.length);
      pieces.push(pre.slice(i, j));
      i = j;
    } else if (pre.startsWith("//", i) || pre.startsWith("#+", i)) {
      let j = i;
      while (j < pre.length && pre[j] !== "\n") j++;
      pieces.push(pre.slice(i, j).replace(/[ \t\r]+$/, ""));
      i = j;
    } else {
      let j = i + 1;
      while (j < pre.length && !/[\s/#]/.test(pre[j])) j++;
      pieces.push(pre.slice(i, j));
      i = j;
    }
  }
  flush();
  return lines;
}

/** Rebuilds the trivia before a token that starts a line (or before the end of the file). */
function trivia(pre: string, commentLevel: number, level: number, first: boolean, eof: boolean): string {
  const lines = triviaLines(pre);
  const tabs = (n: number) => "\t".repeat(n);
  const parts: string[] = [];
  for (let n = 0; n < lines.length; n++) {
    const l = lines[n];
    const last = n === lines.length - 1;
    if (n === 0 && !first) {
      // the rest of the previous token's line: keep a trailing comment where it is
      parts.push(l.body ? l.lead + l.body : "");
    } else if (last && !eof) {
      parts.push(tabs(level) + (l.body ? l.body + l.tail : ""));
    } else {
      parts.push(l.body ? tabs(commentLevel) + l.body : "");
    }
  }
  return parts.join("\n");
}

/** The formatter's own guarantee: the same tokens, each on the line it was on. */
function verify(before: Token[], after: string, file: string): void {
  const a = before.filter((t) => t.kind !== "eof");
  const b = lex(after, file).filter((t) => t.kind !== "eof");
  const same = a.length === b.length && a.every((t, i) => t.kind === b[i].kind && t.text === b[i].text && t.pos.line === b[i].pos.line);
  if (!same) throw new Error(`vidar fmt: internal error: formatting ${file} would change its tokens; left unchanged`);
}

export interface LineEdit {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  newText: string;
}

/** The edits that turn `text` into its formatted version: one per changed line (lines don't move). */
export function formatEdits(text: string, file = "<input>"): LineEdit[] {
  const formatted = format(text, file);
  if (formatted === text) return [];
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const a = text.split(eol);
  const b = formatted.split(eol);
  if (a.length < b.length) return [whole(a, formatted)];
  const edits: LineEdit[] = [];
  for (let i = 0; i < b.length; i++) {
    if (a[i] !== b[i]) edits.push({ range: { start: { line: i, character: 0 }, end: { line: i, character: a[i].length } }, newText: b[i] });
  }
  // trailing blank lines (or a missing final newline) at the end of the file
  if (a.length > b.length) edits.push({ range: { start: { line: b.length - 1, character: b[b.length - 1].length }, end: { line: a.length - 1, character: a[a.length - 1].length } }, newText: "" });
  return edits;
}

function whole(a: string[], newText: string): LineEdit {
  return { range: { start: { line: 0, character: 0 }, end: { line: a.length - 1, character: a[a.length - 1].length } }, newText };
}

/** Every `.vidar` file under `dir`, skipping hidden directories and node_modules. */
function vidarFiles(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith(".") || name === "node_modules") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) found.push(...vidarFiles(p));
    else if (name.endsWith(".vidar")) found.push(p);
  }
  return found;
}

/** `vidar fmt <files|dirs> [--check|--write]` */
export function fmtMain(args: string[]): number {
  const check = args.includes("--check");
  const write = args.includes("--write");
  const paths = args.filter((a) => a !== "--check" && a !== "--write");
  if (!paths.length || (check && write) || paths.some((p) => p.startsWith("-"))) {
    console.error("usage: vidar fmt <files|dirs> [--check|--write]");
    return 2;
  }
  const files: string[] = [];
  for (const p of paths) {
    if (!existsSync(p)) {
      console.error(`error: ${p} does not exist`);
      return 1;
    }
    if (statSync(p).isDirectory()) files.push(...vidarFiles(p));
    else files.push(p);
  }
  let status = 0;
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    let formatted: string;
    try {
      formatted = format(text, f);
    } catch (err) {
      const pos = err instanceof CompileError && err.pos ? `${err.pos.file}:${err.pos.line}:${err.pos.col}: ` : `${f}: `;
      console.error(`${pos}error: ${err instanceof Error ? err.message : err}`);
      status = 1;
      continue;
    }
    if (check) {
      if (formatted !== text) {
        console.log(f);
        status = 1;
      }
    } else if (write) {
      if (formatted !== text) {
        writeFileSync(f, formatted);
        console.error(`formatted ${f}`);
      }
    } else {
      process.stdout.write(files.length > 1 ? `// ==== ${f} ====\n${formatted}` : formatted);
    }
  }
  return status;
}
