# Performance work: progress

Items keep their numbers from the ranked list of what was left after the first batch, so they can be cross-referenced.
Tooling comes first: it makes every later item measurable (17), visible in the editor (20), checkable (18) or complete (19).

The process is the same as for the first batch. Each item is built in its own git worktree and merged into `main` one at a time.
After each merge, fixtures are regenerated with `npm run test:update`, the diff is reviewed, and `npm test` must pass.
Every perf item also has to show its gain, or at least no loss, with `npm run bench` (17).

Status values: `todo`, `in progress`, `done (worktree)`, `merged`, `blocked`.

| Priority | # | Item | Kind | Status |
|---|---|---|---|---|
| 1 | 17 | Benchmark regression check | tooling | done |
| 2 | 20 | One command to rebuild and reinstall the VS Code extension | tooling | done |
| 3 | 18 | `@(no_alloc)` and `@(hot)` checks | tooling | done |
| 4 | 21 | Macro expansion on hover | tooling | done |
| 5 | 19 | Leftovers from the first batch | tooling | done |
| 6 | 1 | Closure call regression (2.9x slower call through a closure) | bug | done |
| 7 | 2 | `sched_pending_io` busy loop | bug | closed (not reproduced) |
| 8 | 3 | Dangling by-reference captures in returned closures | bug | merged |
| 9 | 5 | Intermittent Odin compiler hang | bug | closed (not reproduced) |
| 10 | 6 | Value interfaces / closed unions | perf | merged (as an -opt rewrite) |
| 11 | 7 | Generated per-type printers and JSON code | perf | merged (no unmarshal) |
| 12 | 8 | Multithreaded (M:N) scheduler | perf | merged |
| 13 | 9 | Constant-size `make` on the stack | perf | merged |
| 14 | 10 | Wider bounds-check elimination | perf | merged |
| 15 | 11 | String `switch` through a perfect hash | perf | merged |
| 16 | 13 | Automatic `@(memo)` and two-parameter `@(table)` | perf | merged |
| 17 | 15 | Struct field reordering, then hot/cold splitting | perf | merged (reordering only) |
| 18 | 22 | `vidar test` | dev tooling | merged |
| 19 | 23 | Run-time crash locations mapped to `.vidar` | dev tooling | merged |
| 20 | 24 | `--watch` for `run`, `check` and `test` | dev tooling | merged |
| 21 | 25 | Expand-at-cursor view of generated Odin | dev tooling | merged |
| 22 | 26 | Code actions (quick fixes) | dev tooling | merged |
| 23 | 27 | Semantic tokens | dev tooling | merged |
| 24 | 28 | Workspace symbols, call hierarchy, find implementations | dev tooling | merged |
| 25 | 29 | `-opt` decisions panel and code lens | dev tooling | merged |
| 26 | 30 | `vidar fmt` | dev tooling | merged |
| 27 | 31 | Debugger support: `vidar build -debug` and a launch config | dev tooling | merged |
| 28 | 32 | Run the tests in CI before every release | infra | todo |
| 29 | 33 | Escape analysis through calls | bug | todo |
| 30 | 34 | Closure arrays returned through named results lose their type | bug | todo |
| 31 | 35 | Close 2 and 5 as not reproduced | bug | done |
| 32 | 36 | Goroutine dump and deadlock detection at N threads | scheduler | todo |
| 33 | 37 | Debug race check at N threads | scheduler | todo |
| 34 | 38 | Scheduler trace for Perfetto | scheduler | todo |
| 35 | 39 | Work stealing of goroutines that have run | scheduler | todo |
| 36 | 40 | Closure bodies that use the enclosing proc's constants, types and `$T` | language | todo |
| 37 | 41 | Anonymous struct literals everywhere | language | todo |
| 38 | 42 | Generic impls, and proc groups or polymorphic procs as bound methods | language | todo |
| 39 | 43 | Resolve field and enum-member uses in the analyzer | editor | todo |
| 40 | 44 | Forward rewritten lines to ols | editor | todo |
| 41 | 45 | Index the whole workspace at startup | editor | todo |
| 42 | 46 | Missing-import fix from `odin root` | editor | todo |
| 43 | 47 | Generated `json.unmarshal` | perf | todo |
| 44 | 48 | Hot/cold splitting across procs | perf | todo |
| 45 | 49 | Loop fusion and pipeline macros | perf | todo |
| 46 | 50 | `vidar new` | dev tooling | todo |
| 47 | 51 | Windows support | platform | todo |

## Tooling

### 17. Benchmark regression check
The closure regression (1) was only found by building an old commit by hand and comparing. That comparison should be a command.
- `npm run bench` runs `scripts/bench.js`.
- It builds `examples/negative_cost` twice, at the working tree and at a git ref (default `HEAD`; `--against <ref>` for another). The ref is built in a temporary worktree, so both builds run on the same machine in the same run, and no baseline file goes stale.
- Both builds use `-opt` and `odin build -o:speed` and run with `--bench`. Each section takes the median of 5 runs.
- It prints a table per section (old, new, change) and exits non-zero when a section is more than 15% slower. Sections under 0.5 ms are compared but never fail, since they are mostly noise.
- New sections in `negative_cost`: creating closures in a loop, calling a closure stored in an array, and calling a closure passed as a parameter. Those are the three shapes item 1 changes.
- `--section <name>` limits the run, and `--runs N` changes the run count.
- Not part of `npm test`: it is slow, and timings on a busy machine are flaky. Run it before merging any perf item.

### 20. VS Code extension in one command
The editor runs the LSP binary bundled in the installed `.vsix`, not `dist/`, so analyzer and LSP changes (inlay hints included) don't show until it is rebuilt and reinstalled.
- `npm run vsix` runs `build:binaries`, then `npm run package` in `editors/vscode`, then installs it with `"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" --install-extension editors/vscode/vidar-darwin-arm64-0.1.0.vsix --force` (`code` is not on PATH).
- It prints a reminder to reload the window.
- Run it after each wave that changes anything the editor shows. Check the inlay hints from the first batch in `examples/negative_cost`.

### 18. `@(no_alloc)` and `@(hot)`
Closures no longer allocate, so a proc can now be proven allocation-free. These attributes are promises the compiler checks.
- `@(no_alloc)` makes it a compile error when the proc, or anything it calls, can allocate:
  - `make`, `new`, `new_clone`, `append` to a dynamic array or map, string builders, `fmt.aprint*` / `tprint*`;
  - calls into `core:` or foreign code that aren't on a known non-allocating list;
  - calls through a closure or interface whose targets aren't all known.

  The error names the allocating call and the chain of calls that reached it.
- As a run-time backstop in builds without `-o:speed`, a `@(no_alloc)` proc sets `context.allocator` and `context.temp_allocator` to a panicking allocator on entry. Allocations the analysis missed then fail loudly in tests.
- `@(hot)` turns every `-opt` decision against something inside the proc into a warning: a bounds check left in, an indirect call, an allocation in a loop, a closure not inlined, `no table`. A missed optimization then shows up at build time and as an editor diagnostic, not only in `-opt-report`.
- Both read the existing `an.hint` decisions. They live in `src/autoopt.ts` and `src/analyzer.ts`.

### 21. Macro expansion on hover
Hovering a macro call shows the macro's signature, but not the code it generates. To see that today, you run *Vidar: Show Generated Odin* and find the spot in the whole file.
- Hovering the name of a macro call that generates code (`name!(...)`, `pkg.name!(...)`, a statement macro, a trailing-block call) adds the expansion below the signature, as an `odin` code block. Built-in macros from the prelude (`do!`, `dbg!`, `scoped!`, ...) count too.
- The text is what the emitter writes for that call: the analyzer's `_expansion` (or the statement block for a statement macro), printed the way the emitter prints macro output (`Pretty` in `src/emitter.ts`), with hygienic names as they come out. A macro used inside another macro's expansion shows its own expansion.
- Calls that generate no code show nothing extra: comptime procs called with `!` that return a value (`fib!(10)` shows the value it folded to, if that is cheap to add), and calls inside `comptime!` blocks.
- Long expansions are cut at about 40 lines, ending with a note on how many lines were left out.
- Lives in `src/lsp/features.ts` (hover). Add checks to `scripts/test-lsp.js` for an expression macro, a statement macro, a built-in macro and a macro from another package.
- No effect on generated code, so no fixture changes. Run `npm run vsix` afterwards.

