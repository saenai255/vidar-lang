# Performance work: progress

Six features, built in parallel in separate git worktrees, then merged into `main` one at a time.
After each merge, fixtures are regenerated with `npm run test:update`, the diff is reviewed, and `npm test` must pass.

Status values: `todo`, `in progress`, `done (worktree)`, `merged`, `blocked`.

| # | Feature | Status | Worktree / notes |
|---|---|---|---|
| 1 | Closure env escape analysis: stack env for closures that don't escape, inline env for one pointer-sized capture | merged | |
| 2 | Monomorphize higher-order procs per closure literal argument | merged | |
| 5 | `reserve` before append loops with a known trip count | merged | |
| 6 | Cold error paths: `intrinsics.expect` on `catch` / `or_return X` / `errdefer` failure branches | merged | |
| 9 | Automatic `#soa` for local dynamic arrays of structs whose hot loops touch few fields | merged | |
| 22 | LSP inlay hints for `-opt` decisions | merged | |

## Feature notes

### 1. Closure env escape analysis
Today every closure literal allocates its environment with `new_clone` (`src/emitter.ts`), and the memory is never freed.

### 2. Closure-argument specialization
Reuses the `@(specialize)` cloning so that a call passing a closure literal gets a copy of the callee with a direct call to the closure body.

### 5. `reserve` before append loops
`-opt` rewrite in `src/optimize.ts`.

### 6. Cold error paths
Failure branches of Vidar's error-handling syntax are marked unlikely.
The runtime defines `expect :: intrinsics.expect`, and generated code calls `__vidar.expect(__vidar.failed(e), false)`. A constant alias keeps the hint across packages; a `#force_inline` wrapper proc loses it. `unexpected` is `@(cold)`.
Checked in LLVM IR (`-o:speed`): the branches get `!{!"branch_weights", !"expected", i32 2000, i32 1}`. The new test has 2 such weights with -opt and 0 without.
Not done: plain Odin `or_return`.

### 9. Automatic `#soa`
Only for locals where every use is known to work the same on an `#soa` array.

### 22. Inlay hints
Shows what `-opt` decided (direct call, unchecked index, stack env, table, specialized copy, ...) in the editor.
After merging, the VS Code extension's bundled LSP binary has to be rebuilt and the `.vsix` reinstalled.

## Merge log

- **#6 cold error paths** merged. Applied cleanly. Only the shared `vidar_runtime/runtime.odin` fixtures changed (the alias and `@(cold)`), plus the new case `tests/cases/opt_cold_errors`. `npm test`: 246/246 cases, 103/103 LSP.
- **#22 inlay hints** merged. Its README paragraph conflicted with #6's and both were kept. Adds `an.hint(at, label, tooltip?)` in `src/analyzer.ts`; `-opt-report` and the editor both read it.
- **#5 reserve** merged. Conflicted with #22 over `optimizeProc(body, an)`; resolved. Its report line now goes through `an.hint` (after the appended array) instead of `an.report`, which #22 removed.
- **#9 #soa** merged. `soaLocals` now runs inside `optimizeProc` rather than only in the emitter, so the editor sees its decisions; its report lines go through `an.hint` on the array type. `opt_soa` also gains `reserve` lines from #5, which work on `#soa` arrays.
- **#1 closure env** merged. Its per-proc notes became hints on the closure literal: `stack env`, `env in pointer`, `no stack env`.
- **#2 closure specialization** merged. One call (`optimizeProc` in `liftedClosure`) was updated for #22's signature.
- **After merging:**
  - Closures that #2 inlines are marked and skipped by #1, so they no longer get a misleading `stack env` hint.
  - `@(specialize)` procs with closure copies no longer also report "no call passes a constant".
  - Per-call decisions are now `closure inlined` / `closure not inlined` hints on the call.
  - `opt_closure_env` marks `twice`, `apply` and `each` `@(no_specialize)`, so it still tests stack envs instead of #2's copies.
  - Fixed the stale `bench/bench.js` reference in `examples/negative_cost`.
- **Test runner:** cases now run in parallel (`-jN`, default half the cores). Odin builds time out after 120 s with one retry, and programs after 30 s. 36 s at `-j8` vs 56 s at the default. Final: 258/258 cases, 44 unit, 115 LSP.

## Open issues
- Intermittent hangs: the Odin compiler sometimes spins on a build that normally takes 0.2 s (seen on `closure_types` and `macro_types_strings`, each built with the other -opt setting). The `sched_pending_io` program once busy-looped for about 2 hours. Roughly one run in three has a single flaky failure.
- `errdefer` sees results already zeroed by a failing `or_return X`, so the cleanup misses the allocation. Being fixed in a separate session.
- The VS Code extension's bundled LSP has to be rebuilt and the `.vsix` reinstalled to get inlay hints.
