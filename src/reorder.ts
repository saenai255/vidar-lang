import { dirname } from "node:path";
import { Expr, Node, Param } from "./ast";
import { A, Analyzer, nodeText, posOf, unwrapProc } from "./analyzer";
import { kids } from "./optimize";
import { schedSourcePath } from "./project";
import type { GlobalSym, Sym, Ty } from "./scope";

type StructType = Extract<Expr, { k: "StructType" }>;
type CompoundLit = Extract<Expr, { k: "CompoundLit" }>;

/** -opt: a struct whose fields are written in a new order; `order[i]` is the field group in slot i. */
export interface Reorder {
  order: number[];
  saved: number;
}

const SIZES: Record<string, [number, number]> = {
  bool: [1, 1], b8: [1, 1], i8: [1, 1], u8: [1, 1], byte: [1, 1],
  i16: [2, 2], u16: [2, 2], f16: [2, 2], b16: [2, 2],
  i32: [4, 4], u32: [4, 4], f32: [4, 4], rune: [4, 4], b32: [4, 4],
  int: [8, 8], uint: [8, 8], i64: [8, 8], u64: [8, 8], f64: [8, 8], uintptr: [8, 8], rawptr: [8, 8], b64: [8, 8], typeid: [8, 8], cstring: [8, 8],
  i128: [16, 16], u128: [16, 16], string: [16, 8], any: [16, 8],
};
/** builtins that move values around without looking at their bytes */
const PLAIN_BUILTINS = new Set(["len", "cap", "append", "delete", "make", "new", "new_clone", "free", "clear", "copy", "min", "max", "pop", "pop_safe",
  "unordered_remove", "ordered_remove", "inject_at", "resize", "reserve", "raw_data", "swap", "assert", "panic", "abs", "clamp"]);
/** builtins that show a type's layout */
const LAYOUT_BUILTINS = new Set(["size_of", "align_of", "offset_of", "offset_of_by_string", "type_info_of", "typeid_of", "type_of", "transmute"]);

interface Field { group: Param; size: number; align: number }

/**
 * -opt: a struct's fields sorted by alignment, largest first, when that saves bytes and nobody can
 * see the layout: the struct is plain (no directives, `using`, tags or blank fields), it is never
 * measured, converted, transmuted, used as a map key, or converted to `any`, and no value of a type
 * holding it reaches code vidar can't see (core and foreign procs, proc values), which also keeps
 * fmt and encoding/json, whose output follows the field order, away from it. Positional literals of
 * it are rewritten to name their fields.
 */
