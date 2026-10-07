# Vidar

Odin with **closures**, **interfaces**, **error handling helpers**, **anonymous struct literals**, a **goroutine and channel library**, **cyclic imports**, **typed compile-time macros** and **optimizations Odin can't do on its own** (lookup tables, specialized copies, pools, compiled `fmt` formats). `vidar` transpiles `.vidar` programs to plain Odin.

[SYNTAX.md](SYNTAX.md) is a compact reference of every construct Vidar adds; [examples/](examples) has one runnable program per feature.

Everything that is already Odin passes through **byte-for-byte** (unless you ask for `-opt`): comments, formatting and line numbers are kept. Only the new constructs are rewritten. As a check, 1313 of the 1317 `.odin` files in Odin's `core`, `base` and `vendor` libraries come out of the full pipeline unchanged. Macro expansions get lines of their own, and vidar keeps a map from generated lines to source lines, so errors Odin reports in generated code point at the right line of your `.vidar` file.

```bash
npm install && npm run build
node dist/cli.js run   examples/closures            # transpile + odin run
node dist/cli.js check examples/macros              # transpile + odin check
node dist/cli.js run   examples/cyclic              # a program whose packages import each other
node dist/cli.js emit  examples/cyclic              # print the generated Odin
node dist/cli.js build examples/cyclic -o out/game  # write the generated Odin tree
node dist/cli.js run   examples/negative_cost -opt  # with the -opt rewrites
node dist/cli.js run   examples/closures --watch    # rerun whenever a .vidar file of the program changes
npm test
```

`--watch` works with `run` and `check`. It watches every package of the program in the project (the entry package and every package it imports by relative path, not `core:` or `vidar:sched`), recomputed before each run since imports change, and reruns about 100 ms after the last change. A program still running is killed, together with anything it started, before the rerun. Output is kept unless you add `--clear`, which clears the screen before each rerun. It uses `fs.watch` on each package directory and falls back to polling where that fails. Ctrl-C stops it.

## Standalone binaries

```bash
npm run build:binaries
```

