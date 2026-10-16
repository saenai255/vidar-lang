# Built-in Macros

A *macro* is code that writes code. You call one with a `!` after its name, `dbg!(x)`, and before your program is compiled, the call is replaced by the code the macro produces. Macros can do things a procedure can't: see the text of an argument, wrap a block of statements, or declare names in the caller's scope.

Vidar comes with a dozen macros that every file can use without an import. They're written in Vidar itself, in [`src/prelude.vidar`](../../src/prelude.vidar), with the same tools [Chapter 11](ch11-00-compile-time.md) teaches you to use for your own. A declaration of your own with the same name takes precedence.

| Macro | What it does |
|---|---|
| `scoped! { ... }` | gives the block its own temp allocator, freed when the block ends |
| `with_allocator!(a) { ... }` | makes `a` the block's `context.allocator` |
| `locked!(&m) { ... }` | holds a lock for the block, released on every exit |
| `move!(x)` | moves a value to a new owner ([Chapter 7](ch07-02-ownership.md#moving-with-move)) |
| `dbg!(expr)` | prints an expression and its value, and evaluates to the value |
| `timed!("label") { ... }` | prints how long a block took |
| `track!("label") { ... }` | prints the allocations a block leaves behind |
| `check!(cond)` | panics when `cond` is false, showing the expression and its operands |
| `todo!()`, `unimplemented!()` | panics, for code that isn't written or isn't supported |
| `do! { ...; take value }` | a block that evaluates to a value |
| `comptime! { ... }` | a block that runs at compile time ([Chapter 11](ch11-03-compile-time-evaluation.md)) |

This chapter goes through them in three groups:

- [Memory and Scope](ch10-01-memory-and-scope.md)
- [Debugging and Assertions](ch10-02-debugging-and-assertions.md)
- [Blocks That Produce a Value](ch10-03-do-blocks.md)

The [macro reference](reference-04-macros.md) shows each one's definition, with more examples.
