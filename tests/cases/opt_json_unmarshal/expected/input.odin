package main; import __vidar "vidar_runtime"; import __mem "core:mem"; import __strconv "core:strconv"; import __utf8 "core:unicode/utf8"; import __utf16 "core:unicode/utf16"; import __intrinsics "base:intrinsics"

import "core:encoding/json"
import "core:fmt"
import "core:strings"

Color :: enum { Red, Green, Blue }
Level :: enum u8 { Low = 1, High = 200 }

Point :: struct { x, y: f32 }

Item :: struct {
	id: int,
	name: string `json:"title"`,
	note: string `json:"note,omitempty"`,
	tags: []string,
	secret: string `json:"-"`,
	count: int `json:",omitempty"`,
	color: Color,
	level: Level,
	ok: bool,
	r: rune,
	at: Point,
	path: [dynamic]Point,
	grid: [2][2]i8,
	big: u64,
	small: i8,
	ratio: f64,
	half: f16,
	single: f32,
	inner: struct { a: int, b: string },
	m: map[string]int,
	vals: []f64,
}

// Each call is generated under -opt; json.unmarshal_any is encoding/json either way, so both must agree.
check_item :: proc(name, data: string, init: Item = {}) {
	a, b := init, init
	ea := __json_unmarshal_main_Item(transmute([]byte)data, &a)
	eb := json.unmarshal_any(transmute([]byte)data, &b)
	report(name, __fmt_0(a, ea), __fmt_0(b, eb))
}

check_ints :: proc(name, data: string) {
	a, b: []int
	ea := __json_unmarshal_sl_int(transmute([]byte)data, &a)
	eb := json.unmarshal_any(transmute([]byte)data, &b)
	report(name, __fmt_1(a, ea), __fmt_1(b, eb))
}

check_three :: proc(name, data: string) {
	a, b := [3]int{7, 8, 9}, [3]int{7, 8, 9}
	ea := __json_unmarshal_arr3_int(transmute([]byte)data, &a, allocator = context.temp_allocator)
	eb := json.unmarshal_any(transmute([]byte)data, &b, allocator = context.temp_allocator)
	report(name, __fmt_2(a, ea), __fmt_2(b, eb))
}

check_points :: proc(name, data: string) {
	a, b: [dynamic]Point
	ea := __json_unmarshal_dyn_main_Point(transmute([]byte)string(data), &a)
	eb := json.unmarshal_any(transmute([]byte)data, &b)
	report(name, __fmt_3(a, len(a), cap(a), ea), __fmt_3(b, len(b), cap(b), eb))
}

check_nested :: proc(name, data: string) {
	a, b: [][]int
	ea := __json_unmarshal_sl_sl_int(transmute([]byte)data, &a)
	eb := json.unmarshal_any(transmute([]byte)data, &b)
	report(name, __fmt_4(len(a), a[len(a) - 3:] if len(a) > 3 else a, ea), __fmt_4(len(b), b[len(b) - 3:] if len(b) > 3 else b, eb))
}

check_color :: proc(name, data: string) {
	a, b := Color.Green, Color.Green
	ea := json.unmarshal(transmute([]byte)data, &a)
	eb := json.unmarshal_any(transmute([]byte)data, &b)
	report(name, __fmt_0(a, ea), __fmt_0(b, eb))
}

check_scalars :: proc(name, data: string) {
	s1, s2: string
	f1, f2: f64
	t1, t2: bool
	n1, n2: i32
	e1 := __json_unmarshal_string(transmute([]byte)data, &s1)
	e2 := json.unmarshal_any(transmute([]byte)data, &s2)
	e3 := __json_unmarshal_f64(transmute([]byte)data, &f1)
	e4 := json.unmarshal_any(transmute([]byte)data, &f2)
	e5 := __json_unmarshal_bool(transmute([]byte)data, &t1)
	e6 := json.unmarshal_any(transmute([]byte)data, &t2)
	e7 := __json_unmarshal_i32(transmute([]byte)string(data), &n1)
	e8 := json.unmarshal_any(transmute([]byte)data, &n2)
	report(name, __fmt_5(s1, e1, f1, e3, t1, e5, n1, e7), __fmt_5(s2, e2, f2, e4, t2, e6, n2, e8))
}

report :: proc(name, got, want: string) {
	__fmt_6(name, got == want ? "same" : "DIFFERENT", got)
	if got != want do __fmt_7(want)
}

