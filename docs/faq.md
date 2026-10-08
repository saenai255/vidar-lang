# FAQ

Short answers, with a link to the page that explains each one.

## Closures

### Why can't I change a variable I captured with `[x]`?

`proc[x]` copies `x` into the closure, and each call gets a fresh copy, so a change would be lost. Vidar makes it a compile error instead. Capture `&x` to write the caller's variable, or capture a pointer such as `new_clone(0)`. See [Closures](language/closures.md#capture-lists).

### Why does the compiler say my closure "is returned" and `n` "is gone"?

`proc[&n]` holds a pointer to `n`, which lives in the proc's frame. Returning that closure would leave a dangling pointer. Capture a pointer from `new_clone(n)` instead, so the value lives on the heap. See [Mistakes the compiler catches](language/closures.md#mistakes-the-compiler-catches).

### How big is a closure, and how do I make it bigger?

A closure is 136 bytes by default: 128 bytes of room for captures plus the proc. Nothing is allocated. If the captures don't fit, an Odin `#assert` names the closure. Build with `-define:VIDAR_CLOSURE_ENV=<bytes>` to change the room. Every closure value carries that room, so arrays and channels of closures grow with it. See [Rules](language/closures.md#rules) and [Limits](limits.md#closures).

### Can a closure capture another closure?

Through a pointer, yes: capture `&f`, or `new_clone(f)` if it outlives the frame. By value, no, because it would need more room than it has.

### Why do I get "nested procs cannot see it"?

A plain `proc(...)` with no capture list is an ordinary Odin proc and can't use the enclosing proc's locals. Write `proc[n](...)` or `proc[&n](...)`. Constants, types and polymorphic parameters (`$T`) need no capture.

## Interfaces

### Why do I have to write `&x` when converting to an interface?

