import type { Expr } from "./ast";
import { A, Analyzer, nodeText } from "./analyzer";
import { decodeString, encodeString } from "./fmtspec";
import { tagLookup } from "./jsonopt";
import type { GlobalSym, Sym, Ty } from "./scope";

type Call = Extract<Expr, { k: "Call" }>;

/**
 * -opt: `json.unmarshal(data, &x)` (and `json.unmarshal_string`) with the default options, for a
 * type vidar can see, calls a generated reader instead of encoding/json's walk over type info.
 *
 * The input is first checked to be strict JSON (RFC 8259, valid UTF-8 in strings, nothing after the
 * value but whitespace). Anything else, which includes every input encoding/json rejects and the
 * JSON5 it accepts, goes to `json.unmarshal` untouched, so its result and error are encoding/json's.
 * Strict JSON is then read with encoding/json's rules: fields by `json:` name, then by field name
 * for fields without one; unknown keys skipped; `null` zeroes; ints through i64 (i128 past 18
 * digits), floats as `strconv.parse_f64` makes them (its exact fast path inline, the call otherwise);
 * strings unquoted and allocated exactly as `unquote_string` does; arrays counted first (the check
 * keeps a table of lengths), then allocated at that length. A value the reader
 * doesn't handle itself (the wrong kind for its field, a float into an int, a rune, a field of a
 * type it can't see) is handed to `json.unmarshal` on its own bytes, with an error's position moved
 * back into the whole input. The one difference: object keys aren't allocated.
 */
type Shape =
  | { k: "struct"; key: string; type: string; fields: { name: string; json: string; shape: Shape | null }[]; named: boolean }
  | { k: "array" | "slice" | "dynamic"; key: string; type: string; elem: Shape }
  | { k: "enum"; key: string; type: string; members: string[] }
  | { k: "string" | "bool" | "rune"; type: string }
  | { k: "int" | "float"; type: string };

const INTS = new Set(["int", "uint", "i8", "u8", "byte", "i16", "u16", "i32", "u32", "i64", "u64"]);

/** Why a `json.unmarshal` call isn't generated, or its type when it is; undefined when it isn't one. */
export type UnmarshalPlan = { type: string } | { why: string };

export class JsonReaders {
  readonly procs = new Map<string, string>();
  private shapes = new Map<GlobalSym, Shape | null>();
  private anon = 0;
  private M = "";
  private J = "";

  constructor(
    private an: Analyzer,
    private ref: (sym: GlobalSym) => string | undefined,
    /** the name this file has for a core package, imported when it lacks one */
    private imp: (path: string, name: string) => string,
  ) {}

  /** What `plan` would decide for `c`, without generating anything. */
  plan(c: Call): UnmarshalPlan | undefined {
    const r = this.resolve(c);
    if (!r) return undefined;
    return "why" in r ? r : { type: r.shape.type };
  }

  /** `json.unmarshal(data, ptr)` written as a call to a generated proc, or undefined to leave it. */
  unmarshal(c: Call, emit: (e: Expr) => string): string | undefined {
    const r = this.resolve(c);
    if (!r || "why" in r) return undefined;
    const { shape, pkg, str } = r;
    this.J = pkg;
    this.runtime();
    const key = keyOf(shape);
    const name = `__json_unmarshal_${key}`;
    if (!this.procs.has(name)) {
      this.procs.set(name, "");
      const read = this.value(shape, "ptr", "&r");
      // a `when` on the pointer's type: a wrong guess about it only means encoding/json does it after all
      this.procs.set(name,
        `// json.unmarshal into ${shape.type}, read directly: strict JSON here, anything else through encoding/json\n` +
          `@(private="file")\n` +
          `${name} :: proc(data: []byte, ptr: ^$T, allocator := context.allocator) -> ${pkg}.Unmarshal_Error {\n` +
          `\twhen T == ${shape.type} {\n` +
          `\t\tr: __Jsonr = ---\n\t\tr.s = string(data)\n\t\tr.i = 0\n\t\tr.allocator = allocator\n` +
          `\t\tif !__jsonr_valid(&r) do return ${pkg}.unmarshal(data, ptr, allocator = allocator)\n` +
          `\t\t__jsonr_ws(&r)\n` +
          `\t\treturn ${read}\n` +
          `\t} else {\n\t\treturn ${pkg}.unmarshal(data, ptr, allocator = allocator)\n\t}\n}`);
    }
    const [data, ptr, alloc] = c.args;
    const allocator = alloc?.k === "FieldValue" ? `, allocator = ${emit(alloc.value)}` : "";
    return `${name}(${str ? `transmute([]byte)string(${emit(data)})` : emit(data)}, ${emit(ptr)}${allocator})`;
  }

