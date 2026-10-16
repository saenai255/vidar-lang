# Formatting, Printing and JSON

`core:fmt` and `core:encoding/json` work on any value through run-time type information: they parse the format string, box each argument in an `any`, and walk the type's description field by field. That's flexible, and slow in a hot loop. Vidar knows the types at compile time, so `-opt` writes the specific code instead.

## `fmt` Calls with a Literal Format

`fmt.printf`, `fmt.println`, `fmt.sbprintf`, `fmt.tprintf` and the rest, with a format string literal, compile to a procedure that writes each piece directly: no format parsing, no `any` boxing, no type switch. `%v %d %s %x %t %c` on basic types are written directly; other verbs and flags still go through `fmt`, one argument at a time. A format Vidar can't read (`*` widths, explicit argument indexes) is left alone.

## Generated Printers

`%v` and `%#v`, and `print` and `println`, of a type Vidar can see all the way down, are written by generated `__print_T` procedures instead of `fmt`'s walk over type info. That covers structs, enums, fixed arrays, slices and dynamic arrays made of plain structs, enums without explicit values, strings, booleans, runes, integers and floats.

The output is `fmt`'s, byte for byte, and so is the count `fmt` returns. A `when` on the argument's type keeps `fmt` for anything Vidar guessed wrong, and a program that registers its own `fmt` formatters keeps `fmt` everywhere.

## JSON

`json.marshal(x)` with the default options calls a generated writer for types the printers accept, producing `encoding/json`'s exact bytes, `json:"name"`, `json:"-"` and `omitempty` tags included.

`json.unmarshal(data, &x)` and `json.unmarshal_string` call a generated reader, for structs with tags and fields of any type:

```vidar,opt
Item :: struct {
	name:  string,
	count: int `json:"qty"`,
	tags:  []string,
}

main :: proc() {
	items: []Item
	err := json.unmarshal_string(`[{"name": "apple", "qty": 3, "tags": ["red"]}, {"name": "pear", "qty": 1}]`, &items)
	fmt.println(err, len(items), items[0].name, items[0].count, items[1].tags)
	out, _ := json.marshal(items[1])
	fmt.println(string(out))
}
```

<span class="caption">Listing 15-3: JSON in and out, through generated code under `-opt`</span>

```output
nil 2 apple 3 []
{"name":"pear","qty":1,"tags":[]}
```

The reader first checks that the input is strict JSON (RFC 8259 syntax, valid UTF-8, at most 256 levels deep). Anything else goes to `json.unmarshal` untouched, so its errors and its JSON5 extensions stay `encoding/json`'s. Strict JSON is read with `encoding/json`'s rules, and a value the reader doesn't handle itself, such as a map field, goes to `json.unmarshal` on its own bytes. The one difference is that object keys aren't allocated, so an allocator that's nearly out of memory can fail later than it would.

Neither is used in a program that registers its own marshalers or unmarshalers.
