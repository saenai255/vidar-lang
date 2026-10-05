# Vidar

Odin with **closures**, **interfaces**, **error handling helpers**, **anonymous struct literals**, **goroutines and channels**, **cyclic imports** and **typed compile-time macros**. `vidar` transpiles `.vidar` programs to plain Odin.

[SYNTAX.md](SYNTAX.md) is a compact reference of every construct Vidar adds; [examples/](examples) has one runnable program per feature.

Everything that is already Odin passes through **byte-for-byte**: comments, formatting and line numbers are kept. Only the new constructs are rewritten. As a check, 1313 of the 1317 `.odin` files in Odin's `core`, `base` and `vendor` libraries come out of the full pipeline unchanged. Because line numbers are kept, errors Odin reports in generated code point at the right line of your `.vidar` file.

```bash
npm install && npm run build
node dist/cli.js run   examples/closures            # transpile + odin run
node dist/cli.js check examples/macros              # transpile + odin check
node dist/cli.js run   examples/cyclic              # a program whose packages import each other
node dist/cli.js emit  examples/cyclic              # print the generated Odin
node dist/cli.js build examples/cyclic -o out/game  # write the generated Odin tree
npm test
```

## Standalone binaries

```bash
npm run build:binaries
```

This builds `bin/<os>-<arch>/vidar` and `vidar-lsp`, plus a `.tar.gz` of both, and needs no Node.js or `node_modules` at runtime. Each is a Node [single executable application](https://nodejs.org/api/single-executable-applications.html): the bundled compiler is injected into a copy of the Node binary, which is why a binary is about 85 MB. `vidar-lsp` is a hard link to the same file. Run under that name, or as `vidar lsp`, it starts the language server. `odin` still has to be on your PATH for `run`/`check`.

To build for another OS or CPU, pass a Node binary for that target, e.g. from the official downloads at nodejs.org: `node scripts/build-binaries.js --node path/to/linux-x64/bin/node --target linux-x64`. On macOS, binaries are ad-hoc signed.

A directory is a package: all its `.vidar` (and plain `.odin`) files are transpiled together, along with every package it imports by relative path. A single `.vidar` file can also be built on its own.

## Closures

A proc literal with a capture list is a closure. `[x]` copies `x` into the closure; `[&x]` captures it by reference, and `x` is then moved to the heap so the closure can safely outlive the frame. `proc[]` is a closure with no captures. A plain `proc(...)` with no brackets is an ordinary Odin proc.

```odin
make_counter :: proc(start: int) -> closure() -> int {
	count := start
	return proc[&count]() -> int { count += 1; return count }
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
- Using an outer local without capturing it is a compile error that suggests the fix.

**How it lowers:** a closure value is `Closure(proc(rawptr, A...) -> R)`, a two-field struct holding the proc and its environment. The struct is declared once, in a generated `vidar_runtime` package, so closures can be passed between packages. Each closure literal becomes a call to a generated parapoly constructor, `__closure_N(captures...)`, so Odin infers the capture types itself.

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
- **Calls are proc calls.** Each method becomes an Odin proc group: `area :: proc{__Shape_area, circle_area, rect_area, ...}`. Called with `^T`, Odin picks `T`'s proc, a static call with no vtable. Called with an interface value, it picks the dispatcher, which goes through the vtable. So a call reads the same whether it is static or dynamic, and generic code (`$T`) can call methods on any implementer. `x->m()` on an interface value is an error.
- **Interface values hold a pointer.** The value is `struct { data: rawptr, __vtable: ^VTable }`. `Shape(x)` converts explicitly from `^T` (or another `Shape`). Conversions are also inserted automatically where the expected type is known to be an interface: typed declarations, assignments, call arguments, `return`, named struct-literal fields, and `append` to a `[dynamic]Interface`. Converting a plain value is an error. Write `&x`, or `new_clone(x)` for a heap copy you own.
- **Packages.** Callers in other packages qualify methods like any other proc: `shapes.area(&c)`. An impl can implement another package's interface (`impl game.Entity for Button`) only when it's in the interface's package or in an import cycle with it, and the bound procs must be declared in that package or cycle. That is because Odin needs the proc groups and all impls in one package.
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
- Line numbers are preserved in every generated file, and `vidar run`/`check` map Odin's errors back to the `.vidar` files.

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
- **A `catch` block after a declaration or assignment must leave the scope** (`return`, `break`, `continue`, `panic`); otherwise the values would be used unset. After a bare call it may fall through.
- **`errdefer`** looks at the procedure's last result after `return` has set it. Unnamed results are given names in the generated code, which doesn't change how the procedure is called.
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

Go-style concurrency: `go` starts a goroutine, channels pass values between goroutines, and `select` waits on several channel operations at once. Blocking calls look like ordinary calls. There is no `async`/`await`, so any proc can block.

```odin
import "vidar:sched"

worker :: proc(id: int, jobs: sched.Chan(int), results: sched.Chan(string)) {
	for {
		job, ok := <-jobs                     // blocks this goroutine only
		if !ok do return                      // channel closed
		sched.sleep(10 * time.Millisecond)
		results <- fmt.aprintf("worker %d did job %d", id, job)
	}
}

main :: proc() {
	jobs    := sched.make_chan(int, 10)       // buffered
	results := sched.make_chan(string)        // unbuffered
	for id in 0..<3 do go worker(id, jobs, results)
	for j in 0..<5 do jobs <- j
	sched.close(jobs)

	timeout := sched.make_chan(bool, 1)
	go proc[timeout]() { sched.sleep(time.Second); timeout <- true }()
	for _ in 0..<5 {
		select {
		case r := <-results: fmt.println(r)
		case <-timeout:      fmt.println("timed out"); return
		}
	}
}
```

| Syntax | Meaning |
|---|---|
| `go f(a, b)` | evaluates `f`, `a` and `b` now and runs the call on a new goroutine. Any call works: procs, `pkg.f`, proc groups, closures, `go proc[x]() { ... }()` |
| `ch <- v` | sends `v`. Blocks until a receiver takes it, or until there is room in the buffer |
| `<-ch`, `v := <-ch`, `v, ok := <-ch` | receives. `ok` is false once the channel is closed and drained |
| `select { case v := <-a: ... case b <- x: ... case: ... }` | runs the first case that can proceed and waits if none can. `case:` is the default, which makes the select non-blocking |

The library is imported as `import "vidar:sched"`:

| Proc | |
|---|---|
| `make_chan(T, capacity = 0)`, `Chan(T)` | a channel and its type. Channels are values, so copies share one queue. A zero `Chan(T)` is nil and blocks forever |
| `close(ch)`, `chan_len(ch)`, `chan_cap(ch)` | close a channel, count buffered values, get the capacity |
| `sleep(d)`, `yield()` | pause this goroutine, let others run |
| `Wait_Group`, `add(&wg, n = 1)`, `done(&wg)`, `wait(&wg)` | wait for a set of goroutines |
| `listen_tcp`, `accept`, `dial`, `recv`, `send`, `close(socket)` | TCP that parks the goroutine instead of the thread |

- **Goroutines are stackful coroutines** on one OS thread, as in Go with `GOMAXPROCS=1`. Each one has its own stack, so `defer`, `scoped!`, `context` and everything else work unchanged inside it. A goroutine inherits the `context` of the code that started it.
- **Stacks** are 256 KB with a guard page below them. Deep recursion inside a goroutine crashes on the guard page. Set the size with `-define:VIDAR_STACK_SIZE=<bytes>`. Stacks of finished goroutines are reused.
- **I/O goes through `core:nbio`** (io_uring on Linux, kqueue on macOS). The `sched` procs start the operation and park the goroutine. When no goroutine can run, the scheduler blocks in the event loop until one can. A plain blocking call such as `os.read` or `time.sleep` blocks every goroutine, so use the `sched` versions.
- **Deadlocks are detected**: if every goroutine is blocked on a channel and no I/O is pending, the program panics with `all goroutines are asleep - deadlock!`.
- **When `main` returns, the program exits**, even if goroutines are still running, as in Go.
- **Arguments of `go`** are evaluated into temporaries typed like the callee's parameters, so `go f(2, .Blue)` works when `f` takes an `f64` and an enum. This needs a callee with one known, non-polymorphic signature. For proc groups, polymorphic procs and procs from `core:` packages, untyped constants get their default types (`int`, `f64`), as with `$T`.
- **Lowering:** the runtime lives in the generated `vidar_runtime` package. `go f(a)` becomes `{ t0: <param type> = a; __vidar.go(__go_1(t0)) }`, and a generated helper boxes the values for the new goroutine. `ch <- v` and `<-ch` become `chan_send`/`chan_recv`. `select` becomes a `select_raw` call followed by a `switch` on the chosen case. A 30-line assembly routine per target swaps stacks: darwin/arm64, linux/arm64 and linux/amd64 (assembled with `nasm`). Other targets fail with a compile-time `#panic`.

See [examples/goroutines](examples/goroutines): workers, a closed channel, `select` with a timeout and a default, and a TCP echo server.

## Built-in library

Some macros come with the language: they're available in every file without an import, and a declaration of your own with the same name takes precedence. They're written in Vidar itself ([src/prelude.ts](src/prelude.ts)), and their expansions call helpers in the generated `vidar_runtime` package, so they need no imports.

| Macro | What it does |
|---|---|
| `scoped! { ... }` | gives the block its own temp allocator (`context.temp_allocator`) and frees all of it when the block ends, on every exit path |
| `scoped!(allocator) { ... }` | the same, with the arena's memory taken from `allocator` instead of `context.allocator` |
| `with_allocator!(a) { ... }` | makes `a` the block's `context.allocator` |
| `locked!(&mutex) { ... }` | holds the lock for the block and releases it on every exit (any `core:sync` lock type) |
| `timed!("label") { ... }` | prints how long the block took to stderr; the label defaults to the source location |
| `format!("hi {name}, {x:.2f}")` | string interpolation into a temp-allocated string. `{expr}` prints with `%v`, `{expr:spec}` uses `%spec` (`.2f`, `5d`, `x`, `q`...), and `{{` / `}}` are literal braces. Malformed templates are compile errors. |
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

A `comptime proc` runs inside the transpiler and is invoked with `name!(...)`. It never reaches the generated Odin; only its result does.

```odin
square :: comptime proc(x: Expr(i32)) -> Expr(i32) {
	return quote($x * $x)
}

swap :: comptime proc(a, b: Expr) -> Stmt {
	return quote {
		tmp := $a          // hygienic: renamed, so it cannot clash with the caller's `tmp`
		$a = $b
		$b = tmp
	}
}

fib :: comptime proc(n: int) -> int {
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
- **Line numbers:** code passed into a macro keeps its line breaks, so Odin errors inside the block point at the right line.

**Comptime body language:** a subset of Odin. You get `:=`, `if`/`else`, `for` (C-style, ranges, `for x, i in arr`), `switch`, `[dynamic]` arrays with `append`, `len`, string `+`, and calls to other comptime procs or regular procs.

Builtins:
- `type_name(T)` and `type_fields(T)`: name and field list of a type
- `type_of_expr(e)`: type of an expression argument
- `stringify(x)`: source text of a code value
- `ident(str)`: make a name from a string
- `compile_error(...)`: stop compilation with a message
- `fmt.tprintf`, `fmt.println` (prints to the compiler's stderr)

See [examples/macros](examples/macros), which includes a struct printer built with `type_fields`.

## Language server

`vidar-lsp` speaks standard LSP over stdio, so any editor can use it. Put the standalone binaries on your PATH, or run `npm link` in this repo.

| Feature | Details |
|---|---|
| Diagnostics | vidar errors as you type, several at once. A declaration that doesn't parse is skipped and the rest of the file is still checked. On save, `odin check` runs on the generated code and its errors are shown on the matching `.vidar` lines. |
| Hover | Signature and kind for procs, types, interfaces (with their impls), interface methods (with their interface and the procs implementing them), macros, imports, locals and struct fields. Also shows the generated Odin name (when a cycle prefixes it) and whether a variable is captured by reference. |
| Go to definition | Names, `pkg.member` (into the other package's file), macro calls (`name!`, `pkg.name!`), struct fields, procs bound in an `impl`, and captured variables (jumps to the original declaration). |
| References / rename | Follows a variable through closure capture lists and into macro arguments; works across packages. |
| Completion | After `pkg.`, the package's public members; after `value.`, struct fields; otherwise everything in scope, plus macros and keywords. While the line you're typing doesn't parse yet, completion uses the last good analysis. |
| Outline | Procs, macros, structs (fields), interfaces (methods), impl blocks (bindings). |
| Plain Odin via ols | If [ols](https://github.com/DanielGavin/ols) is on your PATH, requests vidar can't answer go to it: hover, definition and signature help for core library procs and types, and `fmt.`-style completion (merged with vidar's own). See below. |
| `vidar/generatedOdin` | Custom request that returns the generated Odin for a file. |

The server analyzes the program rooted at the open file's package: that package plus everything it imports, cycles included. Unsaved editor contents are used. Editing a file re-checks every open program that contains it.

**How ols is used:** the server keeps a shadow copy of the generated Odin in a temp directory and runs ols on it. Generated code keeps the source's line numbers, and lines vidar doesn't rewrite are unchanged, so a request on such a line is sent to ols at the same position. Results that point into generated code are dropped; results in the shadow tree map back to the `.vidar` file. While a file has errors, the last good output is reused for unchanged lines and the edited lines are passed to ols as typed, so completion keeps working mid-edit. vidar answers first for its own constructs (closures, captures, interfaces, impls, macros, anonymous structs); ols is the fallback, and for hover also wins when vidar couldn't infer a local's type. Lines vidar rewrites (for example a line that uses a by-reference capture) are not forwarded yet.

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
VIDAR_LSP=bin/darwin-arm64/vidar-lsp node scripts/test-lsp.js   # run the LSP suite against a built binary
```

- **Unit tests** (`tests/unit/*.test.js`, `node:test`): lexer semicolon insertion and trivia, parser round-trips of tricky Odin syntax, parsing of the extension syntax and error recovery, compile-time evaluation, hygiene, spacing of generated code, and the import-cycle grouping (Tarjan's algorithm, merged units, prefixes, output layout).
- **Sample programs with fixtures** (`tests/cases/<name>/`): one feature area each. The sample is `input.vidar`, or an `input/` directory for multi-package programs. `expected/` holds the transpiled Odin tree, and `stdout.txt` is the program's expected output, checked by running it with `odin run`. Cases named `plain_*` must come out byte-identical to their input. They cover:
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
- **Language server** (`scripts/test-lsp.js`): starts the server over stdio and drives it like an editor across two workspaces (`tests/lsp/workspace`, and `tests/lsp/cycle` where packages import each other). It checks:
  - diagnostics, including errors in imported files and `odin check` on save
  - hover, definition, references and rename across packages and cycles (the rename edits are applied and the program recompiled)
  - completion, including privacy across packages
  - hover, definition, signature help and completion forwarded to ols (skipped when `ols` is not on PATH)
  - the outline and the generated-Odin request

## Source layout

| File | Role |
|---|---|
| `src/lexer.ts` | Odin lexer with automatic semicolons; keeps whitespace and comments on each token |
| `src/parser.ts` | Odin parser: every node keeps its token range for lossless re-emission |
| `src/analyzer.ts` | scopes, imports and package members, capture rules, best-effort type inference, macro expansion |
| `src/comptime.ts` | interpreter for comptime procs, `quote`/splicing, hygiene |
| `src/sched.ts` | the goroutine runtime (scheduler, channels, `select`, nbio-backed I/O) and its stack-switching assembly |
| `src/emitter.ts` | re-emits tokens and lowers closures, interfaces, cross-package references and expansions |
| `src/project.ts` | loads a program by following imports, groups import cycles (Tarjan's algorithm), and emits the output tree; shared by the CLI and the language server |
| `src/cli.ts` | `build` / `run` / `check` / `emit` |
| `src/bin.ts` | entry point of the standalone binary (`vidar`, `vidar-lsp`) |
| `src/lsp/` | language server: `features.ts` (index, hover, definition, completion, …) and `server.ts` (protocol, `odin check` on save) and `odin.ts` (shadow tree and forwarding to ols) |
| `editors/vscode/` | VS Code extension: grammar and client |

## Limits (MVP)

- **Calling closures relies on type inference.** vidar finds a closure's type through annotations, `:=` from closure literals or proc results, struct fields, indexing and captures. If it can't tell that a callee is a closure, the call is left as is and Odin reports it as a call to a non-procedure.
- **Closure bodies are lifted to file scope.** They can't use the enclosing proc's local constants or types, or its polymorphic parameters (`$T`). vidar reports this as an error.
- **Memory:** closure environments and by-reference boxes are allocated with `context.allocator` and never freed. That is fine for arenas and short programs.
- **Import cycles merge packages.** Odin sees one package for the whole cycle. Procs declared inside `foreign` blocks of cycle members are not prefixed, so they must not clash across the cycle. Only relative imports are followed; packages reached through collections (`core:`, `shared:`, ...) can't take part in a cycle.
- **Anonymous struct literals** only work in `:=` declarations inside procedures; not at file scope or in `if`/`for`/`switch` initializers.
- **Extension keywords are contextual.** `closure`, `comptime`, `quote`, `interface`, `impl`, `catch`, `errdefer`, `go` and `select` remain usable as ordinary identifiers. `ch <- v` and `<-ch` need the `<-` written without a space; `a < -b` with a space is still a comparison, and `a<-b` is too wherever a statement can't start (in conditions and expressions).
- **Goroutines run on one thread.** There is no parallelism yet, and there are no goroutine-aware mutexes (a `core:sync` lock held across a blocking call can deadlock). Only darwin/arm64, linux/arm64 and linux/amd64 are supported, and only darwin/arm64 is tested so far.
- **Interfaces:** no embedding of one interface in another, no generic impls, and impl targets must be named types. Bound procs must be plain procs: no proc groups, polymorphic procs or closures. Method names are package-level names, so two interfaces in one package can't share a method name (`writer_write`, `stream_write`).
