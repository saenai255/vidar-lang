import { Block, Expr, Node, Stmt } from "./ast";
import { A, Analyzer } from "./analyzer";
import { decodeString } from "./fmtspec";
import { kids } from "./optimize";

type Switch = Extract<Stmt, { k: "Switch" }>;
type Lit = Extract<Expr, { k: "Lit" }>;

/** fewer cases than this compare fast enough one after another */
export const MIN_CASES = 8;
/** seeds tried per table size */
const STEP_LIMIT = 20_000;

/**
 * How a perfect hash maps a string to a slot of a `1 << bits` table:
 * - `bytes`: the length and the first, middle and last bytes, mixed by `seed`
 * - `fnv`: FNV-1a over every byte, starting from `seed`
 */
export interface StrHash {
  kind: "bytes" | "fnv";
  seed: number;
  bits: number;
  /** the case strings, in order; a string's index is what its case matches */
  keys: string[];
  /** the slot each key lands in */
  slots: number[];
  /** each case literal, and the index of its string */
  lits: Map<Lit, number>;
}

function mix(x: number, seed: number, bits: number): number {
  return Math.imul(x, seed) >>> (32 - bits);
}

/** The hash, exactly as the generated Odin computes it (u32 arithmetic). */
function hashOf(kind: StrHash["kind"], b: Uint8Array, seed: number, bits: number): number {
  if (kind === "bytes") {
    let x = b.length >>> 0;
    if (b.length > 0) {
      x = (Math.imul(x, 31) + b[0]) >>> 0;
      x = (Math.imul(x, 31) + b[b.length >> 1]) >>> 0;
      x = (Math.imul(x, 31) + b[b.length - 1]) >>> 0;
    }
    return mix(x, seed, bits);
  }
  let h = seed >>> 0;
  for (const c of b) h = Math.imul(h ^ c, 16777619) >>> 0;
  return mix(h, 0x9e3779b1, bits);
}

/** A seed giving every key its own slot, trying the cheap hash first and then bigger tables. */
function search(keys: Uint8Array[]): Pick<StrHash, "kind" | "seed" | "bits" | "slots"> | undefined {
  const base = Math.max(3, Math.ceil(Math.log2(keys.length)));
  for (const kind of ["bytes", "fnv"] as const) {
    for (let bits = base; bits <= base + 2; bits++) {
      for (let i = 0; i < STEP_LIMIT; i++) {
        // odd multipliers for the cheap hash; any start value for FNV
        const seed = kind === "bytes" ? ((i * 2 + 1) * 0x2545f491) | 1 : (0x811c9dc5 + i * 0x01000193) >>> 0;
        const seen = new Set<number>();
        const slots: number[] = [];
        let ok = true;
        for (const k of keys) {
          const h = hashOf(kind, k, seed >>> 0, bits);
          if (seen.has(h)) {
            ok = false;
            break;
          }
          seen.add(h);
          slots.push(h);
        }
        if (ok) return { kind, seed: seed >>> 0, bits, slots };
      }
    }
  }
  return undefined;
}

function isStringType(an: Analyzer, e: Expr): boolean {
  const name = an.typeName(an.typeOf(e, A(e)._scope ?? an.global));
  return name === "string" || name === "untyped string";
}

/** -opt: string switches with MIN_CASES or more literal cases switch on a perfect hash of the string. */
export function stringSwitches(body: Block, an: Analyzer): void {
  if (A(body)._noPerfectHash) return;
  const visit = (n: Node): void => {
    if (n.k === "Switch") consider(n);
    for (const c of kids(n)) if (c.k !== "ProcLit") visit(c);
  };
  const consider = (s: Switch) => {
    if (!s.tag || s.typeSwitchVar) return;
    const lits = new Map<Lit, number>();
    const keys: string[] = [];
    for (const c of s.cases) for (const e of c.exprs) {
      if (e.k !== "Lit" || e.kind !== "string") return;
      const text = e.toks[e.start].text;
      // \x and octal escapes are bytes, which the decoded JavaScript string can't hold
      if (/\\[x0-7]/.test(text)) return;
      const v = decodeString(text);
      if (v === undefined || keys.includes(v)) return;
      lits.set(e, keys.length);
      keys.push(v);
    }
    if (keys.length < MIN_CASES) return;
    if (!isStringType(an, s.tag)) return;
    const found = search(keys.map((k) => new TextEncoder().encode(k)));
    if (!found) return void an.hint(s, "no perfect hash", `no perfect hash for these ${keys.length} strings within ${STEP_LIMIT} seeds per table size; the cases are compared one after another`);
    A(s)._strHash = { ...found, keys, lits } satisfies StrHash;
    an.hint(s, "perfect hash", `${keys.length} strings, a ${1 << found.bits}-slot table (${found.kind === "bytes" ? "length and 3 bytes" : "FNV-1a"}): one hash and one string compare instead of up to ${keys.length} compares`);
  };
  visit(body);
}

/** The Odin proc a switch's tag goes through: the index of the matching case string, or -1. */
export function strHashProc(name: string, h: StrHash, encode: (s: string) => string): string {
  const table = new Array<number>(1 << h.bits).fill(-1);
  h.slots.forEach((slot, i) => (table[slot] = i));
  const shift = 32 - h.bits;
  const hash =
    h.kind === "bytes"
      ? `\tx := u32(len(s))\n\tif len(s) > 0 {\n\t\tx = x * 31 + u32(s[0])\n\t\tx = x * 31 + u32(s[len(s) >> 1])\n\t\tx = x * 31 + u32(s[len(s) - 1])\n\t}\n\th := (x * ${h.seed}) >> ${shift}\n`
      : `\tx: u32 = ${h.seed}\n\tfor c in transmute([]u8)s do x = (x ~ u32(c)) * 16777619\n\th := (x * 0x9e3779b1) >> ${shift}\n`;
  const type = h.keys.length < 128 ? "i8" : "i16";
  return (
    `// switch on ${h.keys.length} strings: a perfect hash, then one compare\n` +
    `@(rodata) ${name}_slots := [${table.length}]${type}{${table.join(", ")}}\n` +
    `@(rodata) ${name}_keys := [${h.keys.length}]string{${h.keys.map(encode).join(", ")}}\n` +
    `${name} :: #force_inline proc "contextless" (s: string) -> int {\n` +
    hash +
    `\t#no_bounds_check i := int(${name}_slots[h])\n` +
    `\t#no_bounds_check if i >= 0 && ${name}_keys[i] == s do return i\n` +
    `\treturn -1\n}`
  );
}