main :: proc() {
	full := `{
		"id": 42, "title": "first", "note": "a note", "tags": ["new", "q\"<&>\n\u00e9"],
		"count": 3, "color": 2, "level": 200, "ok": true, "r": "é",
		"at": {"x": 0.5, "y": -3}, "path": [{"x": 1, "y": 2.5}, {"y": 1e21}],
		"grid": [[1, -2], [3, 4]], "big": 18446744073709551615, "small": -128,
		"ratio": 0.333333333333333314829616256247390992939472198486328125, "half": 65504.0, "single": 16777217,
		"inner": {"a": 7, "b": "in"}, "m": {"k": 1}, "vals": [1, 2.5, -0.0, 1E+2, 6.02214076e23, 5e-324]
	}`
	check_item("full", full)
	check_item("whitespace", " \t\r\n{ \"id\" \n:\t1 , \"title\"  :  \"x\"\r\n}\n ")
	check_item("empty object", `{}`)
	check_item("kept", `{"id": 5}`, Item{id = 1, name = "kept", count = 9, ok = true})
	check_item("null root", `null`, Item{id = 1, name = "gone"})
	check_item("nulls", `{"id": null, "title": null, "tags": null, "color": null, "ok": null, "at": null, "grid": null, "ratio": null, "inner": null, "path": null, "r": null}`,
		Item{id = 1, name = "x", color = .Blue, ok = true, at = {1, 2}, grid = {{1, 1}, {1, 1}}, ratio = 2, inner = {1, "y"}, r = 'q'})

	// keys: by json name, by field name only without one, "-" still names the `json:"-"` field, "" the first field without a json name
	check_item("keys", `{"name": "no", "title": "yes", "secret": "no", "-": "dash", "count": 2, "": 77, "unknown": {"a": [1, {"b": "x\\n"}], "c": null}, "u2": [[], {}], "u3": "s"}`)
	check_item("duplicate keys", `{"id": 1, "id": 2, "tags": ["a"], "tags": ["b", "c"]}`)
	check_item("escaped key", `{"ti\u0074le": "via escape", "\u0069d": 3}`)

	// strings
	check_item("escapes", `{"title": "a\"b\\c\/d\b\f\n\r\t\u00e9\u20AC\ud83d\ude00|\ud800\udc00|\ud800 \udc00|\ud800\u0041|\udc00|\u0000|"}`)
	check_item("empty string", `{"title": "", "tags": ["", "\n"]}`, Item{name = "old"})
	check_item("unicode", `{"title": "héllo wörld ✓ 😀 \ufffd �"}`)

	// numbers
	check_item("int edges", `{"id": -9223372036854775808, "big": 18446744073709551616, "small": 300, "count": 123456789012345678901234567890}`)
	check_item("int digits", `{"id": 999999999999999999, "big": 1000000000000000000, "small": -0}`)
	check_item("floats", `{"ratio": 1e400, "half": 1e10, "single": 3.4028236e38, "vals": [-1e400, 1.7976931348623157e308, 2.2250738585072014e-308, 0.1, 9007199254740993, 123456789012345678901]}`)
	check_item("float into int", `{"id": 2.0, "count": 1e2, "small": -5e0}`)
	check_item("fraction into int", `{"title": "before", "id": 2.5, "count": 3}`)
	check_item("big float into int", `{"id": 1e300}`)
	check_item("string into int", `{"id": "12", "ratio": "2.5", "count": "0x10"}`)
	check_item("bad string into int", "{\"title\": \"t\",\n  \"id\": \"twelve\"}")

	// enums
	check_item("enum names", `{"color": "Blue", "level": "High"}`)
	check_item("enum unknown name", `{"color": "Nope", "level": "low"}`, Item{color = .Green, level = .High})
	check_item("enum numbers", `{"color": 7, "level": 300}`)
	check_item("enum escaped name", `{"color": "B\u006cue"}`)
	check_item("enum float", `{"color": 1.0, "level": 1.5}`)
	check_color("root enum", `"Red"`)
	check_color("root enum number", `0`)

	// runes go to encoding/json
	check_item("rune", `{"r": "\u00e9"}`)
	check_item("rune too long", `{"r": "ab", "id": 1}`)
	check_item("rune number", `{"r": 65}`)

	// arrays
	check_item("arrays", `{"grid": [[1], [2, 3]], "vals": [], "tags": []}`)
	check_item("array too long", "{\"id\": 1,\n\t\"grid\": [[1, 2], [3, 4, 5]], \"id\": 2}")
	check_item("array too many", `{"grid": [[1], [2], [3]]}`)
	check_item("nested elements", `{"path": [{"x": 1}, {"y": 2, "z": [1, 2]}, null, {}]}`)
	check_ints("root slice", ` [1, -2, 3000000000000000000000, 4]`)
	check_ints("root empty slice", `[]`)
	check_ints("root slice bad", `[1, "x", 3]`)
	check_three("short array", `[1]`)
	check_three("long array", `[1, 2, 3, 4]`)
	check_points("dynamic", `[{"x": 1, "y": 2}, {"x": 3}]`)
	check_points("dynamic empty", `[]`)

	// the wrong kind of value: encoding/json's error, at its place in the whole input
	check_item("bool from int", "{\n\"id\": 1,\n  \"ok\": 1}")
	check_item("slice from string", `{"tags": "x"}`)
	check_item("struct from array", `{"at": [1, 2]}`)
	check_item("array from object", `{"grid": {"a": 1}}`)
	check_item("string from number", `{"title": 5}`)
	check_item("string from bool", `{"title": true}`)
	check_item("root from array", `[1]`)
	check_item("map field", `{"m": {"a": 1}, "id": 3}`)
	check_item("map field bad", `{"m": [1]}`)
	check_scalars("scalar string", `"s\u0074r"`)
	check_scalars("scalar number", `-12.5e1`)
	check_scalars("scalar int", `17`)
	check_scalars("scalar true", `true`)
	check_scalars("scalar null", `null`)

	// not strict JSON: encoding/json takes it, whatever it makes of it
	check_item("trailing comma", `{"id": 1,}`)
	check_item("ident key", `{id: 1}`)
	check_item("comment", "// c\n{\"id\": 1 /* x */}")
	check_item("leading zero", `{"id": 01}`)
	check_item("bad exponent", `{"id": 1e}`)
	check_item("trailing text", `{"id": 1} x`)
	check_item("hex", `{"id": 0x10}`)
	check_item("plus", `{"id": +1}`)
	check_item("infinity", `{"ratio": Infinity, "half": -Infinity}`)
	check_item("single quotes", `{'title': 'q'}`)
	check_item("escaped quote", `{"title": "\'"}`)
	check_item("vertical tab", "{\"id\":\v1}")
	check_item("bom", "\uFEFF{\"id\": 1}")
	check_item("empty", ``)
	check_item("unclosed", `{"id": 1`)
	check_item("unclosed array", `{"id": [}`)
	check_item("missing colon", `{"id" 1}`)
	check_item("control character", "{\"title\": \"a\tb\"}")
	check_item("bad utf8", "{\"title\": \"a\xffb\"}")
	check_item("surrogate in utf8", "{\"title\": \"\xed\xa0\x80\"}")
	check_item("short escape", `{"title": "\u12"}`)
	check_item("bad escape", `{"title": "\q"}`)
	check_item("true prefix", `{"ok": tru}`)
	check_item("number then letters", `{"id": 1abc}`)
	check_item("lone minus", `{"id": -}`)
	check_item("dot", `{"ratio": 1.}`)
	check_item("nul", "{\"id\": 1}\x00")

	// more arrays than the check keeps lengths for: the rest are counted again
	many := strings.builder_make()
	strings.write_string(&many, "[")
	for i in 0..<300 do __fmt_8(&many, i > 0 ? ",\n" : "", i, -i)
	strings.write_string(&many, "]")
	check_nested("many arrays", strings.to_string(many))
	strings.builder_reset(&many)
	strings.write_string(&many, "[")
	for i in 0..<300 do __fmt_9(&many, i > 0 ? ",\n" : "", i, i == 290 ? "true" : "1")
	strings.write_string(&many, "]")
	check_nested("many arrays, one bad", strings.to_string(many))

	// deeper than the reader's check goes: encoding/json does it
	deep := strings.concatenate({`{"id": 1, "x": `, strings.repeat("[", 300), strings.repeat("]", 300), `}`})
	check_item("deep", deep)
}

