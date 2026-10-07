import type { Expr } from "./ast";
import { A, Analyzer, INT_TYPES, nodeText } from "./analyzer";
import { encodeString } from "./fmtspec";
import type { GlobalSym, Ty } from "./scope";

/**
 * -opt: `%v` / `%#v` of a struct, enum, array or slice whose type vidar can see all the way down is
 * written by generated procs instead of fmt's walk over type info. The output is fmt's, byte for
 * byte, including the count it returns (fmt doesn't count the ", " between struct fields).
 * Leaves (numbers, bools, runes, floats) still go through the runtime's `w_v`; strings and enum
 * names inside a composite are quoted, as fmt does.
 */
type Shape =
  | { k: "struct"; key: string; type: string; display: string; fields: { name: string; shape: Shape }[]; named: boolean }
  | { k: "enum"; key: string; type: string; members: string[] }
  | { k: "array" | "slice" | "dynamic"; key: string; type: string; elem: Shape }
  | { k: "string"; type: "string" }
  | { k: "leaf"; type: string };

const FLOATS = new Set(["f16", "f32", "f64"]);
const R = "__vidar";

export class Printers {
  /** generated procs by name */
  readonly procs = new Map<string, string>();
  private shapes = new Map<GlobalSym, Shape | null>();

  constructor(
    private an: Analyzer,
    /** how the current file names a global type, or undefined when it can't */
    private ref: (sym: GlobalSym) => string | undefined,
  ) {}

  /**
   * The call writing `x` with `%v` (or `%#v` when `hash`) to writer `w`, and the Odin type it is for,
   * or undefined when fmt has to do it. The caller checks the type with `when`, so a wrong guess about
   * the type only means fmt does it after all.
   */
  write(e: Expr, hash: boolean, w: string, x: string): { call: string; type: string } | undefined {
    const ty = this.an.typeOf(e, A(e)._scope ?? this.an.global);
    let shape: Shape | undefined;
    try {
      shape = ty && this.shape(ty, 0);
    } catch {
      return undefined;
    }
    if (!shape || shape.k === "string" || shape.k === "leaf") return undefined;
    if (shape.k === "struct" && !shape.named) return undefined;
    return { call: `${this.proc(shape, hash, false)}(${w}, ${x}${hash && shape.k !== "enum" ? ", 0" : ""})`, type: shape.type };
  }

  private shape(ty: Ty, depth: number): Shape | undefined {
    if (depth > 16 || ty.t !== "node") return undefined;
    const n = ty.node;
    switch (n.k) {
      case "Paren":
        return this.shape({ ...ty, node: n.x }, depth + 1);
      case "Ident":
      case "Selector": {
        const name = n.k === "Ident" ? n.name : "";
        if (name === "string") return { k: "string", type: "string" };
        if (name === "bool" || name === "rune" || FLOATS.has(name) || (INT_TYPES.has(name) && name !== "uintptr")) return { k: "leaf", type: name };
        const sym = this.an.resolveName(n, ty.scope, null);
        return sym?.kind === "global" ? this.named(sym, depth) : undefined;
      }
      case "TypeExpr": {
        const elem = n.parts[1] ? this.shape({ t: "node", node: n.parts[1], scope: ty.scope }, depth + 1) : undefined;
        if (!elem || (elem.k === "struct" && !elem.named)) return undefined;
        const et = this.typeText(elem);
        if (!et) return undefined;
        if (n.what === "array") {
          const count = n.parts[0];
          if (count?.k !== "Lit" || count.kind !== "int") return undefined;
          const len = nodeText(count).replace(/_/g, "");
          return { k: "array", key: `arr${len}_${keyOf(elem)}`, type: `[${len}]${et}`, elem };
        }
        if (n.what === "slice" && !n.parts[0]) return { k: "slice", key: `sl_${keyOf(elem)}`, type: `[]${et}`, elem };
        if (n.what === "dynamic" && !n.parts[0]) return { k: "dynamic", key: `dyn_${keyOf(elem)}`, type: `[dynamic]${et}`, elem };
        return undefined;
      }
      case "StructType":
        return this.struct(n, ty, depth, undefined);
    }
    return undefined;
  }

