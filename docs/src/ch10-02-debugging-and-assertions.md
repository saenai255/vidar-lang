# Debugging and Assertions

## `dbg!`: Print a Value Without Rewriting the Code

`dbg!(expr)` prints the source text of an expression and its value to stderr, with the file and line, and then evaluates to the value. Because it's an expression, you can wrap any part of existing code without restructuring it:

```vidar
main :: proc() {
	xs := []int{1, 2, 3}
	n := dbg!(len(xs) * 2) + 1
	fmt.println(n)
}
```

```output
7
```

On stderr, it prints:

```text
[main.vidar:3] len(xs) * 2 = 6
```

## `timed!` and `track!`: Measure a Block

`timed!("label") { ... }` prints how long the block took, to stderr. Without a label, it uses the source location.

```vidar
main :: proc() {
	timed!("sum") {
		s := 0
		for i in 0..<1_000_000 do s += i
		fmt.println(s)
	}
}
```

```output
499999500000
```

```text
[timed] sum: 2.28ms
```

`track!("label") { ... }` runs the block with a tracking allocator and, when it ends, prints every allocation still live, with its size and location: a quick way to find a leak. `track!(allocator, "label")` tracks allocations from `allocator` instead of `context.allocator`. Both arguments are optional, and the label must be a string literal. Tracking only happens in `-debug` builds; otherwise the block runs untracked, at full speed.

## `check!`: Assertions That Say What Went Wrong

`check!(cond)` panics when `cond` is false. Unlike Odin's `assert`, its message shows the expression, and for a comparison, the value of each side:

```vidar,should_panic
main :: proc() {
	xs := []int{1, 2, 3}
	check!(len(xs) == 3)                 // passes
	check!(len(xs) == 4, "need four")    // panics
}
```

<span class="caption">Listing 10-2: A failed `check!` shows both sides of the comparison</span>

```error
panic: check failed: len(xs) == 4 (need four)
	len(xs) = 3
```

Each operand is evaluated once, and a literal operand isn't shown, since its value is in the expression already. `check!` is never compiled out, unlike `assert` with `-disable-assert`.

## `todo!` and `unimplemented!`: Placeholders That Panic

`todo!()` marks code that isn't written yet, and `unimplemented!()` code that deliberately isn't supported. Both panic when reached, with an optional message, and both count as leaving the procedure, so a procedure with a result doesn't need a `return` after one:

```vidar,should_panic
area :: proc(shape: string) -> f64 {
	switch shape {
	case "square": return 1
	case "circle": todo!("circles")
	}
	unimplemented!()
}

main :: proc() {
	fmt.println(area("square"))
	fmt.println(area("circle"))
}
```

```output
1
```

```error
panic: not yet implemented: circles
```

All of these panic at the line of the macro call, and `vidar run` reports it at the `.vidar` file and line.
