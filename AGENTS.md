# AGENTS.md

Notes for coding agents working on Vidar.
Vidar is a TypeScript transpiler from `.vidar` to plain Odin. A `.vidar` program is Odin plus closures, interfaces, error handling, cyclic imports, comptime macros and goroutines.
The language is documented in [README.md](README.md) and [SYNTAX.md](SYNTAX.md). The current batch of performance work is tracked in [PERF_PROGRESS.md](PERF_PROGRESS.md).

## Setup

- **Requirements:**
  - Node 20, tested with 20.15.
  - `odin` on PATH, tested with `dev-2026-07-nightly` (installed through nix).
  - `ols`, optionally. Without it, the LSP suite skips its forwarding checks.
- **Platform:** only darwin/arm64 is tested. `vidar:sched` has stack-switching assembly for darwin/arm64, linux/arm64 and linux/amd64.
- **Build:** run `npm install`, then `npm run build`. The build runs `tsc` into `dist/` and copies `src/prelude.vidar` there.
- **Every script and test runs the compiled `dist/`, not `src/`.**
  - `npm test` builds first.
  - `node scripts/test.js`, `node scripts/test-lsp.js`, `node --test tests/unit/` and `node dist/cli.js` don't, so run `npm run build` after every change to `src/`.
- **`tsconfig.json` has `noUnusedLocals`:** an unused import or local fails the build.

## Where things are

README's "Source layout" table lists every source file. Some things it doesn't make obvious:

- **The two generated runtime packages live inside TypeScript strings.**
  - The `vidar_runtime` Odin package (closure types, `expect`, error helpers) is a string in `src/emitter.ts`.
  - The `vidar:sched` package is a string in `src/sched.ts`.
  - Changing either rewrites `expected/vidar_runtime/` or `expected/vidar_sched/` in every fixture that uses it.
- **Built-in macros** (`do!`, `dbg!`, `scoped!`, ...) are Vidar code in `src/prelude.vidar`.
- **Hover text** for keywords, built-ins and attributes is in `src/lsp/docs.ts`.
- **Two files are big:** `src/emitter.ts` (68 KB) and `src/analyzer.ts` (105 KB).
  - Edit them with exact anchors.
  - Check `git diff --stat` after any scripted edit. A loose splice once deleted a large block of `emitter.ts`, and nobody noticed until the tests ran.
- **Ignored by git:** `dist/`, `out/` (default `vidar build` output), `build/`, `bin/` (standalone binaries) and `node_modules/`.
- **A root-level `saves/`** is left over from running slime_mud from the repository root. Don't commit it.

## Testing

Times are from a 12-core M3 Pro.

| Command | What it runs | Time |
|---|---|---|
| `npm test` | build, then the unit, case and LSP suites; exits non-zero on any failure | about 1 minute |
| `npm run test:unit` | `node:test` unit tests in `tests/unit/` | 1 s |
| `node scripts/test.js [-jN]` | fixture cases, error cases, passthrough | 43 s at the default `-j6`, 49 s at `-j1` |
| `node scripts/test.js --only <text>` | only the cases and error tests whose name contains `<text>` (skips the `core` passthrough) | seconds |
| `npm run test:update` | build, then regenerate every fixture (see below) | as above |
| `npm run bench` | `examples/negative_cost` timed against `HEAD`; see "Benchmarks" | 15 s |
| `npm run stress -- <case> [-n 500] [-t 10] [-jN]` | builds one case once and runs it `-n` times to catch rare hangs; on a hang it saves the CPU use and a stack of every thread; `-opt`, `-o:` and `-define:` pass through | 1 s for 100 runs of `sched_pending_io` |
| `node scripts/test-lsp.js` | the language server, end to end over stdio | 6 s |
| `VIDAR_LSP=bin/darwin-arm64/vidar-lsp node scripts/test-lsp.js` | the same suite against a built binary | |
| `node scripts/passthrough.js <files...>` | plain Odin files must come out unchanged; try `$(find "$(odin root)/core" -name '*.odin')` | |