  private named(sym: GlobalSym, depth: number): Shape | undefined {
    if (this.shapes.has(sym)) return this.shapes.get(sym) ?? undefined;
    const value = sym.isConst && !sym.decl.type ? sym.decl.values[sym.index] : undefined;
    const type = this.ref(sym);
    if (!value || !type || (value.k !== "StructType" && value.k !== "EnumType")) return void this.shapes.set(sym, null);
    if (value.k === "EnumType") {
      if (value.members.some((m) => m.value)) return void this.shapes.set(sym, null);
      const s: Shape = { k: "enum", key: `${sym.pkg.name}_${sym.odinName}`, type, members: value.members.map((m) => m.name) };
      this.shapes.set(sym, s);
      return s;
    }
    // a placeholder first, so a struct that holds a slice of itself resolves
    const s = { k: "struct", key: `${sym.pkg.name}_${sym.odinName}`, type, display: sym.odinName, fields: [], named: true } as Extract<Shape, { k: "struct" }>;
    this.shapes.set(sym, s);
    const full = this.struct(value, { t: "node", node: value, scope: sym.scope }, depth, s);
    if (!full) this.shapes.set(sym, null);
    return full;
  }

  /** A plain struct: no parameters, directives, `using`, tags or `any` fields. */
  private struct(n: Extract<Expr, { k: "StructType" }>, ty: Extract<Ty, { t: "node" }>, depth: number, into: Extract<Shape, { k: "struct" }> | undefined): Shape | undefined {
    if (n.polyParams || n.extra.length) return undefined;
    for (let i = n.start; i < n.end && n.toks[i].text !== "{"; i++) if (n.toks[i].kind === "directive") return undefined;
    const fields: { name: string; shape: Shape }[] = [];
    for (const f of n.fields) {
      if (!f.type || f.value || f.names.some((x) => x.prefix)) return undefined;
      // a field tag: a string right after the type
      if (n.toks[f.type.end]?.kind === "string") return undefined;
      if (f.type.k === "Ident" && f.type.name === "any") return undefined;
      const shape = this.shape({ t: "node", node: f.type, scope: ty.scope }, depth + 1);
      if (!shape) return undefined;
      for (const x of f.names) fields.push({ name: x.name, shape });
    }
    if (into) {
      into.fields = fields;
      return into;
    }
    return { k: "struct", key: "", type: "", display: "", fields, named: false };
  }

  private typeText(s: Shape): string | undefined {
    return "type" in s ? s.type : undefined;
  }

  /** The proc for a named struct, enum or array shape, generated the first time it's needed. */
  private proc(s: Shape, hash: boolean, quoted: boolean): string {
    if (s.k === "enum") {
      const name = `__print_${s.key}${quoted ? "_q" : ""}`;
      if (!this.procs.has(name)) {
        const q = (m: string) => encodeString(quoted ? `"${m}"` : m);
        this.procs.set(name,
          `${name} :: proc(w: ${R}.Writer, x: ${s.type}) -> (n: int) {\n\tswitch x {\n` +
            s.members.map((m) => `\tcase .${m}: n += ${R}.w_str(w, ${q(m)})\n`).join("") +
            `\tcase: n += ${R}.w_spec(w, x, "%v")\n\t}\n\treturn\n}`);
      }
      return name;
    }
    if (s.k !== "struct" && s.k !== "array" && s.k !== "slice" && s.k !== "dynamic") throw new Error("no proc for a leaf");
    const name = `__print${hash ? "h" : ""}_${s.key}`;
    if (this.procs.has(name)) return name;
    this.procs.set(name, "");
    const head = `${name} :: proc(w: ${R}.Writer, x: ${s.type}${hash ? ", indent: int" : ""}) -> (n: int) {\n`;
    const body = s.k === "struct" ? this.structBody(s, hash, "x", "indent") : this.arrayBody(s, hash);
    this.procs.set(name, `${head}${body}\treturn\n}`);
    return name;
  }

