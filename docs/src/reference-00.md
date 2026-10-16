# Library Reference

This part of the book describes everything a Vidar program can use without writing it: the built-in procedures, types, constants and macros, the helpers available at compile time, and the two packages that come with the compiler, `vidar:rc` and `vidar:sched`.

Each entry has a description and at least one example. The descriptions are the ones the language server shows on hover, and the pages are generated from the compiler's sources, so they list exactly what the compiler knows.

- [Built-in Procedures](reference-01-procs.md): `len`, `append`, `make`, `delete`, ...
- [Built-in Types](reference-02-types.md): Odin's basic types, and Vidar's `Destroy`, `Clone` and `Pool`.
- [Constants and Context Fields](reference-03-constants.md): `ODIN_OS` and friends, and the fields of `context`.
- [Built-in Macros](reference-04-macros.md): `dbg!`, `check!`, `scoped!`, `do!`, ...
- [Comptime Built-ins](reference-05-comptime.md): `quote` helpers such as `type_fields` and `stringify`, and macro parameter kinds.
- [`vidar:rc`](reference-06-rc.md): shared values.
- [`vidar:sched`](reference-07-sched.md): goroutines, channels and I/O.

For Odin's `core:` library, see the [Odin package documentation](https://pkg.odin-lang.org/).
