export interface Pos {
  file: string;
  line: number;
  col: number;
}

export type TokKind = "ident" | "int" | "float" | "imag" | "string" | "rune" | "op" | "kw" | "directive" | "semi" | "eof";

export interface Token {
  kind: TokKind;
  text: string;
  pre: string;
  pos: Pos;
  /** for tokens copied into generated code: the whitespace they had in the source */
  origPre?: string;
}

export class CompileError extends Error {
  constructor(message: string, public pos?: Pos) {
    super(message);
  }
}

export const KEYWORDS = new Set([
  "import", "foreign", "package", "typeid", "when", "where", "if", "else", "for", "switch", "in", "not_in",
  "do", "case", "break", "continue", "fallthrough", "defer", "return", "proc", "struct", "union", "enum",
  "bit_set", "bit_field", "map", "dynamic", "auto_cast", "cast", "transmute", "distinct", "using",
  "or_else", "or_return", "or_break", "or_continue", "asm", "matrix",
]);

const OPS = [
  "..=", "..<", "---", "<<=", ">>=", "&&=", "||=", "%%=", "&~=",
  "->", "::", ":=", "==", "!=", "<=", ">=", "&&", "||", "<<", ">>", "%%", "&~",
  "+=", "-=", "*=", "/=", "%=", "&=", "|=", "~=", "..",
  "+", "-", "*", "/", "%", "&", "|", "~", "^", "!", "=", "<", ">", "(", ")", "[", "]", "{", "}",
  ",", ";", ":", ".", "?", "$", "@",
];

const SEMI_AFTER_KW = new Set(["break", "continue", "fallthrough", "return", "typeid", "or_return", "or_break", "or_continue"]);
const SEMI_AFTER_OP = new Set([")", "]", "}", "^", "?", "---", "!"]);

export function lex(src: string, file: string): Token[] {
  const toks: Token[] = [];
  const brackets: string[] = [];
  let i = 0;
  let line = 1;
  let col = 1;
  let pre = "";

  const advance = (n: number): string => {
    const s = src.slice(i, i + n);
    for (const ch of s) {
      if (ch === "\n") {
        line++;
        col = 1;
      } else col++;
    }
    i += n;
    return s;
  };

  const wantsSemi = (): boolean => {
    const last = toks[toks.length - 1];
    if (!last || last.kind === "semi") return false;
    const top = brackets[brackets.length - 1];
    if (top === "(" || top === "[") return false;
    if (last.kind === "ident" || last.kind === "int" || last.kind === "float" || last.kind === "imag" || last.kind === "string" || last.kind === "rune") return true;
    if (last.kind === "kw") return SEMI_AFTER_KW.has(last.text);
    if (last.kind === "op") return SEMI_AFTER_OP.has(last.text);
    return false;
  };

  const pushSemi = () => toks.push({ kind: "semi", text: "", pre: "", pos: { file, line, col } });

  while (i < src.length) {
    const c = src[i];
    if (c === "\n") {
      if (wantsSemi()) pushSemi();
      pre += advance(1);
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      pre += advance(1);
      continue;
    }
    if (c === "\\" && /^\\[ \t]*\r?\n/.test(src.slice(i, i + 64))) {
      let j = i + 1;
      while (src[j] !== "\n") j++;
      pre += advance(j + 1 - i);
      continue;
    }
    if (src.startsWith("//", i) || src.startsWith("#+", i)) {
      let j = i;
      while (j < src.length && src[j] !== "\n") j++;
      pre += advance(j - i);
      continue;
    }
    if (src.startsWith("/*", i)) {
      const start = { file, line, col };
      let depth = 0;
      let j = i;
      do {
        if (src.startsWith("/*", j)) {
          depth++;
          j += 2;
        } else if (src.startsWith("*/", j)) {
          depth--;
          j += 2;
        } else j++;
      } while (depth > 0 && j < src.length);
      if (depth > 0) throw new CompileError("unterminated block comment", start);
      const comment = src.slice(i, j);
      if (comment.includes("\n") && wantsSemi()) pushSemi();
      pre += advance(j - i);
      continue;
    }
    const pos: Pos = { file, line, col };
    const push = (kind: TokKind, len: number) => {
      toks.push({ kind, text: advance(len), pre, pos });
      pre = "";
    };
    if (/[A-Za-z_]/.test(c) || c.charCodeAt(0) > 127) {
      let j = i;
      while (j < src.length && (/[A-Za-z0-9_]/.test(src[j]) || src.charCodeAt(j) > 127)) j++;
      push(KEYWORDS.has(src.slice(i, j)) ? "kw" : "ident", j - i);
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? "") && toks[toks.length - 1]?.text !== ".")) {
      let j = i;
      let kind: TokKind = "int";
      if (c === "0" && /[xXbBoOzZhH]/.test(src[i + 1] ?? "")) {
        j += 2;
        while (j < src.length && /[0-9A-Fa-f_]/.test(src[j])) j++;
      } else {
        while (j < src.length && /[0-9_]/.test(src[j])) j++;
        if (src[j] === "." && src[j + 1] !== "." && !/[A-Za-z_]/.test(src[j + 1] ?? "")) {
          kind = "float";
          j++;
          while (j < src.length && /[0-9_]/.test(src[j])) j++;
        }
        if (/[eE]/.test(src[j] ?? "") && /[0-9+-]/.test(src[j + 1] ?? "")) {
          kind = "float";
          j += 2;
          while (j < src.length && /[0-9_]/.test(src[j])) j++;
        }
      }
      if (/[ijk]/.test(src[j] ?? "") && !/[A-Za-z0-9_]/.test(src[j + 1] ?? "")) {
        kind = "imag";
        j++;
      }
      push(kind, j - i);
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\n") throw new CompileError("unterminated literal", pos);
        j += src[j] === "\\" ? 2 : 1;
      }
      if (j >= src.length) throw new CompileError("unterminated literal", pos);
      push(c === '"' ? "string" : "rune", j + 1 - i);
      continue;
    }
    if (c === "`") {
      const j = src.indexOf("`", i + 1);
      if (j < 0) throw new CompileError("unterminated raw string", pos);
      push("string", j + 1 - i);
      continue;
    }
    if (c === "#" && /[A-Za-z_]/.test(src[i + 1] ?? "")) {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      push("directive", j - i);
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new CompileError(`unexpected character '${c}'`, pos);
    if (op === "(" || op === "[" || op === "{") brackets.push(op);
    else if (op === ")" || op === "]" || op === "}") brackets.pop();
    if (op === ";") {
      toks.push({ kind: "semi", text: ";", pre, pos });
      pre = "";
      advance(1);
      continue;
    }
    push("op", op.length);
  }
  if (wantsSemi()) pushSemi();
  toks.push({ kind: "eof", text: "", pre, pos: { file, line, col } });
  return toks;
}

/** Tokens synthesized by the compiler (macro expansions, generated code). */
export function synth(text: string, pos: Pos, kind: TokKind = "ident", pre = " "): Token {
  return { kind, text, pre, pos };
}
