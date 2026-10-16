# Running Code at Compile Time

A `!` after the name runs a procedure at compile time and replaces the call with its result. For a macro, that's how it's always called. But it works on **any** procedure whose arguments are constants:

```vidar
fib :: proc(n: int) -> int {
	return n if n < 2 else fib(n - 1) + fib(n - 2)
}

main :: proc() {
	a := fib!(25)          // computed while compiling: a := 75025
	b := fib(25)           // computed when the program runs
	fmt.println(a, b)
}
```

<span class="caption">Listing 11-5: The same procedure, at compile time and at run time</span>

```output
75025 75025
```

In the generated Odin, the first line is `a := 75025`. Inside a procedure that runs at compile time, calls need no `!`: they're all at compile time already.

## What Folds to What

- Numbers, strings and booleans fold to literals. An integer of a sized type keeps it: `i32(1410065408)`.
- Arrays and structs fold to untyped compound literals, so the variable needs a type:

```vidar
first_primes :: proc(n: int) -> [dynamic]int {
	out: [dynamic]int
	for i := 2; len(out) < n; i += 1 {
		prime := true
		for p in out do if i % p == 0 { prime = false; break }
		if prime do append(&out, i)
	}
	return out
}

Config :: struct { name: string, workers: int }

default_config :: proc(workers: int) -> Config {
	return {name = fmt.tprintf("pool-%d", workers), workers = workers}
}

main :: proc() {
	primes: [8]int = first_primes!(8)
	cfg: Config = default_config!(4)
	fmt.println(primes, cfg)
}
```

<span class="caption">Listing 11-6: A table and a struct built while compiling</span>

```output
[2, 3, 5, 7, 11, 13, 17, 19] Config{name = "pool-4", workers = 4}
```

The program contains only the literals. `first_primes` still exists as an ordinary procedure, callable at run time too; a procedure declared with `proc!` exists only at compile time.

## `comptime!` Blocks

`comptime! { ... }` runs a whole block at compile time, with no helper procedure. Every call in it behaves as if it had a `!`. A single expression folds to its value; with statements, `take value` gives the block its value:

```vidar
VERSION :: 3

main :: proc() {
	mask := comptime! { (1 << 10) - 1 }
	label := comptime! { fmt.tprintf("v%d", VERSION) }
	month_starts: [12]int = comptime! {
		days := [12]int{31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31}
		starts: [dynamic]int
		total := 0
		for d in days {
			append(&starts, total)
			total += d
		}
		take starts
	}
	fmt.println(mask, label, month_starts[11])
}
```

<span class="caption">Listing 11-7: Values computed by `comptime!` blocks</span>

```output
1023 v3 334
```

## Static Assertions

As a statement, `name!(...)` runs only for its effects. A procedure that calls `compile_error` makes a static assertion:

```vidar,compile_fail
TABLE_SIZE :: 12

static_assert :: proc!(ok: bool, msg: string) -> bool {
	if !ok do compile_error(msg)
	return true
}

main :: proc() {
	static_assert!(TABLE_SIZE & (TABLE_SIZE - 1) == 0, "TABLE_SIZE must be a power of two")
}
```

```error
error: in expansion of 'static_assert!': TABLE_SIZE must be a power of two
```

## What Stops Compilation

Compile-time code fails, with an error at the call, when it:

- needs something that only exists at run time: reads a variable, calls a `foreign` procedure, or uses a statement the interpreter doesn't support;
- calls `compile_error`;
- indexes out of bounds or divides by zero;
- runs past the step limit.

```vidar,compile_fail
square :: proc(x: int) -> int { return x * x }

main :: proc() {
	k := 3
	_ = square!(k)
}
```

```error
error: 'square!' cannot run at compile time: 'k' is a runtime value
```

## Summary

- `proc!` declares a macro: it takes code, returns code, and runs while compiling.
- `quote` builds code, `$` splices into it, and names a quote declares are hygienic.
- Parameters can be code (`Expr`, `Stmt`, `Type`, `Ident`) or constants; helpers like `type_fields` and `stringify` inspect them.
- `name!(args)` runs any procedure at compile time when its arguments are constants, and `comptime! { ... }` runs a block.

With [`-opt`](ch15-05-tables-and-specialization.md), Vidar uses the same interpreter on its own, to turn small pure procedures into lookup tables.
