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
| 3 | 18 | `@(no_alloc)` and `@(hot)` checks | tooling | todo |
| 4 | 19 | Leftovers from the first batch | tooling | todo |
| 5 | 1 | Closure call regression (2.9x slower call through a closure) | bug | todo |
| 6 | 2 | `sched_pending_io` busy loop | bug | todo |
| 7 | 3 | Dangling by-reference captures in returned closures | bug | todo |
| 8 | 5 | Intermittent Odin compiler hang | bug | todo |
| 9 | 6 | Value interfaces / closed unions | perf | todo |
| 10 | 7 | Generated per-type printers and JSON code | perf | todo |
| 11 | 8 | Multithreaded (M:N) scheduler | perf | todo |
| 12 | 9 | Constant-size `make` on the stack | perf | todo |
| 13 | 10 | Wider bounds-check elimination | perf | todo |
| 14 | 11 | String `switch` through a perfect hash | perf | todo |
| 15 | 13 | Automatic `@(memo)` and two-parameter `@(table)` | perf | todo |
| 16 | 15 | Struct field reordering, then hot/cold splitting | perf | todo |

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

## Parallel plan
- **Wave 1 (tooling first):** 17, 20, 18 and 19, plus 2, 3 and 5. These touch mostly separate files. Merge in priority order: 17, 20, 18, 19, then the bugs.
- **Wave 2:** 1, measured with 17, merged first because it is a small emitter change that the rest build on. Then 6, 7, 9, 10, 11, 13 and 15 in parallel.
  - Expected conflicts: `src/emitter.ts` (1, 6, 7, 11, 15), `src/optimize.ts` (9, 10, 19), `src/autoopt.ts` (13, 18), `src/analyzer.ts` (3, 6, 15, 18).
- **Wave 3:** 8, after 2 is merged.
- After each wave: `npm test`, `npm run bench`, and `npm run vsix` if the editor's output changed.

## Not in this batch
- Loop fusion and pipeline macros, PGO for dispatch order, and the smaller scheduler items (single-sender/single-receiver channels, stack-size inference, preemption).

## Log
- **20, VS Code extension in one command** done in the main tree. `npm run vsix` (`scripts/vsix.js`) runs `build:binaries`, `npm install` in `editors/vscode` when it has no `node_modules`, `npm run package`, then installs the `.vsix` and reminds you to reload the window. It finds the VS Code CLI through `$VSCODE_CLI`, then `/Applications`, then `code` on PATH. About 13 s. The LSP suite passes against the rebuilt binary, inlay hints included.
- **17, benchmark regression check** done in the main tree. `npm run bench` (`scripts/bench.js`) builds `negative_cost` at the working tree and at a ref, runs them alternately, and fails on a section over 0.5 ms that is more than 15% slower, or on a changed checksum (exit 2 when a build fails). New sections: "closure, created in a loop" (19 ms), "closure, from an array" (19 ms), "closure, as a parameter" (11 ms; a closure parameter called once per call, which is what item 1's copy on entry costs). `--against 14d4af1 --section closure` reports "called through" at +188% and fails, so it catches item 1.
  - Found while writing the array section: `fs := make_closures()`, where `make_closures` has a named result of type `[8]closure(int) -> int`, loses the closure type, and `f(x)` in `for f in fs` fails in Odin with "Cannot call a non-procedure". The section uses a typed declaration instead. Not fixed.
- **`errdefer` / `or_return X` fix** merged from `claude/festive-yonath-2bae71`. In a proc with named results, a failing `or_return X` now sets only the error result and returns, as Odin's `or_return` does, so `errdefer` sees the other results as they were. Before, it returned `{}` for them first, and the cleanup missed the allocation. New case `tests/cases/errdefer_named_results`.
