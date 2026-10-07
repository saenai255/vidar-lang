import type { Expr } from "./ast";
import { A, Analyzer, nodeText } from "./analyzer";
import { decodeString, encodeString } from "./fmtspec";
import type { GlobalSym, Sym, Ty } from "./scope";

type Call = Extract<Expr, { k: "Call" }>;

/**
 * -opt: `json.marshal(x)` with the default options, for a type vidar can see all the way down,
 * calls a generated writer instead of encoding/json's walk over type info. The bytes are
 * encoding/json's: `{"key":value,...}`, `[a,b]`, keys quoted as it quotes them, string values
 * escaped for JSON, floats through `io.write_f*`, enums as their integer value, and `json:"name"`,
 * `json:"-"` and `omitempty` tags (omitempty drops empty strings, slices and dynamic arrays).
 */
type Shape =
  | { k: "struct"; key: string; type: string; fields: { name: string; json: string; omit: boolean; shape: Shape }[]; named: boolean }
  | { k: "array" | "slice" | "dynamic"; key: string; type: string; elem: Shape }
  | { k: "enum"; type: string; unsigned: boolean }
  | { k: "string" | "bool" | "rune"; type: string }
  | { k: "int" | "float"; type: string };

const R = "__vidar";
const BITS_64 = new Set(["int", "uint", "i8", "u8", "byte", "i16", "u16", "i32", "u32", "i64", "u64"]);

export class JsonWriters {
  readonly procs = new Map<string, string>();
  private shapes = new Map<GlobalSym, Shape | null>();

  constructor(
    private an: Analyzer,
    private ref: (sym: GlobalSym) => string | undefined,
  ) {}

