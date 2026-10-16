# Vidar

Odin with **closures**, **interfaces**, **error handling helpers**, **anonymous struct literals**, a **goroutine and channel library**, **cyclic imports**, **typed compile-time macros** and **optimizations Odin can't do on its own** (lookup tables, specialized copies, pools, compiled `fmt` formats). `vidar` transpiles `.vidar` programs to plain Odin.

The documentation is a book, *The Vidar Programming Language*: read it [online](https://saenai255.github.io/vidar-lang/) or in [docs/src](docs/src/SUMMARY.md). [Appendix B](docs/src/appendix-02-syntax.md) is a one-page cheat sheet of every construct Vidar adds; [examples/](examples) has one runnable program per feature.

Everything that is already Odin passes through **byte-for-byte** (unless you ask for `-opt`): comments, formatting and line numbers are kept. Only the new constructs are rewritten. As a check, 1313 of the 1317 `.odin` files in Odin's `core`, `base` and `vendor` libraries come out of the full pipeline unchanged. Macro expansions get lines of their own, and vidar keeps a map from generated lines to source lines, so errors Odin reports in generated code point at the right line of your `.vidar` file.

```bash
npm install && npm run build
vidar new   hello                        # start a program in a new directory
vidar run   hello                        # transpile + odin run
vidar run   examples/closures            # a bundled example
vidar run   examples/negative_cost -opt  # with the -opt rewrites
npm test
```

## Documentation

[*The Vidar Programming Language*](https://saenai255.github.io/vidar-lang/) ([source](docs/src/SUMMARY.md)) teaches the language chapter by chapter, after the Rust book:

- **Getting started:** [Installation](docs/src/ch01-01-installation.md), [Hello, World!](docs/src/ch01-02-hello-world.md), [Coming from Odin](docs/src/ch02-02-coming-from-odin.md), [a first program](docs/src/ch03-00-first-program.md).
- **The language:** [Closures](docs/src/ch04-00-closures.md), [Interfaces](docs/src/ch05-00-interfaces.md), [Error handling](docs/src/ch06-00-error-handling.md), [Destructors and ownership](docs/src/ch07-00-destructors.md), [Anonymous structs](docs/src/ch08-00-anonymous-structs.md), [Packages](docs/src/ch09-00-packages.md), [Built-in macros](docs/src/ch10-00-builtin-macros.md), [Compile-time code](docs/src/ch11-00-compile-time.md), [Testing](docs/src/ch12-00-testing.md), [a project](docs/src/ch13-00-project.md).
- **Going further:** [Goroutines](docs/src/ch14-00-goroutines.md), [`-opt`](docs/src/ch15-00-optimization.md), [Tools](docs/src/ch16-00-tools.md).
- **Reference:** [every built-in, with examples](docs/src/reference-00.md), [keywords](docs/src/appendix-01-keywords.md), [compile errors and their fixes](docs/src/appendix-06-errors.md), [limits](docs/src/appendix-08-limits.md), [FAQ](docs/src/appendix-09-faq.md), [compiler internals](docs/src/internals-00.md).
- **Read it locally:** `npm run docs:serve` (needs [mdBook](https://rust-lang.github.io/mdBook/)).
