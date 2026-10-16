# Capturing Values

A procedure literal with square brackets after `proc` is a closure, and the names in the brackets are its *captures*:

| Written | Meaning |
|---|---|
| `proc[x](...) { ... }` | captures a copy of `x` |
| `proc[&x](...) { ... }` | captures a pointer to `x` (next section) |
| `proc[x, &y, z](...) { ... }` | several captures, mixed |
| `proc[](...) { ... }` | a closure with no captures |
| `proc(...) { ... }` | no brackets: an ordinary Odin procedure, not a closure |

## A Capture Is a Copy

`proc[x]` copies `x` into the closure when the closure is created. Changing `x` afterwards doesn't change the closure's copy:

```vidar
main :: proc() {
	step := 5
	add_step := proc[step](x: int) -> int { return x + step }
	step = 100
	fmt.println(add_step(1))
}
```

<span class="caption">Listing 4-1: A by-value capture is taken when the closure is made</span>

```output
6
```

`add_step` copied `step` while it was 5, so it adds 5, even though `step` is 100 by the time it's called.

That makes loops behave the way you'd expect. Each closure made in a loop captures its own copy of the loop variable:

```vidar
main :: proc() {
	adders: [dynamic]closure(int) -> int
	defer delete(adders)
	for i in 0..<3 {
		append(&adders, proc[i](x: int) -> int { return x + i * 10 })
	}
	for f in adders do fmt.print(f(1), "")
	fmt.println()
}
```

<span class="caption">Listing 4-2: Each iteration's closure captures its own `i`</span>

```output
1 11 21
```

## By-Value Captures Are Read-Only

A closure's copy belongs to the closure, and each call works on a fresh copy of it. If a call could change a by-value capture, the change would be lost as soon as the call returned, which is almost certainly not what the code meant. So Vidar makes it an error:

```vidar,compile_fail
main :: proc() {
	n := 1
	counter := proc[n]() -> int { n += 1; return n }
	_ = counter
}
```

```error
error: 'n' is captured by value: each call gets a fresh copy, so a change would be lost. Capture &n, or a pointer, to change it
```

The message points at the fix: to change a variable, capture a pointer to it with `&n`, which the [next section](ch04-02-capturing-by-pointer.md) covers.

## Forgetting a Capture

A closure can only use the outer locals it captures. Using one that isn't in the list is an error, and so is using a local from an ordinary procedure literal, which has no capture list at all:

```vidar,compile_fail
main :: proc() {
	x := 1
	f := proc[]() -> int { return x }
	_ = f
}
```

```error
error: 'x' is a local of the enclosing procedure and is not captured
```

Both messages say how to fix it: add `x` to the capture list.

## What Doesn't Need Capturing

Only local *variables* are captured. Anything that isn't a value at run time is visible without one:

- globals and package-level constants and procedures;
- the enclosing procedure's local constants and local types;
- its polymorphic parameters, such as `$T` and `$N`.

```vidar
LIMIT :: 3

repeat :: proc(value: $T) -> closure() -> [LIMIT]T {
	Pair :: struct { a, b: T }      // a local type, using $T
	return proc[value]() -> (out: [LIMIT]T) {
		p := Pair{value, value}
		for &o in out do o = p.a
		return
	}
}

main :: proc() {
	make_three := repeat("hi")
	fmt.println(make_three())
}
```

<span class="caption">Listing 4-3: Constants, local types and `$T` need no capture</span>

```output
["hi", "hi", "hi"]
```

Listing a global or a constant in a capture list is an error, since there's nothing to copy:

```vidar,compile_fail
G := 1

main :: proc() {
	f := proc[G]() {}
	_ = f
}
```

```error
error: 'G' is not a local variable; closures can use globals and constants without capturing them
```

## Closures Inside Closures

A closure written inside another closure can capture what the outer one captured:

```vidar
main :: proc() {
	total := 0
	outer := proc[&total](n: int) {
		bump := proc[&total, n]() { total += n }   // captures the outer closure's captures
		bump()
		bump()
	}
	outer(3)
	outer(4)
	fmt.println(total)
}
```

<span class="caption">Listing 4-4: An inner closure capturing the outer one's captures</span>

```output
14
```

It can't reach past the closure it's in, though: a local of `main` that `outer` didn't capture is out of reach for `bump`. The compiler says to capture it in `outer` first.

## Summary

- `proc[x]` copies `x` into the closure when the closure is made, and each loop iteration's closure gets its own copy.
- A by-value capture is read-only.
- Only local variables are captured; constants, types, globals and `$T` are visible anyway.
- Forgetting a capture is a compile error that names the variable.

To change a variable from inside a closure, capture a pointer to it. That's next.
