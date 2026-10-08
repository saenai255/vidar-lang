# Command line

Install with `npm install && npm run build`, or use the [standalone binaries](#standalone-binaries). Every command takes a directory (a package) or a single `.vidar` file.

```bash
npm install && npm run build
node dist/cli.js run   examples/closures            # transpile + odin run
node dist/cli.js check examples/macros              # transpile + odin check
node dist/cli.js run   examples/cyclic              # a program whose packages import each other
node dist/cli.js emit  examples/cyclic              # print the generated Odin
node dist/cli.js build examples/cyclic -o out/game  # write the generated Odin tree
node dist/cli.js run   examples/negative_cost -opt  # with the -opt rewrites
node dist/cli.js run   examples/closures --watch    # rerun whenever a .vidar file of the program changes
node dist/cli.js fmt   examples/closures --check    # list files vidar fmt would change
node dist/cli.js test  examples/testing             # transpile + odin test: run the @(test) procs
node dist/cli.js build examples/cyclic -debug       # also build it with debug info, for lldb or gdb
node dist/cli.js build examples/cyclic -bin -- -o:speed  # also build the binary; -lib: static library, -dll: shared library
node dist/cli.js new   hello                        # start a program in a new directory (--lib: a library package)
npm test
```

`vidar new <dir> [--lib]` writes a `main.vidar` (a hello world, or with `--lib` a library package with a `@(test)` proc, for `vidar test`), a `.gitignore` with `out/`, a `.vscode/launch.json` with the `vidar` debug configuration (see [Debugging](tools/debugging.md)) and a README stub. The package is named after the directory. It refuses a directory that isn't empty.

`--watch` works with `run`, `check` and `test`. It watches every package of the program in the project (the entry package and every package it imports by relative path, not `core:` or `vidar:sched`), recomputed before each run since imports change, and reruns about 100 ms after the last change. A program still running is killed, together with anything it started, before the rerun. Output is kept unless you add `--clear`, which clears the screen before each rerun. It uses `fs.watch` on each package directory and falls back to polling where that fails. Ctrl-C stops it.

### `vidar fmt`

`vidar fmt <files|dirs>` prints each file formatted; `--write` rewrites changed files in place, `--check` lists the files that would change and exits 1 if there are any. Directories are searched for `.vidar` files. Editors get the same through the language server's `textDocument/formatting`.

It only changes whitespace between tokens and never moves a token to another line, so line numbers (errors, `call_site()`, `dbg!`, `todo!`) stay the same and diffs stay small:
- each line is indented with tabs by bracket depth: `case` at its `switch`'s level, a line that continues an expression one level deeper, brackets opened on the same line sharing one level;
- trailing whitespace and trailing blank lines at the end of the file go; blank lines elsewhere stay;
- one space goes around binary and assignment operators (`a+b` becomes `a + b`, `x:=1` becomes `x := 1`) and after commas and the `:` of a declaration, and none inside `(...)` and `[...]`, before a comma, around `.`, or between a name and its `(` or `[`.

Spacing it can't be sure about stays as written: unary operators, `^`, ranges, `->` after a name, `typeid/[]$E`, everything inside `@(...)`, the inside of `{ ... }`, runs of spaces that line things up, and the text of comments and strings (comments are reindented with their line). It doesn't reflow, join or split lines. Formatting is idempotent, and before anything is written the result is checked to have the same tokens on the same lines. `dbg!`, `check!` and `stringify` labels show the expression's spacing, so they follow the formatted source.

## Standalone binaries

```bash
npm run build:binaries
```

This builds `bin/<os>-<arch>/vidar` and `vidar-lsp`, plus a `.tar.gz` of both, and needs no Node.js or `node_modules` at runtime. Each is a Node [single executable application](https://nodejs.org/api/single-executable-applications.html): the bundled compiler is injected into a copy of the Node binary, which is why a binary is about 85 MB. `vidar-lsp` is a hard link to the same file. Run under that name, or as `vidar lsp`, it starts the language server. `odin` still has to be on your PATH for `run`/`check`.

To build for another OS or CPU, pass a Node binary for that target, e.g. from the official downloads at nodejs.org: `node scripts/build-binaries.js --node path/to/linux-x64/bin/node --target linux-x64`. On macOS, binaries are ad-hoc signed.

`run` and `test` print panics, failed `assert`s, bounds-check failures and `testing` messages at `.vidar` locations; `vidar build` writes `<out>/vidar.map.json`, so `vidar map <out> < log` does the same for a saved log of a program you built. `-define:NAME=value` is passed on to `odin` by `run`, `check`, `test` and `build -bin|-lib|-dll|-debug`. `vidar build <input> -bin|-lib|-dll [-- odin flags]` also runs `odin build` and leaves `<name>`, `lib<name>.a` or `lib<name>.dylib`/`.so` (`.exe`, `.lib`, `.dll` on Windows) next to the generated `.odin`; flags after `--` such as `-o:speed` go to `odin`. `-out <file>` puts the result there instead (needed when a package is named like the program, which otherwise gets a `.bin` suffix). A rebuild removes the previous output directory first, but only when it holds a `vidar.map.json` from an earlier build.

A directory is a package: all its `.vidar` (and plain `.odin`) files are transpiled together, along with every package it imports by relative path. A single `.vidar` file can also be built on its own.
