# Closure Types

Every closure has a type, written like a procedure type with `closure` in place of `proc`:

```vidar,ignore
closure(params) -> results
```

`closure(int) -> int` is the type of every closure that takes an `int` and returns an `int`, whatever it captured. Closure types work anywhere a type does: in variables, parameters, results, struct fields, arrays, maps, and type aliases.

```vidar
Op :: closure(a, b: int) -> (int, bool)        // an alias, with two results

Button :: struct {
	label:    string,
	on_click: closure(int) -> string,
}

apply :: proc(f: closure(int) -> int, xs: []int) -> (out: [3]int) {
	for x, i in xs do out[i] = f(x)
	return
}

main :: proc() {
	safe_div: Op = proc[](a, b: int) -> (int, bool) {
		if b == 0 do return 0, false
		return a / b, true
	}
	q, ok := safe_div(7, 2)
	fmt.println(q, ok)

	prefix := "clicked"
	b := Button{"ok", proc[prefix](n: int) -> string { return fmt.tprintf("%s %d", prefix, n) }}
	fmt.println(b.on_click(7))

	double := proc[](x: int) -> int { return x * 2 }
	fmt.println(apply(double, {1, 2, 3}))
}
```

<span class="caption">Listing 4-9: Closure types in an alias, a struct field and a parameter</span>

```output
3 true
clicked 7
[2, 4, 6]
```

## Calling a Closure

A closure is called like a procedure: `f(x)`, `b.on_click(7)`, and even `make_adder(1)(2)` on the closure a call returns. Arguments are passed by position; naming them (`f(a = 1)`) isn't supported for closures.

## Passing a Plain Procedure

A closure type only accepts closures. A plain procedure doesn't convert to one, since it has a different layout, so to pass one where a closure is expected, wrap it in a closure with no captures:

```vidar
square :: proc(x: int) -> int { return x * x }

apply_twice :: proc(f: closure(int) -> int, x: int) -> int { return f(f(x)) }

main :: proc() {
	fmt.println(apply_twice(proc[](x: int) -> int { return square(x) }, 3))
}
```

```output
81
```

Passing `square` itself is an error from Odin, which reports that a `proc(int) -> int` can't be assigned to a `Closure`. With [`-opt`](ch15-06-closures-and-interfaces.md), the wrapper costs nothing: the call is made directly.

## How Big a Closure Is

A closure value is a struct holding the procedure and a buffer for its captures. The buffer is the same size for every closure, 128 bytes by default, so a closure value is 136 bytes on a 64-bit target and every closure type has the same layout. That is what lets a closure be stored, copied and returned without allocating.

Captures that don't fit in the buffer are a compile error that names the closure. You have two ways out:

- capture a pointer to the large value instead of a copy of it;
- build with `-define:VIDAR_CLOSURE_ENV=<bytes>` to give every closure more room. That makes every closure value bigger, so arrays and channels of closures grow too.

## What a Closure Becomes

In the generated Odin, a closure value is `Closure(proc(Env, A...) -> R)`: a struct with the procedure in `call` and the captures in `env`. A closure literal becomes a call to a generated constructor, `__closure_N(captures...)`, written at the end of the file with the body inside it. A call `f(x)` becomes `f.call(f.env, x)`. [Appendix G](appendix-07-lowering.md#closures) shows the full output for a small program.

With [`-opt`](ch15-06-closures-and-interfaces.md), a closure literal passed straight to a procedure goes further: Vidar makes a copy of the procedure that calls the closure's body directly, so LLVM can inline it, as Rust does with closures.

## Summary

- `closure(params) -> results` is a closure's type, and works anywhere a type does.
- Closures are called like procedures, with positional arguments.
- A plain procedure is passed as a closure by wrapping it: `proc[](x: int) -> int { return f(x) }`.
- A closure is 136 bytes by default, with 128 for captures; `-define:VIDAR_CLOSURE_ENV` changes the room.