An interface value holds a pointer (`data` plus a vtable), so converting a plain value would have nothing to point at. Write `&x`, or `new_clone(x)` for a heap copy you own. The language server offers both as quick fixes, and prefers `&x` unless it would dangle. See [Interface values](language/interfaces.md#interface-values).

### Does calling an interface method allocate or go through a vtable?

Neither allocates. Called with `^T`, a method is a static call. Called with an interface value, the dispatcher compares the vtable pointer with each known impl and calls the match directly, which Odin can inline. Only an unknown vtable, or more than 8 candidates, falls back to an indirect call. See [Calling it](language/interfaces.md#4-call-it).

### Can two interfaces in one package have a method with the same name?

No. Method names are package-level names, so two interfaces can't share one (`writer_write` and `stream_write` work). See [Limits](limits.md#interfaces).

### How do I free something through an interface?

Cleanup isn't built in. Declare your own interface with a `destroy` method and call `destroy(&x)`. See [Cleanup](language/interfaces.md#cleanup).

## Error handling

### When do I use `or_return`, `catch` or `errdefer`?

- `or_return` as in Odin propagates the error unchanged.
- `or_return <value>` returns a different error.
- `catch err { ... }` handles the failure inline.
- `catch unreachable` panics with the error if the call can't fail but does.
- `errdefer` is a `defer` that runs only when the proc returns a failure.

See [Error handling](language/error-handling.md).

### Why must a `catch` block leave the scope?

After a declaration or assignment, the values would otherwise be used unset. End the block with `return`, `break`, `continue` or `panic`. After a bare call it may fall through.

## Goroutines

### Why does my whole program freeze when a goroutine calls `os.read` or `time.sleep`?

Plain blocking calls and `core:sync` locks block the thread, and all goroutines share it. Use the `sched` version (`sched.sleep`, `sched.Mutex`), or wrap the call in `sched.blocking`, which runs it on a worker thread. See [What parks only the goroutine](language/goroutines.md#what-parks-only-the-goroutine).

### Can I call a C library that blocks?

Yes, through `sched.blocking(proc[...]() { ... })`. The closure runs on a worker thread, so it must not touch state other goroutines use without synchronizing.

### How do I use more than one thread?

Build with `-define:VIDAR_THREADS=N`. It is opt-in because memory shared without `sched.Mutex` or channels is safe on one thread but a data race on several. Try the race check first: `-define:VIDAR_RACE=true`. See [Several threads](language/goroutines.md#several-threads).

### Why does the program panic with "all goroutines are asleep - deadlock!"?

Every goroutine is blocked on a channel, `Mutex`, `Wait_Group` or `select`, and no I/O or timer is pending. The panic prints every goroutine, what it waits on and where it started. See [Deadlocks](language/goroutines.md#deadlocks).

### Does the program wait for goroutines when `main` returns?

No. As in Go, the program exits when `main` returns, even if goroutines are still running. Use a `Wait_Group` or a channel to wait.

### Do I need `nasm`?

On linux/amd64, yes: `vidar:sched` has a stack-switching assembly file that Odin assembles with it. Other supported targets don't need it.

## `-opt`

### Is `-opt` safe?

It never changes behavior. Vidar only rewrites code where the result is provably the same program, and the test suite builds every case with and without `-opt` and compares the output. See [Faster code](language/optimization.md).

### How do I find out what `-opt` did, or why it didn't do something?

Run with `-opt-report`. It prints each decision as `file:line: name: label: reason`, including the ones it decided against. The language server shows the same as inlay hints. See [Reading `-opt-report`](language/optimization.md#reading-opt-report).

### How do I stop `-opt` from touching one proc?

Use its opt-out attribute: `@(no_table)`, `@(no_specialize)`, `@(no_memo)`, `@(no_stack_buffer)` or `@(no_perfect_hash)`. See [Opting out](language/optimization.md#opting-out).

### What is the difference between `-opt` and `@(table)` or `@(specialize)`?

`-opt` chooses automatically and only when it can prove the result is right. `@(table)` and `@(specialize)` ask for the transformation on one proc. With `@(table)` you promise the body depends only on its argument, and vidar can't check that.

## Macros

### Why was my variable renamed to `tmp__1`?

Names a `quote` declares are renamed (hygiene), so they can't clash with the caller's. Spliced code is never renamed. To declare a name on purpose, take it as an `Ident` parameter. See [Quoting](language/comptime.md#quoting).

### Why does my macro fail with "is a runtime value"?

A macro runs inside the compiler, so it can only use compile-time values. A parameter of type `int`, `string` or `bool` must be a constant at the call. Use `Expr` to accept any expression. See [Parameters](language/comptime.md#parameters).

## Tooling

### Where did the `.vidar` line numbers go in an Odin error?

`vidar run`, `check` and `test` rewrite generated locations to `.vidar` ones. For a binary you built, pipe its output through `vidar map <out-dir>`. A panic inside a closure body that captures variables still shows a generated `.odin` location. See [Testing](tools/testing.md#how-locations-are-mapped).

### How do I see the Odin that Vidar generated?

`vidar emit <dir>` prints it, `vidar build <dir> -o out` writes it, and the editor has *Vidar: Show Generated Odin* and *Vidar: Expand at Cursor*. See [What Vidar generates](internals/lowering.md).

### Does Vidar change my plain Odin?

Not without `-opt`. Everything that is already Odin passes through byte for byte, and line numbers are kept.

### `vidar build -bin` made a file ending in `.bin`. Why?

A package named like the program would clash with the output file, so the binary gets a `.bin` suffix. Pass `-out <file>` to name it yourself. See [`vidar build`](cli.md#vidar-build).

### Can I use `ols` with `.vidar` files?

Yes. If `ols` is on your PATH, the language server forwards the requests it can't answer itself (core library hover, definition, completion). See [How ols is used](tools/language-server.md#how-ols-is-used).

### Which platforms work?

Only darwin/arm64 is tested. Goroutines also have stack-switching code for linux/arm64, linux/amd64 and windows/amd64, but windows/amd64 has only been cross-checked, never run. See [Limits](limits.md#goroutines).
