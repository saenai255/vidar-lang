# Vidar documentation

Vidar is a transpiler from `.vidar` to plain Odin. A `.vidar` program is Odin plus closures, interfaces, error handling, cyclic imports, comptime macros and goroutines. New here? Read [Getting started](getting-started.md), then pick a feature below.

For a one-page cheat sheet of every construct, see [SYNTAX.md](../SYNTAX.md). Each feature has a runnable program in [examples/](../examples).

## Using Vidar

| Page | What it covers |
|---|---|
| [Getting started](getting-started.md) | install, hello world, how a build works |
| [Command line](cli.md) | `run`, `check`, `build`, `test`, `fmt`, `new`, `emit`, `map`; standalone binaries |
| [Limits](limits.md) | what the compiler does not do yet |
| [FAQ](faq.md) | short answers to common questions |

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
| [Built-in macro definitions](reference/macros.md) | `scoped!`, `locked!`, `check!`, ... as written in the prelude |
| [Build flags](reference/defines.md) | every `-define:VIDAR_*` flag with its default |
| [`vidar:sched` API](reference/sched.md) | every public proc and type for goroutines and I/O |
| [Compile errors](reference/errors.md) | every error the compiler tests for, with a program that triggers it |

## How the compiler works

| Page | What it covers |
|---|---|
| [Architecture](internals/architecture.md) | the pipeline from `.vidar` to Odin and back |
| [Source layout](internals/source-layout.md) | every file under `src/` |
| [What Vidar generates](internals/lowering.md) | each construct next to the Odin it becomes |
| [Contributing](contributing.md) | tests, fixtures, benchmarks; links to [AGENTS.md](../AGENTS.md) |
