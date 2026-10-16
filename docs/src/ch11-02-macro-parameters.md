# Macro Parameters and Reflection

A macro's parameters say what kind of argument it takes. Some kinds are code, which the macro splices; others are values, which it computes with.

| Parameter type | Argument |
|---|---|
| `Expr` | any expression |
| `Expr(T)` | an expression that must have type `T` |
| `Stmt` | a `{ ... }` block, or statements |
| `Type` | a type: `f64`, `[]int`, `geo.Vec2` |
| `Ident` | a bare name, spliced as written |
| `[]Ident` | a list of names in braces, `{a, &b}`, each optionally with `&` |
| `int`, `string`, `bool`, ... | a compile-time constant, which is evaluated |

Results work the same way: an `Expr` or `Expr(T)` result can be used anywhere an expression can, a `Stmt` result only as a statement, a constant type folds to a literal, and a macro with no result runs only for its effects, such as stopping compilation with an error.

## Typed Expressions

`Expr(T)` asks for an expression of type `T`. Vidar checks it where it can infer the argument's type: literals, locals, struct fields, results of your procedures. Where it can't, it emits a check that Odin performs instead (a dead `if false { _: T = arg }`), so a mismatch is always an error:

```vidar
double :: proc!(x: Expr(f64)) -> Expr(f64) {
	return quote($x * 2)
}

main :: proc() {
	r := 1.25
	fmt.println(double!(r))
}
```

```output
2.5
```

## Constant Parameters

A parameter with an ordinary type, like `n: int`, takes a compile-time constant: a literal, a constant, or an expression of them. The macro gets its value. Passing a run-time value is an error:

```vidar,compile_fail
twice :: proc!(n: int) -> int { return n * 2 }

main :: proc() {
	n := 3
	_ = twice!(n)
}
```

```error
error: argument 'n' of 'twice!' must be a compile-time constant: 'n' is a runtime value and is not available at compile time
```

## Defaults

Parameters can have defaults. For `Expr`, `Stmt`, `Type` and `[]Ident` parameters, the default is code; for the others, a value:

```vidar,ignore
scoped :: proc!(allocator: Expr = context.allocator, body: Stmt) -> Stmt { ... }
repeat :: proc!(n: int = 2, body: Stmt) -> Stmt { ... }
```

## `Type`: Macros That Take Types

A `Type` parameter takes a type, which the macro can splice and inspect. `type_name(T)` is its spelling, and `type_fields(T)` the names of a struct's fields. Together they can write a printer for any struct:

```vidar
show :: proc!(T: Type, value: Expr) -> Expr(string) {
	layout := type_name(T) + "{{"
	args: [dynamic]Expr
	for f, i in type_fields(T) {
		layout += fmt.tprintf("%s%s = %%v", "" if i == 0 else ", ", f)
		append(&args, quote($value.$(ident(f))))
	}
	layout += "}}"
	return quote(fmt.tprintf($layout, $args))
}

Point :: struct { x, y: i32 }

main :: proc() {
	p := Point{3, -4}
	fmt.println(show!(Point, p))
}
```

<span class="caption">Listing 11-4: A struct printer built with reflection</span>

```output
Point{x = 3, y = -4}
```

`ident(f)` turns the field name, a string, into a name that can be spliced: `$value.$(ident(f))` becomes `p.x`. A `[dynamic]Expr` spliced into an argument list, as `$args` is here, becomes one argument per element. The format string is built at compile time, so the generated code is a single `fmt.tprintf("Point{x = %v, y = %v}", p.x, p.y)`.

`type_of_expr(e)` gives the type of an expression argument, so the caller doesn't have to spell it:

```vidar
zero_like :: proc!(x: Expr) -> Expr {
	T := type_of_expr(x)
	return quote($T{})
}

Point :: struct { x, y: i32 }

main :: proc() {
	p := Point{3, -4}
	fmt.println(zero_like!(p))
}
```

```output
Point{x = 0, y = 0}
```

It knows the types of literals, locals, struct fields, indexing, your procedures' results, and calls into `core:`, `base:` and `vendor:` packages, which it reads from your Odin installation. For a type that comes from another package, it gives the name qualified with your import, such as `strings.Builder`. It can't know a polymorphic result (`$T`), or a type from a package your file doesn't import; those stop compilation with "not known at compile time".

## `Ident`: Names the Caller Chooses

An `Ident` parameter takes a bare name, and splices it without hygiene, so a macro can declare a variable the caller can use:

```vidar
define_twice :: proc!(name: Ident, value: int) -> Stmt {
	return quote { $name := $value * 2 }
}

main :: proc() {
	define_twice!(answer, 21)
	fmt.println(answer)
}
```

```output
42
```

`[]Ident` takes a list of names in braces, each optionally with `&`, and splices as `a, &b`: the shape of a closure's capture list. In the macro's code it's an array, so `len` and `for` work on it:

```vidar
fn :: proc!(captures: []Ident, body: Stmt) -> Expr {
	return quote(proc[$captures]() { $body })
}

main :: proc() {
	a, b := 1, 2
	bump := fn!({a, &b}) { b += a }
	bump()
	fmt.println(b)
}
```

```output
3
```

## Looking at Code

A few more helpers inspect the code a macro receives:

- `stringify(x)` is the source text of a code argument, as written: handy for messages.
- `is_literal(e)` says whether an expression is a literal.
- `split_comparison(e)` splits `a == b` into its operands and operator, and `split_range(e)` splits `lo..<hi`.
- `once(e)` evaluates an argument once, into a temporary, so it can be spliced several times without running twice.
- `call_site()` is the `file:line` of the call being expanded.
- `parse_expr(text)` parses a string as an expression.

```vidar
expect :: proc!(cond: Expr(bool)) -> Stmt {
	msg := "expectation failed: " + stringify(cond)
	return quote {
		if !$cond { fmt.println($msg) }
	}
}

main :: proc() {
	total := 42
	expect!(total == 42)
	expect!(total < 0)
}
```

```output
expectation failed: total < 0
```

## Rejecting Bad Input

`compile_error(...)` stops compilation with a message, for arguments the macro can't handle. The error names the macro call it came from:

```vidar,compile_fail
make_scaler :: proc!(T: Type, k: Expr) -> Expr {
	if type_name(T) == "string" do compile_error("make_scaler: cannot scale a string")
	return quote(proc[](x: $T) -> $T { return x * $k })
}

main :: proc() {
	triple := make_scaler!(f64, 3)
	fmt.println(triple(1.5))
	bad := make_scaler!(string, 2)
}
```

```error
error: in expansion of 'make_scaler!': make_scaler: cannot scale a string
```

## The Language of a Macro's Body

A macro's body runs in Vidar's compile-time interpreter, which understands a subset of Odin:

- `:=` declarations, assignment, `if`/`else` and `switch`;
- `for` loops: C-style, over ranges, and `for x, i in arr`;
- `[dynamic]` arrays with `append` and `len`, and string concatenation with `+`;
- calls to other macros and to ordinary procedures, and `fmt.tprintf` (`fmt.println` prints to the compiler's stderr).

Integers have the width of their type and wrap around as they do at run time; untyped constants are unbounded. A body that loops too long stops at a step limit with an error. The [comptime reference](reference-05-comptime.md) lists every helper with an example.