// ---- generated by vidar ----

// fmt.tprint
__fmt_0 :: proc(a0: $T0, a1: $T1) -> string {
	b := __vidar.builder(context.temp_allocator)
	__vidar.sb_v(&b, a0)
	__vidar.sb_str(&b, " ")
	__vidar.sb_v(&b, a1)
	return __vidar.sb_to_string(&b)
}

// fmt.tprint
__fmt_1 :: proc(a0: $T0, a1: $T1) -> string {
	b := __vidar.builder(context.temp_allocator)
	when T0 == []int { __print_sl_int(__vidar.sb_writer(&b), a0) } else { __vidar.sb_spec(&b, a0, "%v") }
	__vidar.sb_str(&b, " ")
	__vidar.sb_v(&b, a1)
	return __vidar.sb_to_string(&b)
}

// fmt.tprint
__fmt_2 :: proc(a0: $T0, a1: $T1) -> string {
	b := __vidar.builder(context.temp_allocator)
	when T0 == [3]int { __print_arr3_int(__vidar.sb_writer(&b), a0) } else { __vidar.sb_spec(&b, a0, "%v") }
	__vidar.sb_str(&b, " ")
	__vidar.sb_v(&b, a1)
	return __vidar.sb_to_string(&b)
}

// fmt.tprint
__fmt_3 :: proc(a0: $T0, a1: $T1, a2: $T2, a3: $T3) -> string {
	b := __vidar.builder(context.temp_allocator)
	when T0 == [dynamic]Point { __print_dyn_main_Point(__vidar.sb_writer(&b), a0) } else { __vidar.sb_spec(&b, a0, "%v") }
	__vidar.sb_str(&b, " ")
	__vidar.sb_v(&b, a1)
	__vidar.sb_str(&b, " ")
	__vidar.sb_v(&b, a2)
	__vidar.sb_str(&b, " ")
	__vidar.sb_v(&b, a3)
	return __vidar.sb_to_string(&b)
}

// fmt.tprint
__fmt_4 :: proc(a0: $T0, a1: $T1, a2: $T2) -> string {
	b := __vidar.builder(context.temp_allocator)
	__vidar.sb_v(&b, a0)
	__vidar.sb_str(&b, " ")
	when T1 == [][]int { __print_sl_sl_int(__vidar.sb_writer(&b), a1) } else { __vidar.sb_spec(&b, a1, "%v") }
	__vidar.sb_str(&b, " ")
	__vidar.sb_v(&b, a2)
	return __vidar.sb_to_string(&b)
}

// fmt.tprintf "%q %v | %v %v | %v %v | %v %v"
__fmt_5 :: proc(a0: $T0, a1: $T1, a2: $T2, a3: $T3, a4: $T4, a5: $T5, a6: $T6, a7: $T7) -> string {
	b := __vidar.builder(context.temp_allocator)
	__vidar.sb_spec(&b, a0, "%q")
	__vidar.sb_str(&b, " ")
	__vidar.sb_v(&b, a1)
	__vidar.sb_str(&b, " | ")
	__vidar.sb_v(&b, a2)
	__vidar.sb_str(&b, " ")
	__vidar.sb_v(&b, a3)
	__vidar.sb_str(&b, " | ")
	__vidar.sb_v(&b, a4)
	__vidar.sb_str(&b, " ")
	__vidar.sb_v(&b, a5)
	__vidar.sb_str(&b, " | ")
	__vidar.sb_v(&b, a6)
	__vidar.sb_str(&b, " ")
	__vidar.sb_v(&b, a7)
	return __vidar.sb_to_string(&b)
}

