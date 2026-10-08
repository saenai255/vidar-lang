# Vidar

Odin with **closures**, **interfaces**, **error handling helpers**, **anonymous struct literals**, a **goroutine and channel library**, **cyclic imports**, **typed compile-time macros** and **optimizations Odin can't do on its own** (lookup tables, specialized copies, pools, compiled `fmt` formats). `vidar` transpiles `.vidar` programs to plain Odin.

The full documentation is in [docs/](docs/README.md). [SYNTAX.md](SYNTAX.md) is a compact reference of every construct Vidar adds; [examples/](examples) has one runnable program per feature.

Everything that is already Odin passes through **byte-for-byte** (unless you ask for `-opt`): comments, formatting and line numbers are kept. Only the new constructs are rewritten. As a check, 1313 of the 1317 `.odin` files in Odin's `core`, `base` and `vendor` libraries come out of the full pipeline unchanged. Macro expansions get lines of their own, and vidar keeps a map from generated lines to source lines, so errors Odin reports in generated code point at the right line of your `.vidar` file.

```bash
npm install && npm run build
node dist/cli.js new   hello                        # start a program in a new directory
node dist/cli.js run   hello                        # transpile + odin run
node dist/cli.js run   examples/closures            # a bundled example
node dist/cli.js run   examples/negative_cost -opt  # with the -opt rewrites
npm test
```

## Documentation

- **Start here:** [Getting started](docs/getting-started.md), [Command line](docs/cli.md), [SYNTAX.md](SYNTAX.md).
- **Language:** [Closures](docs/language/closures.md), [Interfaces](docs/language/interfaces.md), [Error handling](docs/language/error-handling.md), [Anonymous struct literals](docs/language/anonymous-structs.md), [Cyclic imports](docs/language/cyclic-imports.md), [Collections](docs/language/collections.md), [Goroutines and channels](docs/language/goroutines.md), [Built-in macros](docs/language/builtin-macros.md), [Comptime procs](docs/language/comptime.md), [`-opt`](docs/language/optimization.md).
- **Tools:** [Testing](docs/tools/testing.md), [Debugging](docs/tools/debugging.md), [Language server](docs/tools/language-server.md).
- **Compiler internals:** [Architecture](docs/internals/architecture.md), [Source layout](docs/internals/source-layout.md), [Contributing](docs/contributing.md).
- **Reference** (generated from the compiler): [Keywords](docs/reference/keywords.md), [Built-ins](docs/reference/builtins.md), [Comptime built-ins](docs/reference/comptime.md), [Attributes](docs/reference/attributes.md), [CLI usage](docs/reference/cli.md).
- **Browse as a site:** `npm run docs:dev`.
- **Known gaps:** [Limits](docs/limits.md).
