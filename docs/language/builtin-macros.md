# Built-in macros

Some macros come with the language. They are available in every file without an import, and a declaration of your own with the same name takes precedence.

They are written in Vidar itself ([src/prelude.vidar](../../src/prelude.vidar)), and their expansions call helpers in the generated `vidar_runtime` package, so they need no imports.

## Memory and scope

| Macro | What it does |
|---|---|
| `scoped! { ... }` | gives the block its own temp allocator (`context.temp_allocator`) and frees all of it when the block ends, on every exit path |
| `scoped!(allocator) { ... }` | the same, with the arena's memory taken from `allocator` instead of `context.allocator` |
| `with_allocator!(a) { ... }` | makes `a` the block's `context.allocator` |
| `locked!(&mutex) { ... }` | holds the lock for the block and releases it on every exit (any `core:sync` lock type) |

```odin
scoped! {
	names := make([dynamic]string, context.temp_allocator)
	for i in 0..<1000 do append(&names, fmt.tprintf("item-%d", i))
	report(names[:])
}   // everything allocated from the temp allocator above is freed here
```

## Measuring and debugging

| Macro | What it does |
|---|---|
| `timed!("label") { ... }` | prints how long the block took to stderr; the label defaults to the source location |
| `track!(allocator, "label") { ... }` | gives the block a tracking `context.allocator` over `allocator`; at its end, prints every allocation still live (size and location) to stderr |
| `dbg!(expr)` | prints `[file:line] expr = value` to stderr and evaluates to the value, so it can wrap any expression |

**`track!` details:** both arguments are optional (the allocator defaults to `context.allocator`, the label to the source location), and the label must be a string literal. It is only active in `-debug` builds; otherwise the block runs on `allocator` untracked.

## Assertions and placeholders

| Macro | What it does |
|---|---|
| `check!(cond)` / `check!(cond, "msg")` | panics when `cond` is false, showing the expression. For a comparison it also shows each non-literal operand's value, and each operand is evaluated once |
| `todo!()` / `todo!("msg")` | panics with "not yet implemented", for code paths that aren't written yet |
| `unimplemented!()` / `unimplemented!("msg")` | panics with "not implemented", for code paths that are deliberately unsupported |

`check!`, `todo!` and `unimplemented!` panic at the source line of the call. `vidar run` maps it back to the `.vidar` file:

```
main.vidar(12:5) panic: check failed: len(xs) == 4 (need four)
	len(xs) = 3
```

## Blocks that produce a value

| Macro | What it does |
|---|---|
| `do! { ...; take value }` | a block that evaluates to a value |
| `comptime! { expr }` / `comptime! { ...; take value }` | runs the block in the transpiler and folds to its value; see [compile-time evaluation](comptime.md#compile-time-evaluation) |

### `do!` in detail

- `take value` leaves the block with that value. `return` and `or_return` still leave the procedure.
- **Where it can be used.** The block runs just before the statement it's in, so it works in a declaration, an assignment, an expression statement or a `return`. Nothing with side effects may come before it in that statement.
- **Where it can't.** On the right of `&&`, `||` or `or_else`, or in a branch of a ternary.
- **The result type** is inferred from the taken values. Write `do!(T) { ... }` to give it.
- **Reaching the end** of the block without a `take` panics.

## A runnable tour

```odin
xs := []int{1, 2, 3}
n := dbg!(len(xs) * 2)              // stderr: [main.vidar:9] len(xs) * 2 = 6

timed!("sum") {                      // stderr: [timed] sum: 2.28ms
	s := 0
	for i in 0..<1_000_000 do s += i
	fmt.println(s)                   // 499999500000
}

m: sync.Mutex
locked!(&m) {                        // unlocked again on every exit path
	fmt.println("inside the lock")
}

v := do! {                           // a block that produces a value
	if len(xs) > 2 do take xs[2]
	take 0
}
fmt.println(v)                       // 3

arena: mem.Arena
buf: [1024]byte
mem.arena_init(&arena, buf[:])
with_allocator!(mem.arena_allocator(&arena)) {
	ys := make([]int, 4)             // allocated from the arena
	fmt.println(len(ys))             // 4
}

check!(len(xs) == 3)                 // passes
check!(len(xs) == 4, "need four")    // panics
```

The last line stops the program:

```
main.vidar(38:4) panic: check failed: len(xs) == 4 (need four)
	len(xs) = 3
```

And `todo!`:

```odin
feature :: proc() -> int {
	todo!("not written yet")
}
```

```
main.vidar(4:2) panic: not yet implemented: not written yet
```

## Writing your own

See [Comptime procs](comptime.md) for how to define macros like these.