// fmt.println
__fmt_6 :: proc(a0: $T0, a1: $T1, a2: $T2) -> (n: int) {
	buf: [1024]byte
	bw: __vidar.File_Writer
	w := __vidar.std_writer(&bw, buf[:], false)
	n += __vidar.w_v(w, a0)
	n += __vidar.w_str(w, " ")
	n += __vidar.w_v(w, a1)
	n += __vidar.w_str(w, " ")
	n += __vidar.w_v(w, a2)
	n += __vidar.w_str(w, "\n")
	__vidar.w_flush(w)
	return
}

// fmt.println
__fmt_7 :: proc(a0: $T0) -> (n: int) {
	buf: [1024]byte
	bw: __vidar.File_Writer
	w := __vidar.std_writer(&bw, buf[:], false)
	n += __vidar.w_str(w, "   want ")
	n += __vidar.w_v(w, a0)
	n += __vidar.w_str(w, "\n")
	__vidar.w_flush(w)
	return
}

// fmt.sbprintf "%s[%d, %d]"
__fmt_8 :: proc(b: ^__vidar.Builder, a0: $T0, a1: $T1, a2: $T2) -> string {
	__vidar.sb_s(b, a0)
	__vidar.sb_str(b, "[")
	__vidar.sb_d(b, a1)
	__vidar.sb_str(b, ", ")
	__vidar.sb_d(b, a2)
	__vidar.sb_str(b, "]")
	return __vidar.sb_to_string(b)
}

// fmt.sbprintf "%s[%d, %s]"
__fmt_9 :: proc(b: ^__vidar.Builder, a0: $T0, a1: $T1, a2: $T2) -> string {
	__vidar.sb_s(b, a0)
	__vidar.sb_str(b, "[")
	__vidar.sb_d(b, a1)
	__vidar.sb_str(b, ", ")
	__vidar.sb_s(b, a2)
	__vidar.sb_str(b, "]")
	return __vidar.sb_to_string(b)
}

// fmt's %v for the types printed here, written out
__print_sl_int :: proc(w: __vidar.Writer, x: []int) -> (n: int) {
	if raw_data(x) == nil && len(x) > 0 {
		__vidar.w_str(w, "nil")
		return
	}
	n += __vidar.w_str(w, "[")
	for e, i in x {
		if i > 0 do n += __vidar.w_str(w, ", ")
		n += __vidar.w_v(w, e)
	}
	n += __vidar.w_str(w, "]")
	return
}

__print_arr3_int :: proc(w: __vidar.Writer, x: [3]int) -> (n: int) {
	n += __vidar.w_str(w, "[")
	for e, i in x {
		if i > 0 do n += __vidar.w_str(w, ", ")
		n += __vidar.w_v(w, e)
	}
	n += __vidar.w_str(w, "]")
	return
}

__print_dyn_main_Point :: proc(w: __vidar.Writer, x: [dynamic]Point) -> (n: int) {
	if raw_data(x) == nil && len(x) > 0 {
		__vidar.w_str(w, "nil")
		return
	}
	n += __vidar.w_str(w, "[")
	for e, i in x {
		if i > 0 do n += __vidar.w_str(w, ", ")
		n += __print_main_Point(w, e)
	}
	n += __vidar.w_str(w, "]")
	return
}

__print_main_Point :: proc(w: __vidar.Writer, x: Point) -> (n: int) {
	n += __vidar.w_str(w, "Point{")
	n += __vidar.w_str(w, "x = ")
	n += __vidar.w_float(w, x.x)
	__vidar.w_str(w, ", ")
	n += __vidar.w_str(w, "y = ")
	n += __vidar.w_float(w, x.y)
	n += __vidar.w_str(w, "}")
	return
}

__print_sl_sl_int :: proc(w: __vidar.Writer, x: [][]int) -> (n: int) {
	if raw_data(x) == nil && len(x) > 0 {
		__vidar.w_str(w, "nil")
		return
	}
	n += __vidar.w_str(w, "[")
	for e, i in x {
		if i > 0 do n += __vidar.w_str(w, ", ")
		n += __print_sl_int(w, e)
	}
	n += __vidar.w_str(w, "]")
	return
}