Notes on `scripts/test.js`:
- **Jobs:** `-jN` defaults to half the cores. More jobs barely help, because `odin build` already uses every core. Fewer jobs make timeouts less likely when several worktrees run tests at once.
- **Output:** one `PASS` / `FAIL` line per check, in case order, then `N passed, M failed`. `node scripts/test.js | grep -v '^PASS'` shows only the failures and the summary.
- **Cases:** every `examples/<name>/` that has a `main.vidar`, and every `tests/cases/<name>/`. Each case gets three checks:
  1. The transpiled tree must equal `expected/`.
  2. The program is built with `odin build` and run, and must print `stdout.txt`.
  3. The case is transpiled again with the other `-opt` setting. If that changes the output, that build is run too and must print the same `stdout.txt`. This is what keeps `-opt` honest.
- **Case names:**
  - `opt_*` cases are transpiled with `-opt`.
  - `plain_*` cases are plain Odin and must come out byte-identical.
  - A case is either `input.vidar`, or an `input/` directory for multi-package programs.
- **Error cases:**
  - `tests/errors/<name>.vidar`, or `tests/errors_pkg/<name>/main.vidar` for multi-package programs, must fail to compile.
  - Their first line, `// error: <text>`, gives a substring the message must contain.
- **Passthrough:** five files from Odin's `core` must transpile to themselves: fmt, strings, mem allocators, linalg and the json parser.

**Updating fixtures:**
- `--update` rewrites every `expected/` tree, and every `stdout.txt` whose program ran successfully.
- Then review `git diff`:
  - generated code should change only where you meant it to;
  - a changed `stdout.txt` is a change in behavior and needs a reason.
- A new case's `stdout.txt` is whatever the program printed, so read it and make sure it is right.

**Running one case:** `node scripts/test.js --only closure_values` (after `npm run build`). It combines with `--update` and `-jN`. To look at a case's output by hand, add `-opt` to the build line for `opt_*` cases, and use `input/` for multi-package cases or `examples/<name>` for an example:
```bash
rm -rf "$TMPDIR/case" && node dist/cli.js build tests/cases/<name>/input.vidar -o "$TMPDIR/case"
diff -r tests/cases/<name>/expected "$TMPDIR/case"
odin run "$TMPDIR/case" -out:"$TMPDIR/case/prog" | diff tests/cases/<name>/stdout.txt -
```
`node dist/cli.js emit <input> [-opt]` prints the generated Odin, for a quick look.

**Adding tests:**
- **A feature or fix:** add a case in `tests/cases/`, prefixed `opt_` if it is about `-opt`.
- **A new compile error:** add a file in `tests/errors/`.
- Generate the fixtures with `npm run test:update`.
- **LSP features:** add checks to `scripts/test-lsp.js`. Its workspaces are in `tests/lsp/` and are copied to a temp dir on each run.
- **slime_mud:** `examples/slime_mud` has no top-level `main.vidar`, so `npm test` skips it. After a compiler change, also run these (each takes under a second):
  ```bash
  node dist/cli.js check examples/slime_mud/vidar
  node dist/cli.js check examples/slime_mud/vidar -opt
  ```

## Slow tests and hangs

**Slowest cases** (one job, M3 Pro), with everything else at 1.2 s or less:

| Case | Time |
|---|---|
| `tests/cases/specialize` | 4.6 s |
| `examples/goroutines` | 1.7 s |
| `examples/comptime` | 1.4 s |
| `tests/cases/sched_pending_io` | 1.3 s |
| `examples/anon_structs` | 1.3 s |

**Timeouts.** The runner builds and runs separately, with separate limits:
- A build gets 120 s and one retry.
- A program gets 30 s.

So a hang fails one case (`odin build timed out`, or `timed out after 30s`) instead of stalling the whole run. A build hang can still hold a worker for up to 4 minutes.