  private resolve(c: Call): { shape: Shape; pkg: string; str: boolean } | { why: string } | undefined {
    const fn = c.fn;
    if (fn.k !== "Selector" || (fn.name !== "unmarshal" && fn.name !== "unmarshal_string") || fn.x.k !== "Ident") return undefined;
    const pkg: Sym | undefined = A(fn.x)._sym;
    if (pkg?.kind !== "pkg" || pkg.path !== "core:encoding/json") return undefined;
    const [, , extra, ...more] = c.args;
    if (c.args.length < 2 || c.args[0].k === "FieldValue" || c.args[1].k === "FieldValue" || more.length || (extra && !(extra.k === "FieldValue" && extra.name === "allocator")))
      return { why: "a specification other than the default is passed" };
    if (registersUnmarshalers(this.an)) return { why: "the program registers its own unmarshalers" };
    const arg = c.args[1];
    let ty = this.an.typeOf(arg, A(arg)._scope ?? this.an.global);
    if (ty?.t === "ptr") ty = ty.elem;
    else if (ty?.t === "node" && ty.node.k === "Unary" && ty.node.op === "^") ty = { ...ty, node: ty.node.x };
    else return { why: "the destination isn't a pointer of a known type" };
    let shape: Shape | undefined;
    try {
      shape = this.shape(ty, 0);
    } catch {
      shape = undefined;
    }
    if (!shape) return { why: "the destination's type isn't a struct, enum, array, slice, string, bool or number vidar can see" };
    if (shape.k === "struct" && !shape.named) return { why: "the destination is an anonymous struct" };
    if (shape.k === "rune") return { why: "a rune is left to encoding/json" };
    return { shape, pkg: fn.x.name, str: fn.name === "unmarshal_string" };
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
        if (INTS.has(name)) return { k: "int", type: name };
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
    const key = `${sym.pkg.name}_${sym.odinName}`;
    if (value.k === "EnumType") {
      const base = value.base ? nodeText(value.base) : "int";
      if (!INTS.has(base)) return void this.shapes.set(sym, null);
      const s: Shape = { k: "enum", key, type, members: value.members.map((m) => m.name) };
      this.shapes.set(sym, s);
      return s;
    }
    const s = { k: "struct", key, type, fields: [], named: true } as Extract<Shape, { k: "struct" }>;
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
      if (!f.type || f.value || f.names.some((x) => x.prefix || x.name === "_")) return undefined;
      const tagTok = n.toks[f.type.end];
      let json = "";
      if (tagTok?.kind === "string") {
        const tag = decodeString(tagTok.text);
        if (tag === undefined) return undefined;
        const value = tagLookup(tag, "json");
        if (value === undefined) return undefined;
        const comma = value.indexOf(",");
        // encoding/json's json_name_from_tag_value; a `json:"-"` field is still matched by the key "-"
        json = comma >= 0 ? value.slice(0, comma) : value;
      }
      // a field of a type the reader can't see is read by encoding/json
      const shape = this.shape({ t: "node", node: f.type, scope: ty.scope }, depth + 1) ?? null;
      for (const x of f.names) fields.push({ name: x.name, json, shape });
    }
    if (into) {
      into.fields = fields;
      return into;
    }
    return { k: "struct", key: `anon${this.anon++}`, type: "", fields, named: false };
  }

  /** The call reading shape `s` into pointer `x` (an expression of `r: ^__Jsonr`'s proc). */
  private value(s: Shape | null, x: string, r = "r"): string {
    if (!s) return `__jsonr_delegate(${r}, ${x})`;
    switch (s.k) {
      case "string": return `__jsonr_str(${r}, ${x})`;
      case "bool": return `__jsonr_bool(${r}, ${x})`;
      case "rune": return `__jsonr_delegate(${r}, ${x})`;
      case "int": return `__jsonr_int(${r}, ${x})`;
      case "float": return `__jsonr_float(${r}, ${x})`;
      default: return `${this.reader(s)}(${r}, ${x})`;
    }
  }

  /** The proc reading a composite or an enum, generated once. */
  private reader(s: Extract<Shape, { key: string }>): string {
    const name = `__jsonr_${keyOf(s)}`;
    if (this.procs.has(name)) return name;
    this.procs.set(name, "");
    const M = this.M;
    const head = `@(private="file")\n${name} :: proc(r: ^__Jsonr, x: ^$T) -> ${this.J}.Unmarshal_Error #no_bounds_check {\n`;
    const open = (c: string) =>
      `\tswitch r.s[r.i] {\n\tcase '${c}':\n\tcase 'n':\n\t\t${M}.zero(x, size_of(T))\n\t\tr.i += 4\n\t\treturn nil\n\tcase:\n\t\treturn __jsonr_delegate(r, x)\n\t}\n`;
    let body: string;
    switch (s.k) {
      case "enum":
        // a name in quotes is the member it names, an unknown one leaves the value alone (as encoding/json does)
        body =
          `\ts := r.s\n\ti := r.i\n\tif s[i] != '"' do return __jsonr_int(r, x)\n\tj := i + 1\n` +
          `\tfor s[j] != '"' && s[j] != '\\\\' do j += 1\n\tif s[j] == '\\\\' do return __jsonr_delegate(r, x)\n\tr.i = j + 1\n` +
          (s.members.length ? `\tswitch s[i + 1:j] {\n${s.members.map((m) => `\tcase ${encodeString(m)}: x^ = .${m}\n`).join("")}\t}\n` : "") +
          `\treturn nil\n`;
        break;
      case "struct": {
        // encoding/json's lookup: the first field with the key as its json name, then the first without a json name named so
        const byKey = new Map<string, (typeof s.fields)[number]>();
        for (const f of s.fields) if (!byKey.has(f.json)) byKey.set(f.json, f);
        for (const f of s.fields) if (f.json === "" && !byKey.has(f.name)) byKey.set(f.name, f);
        const cases = [...byKey].map(([k, f]) => `\t\tcase ${encodeString(k)}:\n\t\t\t${this.value(f.shape, `&x.${f.name}`)} or_return\n`).join("");
        body =
          open("{") +
          `\tr.i += 1\n\t__jsonr_ws(r)\n\tfor r.s[r.i] != '}' {\n` +
          `\t\tkey, owned, err := __jsonr_key(r)\n\t\tif err != nil do return err\n\t\tdefer if owned do delete(key, r.allocator)\n\t\t__jsonr_ws(r)\n\t\tr.i += 1\n\t\t__jsonr_ws(r)\n` +
          `\t\tswitch key {\n${cases}\t\tcase:\n\t\t\tr.i = __jsonr_skip(r.s, r.i)\n\t\t}\n` +
          `\t\t__jsonr_ws(r)\n\t\tif r.s[r.i] == ',' {\n\t\t\tr.i += 1\n\t\t\t__jsonr_ws(r)\n\t\t}\n\t}\n\tr.i += 1\n\treturn nil\n`;
        break;
      }
      default: {
        // counted first, as encoding/json does: a fixed array too short is its error before anything is written
        const size =
          s.k === "array" ? `\tif __jsonr_len(r) > len(T) do return __jsonr_delegate(r, x)\n` :
          `\tif err := __jsonr_make(r, x, __jsonr_len(r)); err != nil do return err\n`;
        body =
          open("[") + size +
          `\tr.i += 1\n\t__jsonr_ws(r)\n\tfor k := 0; r.s[r.i] != ']'; k += 1 {\n` +
          `\t\t${this.value(s.elem, "&x[k]")} or_return\n` +
          `\t\t__jsonr_ws(r)\n\t\tif r.s[r.i] == ',' {\n\t\t\tr.i += 1\n\t\t\t__jsonr_ws(r)\n\t\t}\n\t}\n\tr.i += 1\n\treturn nil\n`;
      }
    }
    this.procs.set(name, head + body + "}");
    return name;
  }

  /** The reader's own procs, written once per file. */
  private runtime(): void {
    if (this.procs.has("__jsonr")) return;
    const J = this.J;
    const M = (this.M = this.imp("core:mem", "mem"));
    const SC = this.imp("core:strconv", "strconv");
    const U8 = this.imp("core:unicode/utf8", "utf8");
    const U16 = this.imp("core:unicode/utf16", "utf16");
    const IN = this.imp("base:intrinsics", "intrinsics");
    this.procs.set("__jsonr", READER.replace(/\bJ\./g, `${J}.`).replace(/\bM\./g, `${M}.`).replace(/\bSC\./g, `${SC}.`)
      .replace(/\bU8\./g, `${U8}.`).replace(/\bU16\./g, `${U16}.`).replace(/\bIN\./g, `${IN}.`).trim());
  }
}