// json.unmarshal, read directly
@(private="file")
__Jsonr :: struct {
	s:         string,
	i:         int,
	allocator: __mem.Allocator,
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
			r, w := __utf8.decode_rune_in_string(s[j:])
			if r == __utf8.RUNE_ERROR && w == 1 do return -1
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
__jsonr_pos :: proc(s: string, off: int) -> json.Pos {
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
__jsonr_delegate :: proc(r: ^__Jsonr, x: ^$T) -> json.Unmarshal_Error {
	start := r.i
	r.i = __jsonr_skip(r.s, start)
	err := json.unmarshal(transmute([]byte)r.s[start:r.i], x, allocator = r.allocator)
	if e, ok := err.(json.Unsupported_Type_Error); ok {
		e.token.pos = __jsonr_pos(r.s, start + e.token.offset)
		return e
	}
	return err
}

@(private="file")
__jsonr_alloc_err :: proc(err: __mem.Allocator_Error) -> json.Error {
	return .Out_Of_Memory if err == .Out_Of_Memory else .Invalid_Allocator
}

// A slice or dynamic array of n zeroed elements, allocated as encoding/json allocates it.
@(private="file")
__jsonr_make :: proc{__jsonr_make_slice, __jsonr_make_dynamic}

@(private="file")
__jsonr_make_slice :: proc(r: ^__Jsonr, x: ^[]$E, n: int) -> json.Unmarshal_Error {
	b, err := __mem.alloc_bytes(size_of(E) * n, align_of(E), r.allocator)
	if err != nil do return __jsonr_alloc_err(err)
	raw := (^__mem.Raw_Slice)(x)
	raw.data = raw_data(b)
	raw.len = n
	return nil
}

@(private="file")
__jsonr_make_dynamic :: proc(r: ^__Jsonr, x: ^[dynamic]$E, n: int) -> json.Unmarshal_Error {
	b, err := __mem.alloc_bytes(size_of(E) * n, align_of(E), r.allocator)
	if err != nil do return __jsonr_alloc_err(err)
	raw := (^__mem.Raw_Dynamic_Array)(x)
	raw.data = raw_data(b)
	raw.len = n
	raw.cap = n
	raw.allocator = r.allocator
	return nil
}

@(private="file")
__jsonr_bool :: proc(r: ^__Jsonr, x: ^bool) -> json.Unmarshal_Error #no_bounds_check {
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
__jsonr_int :: proc(r: ^__Jsonr, x: ^$T) -> json.Unmarshal_Error #no_bounds_check {
	C :: __intrinsics.type_core_type(T)
	s := r.s
	i := r.i
	c := s[i]
	if c == 'n' {
		__mem.zero(x, size_of(T))
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
		w, _ := __strconv.parse_i128(s[i:j])
		(^C)(x)^ = C(w)
	} else {
		(^C)(x)^ = C(-v if c == '-' else v)
	}
	return nil
}

// A float: an integer converted as encoding/json converts its i128, anything else through strconv.parse_f64.
@(private="file")
__jsonr_float :: proc(r: ^__Jsonr, x: ^$T) -> json.Unmarshal_Error #no_bounds_check {
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
			f, _ := __strconv.parse_f64(s[i:j])
			x^ = T(f)
		}
	} else if j - d > 18 || T == f16 {
		w, _ := __strconv.parse_i128(s[i:j])
		x^ = T(w)
	} else {
		x^ = T(-v if c == '-' else v)
	}
	r.i = j
	return nil
}

@(private="file")
__jsonr_str :: proc(r: ^__Jsonr, x: ^string) -> json.Unmarshal_Error #no_bounds_check {
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
	b, err := __mem.alloc_bytes(n + 1, 1, r.allocator)
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
__jsonr_key :: proc(r: ^__Jsonr) -> (key: string, owned: bool, err: json.Error) #no_bounds_check {
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
__jsonr_unquote :: proc(s: string, allocator: __mem.Allocator) -> (string, json.Error) {
	i := 0
	for s[i] != '\\' do i += 1
	b, aerr := __mem.alloc_bytes(len(s) + 2 * __utf8.UTF_MAX, 1, allocator)
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
					r = __utf16.decode_surrogate_pair(r, r2)
				}
			}
			buf, n := __utf8.encode_rune(r)
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

// json.unmarshal into Item, read directly: strict JSON here, anything else through encoding/json
@(private="file")
__json_unmarshal_main_Item :: proc(data: []byte, ptr: ^$T, allocator := context.allocator) -> json.Unmarshal_Error {
	when T == Item {
		r: __Jsonr = ---
		r.s = string(data)
		r.i = 0
		r.allocator = allocator
		if !__jsonr_valid(&r) do return json.unmarshal(data, ptr, allocator = allocator)
		__jsonr_ws(&r)
		return __jsonr_main_Item(&r, ptr)
	} else {
		return json.unmarshal(data, ptr, allocator = allocator)
	}
}

@(private="file")
__jsonr_main_Item :: proc(r: ^__Jsonr, x: ^$T) -> json.Unmarshal_Error #no_bounds_check {
	switch r.s[r.i] {
	case '{':
	case 'n':
		__mem.zero(x, size_of(T))
		r.i += 4
		return nil
	case:
		return __jsonr_delegate(r, x)
	}
	r.i += 1
	__jsonr_ws(r)
	for r.s[r.i] != '}' {
		key, owned, err := __jsonr_key(r)
		if err != nil do return err
		defer if owned do delete(key, r.allocator)
		__jsonr_ws(r)
		r.i += 1
		__jsonr_ws(r)
		switch key {
		case "":
			__jsonr_int(r, &x.id) or_return
		case "title":
			__jsonr_str(r, &x.name) or_return
		case "note":
			__jsonr_str(r, &x.note) or_return
		case "-":
			__jsonr_str(r, &x.secret) or_return
		case "id":
			__jsonr_int(r, &x.id) or_return
		case "tags":
			__jsonr_sl_string(r, &x.tags) or_return
		case "count":
			__jsonr_int(r, &x.count) or_return
		case "color":
			__jsonr_main_Color(r, &x.color) or_return
		case "level":
			__jsonr_main_Level(r, &x.level) or_return
		case "ok":
			__jsonr_bool(r, &x.ok) or_return
		case "r":
			__jsonr_delegate(r, &x.r) or_return
		case "at":
			__jsonr_main_Point(r, &x.at) or_return
		case "path":
			__jsonr_dyn_main_Point(r, &x.path) or_return
		case "grid":
			__jsonr_arr2_arr2_i8(r, &x.grid) or_return
		case "big":
			__jsonr_int(r, &x.big) or_return
		case "small":
			__jsonr_int(r, &x.small) or_return
		case "ratio":
			__jsonr_float(r, &x.ratio) or_return
		case "half":
			__jsonr_float(r, &x.half) or_return
		case "single":
			__jsonr_float(r, &x.single) or_return
		case "inner":
			__jsonr_anon0(r, &x.inner) or_return
		case "m":
			__jsonr_delegate(r, &x.m) or_return
		case "vals":
			__jsonr_sl_f64(r, &x.vals) or_return
		case:
			r.i = __jsonr_skip(r.s, r.i)
		}
		__jsonr_ws(r)
		if r.s[r.i] == ',' {
			r.i += 1
			__jsonr_ws(r)
		}
	}
	r.i += 1
	return nil
}

