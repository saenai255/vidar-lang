# Command line

The compiler is the `vidar` command. Every command takes a directory (a package) or a single `.vidar` file.

## Getting the `vidar` command

| Option | How |
|---|---|
| From this repository | `npm install && npm run build`, then `npm link` to put `vidar` and `vidar-lsp` on your PATH |
| Standalone binaries | `npm run build:binaries` (see [below](#standalone-binaries)); no Node.js needed at runtime |

`odin` has to be on your PATH for `run`, `check`, `test` and the `-bin` / `-lib` / `-dll` / `-debug` builds.

## Commands at a glance

```bash
vidar run   examples/closures            # transpile + odin run
vidar check examples/macros              # transpile + odin check
vidar run   examples/cyclic              # a program whose packages import each other
vidar emit  examples/cyclic              # print the generated Odin
vidar build examples/cyclic -o out/game  # write the generated Odin tree
vidar run   examples/negative_cost -opt  # with the -opt rewrites
vidar run   examples/closures --watch    # rerun whenever a .vidar file of the program changes
vidar fmt   examples/closures --check    # list files vidar fmt would change
vidar test  examples/testing             # transpile + odin test: run the @(test) procs
vidar build examples/cyclic -debug       # also build it with debug info, for lldb or gdb
vidar build examples/cyclic -bin -- -o:speed  # also build the binary; -lib: static library, -dll: shared library
vidar new   hello                        # start a program in a new directory (--lib: a library package)
```

| Command | What it does |
|---|---|
| `vidar run <input> [-opt] [-- args...]` | transpile, then `odin run` |
| `vidar check <input> [-opt]` | transpile, then `odin check` |
| `vidar test <input> [-opt] [--run <name>,...] [-- odin flags]` | transpile, then `odin test` the `@(test)` procs. See [Testing](tools/testing.md) |
| `vidar build <input> [-opt] [-o <dir>] [-bin\|-lib\|-dll] [-out <file>] [-debug] [-- odin flags]` | write the generated Odin tree (default `out/<name>`) and `vidar.map.json`; optionally build it |
| `vidar emit <input> [-opt]` | print the generated Odin to stdout |
| `vidar map <out-dir> < log` | rewrite generated `.odin` locations in a saved log to `.vidar` ones |
| `vidar fmt <files\|dirs> [--check\|--write]` | format `.vidar` files. See [below](#vidar-fmt) |
| `vidar new <dir> [--lib]` | start a program in an empty directory |
| `vidar lsp` | run the language server on stdio (same as `vidar-lsp`) |
| `vidar --version` | print the version |

The full usage text is in the [command line reference](reference/cli.md).

## Packages and programs

A directory is a package: all its `.vidar` (and plain `.odin`) files are transpiled together, along with every package it imports by relative path. A single `.vidar` file can also be built on its own.

## Common flags

- **`-opt`** applies the [`-opt` rewrites](language/optimization.md). **`-opt-report`** stands in for it and also prints each decision.
- **`-define:NAME=value`** is passed on to `odin` by `run`, `check`, `test` and `build -bin|-lib|-dll|-debug`.
- **Flags after `--`** go to `odin` (for `build`, `test`) or to the program (for `run`).
- **Panics, failed `assert`s, bounds-check failures and `testing` messages** printed by `run` and `test` appear at `.vidar` locations.

## `vidar build`

`vidar build` always writes the generated Odin tree and `<out>/vidar.map.json`. Add a flag to also run `odin build`:

| Flag | Result next to the generated `.odin` |
|---|---|
| `-bin` | the executable `<name>` (`.exe` on Windows) |
| `-lib` | the static library `lib<name>.a` (`.lib` on Windows) |
| `-dll` | the shared library `lib<name>.dylib` or `.so` (`.dll` on Windows) |
| `-debug` | like `-bin`, with debug info. See [Debugging](tools/debugging.md) |

- **Odin flags** after `--`, such as `-o:speed`, go to `odin`. (Vidar's own `-o <dir>` sets the output directory; Odin's `-o:speed` sets the optimization level.)
- **`-out <file>`** puts the result there instead. It is needed when a package is named like the program, which otherwise gets a `.bin` suffix.
- **Rebuilds** remove the previous output directory first, but only when it holds a `vidar.map.json` from an earlier build.
- **`vidar map`.** Because `vidar build` can't wrap the program it builds, `vidar map <out> < log` rewrites the locations in a saved log of that program afterwards.

## `vidar new`

`vidar new <dir> [--lib]` creates:

- a `main.vidar`: a hello world, or with `--lib` a library package with a `@(test)` proc, for `vidar test`;
- a `.gitignore` with `out/`;
- a `.vscode/launch.json` with the `vidar` debug configuration (see [Debugging](tools/debugging.md));
- a README stub.

The package is named after the directory. It refuses a directory that isn't empty.

## `--watch`

`--watch` works with `run`, `check` and `test`.

- **What it watches:** every package of the program in the project: the entry package and every package it imports by relative path, but not `core:` or `vidar:sched`. The set is recomputed before each run, since imports change.
- **When it reruns:** about 100 ms after the last change.
- **A program still running** is killed, together with anything it started, before the rerun.
- **Output** is kept, unless you add `--clear`, which clears the screen before each rerun.
- **How:** `fs.watch` on each package directory, falling back to polling where that fails.
- **Stop it** with Ctrl-C.

## `vidar fmt`

`vidar fmt <files|dirs>` prints each file formatted.

| Flag | Effect |
|---|---|
| (none) | print the formatted file to stdout |
| `--write` | rewrite changed files in place |
| `--check` | list the files that would change, and exit 1 if there are any |

Directories are searched for `.vidar` files. Editors get the same through the language server's `textDocument/formatting`.

**It only changes whitespace between tokens and never moves a token to another line**, so line numbers (errors, `call_site()`, `dbg!`, `todo!`) stay the same and diffs stay small.

### What it changes

- **Indentation:** tabs, by bracket depth. A `case` sits at its `switch`'s level, a line that continues an expression goes one level deeper, and brackets opened on the same line share one level.
- **Trailing whitespace** and trailing blank lines at the end of the file go. Blank lines elsewhere stay.
- **Spacing:**
  - one space goes around binary and assignment operators (`a+b` becomes `a + b`, `x:=1` becomes `x := 1`);
  - one space goes after commas and after the `:` of a declaration;
  - no space inside `(...)` and `[...]`, before a comma, around `.`, or between a name and its `(` or `[`.

### What it leaves alone

Spacing it can't be sure about stays as written:

- unary operators, `^`, ranges, `->` after a name, `typeid/[]$E`;
- everything inside `@(...)`, and the inside of `{ ... }`;
- runs of spaces that line things up;
- the text of comments and strings (comments are reindented with their line).

It doesn't reflow, join or split lines.

### Guarantees

- Formatting is idempotent.
- Before anything is written, the result is checked to have the same tokens on the same lines.
- `dbg!`, `check!` and `stringify` labels show the expression's spacing, so they follow the formatted source.

## Standalone binaries

```bash
npm run build:binaries
```

This builds `bin/<os>-<arch>/vidar` and `vidar-lsp`, plus a `.tar.gz` of both. They need no Node.js or `node_modules` at runtime.

- **How they work.** Each is a Node [single executable application](https://nodejs.org/api/single-executable-applications.html): the bundled compiler is injected into a copy of the Node binary, which is why a binary is about 85 MB.
- **`vidar-lsp`** is a hard link to the same file. Run under that name, or as `vidar lsp`, it starts the language server.
- **`odin`** still has to be on your PATH for `run` and `check`.

**Building for another OS or CPU.** Pass a Node binary for that target, for example from the official downloads at nodejs.org:

```bash
node scripts/build-binaries.js --node path/to/linux-x64/bin/node --target linux-x64
```

On macOS, binaries are ad-hoc signed.
