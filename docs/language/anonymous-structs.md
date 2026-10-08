# Anonymous struct literals

A `{ name = value, ... }` literal with no type, declared with `:=`, makes its struct type on the spot. Field types are inferred from the values:

```odin
hero := { name = "slime", hp = 10, pos = { x = 1.5, y = 2 } }   // struct { name: string, hp: int, pos: struct { x: f64, y: int } }
hero.pos.x += 1
take :: proc(h: struct { name: string, hp: int, pos: struct { x: f64, y: int } }) { ... }
take(hero)
```

- Only the places Odin has no type for `{ ... }` are affected: the right-hand side of a `:=` declaration (inside a procedure, at file scope, or in an `if`/`for`/`switch` initializer), and an argument whose parameter type is inferred (`$T`, `any`, `..any`, and the values of `fmt`'s print procs): `fmt.println({ x = 1, y = 2 })`, `describe({ name = "a" })`. With an expected type (`p: Point = { x = 1 }`, a typed parameter, `return`), `{ ... }` keeps Odin's meaning. A callee vidar can't see (a `core:` proc other than `fmt`'s) counts as typed.
- Every element needs a name. A field can't be inferred from `nil`, `---` or an untyped positional `{ 1, 2 }`.
- The type is a plain Odin anonymous struct, and Odin treats anonymous structs with the same fields as the same type, so two such literals, or a literal and a written-out `struct { ... }`, are interchangeable.
- vidar knows the field types, so closure fields can be called (`cfg.on_click(x)`) and the language server completes and hovers the fields.
- **Lowering:** in a procedure's `:=` declaration, each value is evaluated once into a temp on its own source line, then `hero := struct { name: type_of(__anon1_name), ... }{name = __anon1_name, ...}`, so Odin infers every field type itself. Elsewhere there is no room for temps, so the literal is one expression: `struct { name: type_of(__anon_typed("slime")), ... }{name = "slime", ...}`. The copy inside `type_of` is never run, and `__anon_typed` (a file-private `proc(x: $T) -> T`) gives untyped constants their default types; a proc or closure value's type is written from its signature. Initializers wrap it in parentheses, where Odin would read the braces as a block.