This builds `bin/<os>-<arch>/vidar` and `vidar-lsp`, plus a `.tar.gz` of both, and needs no Node.js or `node_modules` at runtime. Each is a Node [single executable application](https://nodejs.org/api/single-executable-applications.html): the bundled compiler is injected into a copy of the Node binary, which is why a binary is about 85 MB. `vidar-lsp` is a hard link to the same file. Run under that name, or as `vidar lsp`, it starts the language server. `odin` still has to be on your PATH for `run`/`check`.

To build for another OS or CPU, pass a Node binary for that target, e.g. from the official downloads at nodejs.org: `node scripts/build-binaries.js --node path/to/linux-x64/bin/node --target linux-x64`. On macOS, binaries are ad-hoc signed.

A directory is a package: all its `.vidar` (and plain `.odin`) files are transpiled together, along with every package it imports by relative path. A single `.vidar` file can also be built on its own.

## Closures

A proc literal with a capture list is a closure. `[x]` copies `x` into the closure; `[&x]` captures it by reference: the closure holds `&x` and nothing is moved, so keeping `x` alive while the closure runs is up to you. The compiler catches the common mistake: a closure holding `&x` of a local or parameter that is returned (directly, through a local or named result, or in a struct literal), stored through a pointer, a slice or in a global, or appended to something the proc doesn't own, is an error that suggests `new_clone(x)`. Values passed to calls aren't followed. A closure is a plain value: its captures are stored inside it, so copying, returning or appending a closure copies them, and nothing is ever allocated. For state that changes, or that outlives the frame, capture a pointer: `count := new_clone(0)` with `proc[count]`. `proc[]` is a closure with no captures. A plain `proc(...)` with no brackets is an ordinary Odin proc.

```odin
make_counter :: proc(start: int) -> closure() -> int {
	count := new_clone(start)
	return proc[count]() -> int { count^ += 1; return count^ }
}

main :: proc() {
	step := 10
	add := proc[step](x: int) -> int { return x + step }
	c := make_counter(0)
	c(); c()
	fmt.println(add(1), c())   // 11 3
}
```

- Closure types are written `closure(params) -> results`. They work anywhere a type does: struct fields, `[dynamic]closure(int) -> int`, parameters, return types, aliases.
- Closures are called like procs: `f(x)`, `s.handler(x)`, `make_adder(1)(2)`.
- A closure can capture another closure's captures (nested closures).
- By-value captures are read-only: each call gets a fresh copy, so assigning to one is a compile error. Capture `&x` or a pointer to change state.
- Captures must fit in the closure: 128 bytes by default, set with `-define:VIDAR_CLOSURE_ENV=<bytes>`. A closure that doesn't fit is a compile error naming it. A closure can't capture another closure by value (it would need more room than it has); capture `&f`, or `new_clone(f)` if it outlives the frame.
- Using an outer local without capturing it is a compile error that suggests the fix.

**How it lowers:** a closure value is `Closure(proc(Env, A...) -> R)`, a struct holding the proc and `env: Env`, a fixed `[N]u64` buffer the captures are copied into (136 bytes in all by default). The proc gets the buffer and reads its captures from it. A closure parameter that is called reads its proc into a local on entry (`__f_call := f.call`), so once the callee is inlined into the proc that built the closure, LLVM sees the target and the call becomes direct. The struct is declared once, in a generated `vidar_runtime` package, so closures can be passed between packages. Each closure literal becomes a call to a generated parapoly constructor, `__closure_N(captures...)`, so Odin infers the capture types itself.

## Interfaces

```odin
Shape :: interface { area, scale }          // the interface lists its methods

area  :: proc(s: Shape) -> f64 ---          // each method: no body, the interface first
scale :: proc(s: Shape, k: f64) ---

Circle :: struct { r: f64 }

circle_area  :: proc(c: ^Circle) -> f64  { return math.PI * c.r * c.r }
circle_scale :: proc(c: ^Circle, k: f64) { c.r *= k }

impl Shape for Circle { area = circle_area, scale = circle_scale }

main :: proc() {
	c := Circle{1}
	fmt.println(area(&c))     // static: calls circle_area, no vtable
	s: Shape = &c             // implicit conversion from a pointer: s refers to c
	scale(s, 2)               // dynamic: through the vtable
	shapes: [dynamic]Shape
	append(&shapes, &c, new_clone(Circle{5}))
	fmt.println(area(s), area(Shape(&c)))
}
```

There is one way to declare, implement, convert to and call an interface, and every name in it is a top-level declaration you wrote.

- **Methods are top-level procs without a body.** `area :: proc(s: Shape) -> f64 ---` declares the method `area`. Its first parameter is the interface. The interface lists its methods by name, `Shape :: interface { area, scale }`, in vtable order. vidar checks both directions: every listed name must be such a proc in the interface's package, and every bodiless proc that takes an interface first must be listed by it. Outside `foreign` blocks, `---` procs are only for interface methods.
- **Implementations are ordinary procs.** `impl I for T { m = t_m, ... }` binds each method to a proc declared with a body that takes `^T` first, followed by the method's other parameters. vidar checks for missing, extra or duplicate bindings, the receiver type and the parameter counts. Odin checks the parameter and result types. The implementing procs stay callable by their own names.
- **Calls are proc calls.** Each method becomes an Odin proc group: `area :: proc{__Shape_area, circle_area, rect_area, ...}`. Called with `^T`, Odin picks `T`'s proc, a static call with no vtable. Called with an interface value, it picks the dispatcher. Since every impl lives in the interface's package (or its cycle), the dispatcher knows them all: it compares the value's vtable pointer with each impl's and calls the bound proc directly, which Odin can inline. Only vtables it can't name (a base interface reached from another package) or more than 8 candidates fall back to the indirect call. So a call reads the same whether it is static or dynamic, and generic code (`$T`) can call methods on any implementer. `x->m()` on an interface value is an error.
- **Interface values hold a pointer.** The value is `struct { data: rawptr, __vtable: ^VTable }`. `Shape(x)` converts explicitly from `^T` (or another `Shape`). Conversions are also inserted automatically where the expected type is known to be an interface: typed declarations, assignments, call arguments, `return`, named struct-literal fields, and `append` to a `[dynamic]Interface`. Converting a plain value is an error. Write `&x`, or `new_clone(x)` for a heap copy you own.
- **Packages.** Callers in other packages qualify methods like any other proc: `shapes.area(&c)`. An impl can implement another package's interface (`impl game.Entity for Button`) only when it's in the interface's package or in an import cycle with it, and the bound procs must be declared in that package or cycle. That is because Odin needs the proc groups and all impls in one package.
- **Extending.** `Item :: interface { using Named, using Sized, describe }` extends any number of interfaces, from this package or an imported one. An `Item` value converts implicitly to `Named` or `Sized` (no allocation; the child vtable embeds its bases' vtables), and inherited methods work on it: `name(item)`. `impl Item for T` binds the inherited methods too, and also implements every base declared in the same package (or import cycle), so `&t` converts to those as well. Diamonds are fine; two different methods with the same name are an error.
- **Cleanup** is not built in. Declare it like any interface: `Destroy :: interface { destroy }` with `destroy :: proc(d: Destroy) ---`, then call `destroy(&x)` or `for d in trash do destroy(d)`.

## Cyclic imports

Odin rejects import cycles. Vidar accepts them:

```odin
// game/game.vidar
package game
import "../ui"

World  :: struct { entities: [dynamic]Entity }
Entity :: interface { draw }
draw   :: proc(e: Entity) -> string ---

run :: proc(w: ^World) -> string { return ui.render(w) }
```

```odin
// ui/ui.vidar
package ui
import "../game"

Button :: struct { text: string }
button_draw :: proc(b: ^Button) -> string { return b.text }
impl game.Entity for Button { draw = button_draw }

render :: proc(w: ^game.World) -> string { ... }
```

vidar loads the entry package and every package it imports by relative path (`core:`/`vendor:` collection imports stay ordinary Odin imports). It then finds the groups of packages that import each other (strongly connected components of the import graph):

- **A package not in a cycle** stays its own Odin package, in its own output directory.
- **Packages in a cycle** are merged into one Odin package (`game_ui/` above). Each one's members get its name as a prefix: `ui.render` becomes `ui__render`, `game.World` becomes `game__World`. That prefixing is scope-aware, so locals and struct fields are untouched. Imports between members of the cycle disappear. Importers outside the cycle import the merged package under their original alias, so `game.run(...)` becomes `game.game__run(...)`.
- If the entry package is part of a cycle, it keeps its own names, so `main` stays `main`.
- `@(private)` still means private to the original package, and vidar enforces it even after merging.
- `vidar run`/`check` map Odin's errors and panics back to the `.vidar` files and lines.

See [examples/cyclic](examples/cyclic) for a cycle that shares an interface, closures and a macro, with a separate `util` package outside the cycle. [tests/cases/import_cycles](tests/cases/import_cycles) covers a three-package cycle, a cycle that includes the entry package, and the same names declared in several packages.

## Error handling

Odin's multiple results and `or_return` stay as they are. Three small additions cover the cases they don't:

```odin
load_config :: proc(path: string) -> (Config, Error) {
	data := os.read_entire_file(path) or_return .Read_Failed    // propagate a different error
	defer delete(data)

	parsed := json.parse(data) catch err {                     // handle inline, error bound to `err`
		log.errorf("bad config %s: %v", path, err)
		return {}, .Bad_Format
	}

	buf := make([]u8, 1024)
	errdefer delete(buf)                                        // runs only if we return a failure
	cfg := Config{raw = buf}
	validate(&cfg) or_return
	n := strconv.parse_int("42") catch unreachable             // can't fail; panics with the error if it does
	return cfg, nil
}
```

| Form | Meaning |
|---|---|
| `x := f() or_return <value>` | if `f` fails, return zero values plus `<value>` as the error |
| `x := f() catch err { ... }` | if `f` fails, run the block with the error bound to `err` (the name is optional) |
| `x := f() catch unreachable` | if `f` fails, panic with the error, reporting the source line |
| `errdefer stmt` | a `defer` that only runs when the procedure returns a failure |

- **"Fails"** follows `or_return`: the last result is `false` (an ok-bool), or not nil/zero (an error enum, union or pointer). It works for your procs and for `core:` procs alike, through a small generic check in the runtime package.
- **`or_return <value>` and `catch`** go after a call that is the whole right-hand side of `x := ...` or `x = ...`, or after a bare call statement. The declared names get the call's leading results.
- **A value starting with `-` or `&`** is ambiguous after `or_return`, because in Odin `f() or_return - 1` subtracts from the result. vidar rejects it: write `or_return (-1)` for the error value, or `(f() or_return) - 1` for the arithmetic.
- **A `catch` block after a declaration or assignment must leave the scope** (`return`, `break`, `continue`, `panic`); otherwise the values would be used unset. After a bare call it may fall through.
- **`errdefer`** looks at the procedure's last result after `return` has set it. Unnamed results are given names in the generated code, which doesn't change how the procedure is called.
- **`or_return <value>` with named results** works like Odin's `or_return`: it sets only the error result and returns, so `errdefer` sees the other results as they were when the call failed.
- **Lowering:** everything becomes plain Odin on the same line: `x, e := f(); if failed(e) { ... }` and `defer if failed(err) { ... }`.

## Anonymous struct literals

A `{ name = value, ... }` literal with no type, declared with `:=`, makes its struct type on the spot. Field types are inferred from the values:

```odin
hero := { name = "slime", hp = 10, pos = { x = 1.5, y = 2 } }   // struct { name: string, hp: int, pos: struct { x: f64, y: int } }
hero.pos.x += 1
take :: proc(h: struct { name: string, hp: int, pos: struct { x: f64, y: int } }) { ... }
take(hero)
```

- Only the right-hand side of a `:=` declaration inside a procedure is affected, the one place Odin has no type for `{ ... }`. With an expected type (`p: Point = { x = 1 }`, arguments, `return`), `{ ... }` keeps Odin's meaning.
- Every element needs a name. A field can't be inferred from `nil`, `---` or an untyped positional `{ 1, 2 }`.
- The type is a plain Odin anonymous struct, and Odin treats anonymous structs with the same fields as the same type, so two such literals, or a literal and a written-out `struct { ... }`, are interchangeable.
- vidar knows the field types, so closure fields can be called (`cfg.on_click(x)`) and the language server completes and hovers the fields.
- **Lowering:** each value is evaluated once into a temp on its own source line, then `hero := struct { name: type_of(__anon1_name), ... }{name = __anon1_name, ...}`, so Odin infers every field type itself.

## Goroutines and channels

`import "vidar:sched"` gives Go-style concurrency as a library, with no new syntax. `sched.go` runs a closure on a new goroutine, channels pass values between goroutines, and `sched.select` waits on several channel operations at once. Blocking calls look like ordinary calls. There is no `async`/`await`, so any proc can block.

```odin
import "vidar:sched"

worker :: proc(id: int, jobs: sched.Chan(int), results: sched.Chan(string)) {
	for {
		job, ok := sched.recv(jobs)           // blocks this goroutine only
		if !ok do return                      // channel closed
		sched.sleep(10 * time.Millisecond)
		sched.send(results, fmt.aprintf("worker %d did job %d", id, job))
	}
}

main :: proc() {
	jobs    := sched.make_chan(int, 10)       // buffered
	results := sched.make_chan(string)        // unbuffered
	for id in 0..<3 do sched.go(proc[id, jobs, results]() { worker(id, jobs, results) })
	for j in 0..<5 do sched.send(jobs, j)
	sched.close(jobs)

	timeout := sched.make_chan(bool, 1)
	sched.go(proc[timeout]() { sched.sleep(time.Second); sched.send(timeout, true) })
	for _ in 0..<5 {
		r: string
		switch sched.select(sched.on_recv(results, &r), sched.on_recv(timeout)) {
		case 0: fmt.println(r)
		case 1: fmt.println("timed out"); return
		}
	}
}
```

| Proc | |
|---|---|
| `go(proc[captures]() { ... })` | runs the closure on a new goroutine. The capture list decides what the goroutine gets: `[x]` copies `x` now, `[&x]` shares it |
| `make_chan(T, capacity = 0)`, `Chan(T)` | a channel and its type. Channels are handles, so copies share one queue. A zero `Chan(T)` is nil and blocks forever |
| `send(ch, v)` | blocks until a receiver takes `v`, or until there is room in the buffer |
| `v := recv(ch)`, `v, ok := recv(ch)` | blocks until a value arrives. `ok` is false once the channel is closed and drained |
| `close(ch)`, `chan_len(ch)`, `chan_cap(ch)` | close a channel, count buffered values, get the capacity |
| `select(cases...)`, `try_select(cases...)` | run the first case that can proceed and return its index. `select` waits; `try_select` returns -1 at once when nothing is ready |
| `on_recv(ch, &v = nil, ok = &b)`, `on_send(ch, v)` | the cases passed to `select` |
| `sleep(d)`, `yield()`, `after(d)` | pause this goroutine, let the others run; `after` is a channel that fires once `d` has passed, for `select` timeouts |
| `Wait_Group`, `add(&wg, n = 1)`, `done(&wg)`, `wait(&wg)` | wait for a set of goroutines |
| `Mutex`, `lock(&m)`, `unlock(&m)`, `try_lock(&m)` | a lock that parks the goroutine, not the thread, so it can be held across blocking calls |
| `listen_tcp`, `accept`, `dial`, `send(socket, buf)`, `recv(socket, buf)`, `close(socket)`, `send_file(socket, file)` | TCP |
| `udp_socket()`, `bind`, `send_to`, `recv_from`, `close(socket)` | UDP |
| `wait_ready(socket, .Receive / .Send)` | wait until a socket is readable or writable |
| `open(path, mode)`, `read_at`, `write_at`, `stat`, `close(file)`, `read_entire_file`, `write_entire_file` | files |
| `resolve("host:port")` | DNS lookup |
| `blocking(proc[captures]() { ... })` | runs the closure on a worker thread and parks this goroutine until it returns, for anything that blocks the thread and has no `sched` version: C libraries, `os` calls, heavy computation |

- **Goroutines are stackful coroutines** on one OS thread, as in Go with `GOMAXPROCS=1`. Each one has its own stack, so `defer`, `scoped!`, `context` and everything else work unchanged inside it. A goroutine inherits the `context` of the code that started it.
- **Stacks** are 256 KB with a guard page below them. Deep recursion inside a goroutine crashes on the guard page. Set the size with `-define:VIDAR_STACK_SIZE=<bytes>`. Stacks of finished goroutines are reused.
- **Every `sched` call that waits parks only the calling goroutine.**
  - Sockets and timers go through `core:nbio` (io_uring on Linux, kqueue on macOS) on the scheduler's thread. When no goroutine can run, the scheduler blocks in the event loop until one can.
  - Files use io_uring on Linux. On other systems nbio would read regular files synchronously, so file operations go to a worker thread instead.
  - `blocking(...)` and `resolve` (the DNS resolver blocks) also run on a worker. There are 4 worker threads, each with its own event loop; set the number with `-define:VIDAR_WORKERS=<n>`.
  - **Several threads:** `-define:VIDAR_THREADS=N` (default 1) runs goroutines on N threads, each with its own scheduler, run queue and event loop. New goroutines are handed out round robin, and an idle thread takes goroutines that haven't started from the others. A goroutine stays on the thread that first runs it, so a wakeup from another thread queues it there. Channels, `select`, `Mutex` and `Wait_Group` take a lock each, and only when `N > 1`. Memory that goroutines share without `sched.Mutex` or channels, which is safe on one thread, is a data race on several, which is why this is opt-in. A goroutine started on another thread uses that thread's temp allocator. [examples/fanout](examples/fanout) runs 64 CPU-bound jobs: 60 ms on 1 thread, 33 on 2, 16 on 4 (4-core linux/amd64). Outside Linux, file operations go to the workers too; `-define:VIDAR_FILES_ON_WORKERS=true` does that on Linux, to test that path there. A finished operation is handed back to the scheduler's event loop, which wakes the goroutine.
  - When no other goroutine is runnable or waiting on I/O, `blocking` runs the closure inline instead, since nothing could run in the meantime; a program that calls it only at startup never starts the workers.
  - A closure passed to `blocking` runs on another thread, with the goroutine's `context` but that thread's temp allocator. It must not touch state other goroutines use unless it synchronizes, and `context.allocator` must be thread-safe (the default heap allocator is).
  - Plain blocking calls such as `os.read`, `time.sleep` or `core:sync` locks still block every goroutine. Use the `sched` version, or wrap the call in `blocking`.
- **Deadlocks are detected**: if every goroutine is blocked on a channel and no I/O is pending, the program panics with `all goroutines are asleep - deadlock!`.
- **When `main` returns, the program exits**, even if goroutines are still running, as in Go.
- **The package is written in Vidar** ([src/sched.ts](src/sched.ts)) and bundled with the compiler. It is emitted as an ordinary package (`vidar_sched/`) next to your code, together with a 30-line assembly routine per target that swaps stacks: darwin/arm64, linux/arm64 and linux/amd64 (assembled with `nasm`). Other targets fail with a compile-time `#panic`. The language server completes its members, and go-to-definition opens its source.

See [examples/goroutines](examples/goroutines) for workers, a closed channel, `select` with a timeout, `try_select` and a TCP echo server. [examples/sched_io](examples/sched_io) covers `blocking`, files, DNS, UDP, `Mutex` and `after`.

## Built-in library

Some macros come with the language: they're available in every file without an import, and a declaration of your own with the same name takes precedence. They're written in Vidar itself ([src/prelude.vidar](src/prelude.vidar)), and their expansions call helpers in the generated `vidar_runtime` package, so they need no imports.

| Macro | What it does |
|---|---|
| `scoped! { ... }` | gives the block its own temp allocator (`context.temp_allocator`) and frees all of it when the block ends, on every exit path |
| `scoped!(allocator) { ... }` | the same, with the arena's memory taken from `allocator` instead of `context.allocator` |
| `with_allocator!(a) { ... }` | makes `a` the block's `context.allocator` |
| `locked!(&mutex) { ... }` | holds the lock for the block and releases it on every exit (any `core:sync` lock type) |
| `timed!("label") { ... }` | prints how long the block took to stderr; the label defaults to the source location |
| `track!(allocator, "label") { ... }` | gives the block a tracking `context.allocator` over `allocator`; at its end, prints every allocation still live (size and location) to stderr. Both arguments are optional (allocator defaults to `context.allocator`, label to the source location); the label must be a string literal. Only active in `-debug` builds; otherwise the block runs on `allocator` untracked |
| `do! { ...; take value }` | a block that evaluates to a value: `take value` leaves the block with that value, while `return` and `or_return` still leave the procedure. The block runs just before the statement it's in, so it can be used in a declaration, an assignment, an expression statement or a `return`, and nothing with side effects may come before it in that statement; it can't be on the right of `&&`, `\|\|` or `or_else`, or in a branch of a ternary. The result type is inferred from the taken values; write `do!(T) { ... }` to give it. Reaching the end of the block without a `take` panics |
| `comptime! { expr }` / `comptime! { ...; take value }` | runs the block in the transpiler and folds to its value; see [compile-time evaluation](#compile-time-evaluation) |
| `dbg!(expr)` | prints `[file:line] expr = value` to stderr and evaluates to the value, so it can wrap any expression |
| `check!(cond)` / `check!(cond, "msg")` | panics when `cond` is false, showing the expression. For a comparison it also shows each non-literal operand's value, and each operand is evaluated once. |
| `todo!()` / `todo!("msg")` | panics with "not yet implemented", for code paths that aren't written yet |
| `unimplemented!()` / `unimplemented!("msg")` | panics with "not implemented", for code paths that are deliberately unsupported |

`check!`, `todo!` and `unimplemented!` panic at the source line of the call (`vidar run` maps it back to the `.vidar` file):

```
main.vidar(12:5) panic: check failed: len(xs) == 4 (need four)
	len(xs) = 3
```

```odin
scoped! {
	names := make([dynamic]string, context.temp_allocator)
	for i in 0..<1000 do append(&names, fmt.tprintf("item-%d", i))
	report(names[:])
}   // everything allocated from the temp allocator above is freed here
```

## Comptime procs (typed macros)

A comptime proc is declared with a `!` after `proc`, `name :: proc!(...)`, runs inside the transpiler and is invoked with `name!(...)`. It never reaches the generated Odin; only its result does.

```odin
square :: proc!(x: Expr(i32)) -> Expr(i32) {
	return quote($x * $x)
}

swap :: proc!(a, b: Expr) -> Stmt {
	return quote {
		tmp := $a          // hygienic: renamed, so it cannot clash with the caller's `tmp`
		$a = $b
		$b = tmp
	}
}

fib :: proc!(n: int) -> int {
	return n if n < 2 else fib(n - 1) + fib(n - 2)
}

main :: proc() {
	k: i32 = 7
	fmt.println(square!(k + 1), fib!(20))    // ((k + 1) * (k + 1)), 6765
	a, b := 1, 2
	swap!(a, b)
}
```

**Parameter kinds:**

| Parameter type | Argument |
|---|---|
| `Expr(T)` | an expression that must have type `T` |
| `Expr` | any expression |
| `Stmt` | a `{ ... }` block or statements |
| `Type` | a type: `f64`, `[]int`, `geo.Vec2` |
| `Ident` | a bare name, spliced unhygienically (for declaring things) |
| `int`, `string`, `bool`, … | a compile-time constant; it is evaluated |

**Return kinds:** `Expr` / `Expr(T)` can be used anywhere an expression can. `Stmt` works only as a statement. Constant types fold to a literal. A macro with no result runs only for its side effects, such as `compile_error`.

**Typed checking.** `Expr(T)` arguments and results are checked by vidar when it can infer the types (literals, annotated or inferred locals, struct fields, proc results). When it can't, vidar emits a dead-code assignment (`if false { _: T = arg }`), so Odin performs the check instead.

**Quoting.** `quote(expr)` and `quote { stmts }` build code.

- `$name` splices a comptime value: code, a number, a string, an `Ident`, or a `[dynamic]Stmt` (inserts every statement).
- `$(expr)` splices the result of a comptime expression.
- `$$` emits a literal `$`, for generating polymorphic procs.
- Names a quote declares are renamed (hygiene). Spliced code is never renamed.

Macros from other packages are called as `pkg.name!(...)`.

- **Trailing block:** a macro whose last parameter is a `Stmt` can take it as a block after the call, `name!(args) { ... }`, or `name! { ... }` when there are no other arguments, so it reads like a built-in statement.
- **Defaults:** parameters can have default values, `allocator: Expr = context.allocator`. For `Expr`, `Stmt` and `Type` parameters the default is code; otherwise it's a compile-time value.
- **Generated code:** an expansion is written out as ordinary Odin, one statement per line, under a comment naming the call and where it is. The comptime proc itself becomes a one-line comment. Odin errors and panics in an expansion are reported at the call, or at the line of code passed into it.

```odin
// swap :: proc!(a, b: Expr) -> Stmt — comptime, main.vidar:5
...
	a, b := 1, 2
	// swap!(a, b) — main.vidar:22
	tmp__1 := a
	a = b
	b = tmp__1
```

**Comptime body language:** a subset of Odin. You get `:=`, `if`/`else`, `for` (C-style, ranges, `for x, i in arr`), `switch`, `[dynamic]` arrays with `append`, `len`, string `+`, and calls to other comptime procs or regular procs. A comptime body already runs at compile time, so calls in it need no `!` (`fib(n - 1)`); a `!` is allowed too, and on a macro that returns code it expands the macro and evaluates the code. Integers have the width of their type and wrap around as they do at run time; untyped constants are unbounded.

Builtins:
- `type_name(T)` and `type_fields(T)`: name and field list of a type
- `type_of_expr(e)`: type of an expression argument
- `stringify(x)`: source text of a code value
- `ident(str)`: make a name from a string
- `compile_error(...)`: stop compilation with a message
- `fmt.tprintf`, `fmt.println` (prints to the compiler's stderr)

See [examples/macros](examples/macros), which includes a struct printer built with `type_fields`.

### Compile-time evaluation

`name!(args)` on any proc runs it at compile time and replaces the call with its result, with the same interpreter that runs macro bodies. For a comptime proc that's its normal invocation; a regular proc is called the same way when every argument is a constant. `comptime! { ... }` runs a whole block at compile time: every call in it behaves as if it had a `!`.

```odin
a := fib!(20)                                // a := 6765
area := square!(N)                           // a regular proc, run by the transpiler
label := fmt.tprintf!("v%d", VERSION)        // label := "v3"
primes: [5]int = first_primes!(5)            // primes: [5]int = { 2, 3, 5, 7, 11 }
mask := comptime! { (1 << 10) - 1 }          // mask := 1023
total := comptime! {                         // total := 55
	sum := 0
	for i in 1..=10 do sum += i
	take sum
}
d := square!(k)                              // error: 'k' is a runtime value
```

- Numbers, strings and booleans fold to literals; an integer of a sized type keeps it, e.g. `i32(1410065408)`. Arrays and structs fold to untyped compound literals, so the target needs a known type.
- `comptime! { expr }` folds a single expression; with statements, `take value` gives the block its value. Macros used inside it (`do!`, your own) fold as well.
- As a statement, `name!(...)` runs for its effects only, e.g. `static_assert!(N > 0, "N must be positive")`.
- If something cannot be evaluated at compile time (it reads a variable, calls a foreign proc, uses an unsupported statement, or a macro whose code needs the runtime), compilation fails.
- `compile_error`, out-of-bounds indexes and the step limit also stop compilation.

See [examples/comptime](examples/comptime): lookup tables, struct configs, static assertions and `comptime! { ... }` blocks.

## Faster code: `-opt`, pools, tables and specialization

Vidar can write some code more specifically than you would by hand, because it sees the whole program. Some of this is opt-in syntax (`Pool`, `@(table)`, `@(specialize)`); the rest happens under the `-opt` flag, which also rewrites plain Odin where the result is provably the same program, only faster. Without `-opt`, plain Odin still passes through byte-for-byte.

```bash
node dist/cli.js run examples/negative_cost -opt          # same output, faster
node dist/cli.js emit examples/negative_cost -opt-report  # -opt, plus what it decided per proc and why
```

### `-opt` on plain Odin

- **fmt calls with a literal format** (`fmt.printf`, `fmt.println`, `fmt.sbprintf`, `fmt.tprintf`, `fmt.wprintf`, the `e`/`a` variants, ...) compile to a proc that writes each piece directly: no format parsing at run time, no `any` boxing, no type switch. `%v %d %s %x %t %c` on basic types are written directly; other verbs and flags still go through `fmt`, one argument at a time. A format vidar can't read (`{}` arguments, `*` widths, explicit argument indexes) is left alone.
- **Bounds checks a loop already guarantees** are dropped (`#no_bounds_check` on the statement) when the index comes from `for i in 0..<len(a)`, `for x, i in a` or `for i := 0; i < len(a); i += 1`, and nothing in the loop can change `a`'s length: `a` is a local or parameter that isn't reassigned, appended to, or reachable through a pointer. Constant offsets count too: `a[i + 1]` in `for i in 0..<len(a) - 1`, `a[i - 2]` in `for i in 2..<len(a)`.
- **Bounds checks moved before the loop:** in a loop over `lo..<n` (or `for x, i in a`) with no `break`, `return` or `or_*` in it, an array indexed by plain `i` on every pass, outside any `if`, gets one check before the loop: `__vidar.bounds_upto(n, lo, len(b))` fails with the same index the loop would have failed on, and the indexes inside go unchecked. That covers a bound that isn't `len(b)` (`for i in 0..<n { b[i] }`) and arrays indexed in lockstep (`for x, i in a { b[i] }`). The check is a statement of its own, so LLVM still vectorizes the loop. A failing check panics before the loop's first iteration, not at the iteration that would have failed.
- **`reserve` before append loops:** a loop whose trip count is known before it starts (`for i in a..<b`, `a..=b`, `for x in xs` over a slice, array, dynamic array or string, `for i := a; i < n; i += 1`) and that runs `append(&xs, v)` (or `append(p, v)` for a pointer `p`) as a statement of its body gets `reserve(&xs, len(xs) + count)` before it, counting every value an append takes. Appends under an `if` (or its `else if` / `else` branches) count as the branch that appends the most, so the reserve is an upper bound; since a reserve can't be undone, that is only done for elements of at most 16 bytes. Skipped when the body can `break`, `continue` or `return`, the loop can change the bounds, or it reassigns, clears, resizes or takes the address of the array.
- **Allocations freed together:** adjacent `x := make([]E, n)` / `p := new(T)` that are only freed by a `defer delete(x)` / `defer free(p)` in the same block become one allocation, sliced up, and freed by the defer that runs last.
- **Struct fields reordered:** a plain struct (no directives, `using`, tags or blank fields) whose fields would pack tighter sorted by alignment, largest first, is written that way, when nothing can see its layout: it is never measured (`size_of`, `offset_of`, `type_info_of`, ...), cast, transmuted, converted, used as a map key or converted to `any`, and no value of a type holding it reaches code vidar can't see (core and foreign procs, proc values; so fmt and encoding/json, whose output follows the field order, keep it as written). Positional literals of it are rewritten with field names. Hints: `reordered` / `not reordered`.
- **Interface arrays held inline:** a local `[dynamic]I` (I closed, with no bases) whose elements all come from `new_clone(value)`, used only to append such clones, loop over and call I's methods on the elements, index for a method call, `len`, `clear` and `delete`, holds `union { T1, T2, ... }` instead: `append(&xs, new_clone(Circle{1}))` becomes `append(&xs, Circle{1})`, `for s in xs` becomes `for &s in xs`, and `grow(s, k)` calls `__I_v_grow(&s, k)`, a switch calling the impl directly. Each element was reachable only through the array, so nobody can tell. Not when an implementation is over 64 bytes, or an impl method uses its receiver other than through its fields (it could keep a pointer, which would dangle once the array grows). Hints: `value interface` / `no value interface`.
- **Generated printers:** `%v` and `%#v` (and `print`/`println`) of a struct, enum, fixed array, slice or dynamic array whose type vidar can see all the way down (plain structs without tags, `using`, `any` or directives; enums without explicit values; strings, bools, runes, integers and floats at the leaves) are written by generated `__print_T` procs instead of fmt's walk over type info. The output is fmt's byte for byte, and so is the count fmt returns. A `when` on the argument's type keeps fmt for anything vidar guessed wrong, and a program that registers its own fmt formatters keeps fmt everywhere. `%v` of a float goes straight to fmt's float formatter.
- **Generated JSON encoding:** `json.marshal(x)` with the default options, for such a type, calls a generated writer: encoding/json's exact bytes (its key quoting and JSON string escaping, `io.write_f*` floats, enums as integers, `json:"name"`, `json:"-"` and `omitempty` tags), without the walk over type info. Again under a `when` on the type, and not in a program that registers its own marshalers. `json.unmarshal` is left to encoding/json.
- **String switches through a perfect hash:** a `switch s` whose cases are 8 or more string literals switches on `__strswitch_N(s)` instead: a perfect hash of the string (its length and first, middle and last bytes with a multiplier found at compile time, or seeded FNV-1a when those collide) picks the one candidate, one compare confirms it, and each case's strings become their indexes. Case bodies, `fallthrough` and the default case stay as written. `@(no_perfect_hash)` opts a proc out; hints: `perfect hash` / `no perfect hash`.
- **Constant-size buffers on the stack:** `x := make([]T, N)` with a constant `N` and a matching `defer delete(x)` in the same block becomes `__x_buf: [N]T; x := __x_buf[:]`, when `x` can't outlive the proc: it is only indexed, measured with `len`/`cap`, looped over, or passed to procs that don't keep it (followed into procs with bodies, 4 calls deep; known `core:fmt`, `core:slice`, `core:mem` and `core:math` procs). Up to 4 KB in a proc a goroutine can reach, 64 KB elsewhere. `@(no_stack_buffer)` opts a proc out; hints: `stack buffer` / `no stack buffer`.
- **`#soa` layout:** a local `a: [dynamic]T`, `a: [N]T`, `a := make([dynamic]T, ...)` or `a := make([]T, n)` (with or without a declared type, `a: [dynamic]T = make([dynamic]T, ...)`) of a plain struct `T` (no `using`, tags, directives or parameters) becomes `#soa`, each field in an array of its own, when `T` has at least 3 fields or about 32 bytes and some loop touches only some of its fields. Every use of `a` must mean the same on an `#soa` container: `a[i].f` (read, write, `+=`, `a[i].f[j]`), `a[i]` as a whole value (copied, assigned, compared, passed), `len`, `cap`, `for x in a`, `for &x in a` using only `x.f`, `append(&a, ...)`, `clear`, `reserve`, `resize` and `delete`. Anything else keeps the layout: `&a[i]` or `&a[i].f`, slicing, passing `a` to a proc, returning, reassigning or capturing it.
- **Lookup tables, chosen automatically:** a proc taking one `bool`, `u8` or `i8` and returning an integer or `bool` becomes a table when its body is pure integer code (locals, constants, arithmetic, `if`/`for`/`switch`, calls to procs that pass the same check), has a loop or at least 24 operations, and finishes at compile time for every input. Floats, strings, globals, pointers and macros rule a proc out, because the compile-time interpreter can't promise to compute them exactly as the compiled program does.
- **Specialization, chosen automatically:** a proc gets a copy per constant argument when that parameter bounds a loop, or divides, shifts or branches inside one, and the calls pass constants to it. It is skipped when every call passes the same constant (LLVM already folds that) and when it would take more than 4 copies.
- **Closures passed as literals**, like Rust monomorphizing closures: `for_each(xs, proc[&total, k](x: int) { total += x * k })` calls `for_each__closure0(xs, &total, k)`, a copy of `for_each` in which `f(x)` is a direct call to the closure's body, lifted to a proc of its own, with the captures in an environment on the copy's stack. LLVM can then inline it, and nothing is allocated. This applies when the callee is a plain proc with a body, and its body only calls the parameter. The copy is written in the caller's file, so a callee in another file or package qualifies when its body uses nothing private the caller can't see (`@(private)` across packages, `@(private="file")` across files); imports it needs that the caller's file lacks are added under a `__` name. Storing the parameter, passing it on, returning it, comparing it, or capturing it in another closure keeps the call as it was. Each call passing a literal gets its own copy, at most 4 per proc; the calls past that call the original. Closure values held in variables (`g := proc[k]...; for_each(xs, g)`) aren't specialized.

On Vidar's error handling, `-opt` hints every failure path cold: the checks behind `catch`, `or_return X` and `errdefer` are wrapped in `intrinsics.expect(..., false)`, which LLVM turns into branch weights, and the panic behind `catch unreachable` is `@(cold)` (with or without `-opt`). Plain Odin `or_return` that is a whole statement (`x := f() or_return`, `x = f() or_return`, `f() or_return`) is written out the same way under `-opt`, returning the error itself, so its failure path is cold too.

`@(no_table)` and `@(no_specialize)` keep a proc out of the automatic choices, e.g. a baseline you benchmark against. `-opt-report` lists each proc that was tabulated or specialized, and each one that nearly was, with the reason, plus every statement and call it rewrote (the language server shows the same as inlay hints). A decision inside a macro's expansion is shown at the macro call, prefixed with the macro's name:

```
main.vidar:9: collatz: table: 256 results, has a loop, pure integer code
main.vidar:45: noisy: no table: it reads 'counter', which isn't a local or a constant (line 47)
main.vidar:66: blur: specialized ×2: radius bounds a loop; one copy for each of radius = 1 | radius = 2
main.vidar:73: sum_to: not specialized: every call passes n = 10, which LLVM folds without a copy
main.vidar:81: unchecked: every index here is proven in bounds by its loop, so it gets #no_bounds_check
main.vidar:80: bs: #soa: a loop touches 3 of 10 fields of Body (x, y, z); 10 fields, ~72 bytes
main.vidar:95: ps: not #soa: ps is passed to 'sum_x' (line 98)
```

### `@(table)`

`@(table)` on a proc with one parameter of type `bool`, `u8`, `i8` or an enum turns it into a lookup: the result for every value is stored, and the proc becomes `return table[x]`. For `bool`, `u8` and `i8`, vidar runs the body at compile time and writes the table as a `@(rodata)` literal. For an enum (whose members must not have explicit values), or a body that can't run at compile time, the table is filled once at startup from the original body. The body must not depend on anything but its argument; vidar can't check that for a table you ask for, which is why only the automatic tables are restricted to code it can check. Two parameters of type `bool`, `u8` or `i8` give a two-dimensional table, `table[x][y]`; `-opt` makes those on its own when there are at most 4096 results.

```odin
@(table)
collatz :: proc(b: u8) -> int {         // collatz :: #force_inline proc(b: u8) -> int { return __collatz_table[b] }
	n := int(b) + 1
	steps := 0
	for n != 1 {
		n = n / 2 if n % 2 == 0 else 3 * n + 1
		steps += 1
	}
	return steps
}
```

### `@(memo)`

`@(memo)` gives each outer call a memo table that the proc's calls to itself share; it is freed when the outer call returns, so nothing is kept between calls and nothing is shared between goroutines. The table is an array when every parameter is `bool`, `u8` or `i8` (4096 results at most), else a map keyed by the parameters. The proc keeps its name and signature; its body becomes `__f_memo_body`, in place. `-opt` adds it on its own to a pure integer proc that calls itself more than once per call (exponential recursion, like `fib`), unless the program has `@(no_alloc)` procs, since the table allocates. `@(no_memo)` opts a proc out.

```odin
fib :: proc(n: int) -> int {           // -opt: fib(n) makes the table, __fib_memo(n, &table) looks up or computes
	if n < 2 do return n
	return fib(n - 1) + fib(n - 2)      // __fib_memo(n - 1, __memo) + __fib_memo(n - 2, __memo)
}
```

### `@(specialize)`

`@(specialize)` on a proc gives each call that passes constants a copy where those parameters are compile-time (`$radius`), so Odin builds one version per value and LLVM can unroll loops, turn divisions into shifts and drop branches. Parameters of basic types and enums qualify; calls with run-time values call the original.

```odin
@(specialize)
box_blur :: proc(dst, src: []int, radius: int) { ... }

box_blur(dst, src, 1)       // box_blur__radius(dst, src, 1), with `$radius: int`
box_blur(dst, src, r)       // the original
```

On a `@(specialize)` proc, a call passing a closure literal also gets a copy calling the closure's body directly, as `-opt` does on its own (see above), together with any constants it passes. This happens without `-opt` too, and isn't capped.

### `@(no_alloc)` and `@(hot)`

Two promises the compiler checks:

```odin
@(no_alloc)
step :: proc(w: ^World) { ... }    // error: @(no_alloc) 'step' can allocate: append, reached through step -> spawn -> push at world.vidar:12

@(hot)
blur :: proc(dst, src: []int) { ... }   // with -opt, warning: @(hot) 'blur': no bounds proof: an index here isn't proven in bounds by its loop
```

- **`@(no_alloc)`** is a compile error when the proc, or anything it calls, can allocate. It follows calls into procs with bodies (in any package), proc groups, and interface methods when every impl is known. It stops at `make`, `new`, `new_clone`, `append`, `reserve`, `resize` and the other allocating built-ins, map inserts, `[dynamic]` and `map` literals, and allocating `core:` procs (`fmt.aprintf`, `fmt.tprintf`, `fmt.sbprintf`, `strings.clone`, `strings.builder_make`, ...). A call it can't follow is an error too: a call through a closure or proc value, an interface whose impls aren't all known, or a `core:` proc that isn't on the list of procs known not to allocate (`fmt.println`/`printf`/`bprintf`, `core:math`, `core:time`'s ticks and durations, `strings.has_prefix`, ...). The message names the allocation and the chain of calls that reached it. As a backstop, in builds below `-o:size` the proc's `context.allocator` and `context.temp_allocator` panic, so an allocation the analysis missed fails loudly in tests.
- **`@(hot)`**, with `-opt`, turns every `-opt` decision against something inside the proc into a warning, on the command line and in the editor: an index that keeps its bounds check inside a loop (`no bounds proof`), a call through a closure value (`no direct call`), a closure literal not inlined, a `vtable` call, and an allocation inside a loop. Without `-opt` it does nothing.

### `Pool(I)`

`Pool(I)` holds values of every type implementing the interface `I`, stored by type: one `[dynamic]T` per implementation instead of one array of interface values. `for s in pool` becomes one loop per type, in which `s` is a `^T`, so method calls are direct calls Odin can inline. `s` converts to `I` like any pointer to an implementation.

```odin
shapes: Pool(Shape)
append(&shapes, Rect{2, 3}, Circle{2})   // copies each value into its type's array
for s in shapes do total += area(s)      // a Circle loop, then a Rect loop, ...
len(shapes); clear(&shapes); delete(shapes)
```

- Values of one type keep their order; types are visited in the order of their `impl` blocks.
- `break`, `continue` and labels act on the whole loop, as written.
- Every implementation of `I` must be known: `I` must not be extended by an interface in another package.
- `append` takes values, not pointers, and is a statement of its own. `for s, i in pool` (an index) is an error.

### What it buys

`examples/negative_cost` measures each feature against the plain version (`--bench`, built with `-o:speed` on an M3 Pro):

| | plain | vidar |
|---|---|---|
| `fmt.sbprintf` with a literal format | 210 ms | 68 ms |
| three scratch allocations freed together | 115 ms | 45 ms |
| 1000 appends in a loop, reserved first | 92 ms | 50 ms |
| loop with proven indexes | 24.2 ms | 24.2 ms |
| box blur, radius 1 and 3 (`@(specialize)`) | 33 ms | 11 ms |
| Collatz steps over bytes (`@(table)`) | 282 ms | 1.4 ms |
| sum of areas over shapes (`Pool` vs `[dynamic]Shape`) | 3.5 ms | 3.2 ms |
| 3 of 10 fields over 100k structs (`#soa`) | 75 ms | 29 ms |
| closure literal called per element (copy per closure) | 7.6 ms | 4.0 ms |

Bounds checks rarely matter: LLVM already removes most of them in loops like these. The table wins only when the body costs more than a memory load; a bit count, which LLVM turns into one instruction, gains nothing. On the slime_mud server simulation, `-opt` took a run from 980 ms to 760 ms; the hand-written Odin version takes 905 ms.

## Language server

`vidar-lsp` speaks standard LSP over stdio, so any editor can use it. Put the standalone binaries on your PATH, or run `npm link` in this repo.

| Feature | Details |
|---|---|
| Diagnostics | vidar errors as you type, several at once. A declaration that doesn't parse is skipped and the rest of the file is still checked. On save, `odin check` runs on the generated code and its errors are shown on the matching `.vidar` lines. |
| Hover | Signature and kind for procs, types, interfaces (with their impls), interface methods (with their interface and the procs implementing them), macros, imports, locals and struct fields. Also shows the generated Odin name (when a cycle prefixes it) and whether a variable is captured by reference. On a macro call's name, the code it expands to, as the emitter writes it, with statements it runs first (`do!`); cut after 40 lines. |
| Go to definition | Names, `pkg.member` (into the other package's file), macro calls (`name!`, `pkg.name!`), struct fields, procs bound in an `impl`, and captured variables (jumps to the original declaration). |
| References / rename | Follows a variable through closure capture lists and into macro arguments; works across packages. |
| Completion | After `pkg.`, the package's public members; after `value.`, struct fields; otherwise everything in scope, plus macros and keywords. While the line you're typing doesn't parse yet, completion uses the last good analysis. |
| Outline | Procs, macros, structs (fields), interfaces (methods), impl blocks (bindings). |
| Plain Odin via ols | If [ols](https://github.com/DanielGavin/ols) is on your PATH, requests vidar can't answer go to it: hover, definition and signature help for core library procs and types, and `fmt.`-style completion (merged with vidar's own). See below. |
| Inlay hints | What `-opt` would decide, without building with it: `table` / `specialized ×2` after a proc's name, `unchecked` after a statement whose indexes are proven in bounds, `grouped alloc`, `fmt inlined`, and `direct` / `devirtualized` / `vtable` after an interface method call. The tooltip gives the reason. The setting `optHints` (initialization option or `vidar.optHints` in `workspace/didChangeConfiguration`) is `"on"` (default), `"all"` (also what `-opt` decided against, e.g. `no table`) or `"off"`. They come from a second analysis with `-opt` on, made only when hints are requested; diagnostics and generated code are unaffected. |
| `vidar/generatedOdin` | Custom request that returns the generated Odin for a file. |

The server analyzes the program rooted at the open file's package: that package plus everything it imports, cycles included. Unsaved editor contents are used. Editing a file re-checks every open program that contains it.

**How ols is used:** the server keeps a shadow copy of the generated Odin in a temp directory and runs ols on it. Lines vidar doesn't rewrite are unchanged, and the emitter's line map says where each one went, so a request on such a line is sent to ols at the matching position. Results that point into generated code are dropped; results in the shadow tree map back to the `.vidar` file. While a file has errors, the last good output is reused for unchanged lines and the edited lines are passed to ols as typed, so completion keeps working mid-edit. vidar answers first for its own constructs (closures, captures, interfaces, impls, macros, anonymous structs); ols is the fallback, and for hover also wins when vidar couldn't infer a local's type. Lines vidar rewrites (for example a line that uses a by-reference capture) are not forwarded yet.

**VS Code:** see [editors/vscode](editors/vscode). It provides highlighting, the client, and an *Vidar: Show Generated Odin* command.

**Neovim** (0.11+):

```lua
vim.filetype.add({ extension = { vidar = "vidar" } })
vim.lsp.config("vidar", { cmd = { "vidar-lsp", "--stdio" }, filetypes = { "vidar" }, root_markers = { ".git" } })
vim.lsp.enable("vidar")
```

**Helix** (`languages.toml`):

```toml
[language-server.vidar]
command = "vidar-lsp"
args = ["--stdio"]

[[language]]
name = "vidar"
scope = "source.vidar"
file-types = ["vidar"]
comment-token = "//"
language-servers = ["vidar"]
```

Options (LSP `initializationOptions`): `odinCheckOnSave` (default `true`), `odinPath` (default `"odin"`), `ols` (default `true`) and `olsPath` (default `"ols"`).

## Tests

```bash
npm test               # unit tests, fixture tests, language server tests
npm run test:update    # regenerate fixtures after an intended output change, then review the diff
node scripts/test.js --only closure    # only the cases and error tests whose name contains "closure"
VIDAR_LSP=bin/darwin-arm64/vidar-lsp node scripts/test-lsp.js   # run the LSP suite against a built binary
npm run bench          # examples/negative_cost timed against HEAD; --against <ref>, --section <name>, --runs N
npm run stress -- tests/cases/sched_pending_io -n 2000   # run one case many times; saves a stack on a hang
```

- **Unit tests** (`tests/unit/*.test.js`, `node:test`): lexer semicolon insertion and trivia, parser round-trips of tricky Odin syntax, parsing of the extension syntax and error recovery, compile-time evaluation, hygiene, spacing of generated code, the import-cycle grouping (Tarjan's algorithm, merged units, prefixes, output layout), and `--watch` (the file set, debouncing, reruns on change, polling, and killing a running child with what it started).
- **Sample programs with fixtures** (`tests/cases/<name>/`): one feature area each. The sample is `input.vidar`, or an `input/` directory for multi-package programs. `expected/` holds the transpiled Odin tree, and `stdout.txt` is the program's expected output, checked by running it with `odin run`. Cases named `plain_*` must come out byte-identical to their input. Cases named `opt_*` are transpiled with `-opt`. Every case is also transpiled the other way; if `-opt` changes its output, that version is run too and must print the same. They cover:
  - closures: capture modes, loops, every declaration form, multiple results, variadics, nesting, closure types
  - interfaces: dispatch, static calls across packages, decorators, multiple results, variadic methods
  - macros: hygiene, code generation, reflection, the typecheck fallback
  - anonymous struct literals: inferred field types, nesting, closure fields, evaluation order, structural compatibility
  - import cycles: three packages, the entry package in a cycle, aliases, multiple files per package
  - a diamond-shaped import graph
  - plain Odin passthrough
- **Examples** (`examples/<name>/`): the larger tour programs, one directory each, fixtured the same way (`expected/` and `stdout.txt` inside the example's directory).
- **Errors** (`tests/errors/*.vidar`, and `tests/errors_pkg/<name>/` for multi-package programs): about 70 programs that must fail with a specific message. The first line of the file, or of the package's `main.vidar`, says `// error: <expected message>`.
- **Passthrough:** a few real files from Odin's `core` library must transpile to themselves unchanged.
- **Benchmark** (`scripts/bench.js`, not part of `npm test`): builds `examples/negative_cost` at the working tree and at a git ref in a temporary worktree, both with `-opt` and `-o:speed`, runs them alternately, and compares each section's median. It fails when a section over 0.5 ms is more than 15% slower, or when a checksum changes.
- **Stress runs** (`scripts/stress.js`, not part of `npm test`): builds one case and runs it many times in parallel, each with a timeout, and checks its `stdout.txt`. On a hang it writes the process's CPU use (a busy loop or a wait) and a stack of every thread (`sample` on macOS, `gdb` on Linux) next to the kept binary.
- **Language server** (`scripts/test-lsp.js`): starts the server over stdio and drives it like an editor across two workspaces (`tests/lsp/workspace`, and `tests/lsp/cycle` where packages import each other). It checks:
  - diagnostics, including errors in imported files and `odin check` on save
  - hover, definition, references and rename across packages and cycles (the rename edits are applied and the program recompiled)
  - completion, including privacy across packages
  - hover, definition, signature help and completion forwarded to ols (skipped when `ols` is not on PATH)
  - the outline and the generated-Odin request
  - `-opt` inlay hints (`tests/lsp/opt`), their setting, and that they follow edits

## Source layout

| File | Role |
|---|---|
| `src/lexer.ts` | Odin lexer with automatic semicolons; keeps whitespace and comments on each token |
| `src/parser.ts` | Odin parser: every node keeps its token range for lossless re-emission |
| `src/analyzer.ts` | scopes, imports and package members, capture rules, best-effort type inference, macro expansion |
| `src/comptime.ts` | interpreter for comptime procs, `quote`/splicing, hygiene |
| `src/sched.ts` | the bundled `vidar:sched` package (scheduler, channels, `select`, nbio-backed I/O) and its stack-switching assembly |
| `src/emitter.ts` | re-emits tokens and lowers closures, interfaces, cross-package references and expansions |
| `src/optimize.ts` | `-opt` rewrites inside a proc: proven bounds checks, allocations freed together, `reserve` before append loops |
| `src/soa.ts` | `-opt`: which local arrays of structs become `#soa` |
| `src/reorder.ts` | `-opt`: struct field reordering |
| `src/valueiface.ts` | `-opt`: interface arrays that hold their values inline |
| `src/jsonopt.ts` | `-opt`: generated `json.marshal` writers |
| `src/printers.ts` | `-opt`: generated `%v` / `%#v` printers |
| `src/strswitch.ts` | `-opt`: perfect hashes for string switches |
| `src/stackbuf.ts` | `-opt`: which constant-size `make`s go on the stack |
| `src/escape.ts` | the error for a closure holding `&x` that outlives `x` |
| `src/autoopt.ts` | `-opt` after analysis: which procs become tables or specialized copies, and the `-opt-report` notes |
| `src/checks.ts` | `@(no_alloc)` (what a proc can allocate through) and `@(hot)` (warnings from the `-opt` decisions inside it) |
| `src/fmtspec.ts` | reads `fmt` format strings for `-opt` |
| `src/project.ts` | loads a program by following imports, groups import cycles (Tarjan's algorithm), and emits the output tree; shared by the CLI and the language server |
| `src/cli.ts` | `build` / `run` / `check` / `emit` |
| `src/watch.ts` | `--watch`: the files of a program, the watch loop (`fs.watch` on each package directory, polling as the fallback, debounced), and rerunning the command in a child process that is killed on change |
| `src/bin.ts` | entry point of the standalone binary (`vidar`, `vidar-lsp`) |
| `src/lsp/` | language server: `features.ts` (index, hover, definition, completion, …) and `server.ts` (protocol, `odin check` on save) and `odin.ts` (shadow tree and forwarding to ols) |
| `editors/vscode/` | VS Code extension: grammar and client |

## Limits (MVP)

- **Calling closures relies on type inference.** vidar finds a closure's type through annotations, `:=` from closure literals or proc results, struct fields, indexing and captures. If it can't tell that a callee is a closure, the call is left as is and Odin reports it as a call to a non-procedure.
- **Closure bodies are lifted to file scope.** They can't use the enclosing proc's local constants or types, or its polymorphic parameters (`$T`). vidar reports this as an error.
- **Closure size:** every closure value carries room for `VIDAR_CLOSURE_ENV` bytes of captures (128 by default), whether it uses them or not. Arrays of closures and channels of closures are that much bigger.
- **Import cycles merge packages.** Odin sees one package for the whole cycle. Procs declared inside `foreign` blocks of cycle members are not prefixed, so they must not clash across the cycle. Only relative imports are followed; packages reached through collections (`core:`, `shared:`, ...) can't take part in a cycle.
- **Anonymous struct literals** only work in `:=` declarations inside procedures; not at file scope or in `if`/`for`/`switch` initializers.
- **`@(no_alloc)` trusts lists.** Core procs are judged by name from a list of ones known not to allocate, and a custom `fmt` formatter or an allocator set on the context isn't followed. The run-time backstop only covers builds below `-o:size`.
- **Extension keywords are contextual.** `closure`, `quote`, `interface`, `impl`, `catch` and `errdefer` remain usable as ordinary identifiers, and `take` is only a keyword inside `do!` and `comptime!` blocks.
- **Goroutines run on one thread by default.** With `-define:VIDAR_THREADS=N` they run on N threads, but a goroutine stays on the thread that first runs it; only goroutines that haven't started move to an idle thread. At 1 thread, `blocking` work and non-Linux file I/O are the only other threads. With several threads, a deadlock waits forever instead of panicking. Goroutines aren't preempted: a long loop that never calls into `sched` holds up the others. `core:sync` locks park the whole thread, so use `sched.Mutex` between goroutines. Only darwin/arm64, linux/arm64 and linux/amd64 are supported, and only darwin/arm64 is tested so far.
- **`-opt` and `@(table)`** trust the compile-time interpreter. Automatic tables use only integer code it runs exactly; a `@(table)` you write yourself must be pure, which vidar does not check.
- **Interfaces:** no generic impls, and impl targets must be named types. Bound procs must be plain procs: no proc groups, polymorphic procs or closures. Method names are package-level names, so two interfaces in one package can't share a method name (`writer_write`, `stream_write`).
