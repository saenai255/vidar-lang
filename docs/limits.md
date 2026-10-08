# Limits (MVP)

What the compiler doesn't do yet, grouped by feature.

## Closures

- **Escape analysis trusts what it can't see.** A `&x` closure (or an interface value pointing at a local) passed to a proc value, a closure, an interface method, a `foreign` proc or a `core:` proc is assumed not to escape.
  - A proc that stores a parameter through a pointer counts as letting it escape, even when the pointer is to the caller's own local.
  - A `sched.go` outside `main` is an error even when the proc waits for the goroutine before returning. Capture a pointer from `new_clone(x)` there.
- **Calling closures relies on type inference.** Vidar finds a closure's type through annotations, `:=` from closure literals or proc results (named or not, also of procs written `#force_inline proc` or `#force_no_inline proc`), struct fields, indexing and captures. If it can't tell that a callee is a closure, the call is left as is, and Odin reports it as a call to a non-procedure.
- **Closures that use `$T` stay in their proc.** A closure body using the enclosing proc's polymorphic parameters (or a local constant built from them) isn't copied into a specialized callee by `@(specialize)` or `-opt`: the call goes through the closure value. A closure type naming a local type, called through an expression that isn't a name, field or index (`make_adder(1)(2)`), needs a file-scope helper and doesn't build.
- **Closure size.** Every closure value carries room for `VIDAR_CLOSURE_ENV` bytes of captures (128 by default), whether it uses them or not. Arrays of closures and channels of closures are that much bigger.

## Interfaces

- Impl targets must be named types or parametric ones (`Box($T)`, `Box(int)`).
- Bound procs can't be closures or proc literals.
- A generic impl's vtables are made per instance by Odin, so dispatchers can't name them. Calls on such values always go through the vtable (the `-opt` hint says so), and `Pool(I)` and inline interface arrays refuse interfaces with an impl for a parametric type.
- Method names are package-level names, so two interfaces in one package can't share a method name (`writer_write`, `stream_write`).

## Packages

- **Import cycles merge packages.** Odin sees one package for the whole cycle.
  - Procs declared inside `foreign` blocks of cycle members are not prefixed, so they must not clash across the cycle.
  - Only relative imports are followed. Packages reached through collections (`core:`, `shared:`, ...) can't take part in a cycle.

## Anonymous struct literals

- As arguments they need a callee vidar can see, with a parameter typed `$T`, `any` or `..any` (or one of `fmt`'s print procs).
- In `return`, assignments and other expressions, `{ ... }` keeps Odin's meaning.

## Syntax

- **Extension keywords are contextual.** `closure`, `quote`, `interface`, `impl`, `catch` and `errdefer` remain usable as ordinary identifiers. `take` is only a keyword inside `do!` and `comptime!` blocks.

## Goroutines

- **One thread by default.** With `-define:VIDAR_THREADS=N` they run on N threads, and an idle thread takes runnable goroutines from the others.
  - `main` never moves, and `@(thread_local)` variables are not safe to use across a park in a goroutine.
  - At 1 thread, `blocking` work and non-Linux file I/O are the only other threads.
- **No preemption.** A long loop that never calls into `sched` holds up the others.
- **`core:sync` locks park the whole thread.** Use `sched.Mutex` between goroutines.
- **Servers at several threads.** An idle scheduler thread rechecks for work every 10 ms, which caps request rates for I/O-bound programs. slime_mud's server does about 5k to 9k commands/s at 4 threads, against about 113k at 1. Prefer 1 thread for I/O-bound servers until that wait is replaced.
- **Platforms.** Only darwin/arm64, linux/arm64, linux/amd64 and windows/amd64 are supported, and only darwin/arm64 is tested so far. windows/amd64 has only been cross-checked from Linux (`odin check` and `odin build -build-mode:obj` with `-target:windows_amd64`, and the switch routine run under a Linux harness with a fake TIB), never run on Windows.

## `-opt` and attributes

- **`-opt` and `@(table)` trust the compile-time interpreter.** Automatic tables use only integer code it runs exactly. A `@(table)` you write yourself must be pure, which vidar does not check.
- **`@(no_alloc)` trusts lists.** Core procs are judged by name from a list of ones known not to allocate. A custom `fmt` formatter, or an allocator set on the context, isn't followed. The run-time backstop only covers builds below `-o:size`.

## Debugging

- **`vidar dap` needs `lldb-dap`** (or `lldb-vscode`). gdb's own DAP mode isn't supported.
- **Pointer captures show as pointers.** A closure that captured `&x` lists `x` as a `^T`, not the value it points at.
- **Columns aren't mapped.** A frame's column is always 1, and a breakpoint binds to a line, not a position in it.

## Language server

- **Renaming a field or enum member** is refused while any use of a member of that name has a type vidar can't infer, or sits in a comptime proc (see [Language server](tools/language-server.md#fields-and-enum-members)). Fields of anonymous structs and of Odin's own types aren't renamed.