function keyOf(s: Shape): string {
  return "key" in s && s.key ? s.key : s.type.replace(/\W/g, "_");
}

/** Whether the program registers its own JSON unmarshalers, which generated readers would bypass. */
export function registersUnmarshalers(an: Analyzer): boolean {
  for (const pkg of an.packages) for (const f of pkg.files) for (const t of f.toks) if (t.text === "register_user_unmarshaler" || t.text === "set_user_unmarshalers" || t.text === "_user_unmarshalers") return true;
  return false;
}

/** The decision for a call, for hints: a JsonReaders that names every type by its own name. */
const planners = new WeakMap<Analyzer, JsonReaders>();
export function unmarshalPlan(an: Analyzer, c: Call): UnmarshalPlan | undefined {
  let p = planners.get(an);
  if (!p) planners.set(an, (p = new JsonReaders(an, (sym) => sym.odinName, (_path, name) => name)));
  return p.plan(c);
}

// Every proc is file-private: each file writing readers has its own copy.
// J, M, SC, U8, U16 and IN are replaced by this file's names for encoding/json, mem, strconv, utf8, utf16 and intrinsics.
const READER = String.raw`
// json.unmarshal, read directly
@(private="file")
__Jsonr :: struct {
	s:         string,
	i:         int,
	allocator: M.Allocator,
	// the length of each array the check saw, by where it starts, in order; the first 256 of them
	arrays:    [256][2]int,
	narrays:   int,
	next:      int,
}

@(private="file")
__jsonr_ws :: #force_inline proc(r: ^__Jsonr) #no_bounds_check {
	for r.i < len(r.s) {
		switch r.s[r.i] {
		case ' ', '\t', '\n', '\r': r.i += 1
		case: return
		}
	}
}

@(private="file")
__jsonr_skip_ws :: #force_inline proc(s: string, i: int) -> int #no_bounds_check {
	i := i
	for i < len(s) {
		switch s[i] {
		case ' ', '\t', '\n', '\r': i += 1
		case: return i
		}
	}
	return i
}

// Whether r.s is strict JSON, which encoding/json accepts and reads as the procs here do; the rest goes to it.
@(private="file")
__jsonr_valid :: proc(r: ^__Jsonr) -> bool #no_bounds_check {
	s := r.s
	in_object: [256]bool
	// the array's entry in r.arrays, or -1
	entry: [256]int
	depth := 0
	r.narrays = 0
	r.next = 0
	i := __jsonr_skip_ws(s, 0)
	value: for {
		if i >= len(s) do return false
		switch s[i] {
		case '{', '[':
			object := s[i] == '{'
			at := i
			i = __jsonr_skip_ws(s, i + 1)
			if i < len(s) && s[i] == (object ? '}' : ']') {
				i += 1
			} else {
				if depth == len(in_object) do return false
				in_object[depth] = object
				if !object {
					entry[depth] = -1
					if r.narrays < len(r.arrays) {
						entry[depth] = r.narrays
						r.arrays[r.narrays] = {at, 1}
						r.narrays += 1
					}
				}
				depth += 1
				if object {
					i = __jsonr_valid_key(s, i)
					if i < 0 do return false
				}
				continue value
			}
		case '"':
			i = __jsonr_valid_str(s, i)
			if i < 0 do return false
		case 't':
			if len(s) - i < 4 || s[i:i + 4] != "true" do return false
			i += 4
		case 'f':
			if len(s) - i < 5 || s[i:i + 5] != "false" do return false
			i += 5
		case 'n':
			if len(s) - i < 4 || s[i:i + 4] != "null" do return false
			i += 4
		case '-', '0'..='9':
			i = __jsonr_valid_num(s, i)
			if i < 0 do return false
		case:
			return false
		}
		// after a value: a comma, or the end of objects and arrays
		for {
			i = __jsonr_skip_ws(s, i)
			if depth == 0 do return i == len(s)
			if i >= len(s) do return false
			switch s[i] {
			case ',':
				i = __jsonr_skip_ws(s, i + 1)
				if in_object[depth - 1] {
					i = __jsonr_valid_key(s, i)
					if i < 0 do return false
				} else if e := entry[depth - 1]; e >= 0 {
					r.arrays[e][1] += 1
				}
				continue value
			case '}':
				if !in_object[depth - 1] do return false
			case ']':
				if in_object[depth - 1] do return false
			case:
				return false
			}
			i += 1
			depth -= 1
		}
	}
}

// A key and its colon: where its value starts, or -1.
@(private="file")
__jsonr_valid_key :: proc(s: string, i: int) -> int #no_bounds_check {
	if i >= len(s) || s[i] != '"' do return -1
	i := __jsonr_valid_str(s, i)
	if i < 0 do return -1
	i = __jsonr_skip_ws(s, i)
	if i >= len(s) || s[i] != ':' do return -1
	return __jsonr_skip_ws(s, i + 1)
}

@(private="file")
__jsonr_valid_str :: proc(s: string, i: int) -> int #no_bounds_check {
	j := i + 1
	for j < len(s) {
		c := s[j]
		if c >= 0x20 && c < 0x80 && c != '"' && c != '\\' {
			j += 1
			continue
		}
		switch {
		case c == '"':
			return j + 1
		case c == '\\':
			if j + 1 >= len(s) do return -1
			switch s[j + 1] {
			case '"', '\\', '/', 'b', 'f', 'n', 'r', 't':
				j += 2
			case 'u':
				if j + 6 > len(s) do return -1
				for k in j + 2 ..< j + 6 {
					switch s[k] {
					case '0'..='9', 'a'..='f', 'A'..='F':
					case: return -1
					}
				}
				j += 6
			case:
				return -1
			}
		case c < 0x20:
			return -1
		case c < 0x80:
			j += 1
		case:
			r, w := U8.decode_rune_in_string(s[j:])
			if r == U8.RUNE_ERROR && w == 1 do return -1
			j += w
		}
	}
	return -1
}

@(private="file")
__jsonr_valid_num :: proc(s: string, i: int) -> int #no_bounds_check {
	j := i
	if s[j] == '-' do j += 1
	if j >= len(s) do return -1
	switch s[j] {
	case '0':
		j += 1
	case '1'..='9':
		for j < len(s) && '0' <= s[j] && s[j] <= '9' do j += 1
	case:
		return -1
	}
	if j < len(s) && s[j] == '.' {
		j += 1
		d := j
		for j < len(s) && '0' <= s[j] && s[j] <= '9' do j += 1
		if j == d do return -1
	}
	if j < len(s) && (s[j] == 'e' || s[j] == 'E') {
		j += 1
		if j < len(s) && (s[j] == '+' || s[j] == '-') do j += 1
		d := j
		for j < len(s) && '0' <= s[j] && s[j] <= '9' do j += 1
		if j == d do return -1
	}
	return j
}

// The end of the value at i, in input already checked.
@(private="file")
__jsonr_skip :: proc(s: string, i: int) -> int #no_bounds_check {
	i := i
	switch s[i] {
	case '"':
		return __jsonr_str_end(s, i)
	case '{', '[':
		depth := 0
		for {
			switch s[i] {
			case '"':
				i = __jsonr_str_end(s, i)
				continue
			case '{', '[':
				depth += 1
			case '}', ']':
				depth -= 1
				if depth == 0 do return i + 1
			}
			i += 1
		}
	case 't', 'n':
		return i + 4
	case 'f':
		return i + 5
	}
	for i < len(s) {
		switch s[i] {
		case '0'..='9', '-', '+', '.', 'e', 'E': i += 1
		case: return i
		}
	}
	return i
}

@(private="file")
__jsonr_str_end :: #force_inline proc(s: string, i: int) -> int #no_bounds_check {
	j := i + 1
	for {
		switch s[j] {
		case '"': return j + 1
		case '\\': j += 2
		case: j += 1
		}
	}
}

// The number of elements of the array at r.i: from the check's table, else counted.
@(private="file")
__jsonr_len :: proc(r: ^__Jsonr) -> int #no_bounds_check {
	for r.next < r.narrays && r.arrays[r.next][0] < r.i do r.next += 1
	if r.next < r.narrays && r.arrays[r.next][0] == r.i {
		r.next += 1
		return r.arrays[r.next - 1][1]
	}
	return __jsonr_count(r.s, r.i)
}

@(private="file")
__jsonr_count :: proc(s: string, i: int) -> int #no_bounds_check {
	i := __jsonr_skip_ws(s, i + 1)
	if s[i] == ']' do return 0
	n := 0
	for {
		i = __jsonr_skip_ws(s, __jsonr_skip(s, i))
		n += 1
		if s[i] != ',' do return n
		i = __jsonr_skip_ws(s, i + 1)
	}
}

// Where encoding/json's tokenizer puts offset off.
@(private="file")
__jsonr_pos :: proc(s: string, off: int) -> J.Pos {
	line, nl := 1, 0
	for k in 0 ..< off {
		if s[k] == '\n' {
			line += 1
			nl = k
		}
	}
	return {offset = off, line = line, column = off - nl}
}

// The value at r.i read by encoding/json, with an error's token placed in the whole input.
@(private="file")
__jsonr_delegate :: proc(r: ^__Jsonr, x: ^$T) -> J.Unmarshal_Error {
	start := r.i
	r.i = __jsonr_skip(r.s, start)
	err := J.unmarshal(transmute([]byte)r.s[start:r.i], x, allocator = r.allocator)
	if e, ok := err.(J.Unsupported_Type_Error); ok {
		e.token.pos = __jsonr_pos(r.s, start + e.token.offset)
		return e
	}
	return err
}

@(private="file")
__jsonr_alloc_err :: proc(err: M.Allocator_Error) -> J.Error {
	return .Out_Of_Memory if err == .Out_Of_Memory else .Invalid_Allocator
}

// A slice or dynamic array of n zeroed elements, allocated as encoding/json allocates it.
@(private="file")
__jsonr_make :: proc{__jsonr_make_slice, __jsonr_make_dynamic}

@(private="file")
__jsonr_make_slice :: proc(r: ^__Jsonr, x: ^[]$E, n: int) -> J.Unmarshal_Error {
	b, err := M.alloc_bytes(size_of(E) * n, align_of(E), r.allocator)
	if err != nil do return __jsonr_alloc_err(err)
	raw := (^M.Raw_Slice)(x)
	raw.data = raw_data(b)
	raw.len = n
	return nil
}

@(private="file")
__jsonr_make_dynamic :: proc(r: ^__Jsonr, x: ^[dynamic]$E, n: int) -> J.Unmarshal_Error {
	b, err := M.alloc_bytes(size_of(E) * n, align_of(E), r.allocator)
	if err != nil do return __jsonr_alloc_err(err)
	raw := (^M.Raw_Dynamic_Array)(x)
	raw.data = raw_data(b)
	raw.len = n
	raw.cap = n
	raw.allocator = r.allocator
	return nil
}

@(private="file")
__jsonr_bool :: proc(r: ^__Jsonr, x: ^bool) -> J.Unmarshal_Error #no_bounds_check {
	switch r.s[r.i] {
	case 't':
		x^ = true
		r.i += 4
	case 'f':
		x^ = false
		r.i += 5
	case 'n':
		x^ = false
		r.i += 4
	case:
		return __jsonr_delegate(r, x)
	}
	return nil
}

// An integer or an enum's value; a float, a string or anything else goes to encoding/json.
@(private="file")
__jsonr_int :: proc(r: ^__Jsonr, x: ^$T) -> J.Unmarshal_Error #no_bounds_check {
	C :: IN.type_core_type(T)
	s := r.s
	i := r.i
	c := s[i]
	if c == 'n' {
		M.zero(x, size_of(T))
		r.i = i + 4
		return nil
	}
	if c != '-' && (c < '0' || c > '9') do return __jsonr_delegate(r, x)
	j := i + 1 if c == '-' else i
	d := j
	v: i64
	for j < len(s) && '0' <= s[j] && s[j] <= '9' {
		v = v * 10 + i64(s[j] - '0')
		j += 1
	}
	if j < len(s) && (s[j] == '.' || s[j] == 'e' || s[j] == 'E') do return __jsonr_delegate(r, x)
	r.i = j
	if j - d > 18 {
		w, _ := SC.parse_i128(s[i:j])
		(^C)(x)^ = C(w)
	} else {
		(^C)(x)^ = C(-v if c == '-' else v)
	}
	return nil
}

// A float: an integer converted as encoding/json converts its i128, anything else through strconv.parse_f64.
@(private="file")
__jsonr_float :: proc(r: ^__Jsonr, x: ^$T) -> J.Unmarshal_Error #no_bounds_check {
	s := r.s
	i := r.i
	c := s[i]
	if c == 'n' {
		x^ = 0
		r.i = i + 4
		return nil
	}
	if c != '-' && (c < '0' || c > '9') do return __jsonr_delegate(r, x)
	j := i + 1 if c == '-' else i
	d := j
	v: i64
	for j < len(s) && '0' <= s[j] && s[j] <= '9' {
		v = v * 10 + i64(s[j] - '0')
		j += 1
	}
	if j < len(s) && (s[j] == '.' || s[j] == 'e' || s[j] == 'E') {
		// up to 15 digits over a power of ten up to 22: one correctly rounded division, as parse_f64's own fast path
		nd := j - d
		exp := 0
		if s[j] == '.' {
			j += 1
			for j < len(s) && '0' <= s[j] && s[j] <= '9' {
				v = v * 10 + i64(s[j] - '0')
				nd += 1
				exp -= 1
				j += 1
			}
		}
		if j < len(s) && (s[j] == 'e' || s[j] == 'E') {
			j += 1
			eneg := s[j] == '-'
			if s[j] == '-' || s[j] == '+' do j += 1
			ev := 0
			for j < len(s) && '0' <= s[j] && s[j] <= '9' {
				if ev < 100_000 do ev = ev * 10 + int(s[j] - '0')
				j += 1
			}
			exp += -ev if eneg else ev
		}
		if nd <= 15 && -22 <= exp && exp <= 0 {
			@(static, rodata) pow10 := [23]f64{1e0, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15, 1e16, 1e17, 1e18, 1e19, 1e20, 1e21, 1e22}
			f := f64(v) / pow10[-exp]
			x^ = T(-f if c == '-' else f)
		} else {
			f, _ := SC.parse_f64(s[i:j])
			x^ = T(f)
		}
	} else if j - d > 18 || T == f16 {
		w, _ := SC.parse_i128(s[i:j])
		x^ = T(w)
	} else {
		x^ = T(-v if c == '-' else v)
	}
	r.i = j
	return nil
}

@(private="file")
__jsonr_str :: proc(r: ^__Jsonr, x: ^string) -> J.Unmarshal_Error #no_bounds_check {
	s := r.s
	i := r.i
	switch s[i] {
	case '"':
	case 'n':
		x^ = ""
		r.i = i + 4
		return nil
	case:
		return __jsonr_delegate(r, x)
	}
	j := i + 1
	for s[j] != '"' && s[j] != '\\' do j += 1
	if s[j] == '\\' {
		end := __jsonr_str_end(s, i)
		r.i = end
		str, err := __jsonr_unquote(s[i + 1:end - 1], r.allocator)
		if err != nil do return err
		x^ = str
		return nil
	}
	r.i = j + 1
	n := j - i - 1
	if n == 0 {
		x^ = ""
		return nil
	}
	// clone_string: one byte more, a 0 after the text
	b, err := M.alloc_bytes(n + 1, 1, r.allocator)
	if err != nil do return __jsonr_alloc_err(err)
	copy(b, s[i + 1:j])
	if len(b) > n {
		b[n] = 0
		x^ = string(b[:n])
	} else {
		x^ = ""
	}
	return nil
}

// A key, unquoted (and then allocated) only when it has escapes.
@(private="file")
__jsonr_key :: proc(r: ^__Jsonr) -> (key: string, owned: bool, err: J.Error) #no_bounds_check {
	s := r.s
	i := r.i
	j := i + 1
	for s[j] != '"' && s[j] != '\\' do j += 1
	if s[j] == '"' {
		r.i = j + 1
		return s[i + 1:j], false, nil
	}
	end := __jsonr_str_end(s, i)
	r.i = end
	key, err = __jsonr_unquote(s[i + 1:end - 1], r.allocator)
	return key, err == nil, err
}

@(private="file")
__jsonr_hex4 :: #force_inline proc(s: string) -> rune {
	r: rune
	for c in transmute([]byte)s {
		x: rune
		switch c {
		case '0'..='9': x = rune(c - '0')
		case 'a'..='f': x = rune(c - 'a' + 10)
		case 'A'..='F': x = rune(c - 'A' + 10)
		}
		r = r * 16 + x
	}
	return r
}

// unquote_string, for the escapes strict JSON has.
@(private="file")
__jsonr_unquote :: proc(s: string, allocator: M.Allocator) -> (string, J.Error) {
	i := 0
	for s[i] != '\\' do i += 1
	b, aerr := M.alloc_bytes(len(s) + 2 * U8.UTF_MAX, 1, allocator)
	if aerr != nil do return "", __jsonr_alloc_err(aerr)
	w := copy(b, s[0:i])
	if len(b) == 0 && allocator.data == nil do return string(b[:w]), nil
	for i < len(s) {
		c := s[i]
		if c != '\\' {
			// valid UTF-8 comes out of decode_rune and encode_rune as it went in
			b[w] = c
			i += 1
			w += 1
			continue
		}
		i += 1
		switch s[i] {
		case 'b': b[w] = '\b'
		case 'f': b[w] = '\f'
		case 'r': b[w] = '\r'
		case 't': b[w] = '\t'
		case 'n': b[w] = '\n'
		case 'u':
			r := __jsonr_hex4(s[i + 1:i + 5])
			i += 5
			if r >= 0xD800 && r <= 0xDBFF && len(s) > i + 2 && s[i:i + 2] == "\\u" {
				r2 := __jsonr_hex4(s[i + 2:i + 6])
				if r2 >= 0xDC00 && r2 <= 0xDFFF {
					i += 6
					r = U16.decode_surrogate_pair(r, r2)
				}
			}
			buf, n := U8.encode_rune(r)
			copy(b[w:], buf[:n])
			w += n
			continue
		case:
			b[w] = s[i]
		}
		i += 1
		w += 1
	}
	return string(b[:w]), nil
}
`;