  /** `json.marshal(x)` written as a call to a generated proc, or undefined to leave it. */
  marshal(c: Call, emit: (e: Expr) => string): string | undefined {
    const fn = c.fn;
    if (fn.k !== "Selector" || fn.name !== "marshal" || fn.x.k !== "Ident" || c.args.length !== 1 || c.args[0].k === "FieldValue") return undefined;
    const pkg: Sym | undefined = A(fn.x)._sym;
    if (pkg?.kind !== "pkg" || pkg.path !== "core:encoding/json") return undefined;
    const arg = c.args[0];
    const ty = this.an.typeOf(arg, A(arg)._scope ?? this.an.global);
    let shape: Shape | undefined;
    try {
      shape = ty && this.shape(ty, 0);
    } catch {
      return undefined;
    }
    if (!shape || !("type" in shape) || (shape.k === "struct" && !shape.named)) return undefined;
    const key = keyOf(shape);
    const name = `__json_marshal_${key}`;
    if (!this.procs.has(name)) {
      this.procs.set(name, "");
      const writer = this.writer(shape);
      // a `when` on the argument's type: a wrong guess about it only means encoding/json does it after all
      this.procs.set(name,
        `// json.marshal of ${shape.type}, written out: encoding/json's bytes\n` +
          `${name} :: proc(x: $T, allocator := context.allocator) -> (data: []byte, err: ${fn.x.name}.Marshal_Error) {\n` +
          `\twhen T == ${shape.type} {\n\t\tb := ${R}.builder(allocator)\n\t\t${writer}(${R}.sb_writer(&b), x)\n\t\treturn b.buf[:], nil\n` +
          `\t} else {\n\t\treturn ${fn.x.name}.marshal(x, allocator = allocator)\n\t}\n}`);
    }
    return `${name}(${emit(arg)})`;
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
        if (name === "string" || name === "bool" || name === "rune") return { k: name, type: name };
        if (BITS_64.has(name)) return { k: "int", type: name };
        if (name === "f16" || name === "f32" || name === "f64") return { k: "float", type: name };
        const sym = this.an.resolveName(n, ty.scope, null);
        return sym?.kind === "global" ? this.named(sym, depth) : undefined;
      }
      case "TypeExpr": {
        const elem = n.parts[1] ? this.shape({ t: "node", node: n.parts[1], scope: ty.scope }, depth + 1) : undefined;
        if (!elem || (elem.k === "struct" && !elem.named)) return undefined;
        if (n.what === "array") {
          const count = n.parts[0];
          if (count?.k !== "Lit" || count.kind !== "int") return undefined;
          const len = nodeText(count).replace(/_/g, "");
          return { k: "array", key: `arr${len}_${keyOf(elem)}`, type: `[${len}]${elem.type}`, elem };
        }
        if (n.what === "slice" && !n.parts[0]) return { k: "slice", key: `sl_${keyOf(elem)}`, type: `[]${elem.type}`, elem };
        if (n.what === "dynamic" && !n.parts[0]) return { k: "dynamic", key: `dyn_${keyOf(elem)}`, type: `[dynamic]${elem.type}`, elem };
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
      const base = value.base ? nodeText(value.base) : "int";
      if (!BITS_64.has(base)) return void this.shapes.set(sym, null);
      const s: Shape = { k: "enum", type, unsigned: base.startsWith("u") || base === "byte" };
      this.shapes.set(sym, s);
      return s;
    }
    const s = { k: "struct", key: `${sym.pkg.name}_${sym.odinName}`, type, fields: [], named: true } as Extract<Shape, { k: "struct" }>;
    this.shapes.set(sym, s);
    const full = this.struct(value, { t: "node", node: value, scope: sym.scope }, depth, s);
    if (!full) this.shapes.set(sym, null);
    return full;
  }

  private struct(n: Extract<Expr, { k: "StructType" }>, ty: Extract<Ty, { t: "node" }>, depth: number, into: Extract<Shape, { k: "struct" }> | undefined): Shape | undefined {
    if (n.polyParams || n.extra.length) return undefined;
    for (let i = n.start; i < n.end && n.toks[i].text !== "{"; i++) if (n.toks[i].kind === "directive") return undefined;
    const fields: Extract<Shape, { k: "struct" }>["fields"] = [];
    for (const f of n.fields) {
      if (!f.type || f.value || f.names.some((x) => x.prefix)) return undefined;
      const tagTok = n.toks[f.type.end];
      let json = "";
      let omit = false;
      if (tagTok?.kind === "string") {
        const tag = decodeString(tagTok.text);
        if (tag === undefined) return undefined;
        const value = tagLookup(tag, "json");
        if (value === undefined) return undefined;
        const comma = value.indexOf(",");
        json = comma >= 0 ? value.slice(0, comma) : value;
        omit = comma >= 0 && value.slice(comma + 1).split(",").includes("omitempty");
      }
      if (json === "-") continue;
      if ([...(json || f.names.map((x) => x.name).join(""))].some((c) => c < " " || c === "\\" || c === '"' || c > "~")) return undefined;
      const shape = this.shape({ t: "node", node: f.type, scope: ty.scope }, depth + 1);
      if (!shape) return undefined;
      // omitempty only drops what encoding/json's is_omitempty calls empty
      if (omit && !(shape.k === "string" || shape.k === "slice" || shape.k === "dynamic")) omit = false;
      for (const x of f.names) fields.push({ name: x.name, json: json || x.name, omit, shape });
    }
    if (into) {
      into.fields = fields;
      return into;
    }
    return { k: "struct", key: "", type: "", fields, named: false };
  }

  /** The proc writing a composite, generated once; leaves are written inline. */
  private writer(s: Shape): string {
    const name = `__jsonw_${keyOf(s)}`;
    if (this.procs.has(name)) return name;
    this.procs.set(name, "");
    const t = (s as { type: string }).type;
    this.procs.set(name, `${name} :: proc(w: ${R}.Writer, x: ${t}) {\n${this.value(s, "x", 1)}}`);
    return name;
  }

  private value(s: Shape, x: string, tabs: number): string {
    const t = "\t".repeat(tabs);
    switch (s.k) {
      case "string": return `${t}${R}.w_json_str(w, ${x})\n`;
      case "bool": return `${t}${R}.w_t(w, ${x})\n`;
      case "rune": return `${t}${R}.w_json_rune(w, ${x})\n`;
      case "int": return `${t}${R}.w_d(w, ${x})\n`;
      case "float": return `${t}${R}.w_json_float(w, ${x})\n`;
      case "enum": return `${t}${R}.w_d(w, ${s.unsigned ? "u64" : "i64"}(${x}))\n`;
      case "struct": {
        if (s.named && x !== "x") return `${t}${this.writer(s)}(w, ${x})\n`;
        let out = `${t}${R}.w_str(w, "{")\n`;
        if (s.fields.some((f) => f.omit)) {
          out += `${t}first := true\n`;
          for (const f of s.fields) {
            const body = `${t}\tif !first do ${R}.w_str(w, ",")\n${t}\tfirst = false\n${t}\t${R}.w_str(w, ${encodeString(jsonKey(f.json))})\n${this.value(f.shape, `${x}.${f.name}`, tabs + 1)}`;
            out += f.omit ? `${t}if len(${x}.${f.name}) != 0 {\n${body}${t}}\n` : `${t}{\n${body}${t}}\n`;
          }
        } else {
          s.fields.forEach((f, i) => {
            out += `${t}${R}.w_str(w, ${encodeString((i ? "," : "") + jsonKey(f.json))})\n${this.value(f.shape, `${x}.${f.name}`, tabs)}`;
          });
        }
        return out + `${t}${R}.w_str(w, "}")\n`;
      }
      default: {
        if (x !== "x") return `${t}${this.writer(s)}(w, ${x})\n`;
        return `${t}${R}.w_str(w, "[")\n${t}for e, i in x {\n${t}\tif i > 0 do ${R}.w_str(w, ",")\n${this.value(s.elem, "e", tabs + 1)}${t}}\n${t}${R}.w_str(w, "]")\n`;
      }
    }
  }
}

function keyOf(s: Shape): string {
  return "key" in s && s.key ? s.key : (s as { type: string }).type.replace(/\W/g, "_");
}

/** A key as encoding/json writes it: io.write_quoted_string (not escaped for JSON), then a colon. */
function jsonKey(name: string): string {
  return `"${name}":`;
}

/** reflect.struct_tag_lookup: `key:"value" other:"..."`; undefined when the tag isn't in that form. */
export function tagLookup(tag: string, key: string): string | undefined {
  let t = tag;
  for (;;) {
    t = t.replace(/^ +/, "");
    if (!t) return "";
    const m = /^([^:"\x00-\x1f\x7f]+):"((?:[^"\\]|\\.)*)"/.exec(t);
    if (!m) return undefined;
    if (m[2].includes("\\")) return undefined;
    if (m[1] === key) return m[2];
    t = t.slice(m[0].length);
  }
}

/** Whether the program registers its own JSON marshalers, which generated writers would bypass. */
export function registersMarshalers(an: Analyzer): boolean {
  for (const pkg of an.packages) for (const f of pkg.files) for (const t of f.toks) if (t.text === "register_user_marshaler" || t.text === "set_user_marshalers") return true;
  return false;
}

