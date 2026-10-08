# Built-in library

Some macros come with the language: they're available in every file without an import, and a declaration of your own with the same name takes precedence. They're written in Vidar itself ([src/prelude.vidar](../../src/prelude.vidar)), and their expansions call helpers in the generated `vidar_runtime` package, so they need no imports.

| Macro | What it does |
|---|---|
| `scoped! { ... }` | gives the block its own temp allocator (`context.temp_allocator`) and frees all of it when the block ends, on every exit path |
| `scoped!(allocator) { ... }` | the same, with the arena's memory taken from `allocator` instead of `context.allocator` |
| `with_allocator!(a) { ... }` | makes `a` the block's `context.allocator` |
| `locked!(&mutex) { ... }` | holds the lock for the block and releases it on every exit (any `core:sync` lock type) |
| `timed!("label") { ... }` | prints how long the block took to stderr; the label defaults to the source location |
| `track!(allocator, "label") { ... }` | gives the block a tracking `context.allocator` over `allocator`; at its end, prints every allocation still live (size and location) to stderr. Both arguments are optional (allocator defaults to `context.allocator`, label to the source location); the label must be a string literal. Only active in `-debug` builds; otherwise the block runs on `allocator` untracked |
| `do! { ...; take value }` | a block that evaluates to a value: `take value` leaves the block with that value, while `return` and `or_return` still leave the procedure. The block runs just before the statement it's in, so it can be used in a declaration, an assignment, an expression statement or a `return`, and nothing with side effects may come before it in that statement; it can't be on the right of `&&`, `\|\|` or `or_else`, or in a branch of a ternary. The result type is inferred from the taken values; write `do!(T) { ... }` to give it. Reaching the end of the block without a `take` panics |
| `comptime! { expr }` / `comptime! { ...; take value }` | runs the block in the transpiler and folds to its value; see [compile-time evaluation](comptime.md#compile-time-evaluation) |
| `dbg!(expr)` | prints `[file:line] expr = value` to stderr and evaluates to the value, so it can wrap any expression |
| `check!(cond)` / `check!(cond, "msg")` | panics when `cond` is false, showing the expression. For a comparison it also shows each non-literal operand's value, and each operand is evaluated once. |
| `todo!()` / `todo!("msg")` | panics with "not yet implemented", for code paths that aren't written yet |
| `unimplemented!()` / `unimplemented!("msg")` | panics with "not implemented", for code paths that are deliberately unsupported |

`check!`, `todo!` and `unimplemented!` panic at the source line of the call (`vidar run` maps it back to the `.vidar` file):

```
main.vidar(12:5) panic: check failed: len(xs) == 4 (need four)
	len(xs) = 3
```

```odin
scoped! {
	names := make([dynamic]string, context.temp_allocator)
	for i in 0..<1000 do append(&names, fmt.tprintf("item-%d", i))
	report(names[:])
}   // everything allocated from the temp allocator above is freed here
```
