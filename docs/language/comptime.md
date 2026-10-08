# Comptime procs (typed macros)

A comptime proc is declared with a `!` after `proc`, `name :: proc!(...)`, runs inside the transpiler, and is invoked with `name!(...)`. It never reaches the generated Odin; only its result does.

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

## Parameters

| Parameter type | Argument |
|---|---|
| `Expr(T)` | an expression that must have type `T` |
| `Expr` | any expression |
| `Stmt` | a `{ ... }` block or statements |
| `Type` | a type: `f64`, `[]int`, `geo.Vec2` |
| `Ident` | a bare name, spliced unhygienically (for declaring things) |
| `int`, `string`, `bool`, … | a compile-time constant; it is evaluated |

**Defaults.** Parameters can have default values, `allocator: Expr = context.allocator`. For `Expr`, `Stmt` and `Type` parameters the default is code; otherwise it's a compile-time value.

## Results

- `Expr` / `Expr(T)` can be used anywhere an expression can.
- `Stmt` works only as a statement.
- Constant types fold to a literal.
- A macro with no result runs only for its side effects, such as `compile_error`.

**Typed checking.** `Expr(T)` arguments and results are checked by vidar when it can infer the types (literals, annotated or inferred locals, struct fields, proc results). When it can't, vidar emits a dead-code assignment (`if false { _: T = arg }`), so Odin performs the check instead.

## Quoting

`quote(expr)` and `quote { stmts }` build code. Inside a quote:

| Syntax | Meaning |
|---|---|
| `$name` | splices a comptime value: code, a number, a string, an `Ident`, or a `[dynamic]Stmt` (inserts every statement) |
| `$(expr)` | splices the result of a comptime expression |
| `$$` | emits a literal `$`, for generating polymorphic procs |

**Hygiene.** Names a quote declares are renamed, so they can't clash with the caller's. Spliced code is never renamed.

## More macros

These are from [examples/macros](../../examples/macros), which prints the output shown in the comments.

**`stringify`** gives the source text of a code argument:

```odin
expect :: proc!(cond: Expr(bool)) -> Stmt {
	msg := "expectation failed: " + stringify(cond)
	return quote {
		if !$cond { fmt.println($msg) }
	}
}

expect!(total < 0)                   // expectation failed: total < 0
```

**`Type` parameters and reflection:** a printer for any struct.

```odin
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

p := Point{3, -4}
fmt.println(show!(Point, p))         // Point{x = 3, y = -4}
```

**`type_of_expr`** gives the type of an argument, so the caller doesn't have to spell it:

```odin
zero_like :: proc!(x: Expr) -> Expr {
	T := type_of_expr(x)
	return quote($T{})
}

fmt.println(zero_like!(p))           // Point{x = 0, y = 0}
```

**`Ident` parameters** splice unhygienically, so a macro can declare names on purpose:

```odin
define_twice :: proc!(name: Ident, value: int) -> Stmt {
	return quote { $name := $value * 2 }
}

define_twice!(answer, 21)
fmt.println(answer)                  // 42
```

**Defaults and a trailing block:**

```odin
repeat :: proc!(n: int = 2, body: Stmt) -> Stmt {
	out: [dynamic]Stmt
	for _ in 0..<n do append(&out, body)
	return quote { $out }
}

repeat!(4) { total += 10 }           // the block follows the call
repeat! { total += 1 }               // n defaults to 2
```

**Generating a closure, and rejecting bad input with `compile_error`:**

```odin
make_scaler :: proc!(T: Type, k: Expr) -> Expr {
	if type_name(T) == "string" do compile_error("make_scaler: cannot scale a string")
	return quote(proc[](x: $T) -> $T { return x * $k })
}

triple := make_scaler!(f64, 3)
fmt.println(triple(1.5))             // 4.5
```

## Calling macros

- **From other packages:** `pkg.name!(...)`.
- **Trailing block.** A macro whose last parameter is a `Stmt` can take it as a block after the call, `name!(args) { ... }`, or `name! { ... }` when there are no other arguments, so it reads like a built-in statement.

## The generated code

An expansion is written out as ordinary Odin, one statement per line, under a comment naming the call and where it is. The comptime proc itself becomes a one-line comment. Odin errors and panics in an expansion are reported at the call, or at the line of code passed into it.

```odin
// swap :: proc!(a, b: Expr) -> Stmt — comptime, main.vidar:5
...
	a, b := 1, 2
	// swap!(a, b) — main.vidar:22
	tmp__1 := a
	a = b
	b = tmp__1
```

## The body language

A comptime body is a subset of Odin:

- `:=`, `if` / `else`, `switch`
- `for`: C-style, ranges, `for x, i in arr`
- `[dynamic]` arrays with `append`, and `len`
- string `+`
- calls to other comptime procs or regular procs

A comptime body already runs at compile time, so calls in it need no `!` (`fib(n - 1)`). A `!` is allowed too, and on a macro that returns code it expands the macro and evaluates the code.

Integers have the width of their type and wrap around as they do at run time. Untyped constants are unbounded.

### Built-ins

| Built-in | What it gives |
|---|---|
| `type_name(T)` | name of a type |
| `type_fields(T)` | field list of a type |
| `type_of_expr(e)` | type of an expression argument |
| `stringify(x)` | source text of a code value |
| `ident(str)` | make a name from a string |
| `compile_error(...)` | stop compilation with a message |
| `fmt.tprintf`, `fmt.println` | formatting; `println` prints to the compiler's stderr |

The full list with signatures is in the [comptime reference](../reference/comptime.md).

See [examples/macros](../../examples/macros), which includes a struct printer built with `type_fields`.

## Compile-time evaluation

`name!(args)` on **any** proc runs it at compile time and replaces the call with its result, using the same interpreter that runs macro bodies.

- For a comptime proc that's its normal invocation.
- A regular proc is called the same way when every argument is a constant.
- `comptime! { ... }` runs a whole block at compile time: every call in it behaves as if it had a `!`.

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

**What folds to what:**

- Numbers, strings and booleans fold to literals. An integer of a sized type keeps it, e.g. `i32(1410065408)`.
- Arrays and structs fold to untyped compound literals, so the target needs a known type.

**`comptime!` blocks:**

- `comptime! { expr }` folds a single expression. With statements, `take value` gives the block its value.
- Macros used inside it (`do!`, your own) fold as well.
- As a statement, `name!(...)` runs for its effects only, e.g. `static_assert!(N > 0, "N must be positive")`.

**What stops compilation:**

- something that cannot be evaluated at compile time: it reads a variable, calls a foreign proc, uses an unsupported statement, or is a macro whose code needs the runtime;
- `compile_error`;
- out-of-bounds indexes;
- the step limit.

See [examples/comptime](../../examples/comptime): lookup tables, struct configs, static assertions and `comptime! { ... }` blocks.