**Known hangs:**
- **Odin compiler spin, intermittent.** `odin build` sometimes spins on output that normally builds in 0.2 s.
  - Seen on `closure_types` and `macro_types_strings`, each in the build with the other `-opt` setting.
  - About one full run in three has one flaky failure; `opt_auto`, `opt_bounds` and `macro_hygiene` have also failed this way. It passes on a rerun.
  - Rerun the case alone (`--only <name>`) before calling it a flake. If it fails again, it's real. This is PERF_PROGRESS item 5.
- **Odin compiler hang, every time.** It happens on a struct with blank `_` field names declared inside a polymorphic (`$T`) proc. Never generate blank field names; give padding fields names such as `__pad`.
- **Scheduler busy loop.** The `sched_pending_io` program once spun at 100% CPU for about 2 hours, before the timeouts existed.
  - Treat a run timeout in any `vidar:sched` program (`sched_pending_io`, `examples/goroutines`, `examples/sched_io`) as a likely scheduler bug, not a flake.
  - Hunt it with `npm run stress -- tests/cases/sched_pending_io -n 2000`. On a hang it keeps the binary and writes the CPU use and a `sample` (macOS) or `gdb` (Linux) stack to `$TMPDIR/vidar-stress-*/hang-N.txt`. This is PERF_PROGRESS item 2.
  - Not reproduced on linux/amd64. On macOS, files go to worker threads; `-define:VIDAR_FILES_ON_WORKERS=true` sends them there on Linux too.
- **Your own shell.** A command that waits on stdin hangs the tool call until it is killed. Examples: `cat > file` without a heredoc, a bare `node`, or a program that reads input.

**Finding stuck processes:**
- Test programs run as `$TMPDIR/vidar-test-*/<case>/prog`; list them with `pgrep -fl vidar-test-`.
- Compiler runs show up in `pgrep -fl "odin build"`.
- Kill by PID. Don't `pkill odin`: other sessions or worktrees may be building.

**Temp dirs are never cleaned up.** Each tool leaves its own:

| Prefix in `$TMPDIR` | Left by |
|---|---|
| `vidar-test-*` | `scripts/test.js` |
| `vidar-lsp-*` | `scripts/test-lsp.js` |
| `vidar-unit-*` | the unit tests |
| `vidar-XXXXXX` | `vidar run` and `vidar check` |
| `slime-bench-*` | the slime_mud benchmark |
| `vidar-bench-*` | `npm run bench` |
| `vidar-stress-*` | `npm run stress` |

They had reached about 1 GB here. Clean up when no test, benchmark or editor session is running:
```bash
rm -rf "$TMPDIR"/vidar-test-* "$TMPDIR"/vidar-lsp-* "$TMPDIR"/vidar-unit-* "$TMPDIR"/slime-bench-* "$TMPDIR"/vidar-bench-* "$TMPDIR"/vidar-stress-*
```

## Benchmarks

`examples/negative_cost` measures each optimization against the plain version. Every section prints a checksum, and with `--bench` it also prints the time.

**Regression check:** `npm run bench` builds it at the working tree and at `HEAD` (in a temporary worktree), runs both 5 times alternately, and prints old, new and change per section. It exits 1 when a section over 0.5 ms is more than 15% slower or a checksum changed, and 2 when a build fails. `--against <ref>`, `--section <text>` and `--runs N` change what it compares. It takes about 15 s. Run it before merging any perf item.

Measure at `-o:speed`. `vidar run` builds at Odin's default level, which says little about speed.
```bash
npm run build
node dist/cli.js build examples/negative_cost -opt -o out/nc     # vidar's -o is the output dir
odin build out/nc -o:speed -out:out/nc/prog                      # odin's -o: is the optimization level
out/nc/prog --bench
```
- Building and running take about 5 s.
- Drop `-opt` to see the plain version.
- Use `-opt-report` in place of `-opt` to also print every `-opt` decision, as `file:line: name: label: reason`.