export function reorderStructs(an: Analyzer): void {
  const schedDir = dirname(schedSourcePath());
  const files = an.packages.filter((p) => p.dir !== schedDir).flatMap((p) => p.files);
  const cands = new Map<GlobalSym, { st: StructType; fields: Field[] }>();
  for (const pkg of an.packages) {
    if (pkg.dir === schedDir) continue;
    for (const sym of pkg.scope.syms.values()) {
      if (sym.kind !== "global" || !sym.isConst || sym.decl.type) continue;
      const v = sym.decl.values[sym.index];
      if (v?.k !== "StructType") continue;
      const fields = plainFields(an, v, sym);
      if (fields) cands.set(sym, { st: v, fields });
    }
  }
  if (!cands.size) return;

  const rejected = new Map<GlobalSym, string>();
  const reject = (sym: GlobalSym, why: string, at: Node) => {
    if (cands.has(sym) && !rejected.has(sym)) rejected.set(sym, `${why} (${posOf(at).file === posOf(sym.decl).file ? "" : posOf(at).file.split("/").pop() + ":"}line ${posOf(at).line})`);
  };
  /** the candidate structs a type holds, through fields, arrays, pointers, maps and unions */
  const held = new Map<GlobalSym, Set<GlobalSym>>();
  const holds = (ty: Ty | undefined, depth = 0): Set<GlobalSym> => {
    const out = new Set<GlobalSym>();
    if (!ty || depth > 12) return out;
    if (ty.t === "ptr") return holds(ty.elem, depth + 1);
    if (ty.t !== "node") return out;
    const walk = (n: Node, scope = ty.scope) => {
      if (n.k === "Ident" || n.k === "Selector") {
        const s = an.resolveName(n as Expr, scope, null);
        if (s?.kind === "global") {
          if (cands.has(s)) out.add(s);
          if (!held.has(s)) {
            held.set(s, new Set());
            const v = s.isConst && !s.decl.type ? s.decl.values[s.index] : undefined;
            if (v) held.set(s, holds({ t: "node", node: v, scope: s.scope }, depth + 1));
          }
          for (const x of held.get(s)!) out.add(x);
        }
        if (n.k === "Selector") return;
      }
      for (const c of kids(n)) walk(c, scope);
    };
    walk(ty.node);
    return out;
  };
  /** the candidates an expression's value may hold: from its type, or else from the variables in it */
  const valueHolds = (e: Expr): Set<GlobalSym> => {
    const ty = an.typeOf(e, A(e)._scope ?? an.global);
    if (ty) return holds(ty);
    const out = new Set<GlobalSym>();
    const visit = (n: Node) => {
      if (n.k === "Ident") {
        const s: Sym | undefined = A(n)._sym;
        const t = s?.kind === "local" ? s.ty : s?.kind === "global" && s.decl.type ? { t: "node" as const, node: s.decl.type, scope: s.scope } : undefined;
        for (const x of holds(t)) out.add(x);
        if (s?.kind === "global" && cands.has(s)) out.add(s);
      }
      for (const c of kids(n)) visit(c);
    };
    visit(e);
    return out;
  };
  const isAny = (t: Expr | null | undefined) => !!t && /^(\.\.)?any$/.test(nodeText(t).replace(/\s+/g, ""));

  const literals: CompoundLit[] = [];
  const visit = (n: Node): void => {
    switch (n.k) {
      case "Cast":
        for (const s of [...valueHolds(n.x), ...holds(n.type ? { t: "node", node: n.type, scope: A(n)._scope ?? an.global } : undefined)]) reject(s, "it is cast or transmuted", n);
        break;
      case "CompoundLit":
        if (n.elems.length && !n.elems.some((e) => e.k === "FieldValue")) literals.push(n);
        // `[N]T{{...}, ...}`: the untyped literals inside are T's
        if (n.type?.k === "TypeExpr" && ["array", "slice", "dynamic"].includes(n.type.what) && n.type.parts[1])
          for (const e of n.elems) if (e.k === "CompoundLit" && !e.type) A(e)._elemOf = n.type.parts[1];
        break;
      case "ValueDecl":
        if (isAny(n.type)) for (const v of n.values) for (const s of valueHolds(v)) reject(s, "a value is converted to any", n);
        if (n.type) for (const v of n.values) if (v.k === "CompoundLit" && !v.type) A(v)._elemOf = n.type;
        break;
      case "TypeExpr":
        if (n.what === "map" && n.parts[0]) for (const s of holds({ t: "node", node: n.parts[0], scope: A(n)._scope ?? an.global })) reject(s, "it is a map key, whose hash follows its bytes", n);
        break;
      case "Call": {
        const fn = n.fn;
        const name = fn.k === "Ident" && !A(fn)._sym ? fn.name : undefined;
        if (name && LAYOUT_BUILTINS.has(name)) {
          for (const a of n.args) {
            for (const s of valueHolds(a)) reject(s, `it is passed to ${name}`, n);
            for (const s of holds({ t: "node", node: a, scope: A(a)._scope ?? an.global })) reject(s, `it is passed to ${name}`, n);
          }
          break;
        }
        if (name && PLAIN_BUILTINS.has(name)) break;
        const sym: Sym | undefined = fn.k === "Ident" ? A(fn)._sym : fn.k === "Selector" ? A(fn)._pkgMember : undefined;
        // a conversion: T(x)
        const typeDecl = sym?.kind === "global" && sym.isConst && !sym.decl.type ? sym.decl.values[sym.index] : undefined;
        if (typeDecl && typeDecl.k !== "ProcLit" && typeDecl.k !== "ProcGroup" && !unwrapProc(typeDecl)) {
          for (const s of [...holds({ t: "node", node: fn, scope: A(fn)._scope ?? an.global }), ...n.args.flatMap((a) => [...valueHolds(a)])]) reject(s, "it is converted", n);
          break;
        }
        const lit = sym?.kind === "global" && typeDecl ? unwrapProc(typeDecl) : undefined;
        const vidarCode = (lit?.body && !lit.comptime) || an.ifaceMethods.has(sym as GlobalSym) || A(n)._closure || A(n)._closureSpec || A(n)._spec;
        if (vidarCode) {
          // into a parameter of type any, and on to who knows where
          const params = lit ? lit.sig.params.flatMap((p) => p.names.map(() => p.type)) : [];
          n.args.forEach((a, i) => {
            if (isAny(params[Math.min(i, params.length - 1)])) for (const s of valueHolds(a)) reject(s, "a value is passed as any", n);
          });
          break;
        }
        for (const a of n.args) for (const s of valueHolds(a.k === "FieldValue" ? a.value : a)) reject(s, `a value reaches '${nodeText(fn)}', which vidar can't see into`, n);
        break;
      }
      case "RawStmt":
        for (const s of cands.keys()) if (n.toks.slice(n.start, n.end).some((t) => t.text === s.name)) reject(s, "it appears in a foreign block", n);
        break;
    }
    for (const c of kids(n)) visit(c);
  };
  for (const f of files) f.stmts.forEach(visit);
  // exported and foreign procs show their parameter types to other code
  for (const f of files) for (const s of f.stmts) {
    if (s.k !== "ValueDecl" || !s.attrs.some((a) => /export|foreign|link_name/.test(a))) continue;
    for (const v of s.values) {
      const lit = unwrapProc(v);
      if (lit) for (const p of [...lit.sig.params, ...lit.sig.results]) if (p.type) for (const c of holds({ t: "node", node: p.type, scope: A(p.type)._scope ?? an.global })) reject(c, "an exported proc takes it", s);
    }
  }

  // positional literals: the struct they make must be known, or every candidate they could be is off
  for (const lit of literals) {
    const target = literalType(an, lit);
    if (target) {
      if (cands.has(target)) A(lit)._reorderLit = target;
      continue;
    }
    for (const [sym, c] of cands) if (c.fields.reduce((n, f) => n + f.group.names.length, 0) === lit.elems.length) reject(sym, "a positional literal vidar can't place could be one", lit);
  }

  for (const [sym, c] of cands) {
    const why = rejected.get(sym);
    const before = layout(c.fields.map((f) => f));
    const order = c.fields.map((_, i) => i).sort((a, b) => c.fields[b].align - c.fields[a].align || a - b);
    const after = layout(order.map((i) => c.fields[i]));
    if (after >= before) continue;
    if (why) {
      an.hint(sym, "not reordered", `${before - after} bytes of padding left: ${why}`);
      continue;
    }
    A(c.st)._reorder = { order, saved: before - after } satisfies Reorder;
    an.hint(sym, "reordered", `${before - after} bytes saved (${before} → ${after}): fields by alignment, largest first`);
  }
  // positional literals of reordered structs name their fields
  for (const lit of literals) {
    const sym: GlobalSym | undefined = A(lit)._reorderLit;
    const c = sym && cands.get(sym);
    if (!c || !A(c.st)._reorder) continue;
    const names = c.fields.flatMap((f) => f.group.names.map((x) => x.name));
    lit.elems.forEach((e, i) => (A(e)._fix = { prefix: `${names[i]} = `, suffix: "" }));
  }
}

