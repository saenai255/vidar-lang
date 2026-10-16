# Coming from Odin

If you know Odin, you already know most of Vidar. This section lists what Vidar adds, what it leaves alone, and the few places where an Odin habit needs adjusting.

## What Stays the Same

**All of Odin.** Every Odin construct means what it means in Odin, and Vidar passes it through untouched: same text, same formatting, same comments, same line numbers. As a check, 1313 of the 1317 `.odin` files in Odin's own `core`, `base` and `vendor` libraries come out of Vidar unchanged.

**The `core:` library.** You import and call `core:fmt`, `core:strings`, `core:os` and the rest exactly as in Odin, from your own Odin installation.

**The toolchain.** Vidar writes an ordinary Odin package tree and runs your `odin` on it. Odin flags (`-o:speed`, `-debug`, `-define:...`, `-target:...`) go after `--` and are passed through, and the build is Odin's.

**Performance.** A Vidar construct turns into the Odin you'd write by hand: a closure is a struct on the stack, an interface call compares a pointer and calls directly, a destructor is a `defer`. Nothing allocates behind your back. With [`-opt`](ch15-00-optimization.md), Vidar goes further than hand-written Odin in some places.

## What Vidar Adds

| Feature | Looks like | Chapter |
|---|---|---|
| Closures | `proc[x, &y](a: int) -> int { ... }`, `closure(int) -> int` | [4](ch04-00-closures.md) |
| Interfaces | `Shape :: interface { area }`, `impl Shape for Circle { area = circle_area }` | [5](ch05-00-interfaces.md) |
| Error handling | `f() or_return .Err`, `f() catch err { ... }`, `errdefer` | [6](ch06-00-error-handling.md) |
| Destructors | `impl Destroy for File { destroy = file_close }`, `move!(x)`, `#owned` | [7](ch07-00-destructors.md) |
| Anonymous struct literals | `hero := { name = "slime", hp = 10 }` | [8](ch08-00-anonymous-structs.md) |
| Cyclic imports | packages that import each other | [9](ch09-02-cyclic-imports.md) |
| Collections | `vidar.toml` maps `import "name:pkg"` to a directory | [9](ch09-03-collections.md) |
| Built-in macros | `dbg!(x)`, `check!(a == b)`, `scoped! { ... }`, `do! { ...; take v }` | [10](ch10-00-builtin-macros.md) |
| Your own macros | `square :: proc!(x: Expr) -> Expr { return quote($x * $x) }` | [11](ch11-00-compile-time.md) |
| Compile-time calls | `fib!(20)`, `comptime! { ... }` | [11](ch11-03-compile-time-evaluation.md) |
| Goroutines | `import "vidar:sched"`, `sched.go(proc[ch]() { ... })` | [14](ch14-00-goroutines.md) |
| Optimizations | `-opt`, `@(table)`, `@(specialize)`, `@(no_alloc)`, `Pool(I)` | [15](ch15-00-optimization.md) |

## Adjusting Odin Habits

**New keywords are contextual.** `closure`, `interface`, `impl`, `catch`, `errdefer`, `quote` and `take` are keywords only where Vidar's syntax uses them. A variable called `impl` or `take` still works.

**A few names are built in.** `Destroy`, `Clone` and `Pool` are types every program can use, and the [built-in macros](reference-04-macros.md) (`dbg`, `check`, `do`, `scoped`, ...) exist in every file. A declaration of your own with the same name takes precedence: a program that declares its own `Destroy` interface, for example, gets an ordinary interface, and Vidar destroys nothing automatically. Macros are called with a `!`, so a procedure of yours called `check` doesn't clash with `check!`.

**Bodiless procedures are interface methods.** Outside a `foreign` block, `name :: proc(...) ---` declares a method of an interface (see [Chapter 5](ch05-01-defining-interfaces.md)), and the interface has to list it.

**Packages may import each other.** Odin rejects import cycles; Vidar merges the packages in a cycle into one Odin package. If you split a package only to break a cycle, you don't have to any more.

**`vidar_runtime` appears in the output.** Programs that use closures, interfaces or error handling get a small generated package, `vidar_runtime`, imported as `__vidar`. It's written next to your code by every build, so there is nothing to install.

## Moving an Odin Project to Vidar

There's nothing to convert. A package may mix `.odin` and `.vidar` files, so you can:

1. point `vidar` at the project as it is, `vidar run .`, to check that it builds the same way;
2. rename a file from `.odin` to `.vidar` when you want to use a Vidar feature in it.

Plain Odin, whether in a `.odin` file or a `.vidar` one, is passed through unchanged, unless you build with `-opt`. That flag may rewrite plain Odin too, but only where the result is provably the same program, only faster.

## Summary

Vidar is Odin with additions, and the additions are opt-in: you use a feature by writing its syntax, and code that doesn't use any of them comes out of Vidar as it went in. In the next chapter, we'll write a program that uses several of these features together, before the rest of the book goes through them one at a time.
