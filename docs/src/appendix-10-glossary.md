# Appendix J: Glossary

**Borrow.** Using a value without owning it: through a pointer, a by-value parameter, a loop variable or a closure's by-value capture. A borrow never destroys the value. See [Owners, Borrows and Moves](ch07-02-ownership.md).

**Capture.** A local variable that a closure takes along: a copy with `proc[x]`, or a pointer with `proc[&x]`. The *capture list* is the bracketed list after `proc`. See [Capturing Values](ch04-01-capturing-values.md).

**Clone.** A copy made by a type's clone procedure, declared with `impl Clone`, which gives the copy an owner of its own. See [Copying with `impl Clone`](ch07-03-impl-clone.md).

**Closure.** A procedure value that carries captured data with it. In Vidar, a plain value of 136 bytes by default: the procedure and a buffer of captures. See [Closures](ch04-00-closures.md).

**Collection.** A name for a directory of packages, used as an import prefix: `core:`, `vendor:`, or one declared in `vidar.toml`. See [Collections and `vidar.toml`](ch09-03-collections.md).

**Comptime.** Running at compile time, inside the `vidar` compiler: macro bodies, `name!(...)` calls and `comptime!` blocks. See [Compile-Time Code](ch11-00-compile-time.md).

**Destructor.** The procedure that cleans up a value of a type, declared with `impl Destroy`, and called by the value's owner when it goes out of scope. See [Destructors with `impl Destroy`](ch07-01-impl-destroy.md).

**Dispatch.** Choosing which implementation an interface method call runs, from the interface value's vtable. Vidar's dispatcher compares the vtable pointer with each known implementation's and calls the match directly. See [Interface Values and Dispatch](ch05-02-interface-values.md).

**Escape.** A closure, or an interface value, outliving the procedure that made it: by being returned, stored somewhere longer-lived, or passed to something that does that. A closure holding `&x` of a local must not escape. See [How Long a Closure Can Live](ch04-04-closure-lifetimes.md).

**Expansion.** The code a macro call is replaced by. See [Writing Macros](ch11-01-writing-macros.md).

**Goroutine.** A function running concurrently with others, on its own stack, scheduled by `vidar:sched`. See [Goroutines and Channels](ch14-00-goroutines.md).

**Hint.** A record of one `-opt` decision, with a label and a reason: printed by `-opt-report`, and shown in the editor as an inlay hint. See [Seeing What `-opt` Does](ch15-01-reading-opt.md).

**Hygiene.** Renaming the names a macro's quoted code declares, so they can't clash with the caller's names. See [Writing Macros](ch11-01-writing-macros.md#hygiene).

**Impl.** An `impl I for T { ... }` block, which says that type `T` implements interface `I` and binds a procedure to each method. See [Defining and Implementing an Interface](ch05-01-defining-interfaces.md).

**Interface value.** A value of an interface type: a pointer to the data plus a pointer to its type's vtable. It refers to the data; it doesn't own it.

**Line map.** The map from each line of generated Odin to the `.vidar` line it came from, kept in `vidar.map.json`. It lets errors, panics and debuggers show your lines. See [How a Build Works](ch01-03-how-a-build-works.md).

**Lowering.** Rewriting a Vidar construct as the plain Odin that does the same thing. See [Appendix G](appendix-07-lowering.md).

**Macro.** A procedure declared with `proc!`, which runs at compile time, takes code as arguments, and returns code. Called with a `!`: `name!(...)`. See [Compile-Time Code](ch11-00-compile-time.md).

**Move.** Handing a value to a new owner, leaving the old one zero: `move!(x)`, returning a local, or the last use of a local. See [Owners, Borrows and Moves](ch07-02-ownership.md).

**Owner.** The one variable, field, element or `#owned` parameter responsible for destroying a value with a destructor.

**Park.** What a goroutine does when it waits: it stops, and the scheduler runs another goroutine on the same thread until the first can continue.

**Passthrough.** Code that Vidar emits exactly as it was written. Everything that is plain Odin passes through, unless `-opt` rewrites it.

**Quote.** `quote(...)` or `quote { ... }` in a macro: code as a value, with `$` marking where values are spliced in.

**Specialization.** Making a copy of a procedure for particular constant arguments, so the compiler can optimize each copy for its constants. See [Tables, Memoization and Specialization](ch15-05-tables-and-specialization.md).

**Splice.** Inserting a compile-time value into quoted code: `$x`, `$(expr)`.

**Transpiler.** A compiler whose output is source code in another language. `vidar` turns Vidar into Odin, and `odin` compiles that.

**Vtable.** The table of procedures for one type's implementation of an interface, in the order the interface lists its methods.