  /** Writes a value nested in a composite: strings and enum names quoted. */
  private nested(s: Shape, hash: boolean, x: string, indent: string): string {
    switch (s.k) {
      case "string": return `\tn += ${R}.w_quoted(w, ${x})\n`;
      case "leaf": return FLOATS.has(s.type) ? `\tn += ${R}.w_float(w, ${x})\n` : `\tn += ${R}.w_v(w, ${x})\n`;
      case "enum": return `\tn += ${this.proc(s, false, true)}(w, ${x})\n`;
      case "struct": return s.named ? `\tn += ${this.proc(s, hash, false)}(w, ${x}${hash ? `, ${indent}` : ""})\n` : this.structBody(s, hash, x, indent);
      default: return `\tn += ${this.proc(s, hash, false)}(w, ${x}${hash ? `, ${indent}` : ""})\n`;
    }
  }

  private structBody(s: Extract<Shape, { k: "struct" }>, hash: boolean, x: string, indent: string): string {
    let out = `\tn += ${R}.w_str(w, ${encodeString(s.display + "{")})\n`;
    if (!s.fields.length) return out + `\tn += ${R}.w_str(w, "}")\n`;
    if (hash) {
      out += `\tn += ${R}.w_str(w, "\\n")\n`;
      for (const f of s.fields) {
        out += `\tn += ${R}.w_tabs(w, ${indent} + 1)\n\tn += ${R}.w_str(w, ${encodeString(f.name + " = ")})\n`;
        out += this.nested(f.shape, true, `${x}.${f.name}`, `${indent} + 1`);
        out += `\tn += ${R}.w_str(w, ",\\n")\n`;
      }
      return out + `\tn += ${R}.w_tabs(w, ${indent})\n\tn += ${R}.w_str(w, "}")\n`;
    }
    s.fields.forEach((f, i) => {
      // fmt writes the separator without counting it
      if (i) out += `\t${R}.w_str(w, ", ")\n`;
      out += `\tn += ${R}.w_str(w, ${encodeString(f.name + " = ")})\n`;
      out += this.nested(f.shape, false, `${x}.${f.name}`, indent);
    });
    return out + `\tn += ${R}.w_str(w, "}")\n`;
  }

  private arrayBody(s: Extract<Shape, { k: "array" | "slice" | "dynamic" }>, hash: boolean): string {
    let out = s.k === "array" ? "" : `\tif raw_data(x) == nil && len(x) > 0 {\n\t\t${R}.w_str(w, "nil")\n\t\treturn\n\t}\n`;
    out += `\tn += ${R}.w_str(w, "[")\n`;
    if (hash) {
      out += `\tif len(x) > 0 {\n\t\tn += ${R}.w_str(w, "\\n")\n\t\tfor e in x {\n\t\t\tn += ${R}.w_tabs(w, indent + 1)\n`;
      out += indentBy(this.nested(s.elem, true, "e", "indent + 1"), 2);
      out += `\t\t\tn += ${R}.w_str(w, ",\\n")\n\t\t}\n\t\tn += ${R}.w_tabs(w, indent)\n\t}\n`;
    } else {
      out += `\tfor e, i in x {\n\t\tif i > 0 do n += ${R}.w_str(w, ", ")\n` + indentBy(this.nested(s.elem, false, "e", "indent"), 1) + `\t}\n`;
    }
    return out + `\tn += ${R}.w_str(w, "]")\n`;
  }
}

function keyOf(s: Shape): string {
  return "key" in s && s.key ? s.key : s.type;
}

function indentBy(code: string, tabs: number): string {
  return code.replace(/^/gm, "\t".repeat(tabs)).replace(/\t+$/, "");
}

/** Whether the program registers its own fmt formatters, which generated printers would bypass. */
export function registersFormatters(an: Analyzer): boolean {
  for (const pkg of an.packages) for (const f of pkg.files) for (const t of f.toks) if (t.text === "register_user_formatter" || t.text === "set_user_formatters") return true;
  return false;
}

