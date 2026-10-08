# Vidar documentation

Vidar is a transpiler from `.vidar` to plain Odin. A `.vidar` program is Odin plus closures, interfaces, error handling, cyclic imports, comptime macros and goroutines. New here? Read [Getting started](getting-started.md), then pick a feature below.

For a one-page cheat sheet of every construct, see [SYNTAX.md](../SYNTAX.md). Each feature has a runnable program in [examples/](../examples).

## Using Vidar

| Page | What it covers |
|---|---|
| [Getting started](getting-started.md) | install, hello world, how a build works |
| [Command line](cli.md) | `run`, `check`, `build`, `test`, `fmt`, `new`, `emit`, `map`; standalone binaries |
| [Limits](limits.md) | what the compiler does not do yet |

## The language

| Page | What it covers |
|---|---|
| [Closures](language/closures.md) | `proc[x](...)`, captures, `closure(...)` types, lifetime checks |
| [Interfaces](language/interfaces.md) | `interface`, `impl`, dispatch, generic impls, extending |
| [Error handling](language/error-handling.md) | `or_return <value>`, `catch`, `errdefer` |
| [Anonymous struct literals](language/anonymous-structs.md) | `x := { a = 1 }` |
| [Cyclic imports](language/cyclic-imports.md) | how packages that import each other are merged |
| [Collections](language/collections.md) | `vidar.toml` and `import "name:pkg"` |
| [Goroutines and channels](language/goroutines.md) | `vidar:sched`, `select`, I/O, threads, deadlock dump, trace, race check |
| [Built-in macros](language/builtin-macros.md) | `scoped!`, `locked!`, `timed!`, `dbg!`, `check!`, `do!`, ... |
| [Comptime procs](language/comptime.md) | `proc!`, `quote`, compile-time evaluation |
| [Faster code: `-opt`](language/optimization.md) | tables, specialization, pools, `@(no_alloc)`, benchmarks |

## Tools

| Page | What it covers |
|---|---|
| [Testing](tools/testing.md) | `@(test)` procs and `vidar test` |
| [Debugging](tools/debugging.md) | `-debug`, `lldb`/`gdb`, mapping crashes to `.vidar` lines |
| [Language server](tools/language-server.md) | editor features, VS Code extension |

## Reference

Generated from the compiler's own tables by `npm run docs:gen`, so they match the code.

| Page | What it covers |
|---|---|
| [Keywords](reference/keywords.md) | Vidar's and Odin's keywords |
| [Built-ins](reference/builtins.md) | built-in procs, types, constants, context fields |
| [Comptime built-ins](reference/comptime.md) | helpers for `proc!` and `comptime!`, parameter kinds |
| [Attributes](reference/attributes.md) | `@(table)`, `@(no_alloc)`, `@(private)`, ... |
| [Command line](reference/cli.md) | the full usage text of `vidar` |

## How the compiler works

| Page | What it covers |
|---|---|
| [Architecture](internals/architecture.md) | the pipeline from `.vidar` to Odin and back |
| [Source layout](internals/source-layout.md) | every file under `src/` |
| [Contributing](contributing.md) | tests, fixtures, benchmarks; links to [AGENTS.md](../AGENTS.md) |