### 19. Leftovers from the first batch
Small gaps the first batch's agents left open. One worktree, five commits:
- `reserve` for appends inside an `if` in the loop body, reserving the loop's trip count as an upper bound. Only when the element is small: a reserve can't be undone.
- `#soa` for typed declarations that have a value (`xs: [dynamic]Body = make(...)`).
- Hints inside macro expansions, placed at the macro call.
- Closure-literal specialization (#2 of the first batch) across files and packages, not just within one file.
- Cold-path hints on plain Odin `or_return`, not only Vidar's `catch` / `or_return X` / `errdefer`.

## Bugs

### 1. Closure call regression
"Closure, called through" in `negative_cost` went from 2.87 ms to 8.31 ms with closure values. The specialized copy is unchanged at 2.85 ms.
- **Cause:** the 128-byte `Env` is passed by value on every call and transmuted into a local in the body.
- **Fix:** the signature becomes `proc(^Env, ...)`, and the call passes `&callee.env`. Odin can't take the address of a parameter (`Cannot take the pointer address of 'c.env'`), so the emitter keeps every callee addressable:
  - a closure parameter that is called is copied into a local once, on entry;
  - `for f in closures` becomes `for &f in closures`;
  - a call result that is called right away goes into a temporary first.
- The body reads captures through `(^__Env)(__env_raw)`, with no copy.
- Re-measure creation, which writes 136 bytes per closure, with the new sections from 17.
- **Done when:** "called through" is within 5% of 2.87 ms, and no section is slower than at `14d4af1`.

### 2. `sched_pending_io` busy loop
The test's program once spun at 100% CPU for about 2 hours. This is probably a scheduler bug real programs can hit, not test flakiness.
- Reproduce: run the built program 500 times with a 10 s timeout each. When it hangs, take a stack with `sample` or `lldb`.
- Suspects in `src/sched.ts`: a poll that returns at once when nothing is runnable but I/O is pending, or a pending-I/O count that never reaches zero after a completion races with a park.
- Add a stress case that runs the scenario many times, and keep it under the runner's 30 s limit.
- Must be merged before 8.

### 3. Dangling by-reference captures in returned closures
`every` in `examples/slime_mud` returned `proc[n, &f]`, a pointer to its own parameter. The working tree already has the fix (`fp := new_clone(f)`, `proc[n, fp]`, `fp^(w)`); it is not committed.
What's left is making the compiler catch it next time:
- Error when a closure literal captures `&x` of a local or parameter, and the literal is returned, directly or through a local that is returned. Also when it is stored in a field, a global, or an `append` to something that outlives the proc.
- The message suggests `new_clone(x)`.
- Error cases go in `tests/errors/`. Check that no example or test case trips it by mistake.

### 5. Intermittent Odin compiler hang
About one test run in three has a single flaky failure. The Odin compiler spins on a build that normally takes 0.2 s (seen on `closure_types` and `macro_types_strings`).
- Reproduce by building those outputs 200 times with a timeout, then take a stack of a hung `odin`.
- Lead: Odin always hangs on a parapoly struct with blank `_` field names. Check whether generated code still produces that pattern anywhere (runtime, `sched`, macro output).
- Then either work around it in the emitter, or minimize it and record it as an Odin bug. The runner's retry stays either way.

## Performance

### 6. Value interfaces / closed unions
An interface value is `struct { data: rawptr, __vtable: ^VTable }` and needs `&x` or `new_clone(x)`. Interfaces are now the main source of heap allocations, as closures were before.
- Lowering: a union of the impl types, `union { Circle, Rect, ... }`, stored inline, with `switch` dispatch. This needs every impl to be known, as `Pool` and the dispatcher already require.
- **Decide before starting:** this changes semantics. Today a copied interface value shares its data; a union copies it. Two options:
  - a separate value form that the coder chooses, matching closure values (copy semantics, lifetime is the coder's job);
  - an `-opt` rewrite, applied only where nobody can tell the difference: no method mutates through the receiver, or the value is never copied after conversion.
- Size: impls bigger than a limit stay behind a pointer, so the union doesn't bloat. Report each choice with `an.hint`.
- Bench: the existing "interface array" section and a new one that converts values in a loop.

### 7. Generated per-type printers and JSON code
`fmt %v` on structs and `encoding/json` walk type info at run time. Generated code for a known type is typically several times faster.
- Under `-opt`, `%v` / `%#v` for a struct, enum, array or slice of a known type becomes a generated `__print_T(b: ^strings.Builder, v: T)` that writes the fields directly. Nested types get their own printers.
- `json.marshal` / `json.unmarshal` of a known type get generated encode and decode procs with the same field names and tags.
- Output must be byte-identical to `fmt` / `encoding/json`. Test cases print through both and compare.
- Extends the existing fmt-format lowering in `src/fmtspec.ts` / `src/optimize.ts`.

### 8. Multithreaded (M:N) scheduler
Goroutines run on one thread today, so concurrent programs use one core.
- N worker threads (default: the number of cores), each with its own run queue, plus work stealing. Channels and the I/O poller become thread-safe.
- **Opt-in:** `-define:VIDAR_THREADS=N`, default 1. Programs that share memory between goroutines without synchronization are safe on one thread and become data races on several.
- Keep `slime_mud` and the `sched` tests passing at 1 and at N threads, and add a CPU-bound fan-out bench.
- Starts after 2 is merged, since both change `src/sched.ts`.

### 9. Constant-size `make` on the stack
`x := make([]T, N)` with a constant `N` and a matching `defer delete(x)` in the same scope becomes `x_buf: [N]T; x := x_buf[:]`.
- Only when `x` doesn't escape: it isn't returned, stored, captured by reference into an escaping closure, or passed to something that keeps it.
- Size cap: 4 KB in a proc that a goroutine can reach (goroutine stacks are small), 64 KB elsewhere.
- Hint: `stack buffer` / `no stack buffer: <reason>`. Lives next to alloc grouping in `src/optimize.ts`.

### 10. Wider bounds-check elimination
Today an index is only unchecked when it is proven in bounds directly. To add:
- **Hoisting:** `for i in 0..<n { a[i] }` where `n` isn't `len(a)` gets one check before the loop (`n <= len(a)`, else the same bounds panic) and unchecked indexes inside. Same panic, earlier.
- **Lockstep:** `for x, i in a { b[i] }` checks `len(b) >= len(a)` once.
- **Constant offsets:** `src[i + k]` in `for i in 0..<len(src) - k`.
- Extends `provenIndexes` in `src/optimize.ts`, and adds a bench section for each shape.

### 11. String `switch` through a perfect hash
`switch s { case "a", "b", ... }` with 8 or more string cases compares one string after another.
- Under `-opt`, vidar finds a perfect hash for the case strings at compile time (length plus a few bytes, or a seeded FNV with a seed search), switches on the hash, then does one string compare to confirm.
- Below 8 cases, or when no hash is found within a step limit, the switch stays as written. Report it with `an.hint`.

### 13. Automatic `@(memo)` and two-parameter `@(table)`
The transpiler applies both on its own under `-opt`, as it already does for one-parameter `@(table)` and `@(specialize)` (`src/autoopt.ts`). The attributes also exist for doing it by hand, with `@(no_memo)` to opt out.
- **Two-parameter tables:** a pure integer proc whose two parameters both have small constant domains gets a 2D table. Same purity and cost rules as one-parameter tables, and a limit on the domain product.
- **Memo:** a pure proc that recurses into itself more than once per call (exponential recursion, like `fib`) is memoized:
  - the outer call creates the memo table, the recursive calls share it, and it is freed when the outer call returns, so there is no global state and nothing to share across goroutines;
  - an array when the arguments have a bounded domain, otherwise a map.
- Hints: `table 2D`, `memo`, and `no memo: <reason>`.

### 15. Struct field reordering, then hot/cold splitting
- **Reordering:** under `-opt`, a struct's fields are sorted by alignment, largest first, to cut padding. Only where the layout can't be observed:
  - not `#packed`, `#raw_union` or `#align`, and not used with foreign code;
  - never transmuted, cast to bytes, or used with `offset_of`;
  - never printed with `%v` or serialized, since output follows field order. After 7, generated printers can keep the declared order, which lifts this restriction.

  Positional struct literals `T{1, 2}` are rewritten to named fields.
- **Hot/cold splitting** comes second: for a `[dynamic]T` whose hot loops touch few fields, move the rarely used ones to a parallel array. Same use analysis as automatic `#soa` (`src/soa.ts`), for cases `#soa` doesn't take.
- Hints: `reordered: <bytes> saved`, or the reason not to.

## Developer tooling

Items 22 to 31 make Vidar nicer to work in day to day. None of them changes generated code, so none should change a fixture. Each is built in its own worktree and merged one at a time, like the perf items.

### 22. `vidar test`
There is no way to unit-test a Vidar program.
- `vidar test <dir|file> [-opt] [-- odin flags]` transpiles to a temp dir and runs `odin test` on it, so `@(test)` procs (with `t: ^testing.T`) work as in Odin.
- `-define:ODIN_TEST_NAMES=...` passes through, plus a `--run <name>` shorthand for it.
- Failures, `testing.expect` messages and panics are reported at `.vidar` locations (shares item 23's mapping).
- Exits with `odin test`'s status. New `examples/testing` with passing tests, and an error-path check in the runner for a failing one.

### 23. Run-time crash locations mapped to `.vidar`
Panics, failed `assert`s, bounds-check failures and `testing` messages print locations in the generated `.odin`.
- `vidar run` and `vidar test` pipe the program's stderr (and stdout for `testing`) through a filter that rewrites `path.odin(line:col)` to the `.vidar` location, with the same mapping `mapLocations` in `src/cli.ts` uses for compile errors.
- Only exact generated paths are rewritten; everything else passes through unchanged and unbuffered per line.
- `vidar build` can't wrap the program, so it also writes `<out>/vidar.map.json`, and `vidar map <out> < log` rewrites a saved log.

### 24. `--watch`
- `vidar run --watch`, `check --watch` and `test --watch` rerun when a `.vidar` file in the program (every package it imports from the project, not `core:`) changes.
- Debounced (about 100 ms); a running program is killed before the rerun; the screen is not cleared unless `--clear`.
- `fs.watch` with a polling fallback where recursive watching isn't supported.

### 25. Expand-at-cursor view
Hover shows a macro's expansion (21); *Show Generated Odin* shows the whole file. In between: the Odin for the construct at the cursor.
- A *Vidar: Expand at Cursor* command (custom LSP request `vidar/expandAt`) shows the generated lines for the statement at the cursor (a closure literal, `catch`, `do!`, a `go` call, a lowered `for`, an interface call), using the line structure the emitter keeps.
- Opens in a side editor as Odin, updates when the cursor moves to another statement. A `-opt` toggle shows the `-opt` output.

### 26. Code actions
Quick fixes for the common compile errors, from the analyzer's diagnostics.
- Converting a plain value to an interface: `&x` is the preferred fix (what "fix all" and fix-on-save apply). `new_clone(x)` is a separate action, never preferred, labelled "Allocate a heap copy (new_clone, caller frees)": an allocation is never added without the coder choosing it. When `src/escape.ts` says `&x` would dangle, only the `new_clone` action is offered, with why.
- A missing import for a known package (`fmt.println` without `import "core:fmt"`).
- An opt-out attribute (`@(no_table)`, `@(no_specialize)`, ...) from an `-opt` hint, when the coder wants the decision undone.
- Writing to a by-value capture: capture by reference (`&x`) instead.

### 27. Semantic tokens
Only a TextMate grammar today, so closures, interfaces, captures and macros look like any other identifier.
- `textDocument/semanticTokens/full` (and `/range`) from the analyzer's symbols: interfaces, interface methods, closures and closure parameters, captured variables (by value and by reference), macros, comptime calls, goroutine calls. Generated `__` names never get a token.
- Standard token types where they fit (`interface`, `function`, `parameter`, `macro`), modifiers for `captured`, `byRef`, `readonly`. The extension maps the custom ones to theme scopes.

### 28. Workspace symbols, call hierarchy, find implementations
- `workspace/symbol` over every package the server has analyzed.
- `textDocument/implementation`: from an interface, its implementations (the analyzer's `variants`); from an interface method, the bound procs.
- `callHierarchy/*`: incoming and outgoing calls, through proc groups and closed interfaces where the analyzer knows the targets.

### 29. `-opt` decisions panel and code lens
`-opt-report` prints every decision, and inlay hints show them inline, but there is no overview.
- A code lens over each proc: "N optimizations, M not" (from `an.hint`), which opens the list.
- A *Vidar: Optimization Report* tree view in the extension, grouped by file and proc, decisions against marked, each entry jumping to its location. Custom request `vidar/optReport`.

### 30. `vidar fmt`
- Formats `.vidar` files: plain Odin parts through `odinfmt` when it is on PATH, Vidar syntax (closures, `catch`, macros, `interface`, `impl`) laid out by the same rules (tabs, spacing around operators, brace style).
- `--check` exits 1 when a file would change, `--write` rewrites in place (default prints to stdout). LSP `textDocument/formatting`.
- Must be idempotent and must never change what a file transpiles to apart from whitespace; the runner checks both over every case.

### 31. Debugger support
Odin has no `#line` directive, so stepping happens in the generated Odin.
- `vidar build -debug` builds with `odin build -debug`, keeps the generated `.odin` next to the binary, and writes a `vidar.map.json` (shared with 23).
- The extension adds a `vidar` debug configuration that runs `vidar build -debug` and launches lldb (CodeLLDB) or gdb on the result, plus *Vidar: Show Generated Odin* opening at the line matching the current `.vidar` line so breakpoints can be set there.
- README section on debugging.

## Wave 5

What was left after the developer tooling: open bugs, scheduler debugging, language limits from README's "Limits", editor gaps, the open perf items, and platforms.

### 32. Tests in CI
`.github/workflows/build.yml` builds and releases on every push to `main` without running a test.
- A `test` job on ubuntu-24.04 and macos-14 (arm64): Node 20, Odin from the same nightly the release uses, `npm ci`, `npm test`. The release jobs `needs:` it.
- `ols` is optional; the LSP suite skips its checks without it.
- Also run `node scripts/test.js` once with `VIDAR_ODIN_FLAGS="-define:VIDAR_THREADS=4"` and `npm run stress -- tests/cases/sched_pending_io -n 500`, so 2 and 5 get more machines.
- Upload `$TMPDIR/vidar-stress-*/hang-*.txt` as an artifact on failure.

### 33. Escape analysis through calls
`src/escape.ts` follows a `&x` closure (and, since 26, an interface value pointing at a local) through locals, but not into calls, so passing one to `sched.go` or to a proc that stores it dangles unnoticed.
- A per-proc summary: for each parameter, whether the proc lets it escape (returns it, stores it through a pointer, in a field, a global or a slice it doesn't own, appends it to something it doesn't own, passes it to `sched.go`, or passes it to another parameter that escapes). Computed to a fixed point over the call graph, across packages.
- At a call, an argument holding `&x` of the caller's local goes through the summary. `sched.go` and `sched.go_*` count as escaping.
- Unknown callees (proc values, foreign, `core:`) are trusted, as now; say so in README's Limits.
- Error message names the call and the callee's line where it escapes. Cases in `tests/errors/`.

### 34. Closure arrays through named results
`fs := make_closures()`, where `make_closures` has a named result of type `[8]closure(int) -> int`, loses the closure type; `f(x)` in `for f in fs` then fails in Odin with "Cannot call a non-procedure". Found while writing item 17's bench section.
- Make the result's declared type flow into `:=` for named results, as it does for unnamed ones. Check fixed arrays, slices and dynamic arrays of closures, and a struct holding one. New case.

### 35. Close 2 and 5
Neither reproduced: 2000 runs of `sched_pending_io` on the M3 and thousands on linux/amd64 found no hang; the compiler spin never came back on linux. Closed; 32 runs both checks on every push, and they reopen if CI catches one.

### 36. Goroutine dump and deadlock detection at N threads
- On a deadlock (every goroutine parked, no I/O pending, no timers) and on SIGQUIT (unix), print every goroutine: its id, where it was started (`go` call site, as `.vidar` via the run map), what it is parked on (channel and direction, `Mutex`, `Wait_Group`, `select`, I/O, sleep) and where it parked.
- At `VIDAR_THREADS>1`, a deadlock waits forever today. Detect it with a global count of runnable goroutines and of threads idle, checked when a thread goes idle; then dump and panic as at 1 thread.
- Off in `-o:speed` builds unless `-define:VIDAR_SCHED_DEBUG=true`, except the deadlock panic itself, which stays.

### 37. Debug race check at N threads
`-define:VIDAR_RACE=true` (only with `VIDAR_THREADS>1`): each global and each `&x`-captured local that more than one goroutine can reach gets a shadow word with the last writer's goroutine and a happens-before epoch, bumped by channel operations, `Mutex`, `Wait_Group` and `go`. A write from another goroutine with no ordering between them prints both sites and continues. Cheap and partial, not a full race detector; the docs say what it misses.

### 38. Scheduler trace
`-define:VIDAR_SCHED_TRACE=true`: a ring buffer per thread of `go`, park (with reason), wake, steal, I/O submit/complete and thread idle, with timestamps. Written at exit (or SIGQUIT) as Chrome trace JSON (`vidar-trace.json`, `VIDAR_TRACE_FILE` overrides), viewable in Perfetto. Zero cost when off.

### 39. Work stealing of goroutines that have run
A goroutine stays on the thread that first ran it, because LLVM may keep a thread-local's address across the stack switch. Make moving safe, then steal any runnable goroutine:
- Read the scheduler through a pointer kept in the goroutine's own state (or a non-inlined accessor that LLVM can't cache), so nothing thread-local survives a switch; verify with `-o:speed` and `-build-mode:llvm-ir`.
- Steal half of another thread's queue when idle; the park/wake handshake needs a state word per goroutine (running, parking, parked, runnable) since the waker may then be on another thread.
- `examples/fanout` with uneven jobs as the bench; stress at 2 and 4 threads with `-opt -o:speed`.

### 40. Closure bodies and the enclosing proc's declarations
Closure bodies are lifted to file scope, so they can't use the enclosing proc's local constants or types, or its `$T` parameters.
- Local constants and types the body uses are lifted with it, renamed (`__Local_N`), when they don't depend on runtime values or on `$T`.
- Inside a polymorphic proc, the closure's body proc is emitted as a nested proc declaration inside the polymorphic proc instead of at file scope, so `$T` resolves (Odin allows nested procs that use the outer's constants and types).
- Cases for each; README's Limits updated.

### 41. Anonymous struct literals everywhere
They only work in `:=` declarations inside procs. Allow them at file scope (`x := struct{...}{...}` globals) and in `if`/`for`/`switch` initializers, and as call arguments where the parameter type is inferred.

### 42. Interfaces: generic impls, proc groups and polymorphic procs
- `impl Shape for Box($T)` (an impl for a parametric struct): a vtable per instantiation the program uses.
- A proc group or a polymorphic proc as a bound method: pick the overload, or instantiate, for the impl's type at vtable construction.
- Errors where a choice is ambiguous.

### 43. Field and enum-member uses
`x.field` and `.Red` / `Color.Red` aren't resolved by the analyzer, so hover, go to definition, rename, references and semantic tokens don't work on them.
- Resolve selector fields through the analyzer's types (struct fields, `using` fields, `#soa`, pointers), and implicit enum selectors where the expected type is known (assignments, comparisons, `case`, call arguments, returns).
- Feed `features.ts` (hover, definition, references, rename) and `semantic.ts` (`property`, `enumMember` at uses).

### 44. Forward rewritten lines to ols
Lines vidar rewrites (a line that uses a by-reference capture, say) aren't forwarded to ols, so hover and completion on plain Odin parts of them are lost.
- Use the emitter's column map for rewritten lines: record, for each source token kept in the output, its output column. Forward a request on such a token at its mapped position.
- Can't be tested here without ols; the tests skip as the others do.

### 45. Workspace index at startup
The `-opt` report and workspace symbols only cover programs the server has analyzed, which means files that have been opened. On `initialized`, find every package directory under the workspace folders that holds `.vidar` files (skipping `out/`, `node_modules/`, `.git`, `expected/`), and analyze each program root in the background, lowest priority, debounced.

### 46. Missing-import fix from `odin root`
The quick fix knows about 40 packages from a fixed table. Read `odin root` once (cached), list `core/`, `base/` and `vendor/` package directories, and offer every package whose last path part matches. Keep the table as the fallback when `odin` isn't on PATH.

### 47. Generated `json.unmarshal`
Item 7 generates `json.marshal` only. Generate `json.unmarshal(data, &x)` for the same shapes: a hand-written parser over the bytes (strings with escapes, numbers, bools, null, nested objects and arrays), fields matched by key (with `json:` tags), unknown keys skipped, and encoding/json's errors for the same inputs. Same `when T ==` guard. Bench against encoding/json in `negative_cost`.

### 48. Hot/cold splitting across procs
For a `[dynamic]T` whose hot loops (in any proc it is passed to) touch few fields, store the rarely used fields in a parallel array. Interprocedural: every proc the array reaches must be rewritten consistently, or it isn't split. Same refusal rules as reordering (15) for anything that can see the layout. Bench section in `negative_cost`.

### 49. Loop fusion and pipeline macros
- Macros `map!`, `filter!`, `fold!` (or a `|>` pipeline) over slices and dynamic arrays that expand into one loop with no intermediate arrays.
- `-opt` fusion of adjacent plain loops over the same range when neither reads what the other writes after it.
- Bench sections for both.

### 50. `vidar new`
`vidar new <dir> [--lib]`: `main.vidar` (hello world, or a library package with a test), `.gitignore` (`out/`), a `.vscode/launch.json` with the `vidar` debug configuration, and a README stub. Refuses a non-empty directory.

### 51. Windows
- Stack-switching assembly for windows/amd64 (Win64 calling convention: callee-saved xmm6 to xmm15, the TIB stack fields) in `vidar:sched`.
- Paths: the run map, the CLI and the LSP with `\` and drive letters.
- Can't run here: check that the generated code builds with `odin build -target:windows_amd64` and that `odin check` passes; CI (32) gets a windows job once it runs.

## Parallel plan
- **Wave 1 (tooling first):** 17, 20, 18, 21 and 19, plus 2, 3 and 5. These touch mostly separate files. Merge in priority order: 17, 20, 18, 21, 19, then the bugs.
- **Wave 2:** 1, measured with 17, merged first because it is a small emitter change that the rest build on. Then 6, 7, 9, 10, 11, 13 and 15 in parallel.
  - Expected conflicts: `src/emitter.ts` (1, 6, 7, 11, 15), `src/optimize.ts` (9, 10, 19), `src/autoopt.ts` (13, 18), `src/analyzer.ts` (3, 6, 15, 18).
- **Wave 3:** 8, after 2 is merged.
- **Wave 4 (developer tooling):** 22 to 31 in parallel. Expected conflicts: `src/cli.ts` (22, 23, 24, 30, 31), `src/lsp/server.ts` and `src/lsp/features.ts` (25 to 30), `editors/vscode` (25, 27, 29, 31). Merge order: 23, 22, 24, 31, 30, then the language-server items 26, 28, 27, 25, 29.
- **Wave 5:** 32 to 51, in 10 worktrees: (32, 46, 50), (33, 34), (36, 38, 37, 39) in that order since they share `src/sched.ts`, (40, 41), (42), (43, 45, 44), (47), (48, 49), (51). Expected conflicts: `src/sched.ts` (36 to 39, 51), `src/analyzer.ts` and `src/emitter.ts` (33, 34, 40 to 43, 47 to 49). Merge source, then regenerate fixtures.
- After each wave: `npm test`, `npm run bench`, and `npm run vsix` if the editor's output changed.

## Not in this batch
- Loop fusion and pipeline macros, PGO for dispatch order, and the smaller scheduler items (single-sender/single-receiver channels, stack-size inference, preemption).

## Log
- **Wave 4 (developer tooling) merged.** All of 22 to 31 are in; `npm test` passes (70 unit, 337 case, 198 LSP checks). Not tried in a real VS Code yet: run `npm run vsix` on the M3.
  - **22, `vidar test`** (with 23 and 31, one worktree). `vidar test <in> [-opt] [--run a,b] [-- odin flags]` transpiles to a temp dir and runs `odin test`, exiting with its status; `--run` becomes `-define:ODIN_TEST_NAMES=<pkg>.<name>`; `test --watch` works. New `examples/testing`, and `tests/vidar_test/failing` (a failed expect, a failed assert and a bounds-check panic, at lines a `catch` shifts), checked by two `testing: ...` steps in `scripts/test.js`.
  - **23, run-time locations.** `src/runmap.ts`: both shapes Odin prints, `path.odin(L:C)` and `[file.odin:L:proc()]` (the second only when the base name is unique). `vidar run` streams stderr through the filter, `vidar test` both streams; a partial line is written after 50 ms of quiet. Every build writes `<out>/vidar.map.json`, and `vidar map <out> < log` rewrites a saved log. `mapLocations` uses it; a compile error on a helper line vidar added now keeps its generated path instead of a `.vidar` path with the wrong line.
  - **31, debugging.** `vidar build -debug` keeps the `.odin` next to a `-debug` binary. The extension has a `vidar` debug type that builds and then starts CodeLLDB (`lldb`) or gdb (`cppdbg`); `vidar.cliPath`; the bundled binary runs the CLI with `VIDAR_CLI=1`. *Show Generated Odin* opens at the cursor's line (`vidar/generatedOdin` takes a `line`), in the debug build's real file when it is current, so breakpoints bind. Checked with lldb by hand on linux.
  - **25, Expand at Cursor.** `src/lsp/expand.ts`, `vidar/expandAt { uri, position, opt? }`: the output lines whose line map falls in the statement's lines, plus the helper declarations they name (`__closure_N`, `__fmt_N`, two levels, at most 12). An unchanged statement shows the innermost enclosing one that changed, never a whole top-level declaration. The extension's view follows the cursor and has a `-opt` toggle.
  - **26, quick fixes.** `src/lsp/actions.ts`. Interface conversion: "Use a pointer to it (&x)" is preferred; "Allocate a heap copy (new_clone, caller frees)" is a separate action, never preferred, and `source.fixAll` applies only preferred fixes, so an allocation is never added without being chosen. When `&x` would dangle (the shared walker in `src/escape.ts` now also follows interface values) or isn't possible (parameters, loop values), only `new_clone` is offered, and the diagnostic says why. Also: capture by reference for a write to a by-value capture, a missing import for about 40 known packages (an LSP-only diagnostic), and the opt-out attribute for an automatic table, specialization, memo, stack buffer or perfect hash. `CompileError` carries an optional `fix`; in tolerant (editor) analysis an interface-value error no longer stops the rest of the proc. Error messages are unchanged.
  - **27, semantic tokens.** `src/lsp/semantic.ts`, full and range. Standard types, plus modifiers `captured`, `byRef`, `closure`; `readonly` on by-value captures, `defaultLibrary` on prelude macros and `vidar:sched`, `async` on `sched.go`. Not done: enum members and fields at their uses (the analyzer doesn't resolve those names).
  - **29, optimization report.** `src/lsp/optreport.ts`: `vidar/optReport` groups `an.hint` decisions by file and enclosing proc; a code lens over each proc ("N optimizations, M not", off with `optHints: off` or `vidar.optCodeLens: false`); the extension's *Vidar: Optimization Report* explorer view.
  - **30, `vidar fmt`.** `src/format.ts`, token-based: only the whitespace between tokens changes, never a token's line, so blank-line runs stay (line numbers reach the program through `call_site()`, `dbg!`, `#assert`). Indents by bracket depth, spaces binary operators, commas and declaration colons; leaves alone what it can't be sure of (unary operators, ranges, `@(...)`, alignment runs). Re-lexes its output and refuses on any token change. `--check`, `--write`, LSP formatting. `tests/unit/fmt.test.js` checks idempotence over every `.vidar` file and that scrambled-then-formatted cases emit the same tokens, with and without `-opt`. Doesn't use odinfmt.
  - **Merging:** the agents' three copies of the ols-crash fix were dropped for 4337b74; conflicts in `server.ts`, `cli.ts`, the extension and README were unions of both sides.
- **28, workspace symbols, call hierarchy, find implementations** merged. `src/lsp/navigation.ts`, reusing `features.ts`' index. `workspace/symbol` over every analysis the server holds (substring, then in-order letters; no `__` names). `textDocument/implementation` on an interface (its `variants`, extending interfaces' implementations included) or an interface method (the bound procs). Call hierarchy on procs, proc groups (a group call counts for each member), interface methods (a closed interface's call counts for every bound proc) and macros (calls in an expansion sit at the macro call); items are keyed by declaration position, so incoming calls are found across packages. Not followed: calls through closure values or proc variables. New workspace `tests/lsp/nav/`, 17 checks.
  - Also fixed: with no `ols` on PATH on Node 22 the server crashed on the first opened file (the handshake was written before the process spawned, and the rejected write killed the server). Two LSP checks made stale by items 9 and 10 are updated (`make([]int, 16)` is now a stack buffer, not a grouped alloc; `@(hot)` uses an index that can't be proven).
- **24, `--watch`** merged. `src/watch.ts`: `vidar run --watch` / `check --watch` rerun the whole `vidar` command as a child (own process group, SIGTERM then SIGKILL on a change, so what `odin run` started dies too). Watches each project package directory with `fs.watch` (rename-saves work, no recursive watch needed), falls back to `fs.watchFile` polling; the file set is reloaded in tolerant mode before each run, so new imports and broken programs are handled. 100 ms debounce, `--clear`. `.odin` files in project packages count too. `test --watch` is one line (`WATCH_COMMANDS`) once `vidar test` exists. 8 unit tests in `tests/unit/watch.test.js`.
  - Also fixed: the `@(hot)` unit test expected `no bounds proof` on `b[i]`, which item 10 now proves (it indexes with `a[i]` now), and `npm test` / `test:unit` pass a glob to `node --test`, since a directory fails on Node 22.
- **8, multithreaded scheduler** merged, started before 2 on request (2 is still open).
  - `-define:VIDAR_THREADS=N`, default 1. At 1, every new lock is a `when MULTI` that compiles to nothing, and `pick` is the old loop, so existing programs are unchanged.
  - At N: thread 0 (the first to call into `sched`) starts N-1 scheduler threads, each parked forever on its own stack so it only runs goroutines. Each thread has its own run queue (behind a mutex), event loop and stack pool. `go` hands goroutines out round robin and wakes that thread (`sema_post` and `nbio.wake_up`). A thread with nothing to run takes an unstarted goroutine from another thread's queue, then waits on its semaphore or its event loop for up to 10 ms (`IDLE_POLL`) and looks again.
  - A goroutine stays on the thread that first runs it (`G.owner`). It isn't safe to move one after it has run: LLVM may keep a thread-local's address across the stack switch, and the goroutine would read the old thread's scheduler. Pinning also makes parking simple: a wakeup from another thread only queues the goroutine on its owner, which is the thread parking it, so locks are released before `park`, and a wakeup that comes first just means the owner picks the same goroutine again. Each thread's own stack (`sched.main`) counts as started, or `main` could be stolen.
  - Channels, `Mutex` and `Wait_Group` have a guard each; `select` takes its channels' guards in address order and claims its case with a compare-and-swap; `workers.next` is atomic. A goroutine started on another thread gets that thread's temp allocator.
  - Not done: moving goroutines that have run (real work stealing), and deadlock detection at N > 1, where a deadlock waits forever.
  - Tests: the whole suite passes 4 times in a row with `VIDAR_ODIN_FLAGS="-define:VIDAR_THREADS=4"`; `examples/sched_io` now prints the mutex order sorted, since several threads may take the lock in any order. New case `sched_fanout` (fan-out, a contended `Mutex` with a `Wait_Group`, `select` over closing channels, unbuffered ping-pong), stressed 200 times at 2 and at 4 threads, and 150 times with `-opt -o:speed` at 4, with `examples/goroutines`, `sched_io` and the pending-I/O cases: no hang, no wrong output. slime_mud's bench runs at 4 threads with no failed clients.
  - `examples/fanout` (64 jobs of 2 million steps): 60 ms at 1 thread, 33 at 2, 16 at 4.
- **15, struct field reordering** merged; hot/cold splitting is not done.
  - `src/reorder.ts`, run once per program from `autoOptimize`. Candidates: plain structs declared in the program (not in `vidar:sched`), at least two field groups, every field type's size and alignment known exactly (Odin's rules: basic types, pointers, slices 16, dynamic arrays 40, maps 32, fixed arrays, enums by base type, nested plain structs; closures are out, since `VIDAR_CLOSURE_ENV` sets their size). Field groups are sorted by alignment, largest first, stably; only when that saves bytes.
  - Refused, with the reason as a `not reordered` hint, when anything could see the layout: `size_of`/`align_of`/`offset_of`/`type_info_of`/`typeid_of`/`type_of`/`transmute` on it, a cast or conversion of something holding it, a map key holding it, a value holding it converted to `any` (a declaration or a vidar proc parameter of type `any`), a value holding it passed to anything but vidar procs, interface methods and closures (that is: core, foreign and proc values, and so fmt and encoding/json), a mention in a foreign block, or an exported proc taking it. Values whose type the analyzer can't tell are judged by the variables in them.
  - Positional literals: typed ones, and untyped ones inside a typed array literal or as a typed declaration's value, get field names (`_fix` prefixes). An untyped positional literal vidar can't place refuses every candidate with that many fields.
  - `negative_cost` "structs, reordered" (1,000,000 40-byte structs that become 24, one pass per rep): 112 → 53 ms.
  - Not done, hot/cold splitting: inside one proc, automatic `#soa` already splits every field into its own array, which serves the same loops. Splitting arrays that cross proc boundaries means rewriting every parameter and call they pass through, which is a different, interprocedural optimization.
  - New case `opt_reorder`.
- **6, value interfaces** merged, as the second option: an `-opt` rewrite where nobody can tell the difference, with no new syntax (the value form for the coder to choose can still come later).
  - `src/valueiface.ts`: a local `[dynamic]I` (typed or from `make`) of a closed interface without bases or extensions, whose every use is `append(&xs, new_clone(v))` with `v` of an implementation type, a `for s in xs` whose `s` is only a method receiver, `m(xs[i], ...)`, `len`, `cap`, `clear(&xs)` or `delete(xs)`, and nothing in a loop over it touching it. Not captured by a closure. Each implementation at most 64 bytes, and each bound method uses its receiver only through `.field` or `^`, so no pointer to an element can be kept past a reallocation.
  - Emitted as `[dynamic]__I_Value` (`union { T1, T2, ... }`), `append(&xs, v)`, `for &s in xs`, and `__I_v_m(&s, ...)`: a `#force_inline` type switch calling the bound proc with `&v`.
  - `negative_cost`: new "interface values, built" (10,000 shapes appended and summed, 50 times), plain vs `-opt`: 10.8 → 2.6 ms; no allocation per element. "interface array" (the loop alone) is unchanged against `-opt` before this (4.0 vs 4.2 ms), which already devirtualized those calls and had the clones packed by the temp allocator.
  - New case `opt_value_iface`: in-place growth through `for s in xs` and `xs[0]`, and the three refusals (a clone converted twice, an element kept in a variable, an append inside a loop over the array).
- **7, JSON (second half)** merged: `json.marshal`; `json.unmarshal` is not done.
  - `src/jsonopt.ts`: `json.marshal(x)` with one argument (default options) and a type resolved like the printers' (structs may have tags here) calls `__json_marshal_T(x)`, a `$T` proc whose `when T == <type>` branch writes with generated `__jsonw_T` procs and whose `else` calls `json.marshal`. It follows `marshal_to_writer` for `.JSON`, not pretty: keys through `io.write_quoted_string` (not escaped for JSON, so keys needing escapes are left to encoding/json), string values with `for_json`, runes quoted, floats through `io.write_f16/f32/f64`, enums as their integer value, `json:"name"`, `json:"-"`, and `omitempty`, which drops only what `is_omitempty` calls empty (strings, slices, dynamic arrays; a 0 int stays). Programs that register their own marshalers keep encoding/json.
  - `negative_cost` "json.marshal of a struct" (the same `Particle`), plain vs `-opt`: 172 → 77 ms.
  - New case `opt_json`, compared with encoding/json called through a proc value.
  - Why not unmarshal: encoding/json first validates the whole input (`is_valid`), coerces between integers and floats, and reports `Unsupported_Type_Error` with the token where it failed, all through private procs (`unmarshal_value`, `unmarshal_object`). A generated decoder would have to reimplement the parser to give the same errors on bad input. That is a separate item if wanted.
- **7, generated printers (first half)** merged; JSON is next.
  - `src/printers.ts`. In a lowered fmt call, a `%v` / `%#v` argument whose type resolves to a plain struct (no parameters, directives, `using`, tags or `any` fields), an enum without explicit values, or a fixed array, slice or dynamic array of those, strings and numbers, goes to generated `__print_T(w, x)` / `__printh_T(w, x, indent)` procs. They follow `fmt_struct` / `fmt_write_array` exactly: `Name{a = 1, b = 2}`, strings and enum names quoted inside composites, runes raw, `%!(BAD ENUM VALUE=n)` through fmt, `nil` for a nil slice with a length, `%#v`'s tabs and trailing commas, and the count, which leaves out the ", " between fields as fmt's does.
  - Each call sits under `when T0 == <type>`, with fmt as the `else`, so an analyzer type that's off (it calls `dy[:]` a dynamic array) costs nothing but the optimization. Programs that call `register_user_formatter` keep fmt everywhere.
  - Floats now go to `fmt.fmt_float` directly (`w_float`), in printers and for `%v` of a plain float.
  - `negative_cost` "fmt %v of a struct" (`sbprintf` of a 5-field struct with a `[3]f32` and a `[]string`), plain vs `-opt`: 90 → 63 ms. The rest is the leaves, which stay fmt's code: quoted strings and floats.
  - New case `opt_printers` checks each shape against fmt called through a proc value (which `-opt` leaves alone), the returned counts, and a builder sink.
  - Found on the way, in Odin: `any(o)` inside a big slice literal (`[]string{fmt.tprint(any(o)), ...}`) gets a garbage data pointer and crashes fmt; and a slice literal inside a struct literal doesn't outlive its statement. The test avoids both.
- **13, automatic `@(memo)` and two-parameter `@(table)`** merged.
  - 2D tables: `@(table)` takes two `bool`/`u8`/`i8` parameters (`table[x][y]`, computed at compile time or filled at startup). `-opt` makes one on its own under the one-parameter rules (pure integer code, a loop or 24+ operations) when there are at most 4096 results, since each is computed at compile time; past that it hints `no table 2D`.
  - `@(memo)` (`src/memo.ts`): the declaration becomes `__f_memo_body(..., __memo)` in place, with its calls to itself going to `__f_memo`; the helpers add `f` (makes the table, frees it on return) and `__f_memo` (look up, or compute and store). An array of `done`/`value` when every parameter is `bool`/`u8`/`i8` and there are at most 4096 results, else a map, keyed by a struct for several parameters. By hand on any proc with basic or enum parameters and one result; `-opt` adds it to pure integer procs (`integerOnly`) that call themselves at least twice, unless the program has `@(no_alloc)` procs (the table allocates, which their checks wouldn't see). `@(no_memo)` opts out. Hints `memo` / `no memo`.
  - `negative_cost` "fib, memoized" (fib(32)): 7 ms plain, 0.02 ms with `-opt`.
  - New cases `opt_table_2d`, `opt_memo`; error cases `table_three_params`, `table_two_params_enum`, `memo_bad_key`, `memo_and_no_memo`.
- **11, string `switch` through a perfect hash** merged (`src/strswitch.ts`). A `switch` with a string tag whose cases are all string literals, 8 or more, distinct and without `\x`/octal escapes, gets its tag rewritten to `__strswitch_N(tag)` and each literal to its index. The generated proc hashes, looks the slot up in an `@(rodata)` table and confirms with one compare, returning -1 (the default case) otherwise. The hash is found at compile time: first the length and the first, middle and last bytes mixed by an odd multiplier, then seeded FNV-1a, each with tables of 2^⌈log2 n⌉ to 4× that and 20,000 seeds per size; the TypeScript search computes exactly the Odin u32 arithmetic. Everything is rewritten in place, so lines and `fallthrough` stay. `@(no_perfect_hash)` opts out.
  - `negative_cost` "string switch" (12 keywords, 16 words looked up 5 million times), plain vs `-opt`, linux/amd64: 63 → 15.8 ms.
  - New case `opt_string_switch`: keywords, two strings in one case, `fallthrough`, a default case in the middle, an init statement, `""` and a multi-byte string, strings only FNV tells apart, an opt-out, and a 2-case switch left alone.
- **10, wider bounds-check elimination** merged (`provenIndexes` in `src/optimize.ts`).
  - Constant offsets: `a[i + k]` / `a[i - k]` are proven when the range is `lo..<len(a) - m` with `k <= m` and `lo >= k` (also `for i := lo; i < len(a) - m; i += c`).
  - Hoisting and lockstep, one mechanism: for `for i in lo..<n` (n made of stable locals, literals, `len`, ...) or `for x, i in a` over a slice or array, with no break/return/`or_*` in the body, an array indexed by plain `i` in the body's own statements (not under an if, a loop, `&&`, `||` or `?:`) and declared before the loop gets `__vidar.bounds_upto(n, lo, len(b)...)` before the loop. The runtime helper panics with `max(lo, min len)` and that length, the panic the loop would have hit, just earlier. Statements whose every index is then proven get `#no_bounds_check`; a call statement gets `#no_bounds_check { ... }`, since Odin takes the directive only on some statements. A loop that is a `do` body is put in braces.
  - The check has to be a statement: folding it into the loop bound (`0..<bounds_upto(n, ...)`) stopped LLVM from vectorizing the loop.
  - `negative_cost`, plain Odin vs `-opt`, 4-core linux/amd64, medians of 7: "bounds, hoisted" 17.8 → 14.7 ms, "bounds, lockstep" 36.7 → 14.4 ms (now vectorized), "bounds, offsets" 19.9 → 20.5 ms (LLVM already proves `i ± 1` from the range; no gain, kept because offsets let such a statement use a hoisted check).
  - Bench robustness: each section driver in `negative_cost` is now `#force_no_inline`. With them all inlined into `main`, the one hoisted check in `blur`'s setup loop (outside the timer) made "collatz, computed" 20% slower, a layout effect. "append in a loop" is bimodal on linux (about 55 or 97 ms with identical code), depending on the heap state the earlier sections leave.
  - Found on the way: `@(specialize)` makes a copy for a constant 0 bound, and its `for i in 0..<0` didn't compile ("Invalid interval range"). Fixed: a parameter isn't made compile-time for a value that empties one of the proc's `lo..<p` / `lo..=p` loops (`emptiesRange`).
  - New case `opt_bounds_wide`.
- **9, constant-size `make` on the stack** merged (`src/stackbuf.ts`, run before alloc grouping). `x := make([]T, N)` with `N` made of literals and constants, freed once by a `defer delete(x)` later in the same block, never assigned, addressed or captured, becomes `__x_buf: [N]T; x := __x_buf[:]` and the defer becomes a comment. Every use of `x` must be indexing (not `&x[i]`), `len`/`cap`, a `for v in x`, or an argument to a proc that doesn't keep it: `core:fmt`, `core:math`, a list from `core:slice` and `core:mem`, or a proc with a body whose parameter passes the same check (4 calls deep). A `#soa` buffer becomes `#soa[N]T`. `@(no_stack_buffer)` opts out.
  - Size cap: 4 KB in a proc reachable from a literal passed to `sched.go` (through calls and nested closures; every proc when a goroutine runs a closure value), 64 KB elsewhere. Sizes are `soa.sizeOf`'s estimate, which ignores padding.
  - `negative_cost`: "scratch allocations" 63 → 46 ms (`weights` in `smooth` went on the stack). "append in a loop" read 40% slower with identical code; it runs right after, and with `allocs` removed from both builds the two match (57 ms each), so that is heap state left by the previous section, not this change.
  - New case `opt_stack_buffers`.
- **5, intermittent Odin compiler hang**: not reproduced, blocked on the M3. 800 builds (the `closure_types` and `macro_types_strings` outputs, each at both `-opt` settings, 200 times, 4 in parallel) with Odin dev-2026-10 on linux/amd64: no hang, none over 10 s. No generated code has blank `_` struct fields (checked every fixture, the runtime, `vidar:sched` and the prelude). Next: the same loop on the M3 with dev-2026-07; `/tmp`-style script: `for i in $(seq 200); do timeout 60 odin build <dir> -out:<dir>/p || echo HANG; done`, then `sample` the spinning `odin`.
- **3, dangling by-reference captures** merged. `src/escape.ts` runs on each proc body after analysis. A closure literal capturing `&x` of one of the proc's locals or parameters (or of a by-value capture, which lives in the closure's copy of its environment) is an error when it is returned (directly, through locals, a named result, or inside a struct literal), stored through a pointer or a slice or in a global or an outer proc's variable, or appended to anything but a local the proc owns. Values are followed through locals and local structs and arrays until nothing changes; calls are not followed. The error is at the capture and suggests `new_clone(x)`.
  - It found one in `examples/cyclic`: `run` appended `proc[&ticks]` to `w.on_frame`, which outlives it. The counter is now `new(int)`.
  - Nine error cases (`tests/errors/closure_ref_*`), and `tests/cases/closure_ref_local` for `&x` closures that stay in the frame (passed to a call, held in a local, appended to a local array).
- **2, `sched_pending_io` busy loop**: not reproduced on linux/amd64, so blocked on a macOS run. Tooling and a stress case are in.
  - `npm run stress -- <case>` (`scripts/stress.js`) builds a case once, runs it `-n` times (`-jN` at a time, `-t` seconds each) and checks `stdout.txt`. On a hang it records the CPU use (near 100% is the busy loop, near 0% a lost wakeup) and every thread's stack (`sample` on macOS, `gdb` on Linux) in `$TMPDIR/vidar-stress-*/hang-N.txt`, and keeps the binary.
  - `-define:VIDAR_FILES_ON_WORKERS=true` sends file operations to the worker threads on Linux, as on macOS, so the cross-thread hand-off (`worker_done` → `resume_from_worker`) runs here too.
  - New case `sched_pending_io_stress`: the scenario 2000 times in one process, about 0.6 s (1.1 s with files on workers).
  - Runs without a hang, Odin dev-2026-10 on a 4-core VM: `sched_pending_io` 12,000 times (8 in parallel, debug and `-o:speed`), 16,000 times with files on workers; the stress case 1,200 times, half with files on workers (2.4 million rounds). `blocking` while waiting on a worker doesn't spin either (1 s wait, 4 ms CPU).
  - Ruled out: the two cross-thread races fixed in `core:nbio` (`exec` reading `op.l` after publishing the op, the operation pool's free list) are already in dev-2026-07; its nbio sources match dev-2026-10's. kqueue's wake-up event is `EV_CLEAR`, so it can't stay triggered.
  - Lead for macOS: kqueue's `__tick` doesn't block when nothing is submitted to the kernel (`len(l.submitted) == 0` gives a zero timeout). If a hand-off from a worker were lost while the scheduler's loop had nothing in the kernel, `pick` would call `nbio.tick()` in a loop at 100% CPU: the reported symptom. In this test the accept goroutine keeps an accept in the kernel, so that would also need the accept to be gone. Next: `npm run stress -- tests/cases/sched_pending_io_stress -n 500` on the M3.
- **1, closure call regression** done in the main tree, not committed yet. The planned fix didn't apply: with Odin dev-2026-10, the `Env` passed by value already goes as a pointer to the caller's closure, with no copy at the call or in the body (checked in the x86-64 and darwin/arm64 assembly). The cost was elsewhere: the call passes a pointer into the closure's own memory, so LLVM has to reload `f.call` after every call and never sees the target, even with `pairs_plain` inlined into the proc that built the closure.
  - Fix: a closure parameter that is called reads its proc into a local on entry, `__f_call := f.call`, and calls go through it. Parameters are immutable in Odin; one captured by reference is a local copy and keeps `f.call(...)`. Once inlined, the call is direct and the closure's body inlines and vectorizes.
  - Tried first, as planned: `proc(^Env, ...)` with `&f.env` and a local copy of each called parameter. That copy is a 136-byte `memcpy` per call: "closure, as a parameter" +184%, "created in a loop" +390%, and "called through" unchanged. Dropped.
  - `npm run bench` on a 4-core linux/amd64 VM (Odin dev-2026-10): "called through" 21.1 → 4.7 ms, the same as "closure, specialized" (4.3 to 4.7 ms there); no other section outside run-to-run noise (re-ran each one that crossed 15%). Not yet measured on the M3.
  - New case `closure_param_calls`: a parameter called twice, in a loop, captured by reference and reassigned, called from a nested closure, and a closure literal's own closure parameter.
- **19, leftovers from the first batch** done in the main tree, not committed yet.
  - `reserve`: appends under an `if` (any depth, `else if` / `else` included) count as the branch that appends the most, so the reserve is an upper bound. Only for elements of at most 16 bytes (`SMALL_ELEM` in `src/optimize.ts`); bigger ones get `not reserved`. `opt_reserve`'s conditional-append example moved from "not reserved" to reserved; two closure-specialize fixtures picked up a reserve in `filter_map`.
  - `#soa`: `a: [dynamic]T = make([dynamic]T, ...)` and `a: []T = make([]T, n)` qualify when both types are spelled the same; both get `#soa`.
  - Hints inside macro expansions: the analyzer maps each expansion's tokens to its macro call (`expandedFrom`), and `an.hint` moves a hint from expanded code to the outermost call in the source, with a tooltip starting `in name!:`. This also puts them under `@(hot)`.
  - Closure-literal specialization across files and packages: the copy was already written in the caller's file; now the callee's body can be written there too. The emitter qualifies the callee package's names (`iter.bump`) and maps the callee file's imports to the caller file's, adding `import __alias "path"` when missing. Skipped, with a note, when the body uses something `@(private)` from another package or `@(private="file")` from another file, or the caller's file doesn't import the callee's package. New case `opt_closure_specialize_pkg`.
    - Tried first: a generic copy in the callee's file taking the lifted closure as a `$F` proc constant. Odin can't take a polymorphic proc there, and with `^$E` inferred first it compiled but silently skipped the loop (printed 0), so it was dropped.
  - Cold paths on plain Odin `or_return`: under `-opt`, a whole-statement `or_return` is written out like `or_return X`, returning the error itself, hinted `cold failure`. Only where Odin accepts it (named results, or a single one), so `-opt` never accepts what plain Odin rejects.
  - `npm test` passes (278 case checks, 121 LSP checks); `npm run bench` shows no section more than 3% off `HEAD`.
- **21, macro expansion on hover** done in the main tree. The emitter records the code it writes for each macro call when given an `expansions` map (`emitProgram(p, expansions)`); the language server emits once per analysis, on the first hover over a macro call's name, and appends that code to the macro's hover. Statements a macro hoists before its statement (`do!`, values evaluated once) are tagged with the macro calls being expanded (`_hoistedFor`) and shown first. Comptime calls show the value they folded to (`fib!(20)` expands to `6765`). The rename check in `scripts/test-lsp.js` now loads the whole workspace, since the workspace uses a macro from `geo`.
- **18, `@(no_alloc)` and `@(hot)`** done in the main tree, in a new `src/checks.ts` rather than `autoopt.ts`/`analyzer.ts`.
  - `@(no_alloc)` follows calls through procs with bodies, proc groups, nested proc constants and interface methods (when the interface is closed), memoized per proc. A call it can't follow says "can't be checked" rather than "can allocate". The backstop is a `when __vidar.NO_ALLOC_CHECKS { ... }` on the body's first line (true at `-o:none` and `-o:minimal`), which also lands in `@(specialize)` copies; it adds two lines to every `expected/vidar_runtime`.
  - `@(hot)` needed decisions against that weren't recorded, so `-opt` now also hints `no bounds proof` (a statement in a loop with an index that keeps its check) and `no direct call` (a call through a closure value, unless the proc has closure copies). Allocations in a loop are found by `@(hot)` itself. Hints are now always collected under `-opt`; `-opt-report` only decides whether to print them, and `LoadOptions.report` is gone.
  - The language server runs its `-opt` analysis whenever a package has a `@(hot)` proc, and publishes the warnings with the errors.
  - Not done: the "no direct call" hint doesn't know whether a closure parameter's callers all got copies, so it is skipped for any proc with closure copies.
- **20, VS Code extension in one command** done in the main tree. `npm run vsix` (`scripts/vsix.js`) runs `build:binaries`, `npm install` in `editors/vscode` when it has no `node_modules`, `npm run package`, then installs the `.vsix` and reminds you to reload the window. It finds the VS Code CLI through `$VSCODE_CLI`, then `/Applications`, then `code` on PATH. About 13 s. The LSP suite passes against the rebuilt binary, inlay hints included.
- **17, benchmark regression check** done in the main tree. `npm run bench` (`scripts/bench.js`) builds `negative_cost` at the working tree and at a ref, runs them alternately, and fails on a section over 0.5 ms that is more than 15% slower, or on a changed checksum (exit 2 when a build fails). New sections: "closure, created in a loop" (19 ms), "closure, from an array" (19 ms), "closure, as a parameter" (11 ms; a closure parameter called once per call, which is what item 1's copy on entry costs). `--against 14d4af1 --section closure` reports "called through" at +188% and fails, so it catches item 1.
  - Found while writing the array section: `fs := make_closures()`, where `make_closures` has a named result of type `[8]closure(int) -> int`, loses the closure type, and `f(x)` in `for f in fs` fails in Odin with "Cannot call a non-procedure". The section uses a typed declaration instead. Not fixed.
- **`errdefer` / `or_return X` fix** merged from `claude/festive-yonath-2bae71`. In a proc with named results, a failing `or_return X` now sets only the error result and returns, as Odin's `or_return` does, so `errdefer` sees the other results as they were. Before, it returned `{}` for them first, and the cleanup missed the allocation. New case `tests/cases/errdefer_named_results`.
