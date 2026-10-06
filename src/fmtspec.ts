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
