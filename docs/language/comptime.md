# Comptime procs (typed macros)

A comptime proc is declared with a `!` after `proc`, `name :: proc!(...)`, runs inside the transpiler and is invoked with `name!(...)`. It never reaches the generated Odin; only its result does.

```odin
square :: proc!(x: Expr(i32)) -> Expr(i32) {
	return quote($x * $x)
}

swap :: proc!(a, b: Expr) -> Stmt {
	return quote {
		tmp := $a          // hygienic: renamed, so it cannot clash with the caller's `tmp`
		$a = $b
		$b = tmp
	}
}

fib :: proc!(n: int) -> int {
	return n if n < 2 else fib(n - 1) + fib(n - 2)
}

main :: proc() {
	k: i32 = 7
	fmt.println(square!(k + 1), fib!(20))    // ((k + 1) * (k + 1)), 6765
	a, b := 1, 2
	swap!(a, b)
}
```

**Parameter kinds:**

| Parameter type | Argument |
|---|---|
| `Expr(T)` | an expression that must have type `T` |
| `Expr` | any expression |
| `Stmt` | a `{ ... }` block or statements |
| `Type` | a type: `f64`, `[]int`, `geo.Vec2` |
| `Ident` | a bare name, spliced unhygienically (for declaring things) |
| `int`, `string`, `bool`, … | a compile-time constant; it is evaluated |

**Return kinds:** `Expr` / `Expr(T)` can be used anywhere an expression can. `Stmt` works only as a statement. Constant types fold to a literal. A macro with no result runs only for its side effects, such as `compile_error`.

**Typed checking.** `Expr(T)` arguments and results are checked by vidar when it can infer the types (literals, annotated or inferred locals, struct fields, proc results). When it can't, vidar emits a dead-code assignment (`if false { _: T = arg }`), so Odin performs the check instead.

**Quoting.** `quote(expr)` and `quote { stmts }` build code.

- `$name` splices a comptime value: code, a number, a string, an `Ident`, or a `[dynamic]Stmt` (inserts every statement).
- `$(expr)` splices the result of a comptime expression.
- `$$` emits a literal `$`, for generating polymorphic procs.
- Names a quote declares are renamed (hygiene). Spliced code is never renamed.

Macros from other packages are called as `pkg.name!(...)`.

- **Trailing block:** a macro whose last parameter is a `Stmt` can take it as a block after the call, `name!(args) { ... }`, or `name! { ... }` when there are no other arguments, so it reads like a built-in statement.
- **Defaults:** parameters can have default values, `allocator: Expr = context.allocator`. For `Expr`, `Stmt` and `Type` parameters the default is code; otherwise it's a compile-time value.
- **Generated code:** an expansion is written out as ordinary Odin, one statement per line, under a comment naming the call and where it is. The comptime proc itself becomes a one-line comment. Odin errors and panics in an expansion are reported at the call, or at the line of code passed into it.

```odin
// swap :: proc!(a, b: Expr) -> Stmt — comptime, main.vidar:5
...
	a, b := 1, 2
	// swap!(a, b) — main.vidar:22
	tmp__1 := a
	a = b
	b = tmp__1
```

**Comptime body language:** a subset of Odin. You get `:=`, `if`/`else`, `for` (C-style, ranges, `for x, i in arr`), `switch`, `[dynamic]` arrays with `append`, `len`, string `+`, and calls to other comptime procs or regular procs. A comptime body already runs at compile time, so calls in it need no `!` (`fib(n - 1)`); a `!` is allowed too, and on a macro that returns code it expands the macro and evaluates the code. Integers have the width of their type and wrap around as they do at run time; untyped constants are unbounded.

Builtins:
- `type_name(T)` and `type_fields(T)`: name and field list of a type
- `type_of_expr(e)`: type of an expression argument
- `stringify(x)`: source text of a code value
- `ident(str)`: make a name from a string
- `compile_error(...)`: stop compilation with a message
- `fmt.tprintf`, `fmt.println` (prints to the compiler's stderr)

See [examples/macros](../../examples/macros), which includes a struct printer built with `type_fields`.

## Compile-time evaluation

`name!(args)` on any proc runs it at compile time and replaces the call with its result, with the same interpreter that runs macro bodies. For a comptime proc that's its normal invocation; a regular proc is called the same way when every argument is a constant. `comptime! { ... }` runs a whole block at compile time: every call in it behaves as if it had a `!`.

```odin
a := fib!(20)                                // a := 6765
area := square!(N)                           // a regular proc, run by the transpiler
label := fmt.tprintf!("v%d", VERSION)        // label := "v3"
primes: [5]int = first_primes!(5)            // primes: [5]int = { 2, 3, 5, 7, 11 }
mask := comptime! { (1 << 10) - 1 }          // mask := 1023
total := comptime! {                         // total := 55
	sum := 0
	for i in 1..=10 do sum += i
	take sum
}
d := square!(k)                              // error: 'k' is a runtime value
```

- Numbers, strings and booleans fold to literals; an integer of a sized type keeps it, e.g. `i32(1410065408)`. Arrays and structs fold to untyped compound literals, so the target needs a known type.
- `comptime! { expr }` folds a single expression; with statements, `take value` gives the block its value. Macros used inside it (`do!`, your own) fold as well.
- As a statement, `name!(...)` runs for its effects only, e.g. `static_assert!(N > 0, "N must be positive")`.
- If something cannot be evaluated at compile time (it reads a variable, calls a foreign proc, uses an unsupported statement, or a macro whose code needs the runtime), compilation fails.
- `compile_error`, out-of-bounds indexes and the step limit also stop compilation.

See [examples/comptime](../../examples/comptime): lookup tables, struct configs, static assertions and `comptime! { ... }` blocks.
