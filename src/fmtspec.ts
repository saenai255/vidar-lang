import type { Expr } from "./ast";
import { A, Analyzer } from "./analyzer";
import type { Sym } from "./scope";

type Call = Extract<Expr, { k: "Call" }>;

/** A format string split the way fmt.wprintf reads it: literal text, and verbs that each take an argument. */
export type FmtPiece = { k: "text"; text: string } | { k: "arg"; verb: string; spec: string };

/** The value of an Odin string literal, or undefined when it holds bytes that aren't text. */
export function decodeString(lit: string): string | undefined {
  if (lit.startsWith("`")) return lit.slice(1, -1);
  if (!lit.startsWith('"')) return undefined;
  const body = lit.slice(1, -1);
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== "\\") {
      out += c;
      continue;
    }
    const e = body[++i];
    const simple: Record<string, string> = { a: "\x07", b: "\b", e: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\", "'": "'", '"': '"' };
    if (e in simple) {
      out += simple[e];
      continue;
    }
    const hex = (n: number) => {
      const h = body.slice(i + 1, i + 1 + n);
      if (!/^[0-9a-fA-F]+$/.test(h) || h.length !== n) return undefined;
      i += n;
      return parseInt(h, 16);
    };
    let code: number | undefined;
    if (e === "x") code = hex(2);
    else if (e === "u") code = hex(4);
    else if (e === "U") code = hex(8);
    else if (/[0-7]/.test(e)) {
      const o = body.slice(i, i + 3);
      if (!/^[0-7]{3}$/.test(o)) return undefined;
      code = parseInt(o, 8);
      i += 2;
    }
    // \x and octal escapes are bytes: above 0x7f they aren't a code point
    if (code === undefined || ((e === "x" || /[0-7]/.test(e)) && code > 0x7f)) return undefined;
    out += String.fromCodePoint(code);
  }
  return out;
}

export function encodeString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '"' || ch === "\\") out += "\\" + ch;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\r") out += "\\r";
    else if (c < 0x20 || c === 0x7f) out += "\\x" + c.toString(16).padStart(2, "0");
    else out += ch;
  }
  return out + '"';
}

/**
 * Splits a format into pieces, or undefined when fmt would do something this can't express:
 * `{...}` arguments, `*` widths, explicit argument indexes, a missing verb.
 */
export function parseFormat(f: string): FmtPiece[] | undefined {
  const out: FmtPiece[] = [];
  const text = (t: string) => {
    const last = out[out.length - 1];
    if (last?.k === "text") last.text += t;
    else if (t) out.push({ k: "text", text: t });
  };
  for (let i = 0; i < f.length; ) {
    const c = f[i];
    if (c === "}") {
      text("}");
      i += f[i + 1] === "}" ? 2 : 1;
      continue;
    }
    if (c === "{") {
      if (f[i + 1] !== "{") return undefined;
      text("{");
      i += 2;
      continue;
    }
    if (c !== "%") {
      text(c);
      i++;
      continue;
    }
    if (f[i + 1] === "%") {
      text("%");
      i += 2;
      continue;
    }
    const m = /^%([-+ #0]*)(\d*)(?:\.(\d*))?/.exec(f.slice(i))!;
    i += m[0].length;
    if (i >= f.length || "*[ ".includes(f[i])) return undefined;
    const verb = String.fromCodePoint(f.codePointAt(i)!);
    i += verb.length;
    out.push({ k: "arg", verb, spec: m[0] + verb });
  }
  return out;
}

/** fmt procs -opt specializes: where they write, and how many arguments come before the format */
const FMT_ENTRIES = new Map<string, { kind: "out" | "err" | "t" | "a" | "sb" | "w"; lead: number; format: boolean; newline: boolean }>(
  (
    [["", "out", 0], ["e", "err", 0], ["t", "t", 0], ["a", "a", 0], ["sb", "sb", 1], ["w", "w", 1]] as const
  ).flatMap(([prefix, kind, lead]) => [
    [`${prefix}printf`, { kind, lead, format: true, newline: false }],
    [`${prefix}printfln`, { kind, lead, format: true, newline: true }],
    [`${prefix}print`, { kind, lead, format: false, newline: false }],
    [`${prefix}println`, { kind, lead, format: false, newline: true }],
  ]),
);

/** `fmt.<name>(...)` for one of the procs -opt specializes */
export function fmtEntry(c: Call) {
  const fn = c.fn;
  if (fn.k !== "Selector" || fn.x.k !== "Ident") return undefined;
  const pkg: Sym | undefined = A(fn.x)._sym;
  return pkg?.kind === "pkg" && pkg.path === "core:fmt" ? FMT_ENTRIES.get(fn.name) : undefined;
}

/** The pieces -opt writes a fmt call as, or undefined when the call is left alone. */
export function fmtPlan(an: Analyzer, c: Call) {
  const entry = fmtEntry(c);
  if (!entry || c.args.some((a) => a.k === "FieldValue" || a.k === "Spread")) return undefined;
  const lead = c.args.slice(0, entry.lead);
  const values = c.args.slice(entry.lead + (entry.format ? 1 : 0));
  const scope = A(c)._scope ?? an.global;
  const single = (v: Expr) => an.isSingleValue(v, scope) || (v.k === "Call" && !!fmtEntry(v));
  if (lead.length < entry.lead || values.some((v) => (v.k === "Ident" && v.name === "nil") || !single(v))) return undefined;
  let pieces: FmtPiece[] | undefined;
  if (entry.format) {
    const f = c.args[entry.lead];
    const text = f?.k === "Lit" && f.kind === "string" ? decodeString(an.tokText.get(f.toks[f.start]) ?? f.toks[f.start].text) : undefined;
    pieces = text === undefined ? undefined : parseFormat(text);
    if (!pieces || pieces.filter((p) => p.k === "arg").length !== values.length) return undefined;
  } else pieces = values.flatMap((_, i): FmtPiece[] => [...(i ? [{ k: "text" as const, text: " " }] : []), { k: "arg", verb: "v", spec: "%v" }]);
  if (entry.newline) pieces.push({ k: "text", text: "\n" });
  return { entry, lead, values, pieces };
}