@(private="file")
__jsonr_sl_string :: proc(r: ^__Jsonr, x: ^$T) -> json.Unmarshal_Error #no_bounds_check {
	switch r.s[r.i] {
	case '[':
	case 'n':
		__mem.zero(x, size_of(T))
		r.i += 4
		return nil
	case:
		return __jsonr_delegate(r, x)
	}
	if err := __jsonr_make(r, x, __jsonr_len(r)); err != nil do return err
	r.i += 1
	__jsonr_ws(r)
	for k := 0; r.s[r.i] != ']'; k += 1 {
		__jsonr_str(r, &x[k]) or_return
		__jsonr_ws(r)
		if r.s[r.i] == ',' {
			r.i += 1
			__jsonr_ws(r)
		}
	}
	r.i += 1
	return nil
}

@(private="file")
__jsonr_main_Color :: proc(r: ^__Jsonr, x: ^$T) -> json.Unmarshal_Error #no_bounds_check {
	s := r.s
	i := r.i
	if s[i] != '"' do return __jsonr_int(r, x)
	j := i + 1
	for s[j] != '"' && s[j] != '\\' do j += 1
	if s[j] == '\\' do return __jsonr_delegate(r, x)
	r.i = j + 1
	switch s[i + 1:j] {
	case "Red": x^ = .Red
	case "Green": x^ = .Green
	case "Blue": x^ = .Blue
	}
	return nil
}

@(private="file")
__jsonr_main_Level :: proc(r: ^__Jsonr, x: ^$T) -> json.Unmarshal_Error #no_bounds_check {
	s := r.s
	i := r.i
	if s[i] != '"' do return __jsonr_int(r, x)
	j := i + 1
	for s[j] != '"' && s[j] != '\\' do j += 1
	if s[j] == '\\' do return __jsonr_delegate(r, x)
	r.i = j + 1
	switch s[i + 1:j] {
	case "Low": x^ = .Low
	case "High": x^ = .High
	}
	return nil
}

@(private="file")
__jsonr_main_Point :: proc(r: ^__Jsonr, x: ^$T) -> json.Unmarshal_Error #no_bounds_check {
	switch r.s[r.i] {
	case '{':
	case 'n':
		__mem.zero(x, size_of(T))
		r.i += 4
		return nil
	case:
		return __jsonr_delegate(r, x)
	}
	r.i += 1
	__jsonr_ws(r)
	for r.s[r.i] != '}' {
		key, owned, err := __jsonr_key(r)
		if err != nil do return err
		defer if owned do delete(key, r.allocator)
		__jsonr_ws(r)
		r.i += 1
		__jsonr_ws(r)
		switch key {
		case "":
			__jsonr_float(r, &x.x) or_return
		case "x":
			__jsonr_float(r, &x.x) or_return
		case "y":
			__jsonr_float(r, &x.y) or_return
		case:
			r.i = __jsonr_skip(r.s, r.i)
		}
		__jsonr_ws(r)
		if r.s[r.i] == ',' {
			r.i += 1
			__jsonr_ws(r)
		}
	}
	r.i += 1
	return nil
}

@(private="file")
__jsonr_dyn_main_Point :: proc(r: ^__Jsonr, x: ^$T) -> json.Unmarshal_Error #no_bounds_check {
	switch r.s[r.i] {
	case '[':
	case 'n':
		__mem.zero(x, size_of(T))
		r.i += 4
		return nil
	case:
		return __jsonr_delegate(r, x)
	}
	if err := __jsonr_make(r, x, __jsonr_len(r)); err != nil do return err
	r.i += 1
	__jsonr_ws(r)
	for k := 0; r.s[r.i] != ']'; k += 1 {
		__jsonr_main_Point(r, &x[k]) or_return
		__jsonr_ws(r)
		if r.s[r.i] == ',' {
			r.i += 1
			__jsonr_ws(r)
		}
	}
	r.i += 1
	return nil
}

