# Blocks That Produce a Value

In Odin, `if` and `switch` are statements: they can't produce a value. When computing a value takes a few statements, you declare the variable first and assign it in each branch. `do!` turns a block into an expression instead. `take value` leaves the block with that value:

```vidar
main :: proc() {
	xs := []int{4, 8, 15}
	third := do! {
		if len(xs) > 2 do take xs[2]
		take 0
	}
	label := do! {
		switch {
		case third > 10: take "big"
		case third > 0:  take "small"
		}
		take "none"
	}
	fmt.println(third, label)
}
```

<span class="caption">Listing 10-3: Values computed by blocks</span>

```output
15 big
```

`take` leaves only the `do!` block; `return` and `or_return` inside it still leave the procedure.

## Where It Can Go

The block runs just before the statement it's in, and its value is used in its place. So it works in a declaration, an assignment, an expression statement or a `return`, and nothing with side effects may come before it in the same statement.

That rules out a few places where it would run when it shouldn't: on the right of `&&`, `||` or `or_else`, and in a branch of a ternary, the block would run even when that side is skipped:

```vidar,compile_fail
main :: proc() {
	ready := false
	ok := ready && do! { take true }
	_ = ok
}
```

```error
error: in expansion of 'do!': do! would run before the statement, even when the right side of '&&' is skipped; compute it in a statement of its own first
```

## The Result Type

The type of a `do!` is inferred from the values it takes. When it can't be, write it: `do!(T) { ... }`. Reaching the end of the block without a `take` panics.

## Summary

That's the built-in macros: blocks with an allocator, a lock or a timer around them; `dbg!` and `check!` for looking at values; placeholders; and blocks that produce values. They're all written in Vidar, with the tools of the next chapter.
