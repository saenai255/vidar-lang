# Faster Code with `-opt`

Vidar sees the whole program before Odin does: every call site of every procedure, every use of every local. That lets it write some code more specifically than you'd write it by hand: a lookup table instead of a computation, a copy of a procedure for each constant it's called with, one bounds check before a loop instead of one per iteration. There are two ways to get that.

**The `-opt` flag.** With `-opt`, Vidar rewrites plain Odin wherever the result is provably the same program, only faster:

```console
$ vidar run . -opt
$ vidar build . -opt -bin -- -o:speed
```

Nothing changes in behavior. That's a promise the test suite checks: every test program is built with and without `-opt`, and both builds must print the same output. Without `-opt`, plain Odin passes through byte for byte, as always.

**Attributes and types that ask for something.** `@(table)`, `@(memo)` and `@(specialize)` ask for a transformation on one procedure, `Pool(I)` stores an interface's implementations by type, and `@(no_alloc)` and `@(hot)` ask the compiler to check a promise. These work with or without `-opt`.

Every decision `-opt` makes, for or against, is recorded with its reason. `-opt-report` prints them, and the editor shows them as inlay hints, so you can see why a loop kept its bounds check or why a procedure wasn't turned into a table.

- [Seeing What `-opt` Does](ch15-01-reading-opt.md)
- [Loops and Bounds Checks](ch15-02-loops.md)
- [Memory and Layout](ch15-03-memory.md)
- [Formatting, Printing and JSON](ch15-04-formatting-and-json.md)
- [Tables, Memoization and Specialization](ch15-05-tables-and-specialization.md)
- [Closures, Interfaces and `Pool`](ch15-06-closures-and-interfaces.md)
- [Promises the Compiler Checks](ch15-07-checked-promises.md)
- [What It Buys](ch15-08-what-it-buys.md)

Measure with Odin's optimizer on, `-- -o:speed`: `vidar run` builds at Odin's default level, which says little about speed.