@(private="file")
__jsonr_arr2_arr2_i8 :: proc(r: ^__Jsonr, x: ^$T) -> json.Unmarshal_Error #no_bounds_check {
	switch r.s[r.i] {
	case '[':
	case 'n':
		__mem.zero(x, size_of(T))
		r.i += 4
		return nil
	case:
		return __jsonr_delegate(r, x)
	}
	if __jsonr_len(r) > len(T) do return __jsonr_delegate(r, x)
	r.i += 1
	__jsonr_ws(r)
	for k := 0; r.s[r.i] != ']'; k += 1 {
		__jsonr_arr2_i8(r, &x[k]) or_return
		__jsonr_ws(r)
		if r.s[r.i] == ',' {
			r.i += 1
			__jsonr_ws(r)
		}
	}
	r.i += 1
	return nil
}

@(private="file")
__jsonr_arr2_i8 :: proc(r: ^__Jsonr, x: ^$T) -> json.Unmarshal_Error #no_bounds_check {
	switch r.s[r.i] {
	case '[':
	case 'n':
		__mem.zero(x, size_of(T))
		r.i += 4
		return nil
	case:
		return __jsonr_delegate(r, x)
	}
	if __jsonr_len(r) > len(T) do return __jsonr_delegate(r, x)
	r.i += 1
	__jsonr_ws(r)
	for k := 0; r.s[r.i] != ']'; k += 1 {
		__jsonr_int(r, &x[k]) or_return
		__jsonr_ws(r)
		if r.s[r.i] == ',' {
			r.i += 1
			__jsonr_ws(r)
		}
	}
	r.i += 1
	return nil
}

@(private="file")
__jsonr_anon0 :: proc(r: ^__Jsonr, x: ^$T) -> json.Unmarshal_Error #no_bounds_check {
	switch r.s[r.i] {
	case '{':
	case 'n':
		__mem.zero(x, size_of(T))
		r.i += 4
		return nil
	case:
		return __jsonr_delegate(r, x)
	}
	r.i += 1
	__jsonr_ws(r)
	for r.s[r.i] != '}' {
		key, owned, err := __jsonr_key(r)
		if err != nil do return err
		defer if owned do delete(key, r.allocator)
		__jsonr_ws(r)
		r.i += 1
		__jsonr_ws(r)
		switch key {
		case "":
			__jsonr_int(r, &x.a) or_return
		case "a":
			__jsonr_int(r, &x.a) or_return
		case "b":
			__jsonr_str(r, &x.b) or_return
		case:
			r.i = __jsonr_skip(r.s, r.i)
		}
		__jsonr_ws(r)
		if r.s[r.i] == ',' {
			r.i += 1
			__jsonr_ws(r)
		}
	}
	r.i += 1
	return nil
}

@(private="file")
__jsonr_sl_f64 :: proc(r: ^__Jsonr, x: ^$T) -> json.Unmarshal_Error #no_bounds_check {
	switch r.s[r.i] {
	case '[':
	case 'n':
		__mem.zero(x, size_of(T))
		r.i += 4
		return nil
	case:
		return __jsonr_delegate(r, x)
	}
	if err := __jsonr_make(r, x, __jsonr_len(r)); err != nil do return err
	r.i += 1
	__jsonr_ws(r)
	for k := 0; r.s[r.i] != ']'; k += 1 {
		__jsonr_float(r, &x[k]) or_return
		__jsonr_ws(r)
		if r.s[r.i] == ',' {
			r.i += 1
			__jsonr_ws(r)
		}
	}
	r.i += 1
	return nil
}

// json.unmarshal into []int, read directly: strict JSON here, anything else through encoding/json
@(private="file")
__json_unmarshal_sl_int :: proc(data: []byte, ptr: ^$T, allocator := context.allocator) -> json.Unmarshal_Error {
	when T == []int {
		r: __Jsonr = ---
		r.s = string(data)
		r.i = 0
		r.allocator = allocator
		if !__jsonr_valid(&r) do return json.unmarshal(data, ptr, allocator = allocator)
		__jsonr_ws(&r)
		return __jsonr_sl_int(&r, ptr)
	} else {
		return json.unmarshal(data, ptr, allocator = allocator)
	}
}

@(private="file")
__jsonr_sl_int :: proc(r: ^__Jsonr, x: ^$T) -> json.Unmarshal_Error #no_bounds_check {
	switch r.s[r.i] {
	case '[':
	case 'n':
		__mem.zero(x, size_of(T))
		r.i += 4
		return nil
	case:
		return __jsonr_delegate(r, x)
	}
	if err := __jsonr_make(r, x, __jsonr_len(r)); err != nil do return err
	r.i += 1
	__jsonr_ws(r)
	for k := 0; r.s[r.i] != ']'; k += 1 {
		__jsonr_int(r, &x[k]) or_return
		__jsonr_ws(r)
		if r.s[r.i] == ',' {
			r.i += 1
			__jsonr_ws(r)
		}
	}
	r.i += 1
	return nil
}

// json.unmarshal into [3]int, read directly: strict JSON here, anything else through encoding/json
@(private="file")
__json_unmarshal_arr3_int :: proc(data: []byte, ptr: ^$T, allocator := context.allocator) -> json.Unmarshal_Error {
	when T == [3]int {
		r: __Jsonr = ---
		r.s = string(data)
		r.i = 0
		r.allocator = allocator
		if !__jsonr_valid(&r) do return json.unmarshal(data, ptr, allocator = allocator)
		__jsonr_ws(&r)
		return __jsonr_arr3_int(&r, ptr)
	} else {
		return json.unmarshal(data, ptr, allocator = allocator)
	}
}

