# Contributing

Setup, the full test table, worktree workflow, commit format and known hangs are in [AGENTS.md](../AGENTS.md). Start with [Architecture](internals/architecture.md) and [Source layout](internals/source-layout.md).

## Working on the docs

```bash
npm run docs:dev      # regenerate the reference pages, then serve the site with hot reload
npm run docs:build    # static site in docs/.vitepress/dist
npm run docs:gen      # only the generated pages in docs/reference/
```

- **The site** is [VitePress](https://vitepress.dev). Pages are plain Markdown in `docs/`. A new page needs an entry in the sidebar in `docs/.vitepress/config.mjs`.
- **Code blocks** tagged `odin` or `vidar` are highlighted with the VS Code extension's grammar.
- **Links** that leave `docs/` (to `src/`, `examples/`, `SYNTAX.md`) become GitHub links on the site.
- **Generated pages.** `docs/reference/*.md` and `docs/internals/lowering.md` are written by `scripts/gen-docs.js` from the compiler's own sources: `src/lsp/docs.ts` (the text the language server shows on hover), the usage text in `src/cli.ts`, `src/prelude.vidar`, the `#config` flags and public procs in `src/sched.ts`, the error cases in `tests/errors/`, and the snippets in `docs/snippets/lowering/` (add one there to show another construct). Don't edit them by hand: change the source and run `npm run docs:gen`. `tests/unit/docs.test.js` and the Docs workflow fail when they are stale.
- **CI** (`.github/workflows/docs.yml`) builds the site on every PR and publishes it to GitHub Pages when `main` changes. Pages must be set to "GitHub Actions" in the repository settings.

## Tests

```bash
npm test               # unit tests, fixture tests, language server tests
npm run test:update    # regenerate fixtures after an intended output change, then review the diff
node scripts/test.js --only closure    # only the cases and error tests whose name contains "closure"
VIDAR_LSP=bin/darwin-arm64/vidar-lsp node scripts/test-lsp.js   # run the LSP suite against a built binary
npm run bench          # examples/negative_cost timed against HEAD; --against <ref>, --section <name>, --runs N
npm run stress -- tests/cases/sched_pending_io -n 2000   # run one case many times; saves a stack on a hang
```

| Suite | Where | What it checks |
|---|---|---|
| [Unit tests](#unit-tests) | `tests/unit/*.test.js` | the compiler's parts one at a time |
| [`vidar test`](#vidar-test) | `scripts/test.js`, `examples/testing`, `tests/vidar_test/failing` | the test runner and its location mapping |
| [Sample programs](#sample-programs-with-fixtures) | `tests/cases/<name>/` | output of the transpiler and of the built program, with and without `-opt` |
| [Examples](#examples) | `examples/<name>/` | the larger tour programs, fixtured the same way |
| [Scheduler debugging](#scheduler-debugging) | `tests/sched_debug/<name>/` | the goroutine dump, trace and race check |
| [Errors](#errors) | `tests/errors/`, `tests/errors_pkg/` | programs that must fail with a given message |
| [Passthrough](#passthrough) | `scripts/test.js` | real Odin files come out unchanged |
| [Language server](#language-server) | `scripts/test-lsp.js` | the server, end to end |
| [Debug adapter](#debug-adapter) | `tests/unit/dap.test.js`, `scripts/test-dap.js` | `vidar dap`, end to end against lldb-dap (skipped without it) |
| [Benchmark](#benchmark), [stress runs](#stress-runs) | `scripts/bench.js`, `scripts/stress.js` | not part of `npm test` |
| [CI](#ci) | `.github/workflows/build.yml` | what runs on every PR |

### Unit tests

`tests/unit/*.test.js`, run with `node:test`. They cover:

- lexer semicolon insertion and trivia;
- parser round-trips of tricky Odin syntax, parsing of the extension syntax, and error recovery;
- compile-time evaluation, hygiene, and spacing of generated code;
- the import-cycle grouping (Tarjan's algorithm, merged units, prefixes, output layout);
- the run-time location mapping (`runmap.test.js`): both location shapes, what passes through, the line filter, `vidar.map.json`;
- Windows paths (`paths.test.js`, through `path.win32`): drive letters in either case, either slash, in the location mapping and in the paths the language server compares;
- `--watch`: the file set, debouncing, reruns on change, polling, and killing a running child with what it started;
- the missing-import fix's package index (`actions.test.js`): a fake `odin root`, shared names, the fallback table;
- `vidar new` (`scaffold.test.js`): the files, package names, refusing a non-empty directory, and that the program runs and the library's test passes (skipped without `odin`);
- the generated reference pages being up to date (`docs.test.js`);
- `vidar fmt`: over every `.vidar` file in the repository it must be idempotent and indent from the tokens alone. Every case and example (and the prelude), with its whitespace scrambled and then formatted, must transpile to the same tokens as before, with and without `-opt`.

### `vidar test`

In `scripts/test.js`, named `testing: ...`:

- `vidar test examples/testing` must pass.
- `vidar test tests/vidar_test/failing` must fail, reporting a failed `testing.expect`, a failed `assert` and a bounds-check panic at the `.vidar` lines marked `// fails here`.

### Sample programs with fixtures

`tests/cases/<name>/`: one feature area each. The sample is `input.vidar`, or an `input/` directory for multi-package programs.

| File | Holds |
|---|---|
| `expected/` | the transpiled Odin tree |
| `stdout.txt` | the program's expected output, checked by running it with `odin run` |

**Naming:**

- `plain_*` cases must come out byte-identical to their input.
- `opt_*` cases are transpiled with `-opt`.
- Every case is also transpiled the other way. If `-opt` changes its output, that version is run too and must print the same.

**They cover:**

- **Closures:** capture modes, loops, every declaration form, multiple results, variadics, nesting, closure types.
- **Interfaces:** dispatch, static calls across packages, decorators, multiple results, variadic methods, generic impls (`Box($T)`, `Pair(int, f64)`, converted in generic code), proc groups and polymorphic procs as bound methods.
- **Macros:** hygiene, code generation, reflection, the typecheck fallback.
- **Anonymous struct literals:** inferred field types, nesting, closure fields, evaluation order, structural compatibility; globals, initializers and arguments to inferred parameters.
- **Import cycles:** three packages, the entry package in a cycle, aliases, multiple files per package.
- A diamond-shaped import graph.
- Plain Odin passthrough.

### Examples

`examples/<name>/`: the larger tour programs, one directory each, fixtured the same way (`expected/` and `stdout.txt` inside the example's directory).

### Scheduler debugging

`tests/sched_debug/<name>/`, in `scripts/test.js`. Each is a program and a `check.json` listing runs. Each run is built with its own odin flags (`VIDAR_THREADS`, `-o:speed`, ...), may be required to fail, and its stderr, mapped to `.vidar` lines, must hold given texts.

| Check | What it verifies |
|---|---|
| `deadlock` | the dump and the panic at 1 and 4 threads, and that `-o:speed` leaves the dump out |
| `trace` | the trace file is valid JSON holding each kind of event, at 1 and 4 threads and with a ring smaller than the run |
| `race` | the two racy writes are reported, at 1, 2 and 4 threads and with `-opt -o:speed`; writes ordered by a `Mutex`, a channel, a `Wait_Group` and `go` are not |

### Errors

`tests/errors/*.vidar`, and `tests/errors_pkg/<name>/` for multi-package programs: about 70 programs that must fail with a specific message. The first line of the file, or of the package's `main.vidar`, says `// error: <expected message>`.

### Passthrough

A few real files from Odin's `core` library must transpile to themselves unchanged.

### Benchmark

`scripts/bench.js`, not part of `npm test`. It builds `examples/negative_cost` at the working tree and at a git ref in a temporary worktree, both with `-opt` and `-o:speed`, runs them alternately, and compares each section's median. It fails when a section over 0.5 ms is more than 15% slower, or when a checksum changes.

### Stress runs

`scripts/stress.js`, not part of `npm test`. It builds one case and runs it many times in parallel, each with a timeout, and checks its `stdout.txt`. On a hang it writes the process's CPU use (a busy loop or a wait) and a stack of every thread (`sample` on macOS, `gdb` on Linux) next to the kept binary.

### CI

`.github/workflows/build.yml`. Every push and pull request runs, on ubuntu-24.04 and macos-14 (arm64), with Node 20 and the Odin release pinned in `ODIN_VERSION`:

1. `npm test` (no `ols`, so the forwarding checks are skipped);
2. `node scripts/test.js` again with goroutines on 4 threads (`VIDAR_ODIN_FLAGS="-define:VIDAR_THREADS=4"`);
3. a 500-run stress of `tests/cases/sched_pending_io`.

When a step fails, the stress run's `hang-*.txt` stacks are uploaded as an artifact. The binaries are built and released only after it passes.

### Debug adapter

`scripts/test-dap.js` drives `vidar dap` over stdio like an editor, against a real `lldb-dap` and `odin` (it prints `SKIP` and passes when either is missing). It launches `tests/dap/closure` and checks breakpoints on `.vidar` lines (including one with no code), frames inside a closure, its captured variables and a watch expression naming one, stepping into and out of a proc, and that stepping into `fmt` steps back out. The translation itself is covered without a debugger by `tests/unit/dap.test.js`.

### Language server

`scripts/test-lsp.js` starts the server over stdio and drives it like an editor across two workspaces: `tests/lsp/workspace`, and `tests/lsp/cycle` where packages import each other. It checks:

- diagnostics, including errors in imported files and `odin check` on save;
- hover, definition, references and rename across packages and cycles (the rename edits are applied and the program recompiled);
- completion, including privacy across packages;
- hover, definition, signature help and completion forwarded to ols (skipped when `ols` is not on PATH);
- the outline and the generated-Odin request;
- workspace symbols, go to implementation and the call hierarchy, across packages, proc groups, an extended interface and a macro (`tests/lsp/nav`);
- the workspace index (`tests/lsp/index`, added as a workspace folder): workspace symbols and `vidar/optReport` find programs never opened, skipped directories stay out, no diagnostics until a file is opened, and removing the folder drops them;
- `-opt` inlay hints (`tests/lsp/opt`), their setting, and that they follow edits;
- semantic tokens (`tests/lsp/semantic`), decoded from the stream: interfaces and their methods, closures, by-value and pointer captures, macro calls, `sched.go`, ranges, and a file with a syntax error;
- field and enum-member uses (`tests/lsp/members`): hover, definition, references and semantic tokens through pointers, `using`, `#soa` and another package, implicit selectors in each kind of position, a field rename that recompiles to the same program, and a rename refused over a use it can't resolve;
- the `vidar/optReport` request (decisions under their enclosing proc, decisions against marked) and the code lenses with their settings;
- quick fixes (`tests/lsp/actions`): each fix's edit, missing imports of packages found under `odin root` (one preferred, or one action per package that shares the name), that `new_clone` is never preferred, that "fix all" never allocates, and that the fixed file has no errors left;
- formatting: per-line edits matching `vidar fmt`, and none for a file that doesn't lex.