**Comparing by hand:** `npm run bench` does this for you. To do it by hand, build that commit in a temporary worktree the same way. Then run the two binaries alternately a few times and compare medians; sections vary by about 5% from run to run.
```bash
git worktree add "$TMPDIR/vidar-base" <commit>
ln -s "$PWD/node_modules" "$TMPDIR/vidar-base/node_modules"
(cd "$TMPDIR/vidar-base" && npm run build && node dist/cli.js build examples/negative_cost -opt -o out/nc && odin build out/nc -o:speed -out:out/nc/prog)
"$TMPDIR/vidar-base/out/nc/prog" --bench
git worktree remove --force "$TMPDIR/vidar-base"
```

**Reference numbers:** 12-core M3 Pro, `-opt`, `-o:speed`, 2026-10-07. A section much slower than this on the same machine needs an explanation.

| Section | ms |
|---|---|
| interface array | 2.5 |
| pool | 2.4 |
| fmt.sbprintf | 52 |
| loop with indexes | 17.5 |
| scratch allocations | 34 |
| append in a loop | 35 |
| blur, radius at run time | 24 |
| blur, @(specialize) | 8.0 |
| collatz, computed | 207 |
| collatz, @(table) | 1.0 |
| bodies, 3 of 10 fields | 21 |
| closure, called through | 2.9 |
| closure, specialized | 2.9 |
| closure, created in a loop | 19 |
| closure, from an array | 19 |
| closure, as a parameter | 11 |

"bounds, hoisted", "bounds, lockstep" and "bounds, offsets" are newer than this table; on a 4-core linux/amd64 VM they run 14.7, 14.4 and 20.5 ms. "Append in a loop" is bimodal there (about 55 or 97 ms with identical code), from heap state left by earlier sections.

"Closure, called through" was 8.4 ms until item 1 of PERF_PROGRESS; it should now match "closure, specialized" (re-measure on the M3; measured on linux/amd64 so far). README's "What it buys" table compares the plain and Vidar versions.

**slime_mud:**
- `node examples/slime_mud/bench/bench.js` builds the Vidar and Odin versions and checks they behave the same.
- It then measures build, startup, simulation and load. A full run takes about 2 minutes; `--quick` does a smoke run.
- It rewrites the tracked `examples/slime_mud/bench/results.md`. Don't commit a changed results file unless the run was the point.

## What to watch for

**Generated code:**
- **Plain Odin passes through unchanged** without `-opt`, byte for byte. The `plain_*` cases and the `core` samples check this.
- **Line structure is kept.**
  - A lowered construct takes as many lines as its source (`skipLines` in the emitter).
  - Lines vidar doesn't rewrite stay identical.
  - Error locations (`mapLocations` in `src/cli.ts`) and the LSP's forwarding to ols depend on both.
- **Generated names start with `__`** (`__vidar`, `__closure_N`, `__env`). The LSP hides them from completion.
- **`-opt` never changes behavior.** The runner runs both builds and compares their output.
  - Record each `-opt` decision with `an.hint(at, label, tooltip?)` in `src/analyzer.ts`. It feeds both `-opt-report` and the editor's inlay hints.
  - A label starting with "no" or "not" is a decision against. The editor shows those only with `optHints: "all"`.
  - Give each automatic choice an opt-out attribute like `@(no_table)` / `@(no_specialize)` (`KEEPS` in `src/autoopt.ts`), with hover text in `src/lsp/docs.ts`.
- **Closures are values:** `Closure(P) :: struct { call: P, env: Env }`.
  - There are 128 bytes of room for captures, so a closure is 136 bytes; `-define:VIDAR_CLOSURE_ENV=<bytes>` changes the room. Nothing is allocated.
  - Captures that don't fit fail an Odin `#assert` that names the closure's `file:line`.
  - These are compile errors: writing to a by-value capture (they are read-only), and capturing another closure by value.
  - Lifetime is the programmer's job. `src/escape.ts` makes it an error for a closure holding `&x` of a local or parameter to be returned, stored through a pointer, a slice or in a global, or appended to something the proc doesn't own. It follows values through locals, not into calls, so a `&x` closure passed to `sched.go` or stored by a callee still dangles unnoticed.