@(private="file")
__jsonr_arr3_int :: proc(r: ^__Jsonr, x: ^$T) -> json.Unmarshal_Error #no_bounds_check {
	switch r.s[r.i] {
	case '[':
	case 'n':
		__mem.zero(x, size_of(T))
		r.i += 4
		return nil
	case:
		return __jsonr_delegate(r, x)
	}
	if __jsonr_len(r) > len(T) do return __jsonr_delegate(r, x)
	r.i += 1
	__jsonr_ws(r)
	for k := 0; r.s[r.i] != ']'; k += 1 {
		__jsonr_int(r, &x[k]) or_return
		__jsonr_ws(r)
		if r.s[r.i] == ',' {
			r.i += 1
			__jsonr_ws(r)
		}
	}
	r.i += 1
	return nil
}

// json.unmarshal into [dynamic]Point, read directly: strict JSON here, anything else through encoding/json
@(private="file")
__json_unmarshal_dyn_main_Point :: proc(data: []byte, ptr: ^$T, allocator := context.allocator) -> json.Unmarshal_Error {
	when T == [dynamic]Point {
		r: __Jsonr = ---
		r.s = string(data)
		r.i = 0
		r.allocator = allocator
		if !__jsonr_valid(&r) do return json.unmarshal(data, ptr, allocator = allocator)
		__jsonr_ws(&r)
		return __jsonr_dyn_main_Point(&r, ptr)
	} else {
		return json.unmarshal(data, ptr, allocator = allocator)
	}
}

// json.unmarshal into [][]int, read directly: strict JSON here, anything else through encoding/json
@(private="file")
__json_unmarshal_sl_sl_int :: proc(data: []byte, ptr: ^$T, allocator := context.allocator) -> json.Unmarshal_Error {
	when T == [][]int {
		r: __Jsonr = ---
		r.s = string(data)
		r.i = 0
		r.allocator = allocator
		if !__jsonr_valid(&r) do return json.unmarshal(data, ptr, allocator = allocator)
		__jsonr_ws(&r)
		return __jsonr_sl_sl_int(&r, ptr)
	} else {
		return json.unmarshal(data, ptr, allocator = allocator)
	}
}

@(private="file")
__jsonr_sl_sl_int :: proc(r: ^__Jsonr, x: ^$T) -> json.Unmarshal_Error #no_bounds_check {
	switch r.s[r.i] {
	case '[':
	case 'n':
		__mem.zero(x, size_of(T))
		r.i += 4
		return nil
	case:
		return __jsonr_delegate(r, x)
	}
	if err := __jsonr_make(r, x, __jsonr_len(r)); err != nil do return err
	r.i += 1
	__jsonr_ws(r)
	for k := 0; r.s[r.i] != ']'; k += 1 {
		__jsonr_sl_int(r, &x[k]) or_return
		__jsonr_ws(r)
		if r.s[r.i] == ',' {
			r.i += 1
			__jsonr_ws(r)
		}
	}
	r.i += 1
	return nil
}

// json.unmarshal into string, read directly: strict JSON here, anything else through encoding/json
@(private="file")
__json_unmarshal_string :: proc(data: []byte, ptr: ^$T, allocator := context.allocator) -> json.Unmarshal_Error {
	when T == string {
		r: __Jsonr = ---
		r.s = string(data)
		r.i = 0
		r.allocator = allocator
		if !__jsonr_valid(&r) do return json.unmarshal(data, ptr, allocator = allocator)
		__jsonr_ws(&r)
		return __jsonr_str(&r, ptr)
	} else {
		return json.unmarshal(data, ptr, allocator = allocator)
	}
}

// json.unmarshal into f64, read directly: strict JSON here, anything else through encoding/json
@(private="file")
__json_unmarshal_f64 :: proc(data: []byte, ptr: ^$T, allocator := context.allocator) -> json.Unmarshal_Error {
	when T == f64 {
		r: __Jsonr = ---
		r.s = string(data)
		r.i = 0
		r.allocator = allocator
		if !__jsonr_valid(&r) do return json.unmarshal(data, ptr, allocator = allocator)
		__jsonr_ws(&r)
		return __jsonr_float(&r, ptr)
	} else {
		return json.unmarshal(data, ptr, allocator = allocator)
	}
}

// json.unmarshal into bool, read directly: strict JSON here, anything else through encoding/json
@(private="file")
__json_unmarshal_bool :: proc(data: []byte, ptr: ^$T, allocator := context.allocator) -> json.Unmarshal_Error {
	when T == bool {
		r: __Jsonr = ---
		r.s = string(data)
		r.i = 0
		r.allocator = allocator
		if !__jsonr_valid(&r) do return json.unmarshal(data, ptr, allocator = allocator)
		__jsonr_ws(&r)
		return __jsonr_bool(&r, ptr)
	} else {
		return json.unmarshal(data, ptr, allocator = allocator)
	}
}

// json.unmarshal into i32, read directly: strict JSON here, anything else through encoding/json
@(private="file")
__json_unmarshal_i32 :: proc(data: []byte, ptr: ^$T, allocator := context.allocator) -> json.Unmarshal_Error {
	when T == i32 {
		r: __Jsonr = ---
		r.s = string(data)
		r.i = 0
		r.allocator = allocator
		if !__jsonr_valid(&r) do return json.unmarshal(data, ptr, allocator = allocator)
		__jsonr_ws(&r)
		return __jsonr_int(&r, ptr)
	} else {
		return json.unmarshal(data, ptr, allocator = allocator)
	}
}
