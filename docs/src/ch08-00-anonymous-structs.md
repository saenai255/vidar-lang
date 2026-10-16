# Anonymous Struct Literals

Some values are a bundle of a few fields that belong together for a while: the totals a loop collects, the options passed to one call, a summary that gets printed once. Declaring a named struct type for each of them is noise. Odin lets you write an anonymous struct *type*, but its literal still needs the type spelled out in front of the braces.

In Vidar, a struct literal with no type in front, declared with `:=`, makes its type on the spot. Each field's type comes from its value:

```vidar
main :: proc() {
	hero := { name = "slime", hp = 10, pos = { x = 1.5, y = 2 } }
	hero.hp -= 3
	hero.pos.x += 1
	fmt.println(hero)
	fmt.printfln("%T", hero)
}
```

<span class="caption">Listing 8-1: A struct literal whose type is inferred</span>

```output
{name = "slime", hp = 7, pos = {x = 2.5, y = 2}}
struct {name: string, hp: int, pos: struct {x: f64, y: int}}
```

Untyped constants take their default types: integers are `int`, floats `f64`, text `string`, characters `rune`. Nested literals become nested struct types. A field can hold anything, closures included:

```vidar
main :: proc() {
	total := 0
	counter := {
		label = "clicks",
		bump  = proc[&total](n: int) { total += n },
	}
	counter.bump(2)
	counter.bump(3)
	fmt.println(counter.label, total)
}
```

```output
clicks 5
```

## It's an Ordinary Odin Type

The type Vidar makes is an Odin anonymous struct, `struct { name: string, hp: int, ... }`. Odin treats anonymous structs with the same fields, in the same order, as the same type, so two literals with matching fields are interchangeable, and a literal can be passed where a written-out `struct { ... }` is expected:

```vidar
print_range :: proc(r: struct { lo: int, hi: int }) {
	fmt.printfln("range %d..%d", r.lo, r.hi)
}

main :: proc() {
	bounds := { lo = 0, hi = 10 }
	clamped := { lo = 2, hi = 8 }
	bounds = clamped                 // the same type
	print_range(bounds)
}
```

<span class="caption">Listing 8-2: Anonymous structs with the same fields are the same type</span>

```output
range 2..8
```

## Where It Applies

Only in places where Odin has no type for `{ ... }`:

| Position | Example |
|---|---|
| the right-hand side of a `:=` declaration: in a procedure, at file scope, or in an `if`, `for` or `switch` initializer | `hero := { name = "a" }` |
| an argument whose parameter type is inferred: `$T`, `any`, `..any`, and the values passed to `fmt`'s print procedures | `fmt.println({ x = 1, y = 2 })` |

```vidar
describe :: proc(x: $T) { fmt.printfln("%v", x) }

main :: proc() {
	fmt.println({ x = 1, y = 2 })
	describe({ name = "a", n = 3 })
	if p := { hp = 10 }; p.hp > 0 do fmt.println("alive")
}
```

```output
{x = 1, y = 2}
{name = "a", n = 3}
alive
```

Everywhere else, `{ ... }` keeps its Odin meaning: with an expected type, as in `p: Point = { x = 1 }`, a typed parameter, a `return` or an assignment, the braces build a value of that type.

## Every Field Needs a Name and a Type

Since the type comes from the fields, each element needs a name, and a value whose type can be worked out. A positional element, `nil`, `---`, or an untyped positional literal such as `{ 1, 2 }` doesn't say what type the field should have:

```vidar,compile_fail
main :: proc() {
	a := { pos = { 1, 2 } }
	_ = a
}
```

```error
error: the type of field 'pos' cannot be inferred; write the literal's type
```

Write the type of that value, `pos = Point{1, 2}`, or name its fields too, `pos = { x = 1, y = 2 }`.

## Evaluation Order

Values are evaluated once, left to right, before the struct is built, just as in a typed literal. In the generated Odin, each value goes into a temporary on the same line, and the struct type is written with `type_of` on those temporaries, so Odin infers each field's type itself. [Appendix G](appendix-07-lowering.md#anonymous-struct-literals) shows the output.

## Summary

- `x := { name = value, ... }` declares `x` with a struct type made from its fields.
- It applies only where Odin has no type for the braces: `:=` declarations and inferred parameters.
- The type is an ordinary Odin anonymous struct, identical to any other with the same fields.