- **Interface values hold a pointer** (data plus vtable). Converting a plain value is an error; write `&x` or `new_clone(x)`.
- **Goroutines run on one thread**, with no preemption. `core:sync` locks park the whole thread.

**Odin quirks found so far:**
- A struct with blank `_` field names inside a polymorphic proc hangs the compiler.
- You can't take the address of a proc parameter or its fields (`Cannot take the pointer address of 'c.env'`). Copy it to a local first.
- `intrinsics.expect` keeps its branch weights only through a constant alias (`expect :: intrinsics.expect` in the runtime). A `#force_inline` wrapper proc loses them. To check, build with `odin build <dir> -o:speed -build-mode:llvm-ir` and look for `branch_weights`.
- `vidar build -o <dir>` sets the output directory, while Odin's `-o:speed` sets the optimization level.

**Editor:** VS Code runs the `vidar-lsp` binary bundled in the installed `.vsix`, not `dist/`. To see an analyzer or LSP change there, run `npm run vsix`, then reload the VS Code window. It rebuilds the binaries, packages the `.vsix` and installs it with the CLI inside `/Applications/Visual Studio Code.app` (`code` is not on PATH; `VSCODE_CLI` overrides it). It takes about 15 s.

**Docs:** when behavior changes, update:
- README.md: the feature's section, plus "Tests", "Source layout" and "Limits" when they're affected;
- SYNTAX.md;
- examples/README.md;
- for perf work, the status table and log in PERF_PROGRESS.md.

**Git:**
- Commit only when asked.
- **Always use [Conventional Commits](https://www.conventionalcommits.org/)**: `type(scope): summary`, with a short imperative summary, e.g. `feat(opt): reserve for appends under an if` or `fix(sched): run blocking closures inline when idle`.
  - Types: `feat`, `fix`, `perf`, `refactor`, `test`, `docs`, `build`, `ci`, `chore`. A breaking change gets `!` after the type (`feat!: ...`).
  - Every push to `main` is released (`.github/workflows/build.yml`), and the release notes are generated from these messages, grouped by type. A message that doesn't follow the format lands under "Other".
  - Older commits in the log predate this ("Add ...; fix ...").
- The working tree often holds the user's own uncommitted edits, for example in `examples/slime_mud`. Check `git status`, and ask before committing files you didn't change.

## Parallel work in worktrees

- Worktrees go in `.claude/worktrees/<name>`.
- Each needs its own `npm install` and `npm run build`, since `dist/` is per checkout.
- When several worktrees run tests at once, give each `-j2` to `-j4`.

**Merge source changes, not fixtures.** Two worktrees' fixtures always conflict, and regenerating them gives exactly the right result.

1. In the main tree, run `git add -A`.
   - `git apply --3way` needs this index to merge against; without it, it fails with "does not match index".
   - It also stages the user's unrelated edits, so leave those out of any commit.
2. In the worktree, run `git add -N .` so new files show up in the diff. Then write the patch without fixtures:
   ```bash
   git diff -- . ':(exclude,glob)**/expected/**' ':(exclude,glob)**/stdout.txt' > "$TMPDIR/<name>.patch"
   ```
   If `node_modules` is a symlink rather than a directory, the `node_modules/` ignore rule doesn't match it, so exclude it from the patch too.
3. In the main tree, apply the patch, resolve any conflicts, then regenerate the fixtures:
   ```bash
   git apply --3way "$TMPDIR/<name>.patch"
   npm run build && node scripts/test.js --update
   ```
   Review the fixture diff: `git diff --stat`, and every `stdout.txt` change. Then run `npm test`.
4. Merge one worktree at a time, run the tests after each, and log each merge in PERF_PROGRESS.md.
5. Remove a worktree only once its session has finished: `git worktree remove .claude/worktrees/<name>`.
