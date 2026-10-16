# The `vidar` Command

Every command takes a directory, which is a package, or a single `.vidar` file. Packages the program imports by relative path are transpiled with it.

```console
$ vidar run   examples/closures            # transpile and odin run
$ vidar check examples/macros              # transpile and odin check
$ vidar test  examples/testing             # transpile and odin test
$ vidar build examples/cyclic -o out/game  # write the generated Odin tree
$ vidar build examples/cyclic -bin -- -o:speed   # and build the executable
$ vidar emit  examples/cyclic              # print the generated Odin
$ vidar run   examples/negative_cost -opt  # with the -opt rewrites
$ vidar run   examples/closures --watch    # rerun when a .vidar file changes
$ vidar fmt   examples/closures --check    # list files vidar fmt would change
$ vidar new   hello                        # start a program in a new directory
```

| Command | What it does |
|---|---|
| `vidar run <input> [-opt] [-- args...]` | transpile, then `odin run`; arguments after `--` go to the program |
| `vidar check <input> [-opt]` | transpile, then `odin check` |
| `vidar test <input> [-opt] [--run <name>,...] [-- odin flags]` | transpile, then `odin test`; see [Chapter 12](ch12-02-running-tests.md) |
| `vidar build <input> [-opt] [-o <dir>] [-bin\|-lib\|-dll] [-out <file>] [-debug] [-- odin flags]` | write the generated Odin tree (default `out/<name>`) and `vidar.map.json`; optionally build it |
| `vidar emit <input> [-opt]` | print the generated Odin |
| `vidar map <out-dir> < log` | rewrite generated `.odin` locations in a saved log to `.vidar` ones |
| `vidar fmt <files\|dirs> [--check\|--write]` | format `.vidar` files; see [the next section](ch16-02-fmt.md) |
| `vidar new <dir> [--lib]` | start a program, or a library package with a test, in an empty directory |
| `vidar lsp` | run the language server on stdio (the same as `vidar-lsp`) |
| `vidar dap [--backend <lldb-dap>]` | run the debug adapter on stdio; see [Debugging](ch16-04-debugging.md) |
| `vidar --version` | print the version |

`odin` has to be on your `PATH` for `run`, `check` and `test`, and for `build` with `-bin`, `-lib`, `-dll` or `-debug`. [Appendix K](appendix-11-cli.md) has the full usage text.

## Common Flags

- **`-opt`** applies the [`-opt` rewrites](ch15-00-optimization.md). **`-opt-report`** stands in for it and also prints each decision.
- **`-define:NAME=value`** is passed on to `odin` by `run`, `check`, `test` and the building forms of `build`. Vidar reads some of them itself; [Appendix E](appendix-05-build-flags.md) lists its own.
- **Flags after `--`** go to `odin` for `build` and `test`, and to the program for `run`.
- **Locations.** Panics, failed `assert`s, bounds-check failures and test messages printed by `run` and `test` are shown at `.vidar` locations.

## `vidar build`

`vidar build` always writes the generated Odin tree and `<out>/vidar.map.json`. A flag also runs `odin build`:

| Flag | Result, next to the generated `.odin` files |
|---|---|
| `-bin` | the executable `<name>` (`.exe` on Windows) |
| `-lib` | the static library `lib<name>.a` (`.lib` on Windows) |
| `-dll` | the shared library `lib<name>.dylib` or `.so` (`.dll` on Windows) |
| `-debug` | like `-bin`, with debug info; see [Debugging](ch16-04-debugging.md) |

- Odin flags go after `--`: `vidar build . -bin -- -o:speed`. Vidar's own `-o <dir>` sets the output directory; Odin's `-o:speed` sets the optimization level.
- `-out <file>` puts the result somewhere else. It's needed when a package is named like the program, which otherwise gets a `.bin` suffix.
- A rebuild removes the previous output directory first, but only when it holds a `vidar.map.json` from an earlier build.
- `vidar build` can't wrap the program it builds, so to see `.vidar` locations in its output, pipe the output through `vidar map <out>`.

## `vidar new`

`vidar new <dir>` creates a `main.vidar` hello world, a `.gitignore` with `out/`, a `.vscode/launch.json` for debugging, and a README. `--lib` makes a library package with a `@(test)` procedure instead. The package is named after the directory, which must be empty or missing.

## `--watch`

`--watch` works with `run`, `check` and `test`. It reruns about 100 ms after the last change to any package of the program: the entry package and everything it imports by relative path, recomputed before each run since imports change. A program still running is killed, with anything it started, before the rerun. Output is kept, unless `--clear` clears the screen first. Stop it with Ctrl-C.

## Standalone Binaries

```console
$ npm run build:binaries
```

This builds `bin/<os>-<arch>/vidar` and `vidar-lsp`, and a `.tar.gz` of both, like the ones on the releases page. They need no Node.js at run time: each is a Node [single executable application](https://nodejs.org/api/single-executable-applications.html), the bundled compiler injected into a copy of the Node binary, which is why one is about 85 MB. `vidar-lsp` is a hard link to the same file; run under that name, or as `vidar lsp`, it starts the language server.

To build for another platform, pass a Node binary for it:

```console
$ node scripts/build-binaries.js --node path/to/linux-x64/bin/node --target linux-x64
```