/** Sizes and alignments of a plain struct's field groups, or undefined when it isn't one. */
function plainFields(an: Analyzer, st: StructType, sym: GlobalSym): Field[] | undefined {
  if (st.polyParams || st.extra.length || st.fields.length < 2) return undefined;
  for (let i = st.start; i < st.end && st.toks[i].text !== "{"; i++) if (st.toks[i].kind === "directive") return undefined;
  const out: Field[] = [];
  for (const f of st.fields) {
    if (!f.type || f.value || f.names.some((x) => x.prefix || x.name === "_")) return undefined;
    if (st.toks[f.type.end]?.kind === "string") return undefined;
    const sa = sizeAlign(an, { t: "node", node: f.type, scope: sym.scope }, 0);
    if (!sa) return undefined;
    out.push({ group: f, size: sa[0] * f.names.length, align: sa[1] });
  }
  return out;
}

function layout(fields: Field[]): number {
  let off = 0;
  let max = 1;
  for (const f of fields) {
    off = Math.ceil(off / f.align) * f.align + f.size;
    max = Math.max(max, f.align);
  }
  return Math.ceil(off / max) * max;
}

/** Odin's size and alignment of a type, or undefined when vidar doesn't know them exactly. */
export function sizeAlign(an: Analyzer, ty: Ty, depth: number): [number, number] | undefined {
  if (depth > 12) return undefined;
  if (ty.t === "ptr") return [8, 8];
  if (ty.t !== "node") return undefined;
  const n = ty.node;
  switch (n.k) {
    case "Paren": return sizeAlign(an, { ...ty, node: n.x }, depth + 1);
    case "Unary": return n.op === "^" ? [8, 8] : undefined;
    case "ProcType": return [8, 8];
    case "Ident":
    case "Selector": {
      if (n.k === "Ident" && SIZES[n.name]) return SIZES[n.name];
      const s = an.resolveName(n, ty.scope, null);
      if (s?.kind !== "global" || !s.isConst || s.decl.type) return undefined;
      const v = s.decl.values[s.index];
      if (!v) return undefined;
      if (v.k === "EnumType") return v.base ? sizeAlign(an, { t: "node", node: v.base, scope: s.scope }, depth + 1) : [8, 8];
      if (v.k === "StructType") {
        if (v.polyParams || v.extra.length) return undefined;
        for (let i = v.start; i < v.end && v.toks[i].text !== "{"; i++) if (v.toks[i].kind === "directive") return undefined;
        const fields: Field[] = [];
        for (const f of v.fields) {
          if (!f.type) return undefined;
          const sa = sizeAlign(an, { t: "node", node: f.type, scope: s.scope }, depth + 1);
          if (!sa) return undefined;
          fields.push({ group: f, size: sa[0] * f.names.length, align: sa[1] });
        }
        return [layout(fields), Math.max(1, ...fields.map((f) => f.align))];
      }
      return undefined;
    }
    case "TypeExpr": {
      if (n.what === "slice" && !n.parts[0]) return [16, 8];
      if (n.what === "dynamic" && !n.parts[0]) return [40, 8];
      if (n.what === "multipointer") return [8, 8];
      if (n.what === "map") return [32, 8];
      if (n.what === "array" && n.parts[0]?.k === "Lit" && n.parts[1]) {
        const len = Number(nodeText(n.parts[0]).replace(/_/g, ""));
        const e = sizeAlign(an, { t: "node", node: n.parts[1], scope: ty.scope }, depth + 1);
        return e && Number.isFinite(len) ? [len * e[0], e[1]] : undefined;
      }
      return undefined;
    }
  }
  return undefined;
}

/** The struct a positional literal makes: its own type, or the element type of a typed array literal around it. */
function literalType(an: Analyzer, lit: CompoundLit): GlobalSym | undefined {
  const t = lit.type ?? (A(lit)._elemOf as Expr | undefined);
  if (!t) return undefined;
  const s = an.resolveName(t, A(t)._scope ?? A(lit)._scope ?? an.global, null);
  return s?.kind === "global" ? s : undefined;
}

