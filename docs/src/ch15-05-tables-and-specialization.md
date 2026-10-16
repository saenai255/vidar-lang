# Tables, Memoization and Specialization

## Lookup Tables

A procedure that takes one small value and does a lot of work on it can be replaced by a table of its results. `-opt` does that on its own when **all** of these hold:

- it takes one `bool`, `u8` or `i8` and returns an integer or `bool`;
- its body is pure integer code: locals, constants, arithmetic, `if`, `for` and `switch`, and calls to procedures that pass the same check;
- it has a loop, or at least 24 operations;
- it finishes at compile time for every input.

Vidar runs the body at compile time for every possible input, using the [compile-time interpreter](ch11-03-compile-time-evaluation.md), and writes the results as a `@(rodata)` table. Floats, strings, globals, pointers and macros rule a procedure out, because the interpreter can't promise to compute them exactly as the compiled program would. `@(no_table)` opts a procedure out.

### `@(table)`: Asking for a Table

`@(table)` asks for a table yourself, also for an enum parameter, or a body Vidar can't run at compile time:

```vidar
@(table)
collatz :: proc(b: u8) -> int {
	n := int(b) + 1
	steps := 0
	for n != 1 {
		n = n / 2 if n % 2 == 0 else 3 * n + 1
		steps += 1
	}
	return steps
}

main :: proc() {
	fmt.println(collatz(26), collatz(255))
}
```

<span class="caption">Listing 15-4: A procedure turned into a 256-entry table</span>

```output
111 8
```

| Parameter | Table |
|---|---|
| `bool`, `u8`, `i8` | computed by Vidar, written as a `@(rodata)` literal |
| an enum without explicit values, or a body that can't run at compile time | filled once at startup from the original body |
| two parameters of type `bool`, `u8` or `i8` | a two-dimensional table, `table[x][y]`; `-opt` makes these on its own up to 4096 results |

With `@(table)` you promise that the body depends only on its arguments. Vidar can't check that for a table you ask for, which is why only the automatic tables are limited to code it can check.

## Memoization

A procedure that calls itself more than once per call, like the textbook `fib`, does exponential work. `@(memo)` gives each outer call a table of results that its calls to itself share, so each value is computed once:

```vidar
@(memo)
fib :: proc(n: int) -> int {
	if n < 2 do return n
	return fib(n - 1) + fib(n - 2)
}

main :: proc() {
	fmt.println(fib(80))
}
```

<span class="caption">Listing 15-5: A memoized `fib`, instant at 80</span>

```output
23416728348467685
```

The table is freed when the outer call returns, so nothing is kept between calls or shared between goroutines. It's an array when every parameter is `bool`, `u8` or `i8` (4096 results at most), and a map keyed by the parameters otherwise. The procedure keeps its name and signature.

`-opt` adds `@(memo)` on its own to a pure integer procedure that calls itself more than once per call, unless the program has `@(no_alloc)` procedures, since the table allocates. `@(no_memo)` opts out.

## Specialization

A procedure whose behavior depends heavily on a parameter that's usually a constant, such as a blur's radius, does better as a copy per constant: LLVM can unroll its loops, turn divisions into shifts, and drop branches.

`@(specialize)` gives each call that passes constants a copy where those parameters are compile-time (`$radius`), and Odin builds one version per value. Calls with run-time values call the original:

```vidar
@(specialize)
box_blur :: proc(dst, src: []int, radius: int) {
	for i in 0..<len(src) {
		sum := 0
		for k in -radius..=radius do sum += src[clamp(i + k, 0, len(src) - 1)]
		dst[i] = sum / (2 * radius + 1)
	}
}

main :: proc() {
	src := []int{0, 0, 9, 0, 0}
	dst := make([]int, len(src))
	defer delete(dst)
	box_blur(dst, src, 1)          // calls box_blur__radius, with $radius = 1
	fmt.println(dst)
}
```

```output
[0, 3, 3, 3, 0]
```

Parameters of basic types and enums qualify. `-opt` specializes on its own when calls pass constants to a parameter that bounds a loop, or divides, shifts or branches inside one, unless every call passes the same constant (LLVM folds that already) or it would take more than 4 copies. `@(no_specialize)` opts out.

## String Switches

A `switch` on a string with **8 or more** literal cases compares the string against each case in turn. `-opt` switches on a perfect hash instead: the length and the first, middle and last bytes pick the one candidate (or seeded FNV-1a when those collide), one compare confirms it, and each case's strings become their indexes. Case bodies, `fallthrough` and the default case stay as written. `@(no_perfect_hash)` opts out.
