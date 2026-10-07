# Vidar syntax reference

Everything Vidar adds on top of Odin, in one place. Anything not listed here is plain Odin and passes through unchanged. The [README](README.md) explains how each feature lowers to Odin; [examples/](examples) has a runnable program per feature.

All new keywords are contextual: `closure`, `quote`, `interface`, `impl`, `catch`, `unreachable` (after `catch`) and `errdefer` stay usable as ordinary identifiers, and `take` is a keyword only inside `do!` and `comptime!` blocks.

## Closures

| Syntax | Meaning |
|---|---|
| `proc[x](...) -> R { ... }` | closure capturing `x` by value (a copy taken when the closure is created) |
| `proc[&x](...) -> R { ... }` | closure capturing `x` by reference: a pointer to `x` where it lives, so the closure must not outlive it |
| `proc[x, &y, z](...) { ... }` | mixed capture list |
| `proc[](...) { ... }` | closure with no captures |
| `proc(...) { ... }` | (no brackets) an ordinary Odin proc, not a closure |
| `closure(params) -> results` | closure type; usable anywhere a type is (fields, params, results, `[dynamic]closure(int) -> int`, aliases) |
| `f(x)`, `s.handler(x)`, `make_adder(1)(2)` | calling a closure, exactly like a proc |

```odin
Op :: closure(a, b: int) -> (int, bool)

make_counter :: proc(start: int) -> closure() -> int {
	count := new_clone(start)
	return proc[count]() -> int { count^ += 1; return count^ }
}

step := 10
add := proc[step](x: int) -> int { return x + step }
for i in 0..<3 do append(&fs, proc[i]() -> int { return i })   // each iteration captures its own i
```

Rules:
- Using an outer local without capturing it is a compile error that suggests the fix.
- Each name may appear once in a capture list. Only locals can be captured: globals and constants are visible without capturing, and listing one is an error.
- A nested closure can capture what its enclosing closure captured.
- Closure bodies are lifted to file scope, so they cannot use the enclosing proc's local constants, local types or `$T` parameters.
- A closure is a value: its captures are copied into it (room for 128 bytes, `-define:VIDAR_CLOSURE_ENV=<bytes>` to change), so it can be returned, stored and copied freely and never allocates. Captures that don't fit are a compile error.
- By-value captures are read-only (each call gets a fresh copy); capture `&x` or a pointer to change state.
- A closure can't capture another closure by value: capture `&f`, or `new_clone(f)` if it outlives the frame.
- A closure holding `&x` of a local or parameter can't leave the frame: returning it, storing it through a pointer, a slice or in a global, or appending it to something the proc doesn't own is an error. Capture a pointer from `new_clone(x)` instead.

Example: [examples/closures](examples/closures).

## Interfaces

| Syntax | Meaning |
|---|---|
| `I :: interface { m, n, ... }` | interface declaration: lists its methods, in vtable order |
| `m :: proc(x: I, a: A) -> R ---` | method declaration: a top-level proc without a body whose first parameter is the interface |
| `impl I for T { m = t_m, n = t_n }` | implementation: binds every method to a proc declared with a body, taking `^T` first |
| `impl pkg.I for T { ... }` | implementing another package's interface (only from that package or one in an import cycle with it) |
| `m(&x, args)` with `x: T` | static call to `T`'s bound proc; works through pointers, fields, indexes and `&p^` |
| `m(i, args)` with `i: I` | dynamic call: tests the vtable against each impl and calls its proc directly, else through the vtable |
| `pkg.m(...)` | calling another package's method, like any proc |
| `I(&x)` | explicit conversion from `^T` or an `I` |
| `I :: interface { using A, using pkg.B, m }` | extending interfaces: `I` has `A`'s and `B`'s methods plus its own |
| `a: A = i`, `name(i)`, `A(i)` with `i: I` | converting to a base interface (implicit or explicit); inherited methods dispatch through it |
| `s: I = &x`, `f(&x)`, `return &x`, `S{field = &x}`, `append(&list, &x)` | implicit conversion wherever the expected type is known to be an interface |

```odin
Shape :: interface { area, scale }

area  :: proc(s: Shape) -> f64 ---
scale :: proc(s: Shape, k: f64) ---

circle_area  :: proc(c: ^Circle) -> f64  { return math.PI * c.r * c.r }
circle_scale :: proc(c: ^Circle, k: f64) { c.r *= k }

impl Shape for Circle { area = circle_area, scale = circle_scale }

area(&c)         // static, no vtable
s: Shape = &c
scale(s, 2)      // dynamic
```

Rules:
- Every listed method must be declared in the interface's package as `m :: proc(x: I, ...) ---`, and every such proc must be listed by its interface. Outside `foreign` blocks, `---` procs are only for interface methods.
- Each method is an Odin proc group of a vtable dispatcher plus every proc bound to it, so method names are package-level names.
- Missing, extra or duplicate bindings, a wrong receiver type and wrong parameter counts are vidar errors; parameter and result types are checked by Odin.
- Bound procs must be plain procs with a body, declared in the impl's package (or its import cycle): no proc literals, proc groups or closures.
- Interface values hold a pointer: converting a plain value is an error (use `&x`, or `new_clone(x)` for an owned copy).
- `x->m()` on an interface value is an error; call `m(x)`.
- Impl blocks are only allowed at file scope, and impl targets must be named types.
- `impl I for T` binds every method of `I`, inherited ones included, and also implements each base of `I` declared in the same package (or import cycle). A base in another package is reached by converting an `I` value; `base_method(&x)` static calls need an impl of that base itself.
- Extending is transitive and may form diamonds; an interface can't extend itself, list a base twice, or get two different methods with the same name.
- No generic impls. There is no builtin cleanup interface; declare `Destroy :: interface { destroy }` yourself.

Examples: [examples/interfaces](examples/interfaces), [examples/methods](examples/methods).

## Error handling

Odin's own `or_return`, `or_else`, `or_break` and `or_continue` work unchanged. Vidar adds:

| Syntax | Meaning |
|---|---|
| `x := f() or_return value` | if `f` fails, return zero values plus `value` as the error |
| `x := f() catch err { ... }` | if `f` fails, run the block with the error bound to `err` |
| `x := f() catch { ... }` | same, without naming the error |
| `x := f() catch unreachable` | if `f` fails, panic with the error and the source line |
| `errdefer stmt` / `errdefer { ... }` | a `defer` that runs only when the proc returns a failure |

```odin
n := strconv.parse_int(text) or_return .Bad_Number
cfg := parse_config(text) catch err {
	log.error(err)
	return {}, err
}
parse_int("-1", 10) catch err { fmt.println(err) }   // bare call: may fall through
answer := parse_int("42", 100) catch unreachable
errdefer delete(buf)
```

Rules:
- "Fails" means what it means for `or_return`: the last result is `false` (ok-bool), or not nil/zero (error enum, union, pointer).
- `or_return value` and `catch` follow a call that is the whole right-hand side of `x := ...` / `x = ...`, or a bare call statement. The left-hand names receive the call's leading results; a typed declaration (`x: T = ...`) is not allowed.
- A value starting with `-` or `&` is ambiguous (Odin reads `f() or_return - 1` as arithmetic) and is an error: write `or_return (-1)`, or `(f() or_return) - 1`.
- A `catch` block after a declaration or assignment must leave the scope (`return`, `break`, `continue`, `panic`, ...). After a bare call it may fall through.
- `or_return value` and `errdefer` need a proc with results. `errdefer` checks the last result after `return` has set it.

Example: [examples/errors](examples/errors).

## Anonymous struct literals

| Syntax | Meaning |
|---|---|
| `x := { name = value, ... }` | declares `x` with a struct type made on the spot; each field's type is inferred from its value |
| `x := { pos = { x = 1, y = 2 }, ... }` | nested literals become nested struct types |
| `a, b := { v = 1 }, { v = 2 }` | several in one declaration |

```odin
hero := { name = "slime", hp = 10 }     // struct { name: string, hp: int }
hero.hp += 1
cfg := { size = { w = 800, h = 600 }, on_resize = proc[&hero](w, h: int) { ... }, at = Point{1, 2} }

take :: proc(h: struct { name: string, hp: int }) { ... }
take(hero)                               // same field names and types: same type
```

Rules:
- Only on the right-hand side of a `:=` declaration inside a procedure, the one place where Odin has no type for `{ ... }`. Everywhere else (`p: Point = { x = 1 }`, arguments, `return`, assignments) a `{ ... }` keeps Odin's meaning.
- Every element needs a name. Untyped constants take their default types (`int`, `f64`, `string`, `rune`, `bool`). A field cannot be inferred from `nil`, `---` or an untyped positional literal like `{ 1, 2 }`; write the type, e.g. `Point{1, 2}`.
- Values are evaluated once, left to right, before the struct is built.
- The type is an ordinary Odin anonymous struct, so it is identical to any other with the same fields in the same order, including a written-out `struct { ... }`.
- Not allowed at file scope or in an `if`/`for`/`switch` initializer.

Example: [examples/anon_structs](examples/anon_structs).

## Cyclic imports

There is no new syntax: relative imports may form cycles.

```odin
// game/game.vidar                      // ui/ui.vidar
package game                             package ui
import "../ui"                           import "../game"
```

- Packages in a cycle are merged into one Odin package; their members are prefixed (`ui.render` becomes `ui__render`), except in the entry package.
- `@(private)` still means private to the original package.
- Only relative imports take part; `core:`, `vendor:` and other collections stay ordinary imports.

Example: [examples/cyclic](examples/cyclic).

## Comptime procs (macros)

| Syntax | Meaning |
|---|---|
| `name :: proc!(params) -> Kind { ... }` | a comptime proc (macro): the `!` after `proc` makes it one. It runs inside the transpiler and never reaches the generated Odin |
| `name!(args)` | invoke a comptime proc |
| `pkg.name!(args)` | invoke a macro from another package |
| `name!(args) { ... }` | trailing block, when the last parameter is a `Stmt` |
| `name! { ... }` | trailing block with no other arguments |
| `p: Kind = default` | parameter default: code for `Expr`/`Stmt`/`Type`, a constant otherwise |
| `quote(expr)` | build an expression |
| `quote { stmts }` | build statements |
| `$name` | splice a comptime value: code, number, string, `Ident` or `[dynamic]Stmt` (inserts every statement) |
| `$(expr)` | splice the result of a comptime expression, e.g. `$value.$(ident(f))` |
| `$$` | a literal `$` in the output, for generating polymorphic procs |

Parameter kinds:

| Type | Argument |
|---|---|
| `Expr(T)` | an expression that must have type `T` |
| `Expr` | any expression |
| `Stmt` | a `{ ... }` block or statements |
| `Type` | a type: `f64`, `[]int`, `geo.Vec2` |
| `Ident` | a bare name, spliced unhygienically (to declare something on purpose) |
| `int`, `string`, `bool`, `f64`, ... | a compile-time constant, evaluated |

Result kinds: `Expr` / `Expr(T)` (usable anywhere an expression is), `Stmt` (statements only), a constant type (folds to a literal), or none (runs for side effects such as `compile_error`).

```odin
square :: proc!(x: Expr(i32)) -> Expr(i32) { return quote($x * $x) }

swap :: proc!(a, b: Expr) -> Stmt {
	return quote { tmp := $a; $a = $b; $b = tmp }   // `tmp` is renamed (hygiene)
}

repeat :: proc!(n: int = 2, body: Stmt) -> Stmt {
	out: [dynamic]Stmt
	for _ in 0..<n do append(&out, body)
	return quote { $out }
}

square!(k + 1)
swap!(a, b)
repeat!(4) { total += 10 }
```

Body language: a subset of Odin — `:=`, `if`/`else`, ternary `a if c else b`, `for` (C-style, ranges, `for x, i in arr`), `switch`, `[dynamic]` arrays with `append` and `len`, string `+` and slicing, and calls to other procs. Integers have their type's width and wrap around as at run time; untyped constants are unbounded.

Comptime builtins:

| Builtin | Result |
|---|---|
| `type_name(T)` | the type's name as a string |
| `type_fields(T)` | the struct's field names |
| `type_of_expr(e)` | the type of an `Expr` argument, as a `Type` |
| `stringify(x)` | source text of a code value |
| `ident(s)` | a name from a string |
| `parse_expr(s)` | an `Expr` parsed from a string |
| `split_comparison(e)` | `[lhs, op, rhs]` for a comparison, otherwise empty |
| `split_range(e)` | `[lo, op, hi]` for a range `lo..<hi` / `lo..=hi`, otherwise empty |
| `block_value(T, body)` | what `do!` expands to: `body` hoisted before the current statement, its `take`s storing the result (`T` is `_` to infer it) |
| `comptime_value(body)` | what `comptime!` expands to: `body` evaluated now, folded to its value |
| `once(e)` | `e` when evaluating it twice is harmless (no calls), otherwise a temporary holding it, declared just before the current statement |
| `is_literal(e)` | whether `e` is a literal (optionally negated or parenthesized) |
| `call_site()` | `"file:line"` of the macro call |
| `compile_error(...)` | stop compilation with a message |
| `len`, `append`, `min`, `max`, `abs` | as in Odin |
| `fmt.tprintf`, `fmt.aprintf`, `fmt.tprint`, `fmt.aprint` | build strings |
| `fmt.println`, `fmt.printf` | print to the compiler's stderr |

Rules:
- Names declared inside a `quote` are renamed; spliced code is never renamed.
- `Expr(T)` is checked by vidar when it can infer the type, and by Odin otherwise.
- A comptime body already runs at compile time: calls need no `!` (`fib(n - 1)`), though one is allowed; on a macro returning code, `!` expands it and evaluates the code. Expansion depth and evaluation steps are limited.
- A `Stmt` macro can also be invoked at file scope, e.g. to generate declarations.

Example: [examples/macros](examples/macros).

### Compile-time evaluation

| Syntax | Meaning |
|---|---|
| `f!(args)` | run `f` at compile time and replace the call with its result; works for comptime procs and, when every argument is a constant, regular procs (`square!(N)`, `fmt.tprintf!("v%d", V)`) |
| `comptime! { expr }` | evaluate `expr` at compile time; every call in it behaves as if it had a `!` |
| `comptime! { ...; take v }` | run a block at compile time; folds to `v` |

```odin
a := fib!(20)                                      // a := 6765
primes: [5]int = first_primes!(5)                  // { 2, 3, 5, 7, 11 }
total := comptime! { s := 0; for i in 1..=10 do s += i; take s }  // 55
big := comptime! { 1 << 40 }                       // 1099511627776
w := square32!(100000)                             // i32(1410065408), as at run time
static_assert!(N > 0, "N must be positive")        // a statement: runs for its effects
d := square!(k)                                    // error: 'k' is a runtime value
```

Rules:
- Numbers, strings and booleans fold to literals (sized integers keep their type); arrays and structs to untyped compound literals, so the target needs a known type.
- Anything that needs run-time values, `compile_error` and other evaluation errors stop compilation.
- `return` cannot leave a `comptime!` block; use `take`.

Example: [examples/comptime](examples/comptime).

## Performance

| Syntax | Meaning |
|---|---|
| `@(table) f :: proc(x: T) -> R { ... }` | `T` is `bool`, `u8`, `i8` or an enum (without explicit member values): every result is stored once, and `f(x)` becomes a table lookup. Computed at compile time when the body can run there, else at startup. The body must depend only on `x` |
| `@(specialize) f :: proc(...) { ... }` | each call passing constants to basic or enum parameters calls a copy where those are compile-time (`$p`); a call passing a closure literal to a closure parameter `f`'s body only calls calls a copy that calls the literal's body directly (also without `-opt`); other calls call `f` |
| `@(no_table)`, `@(no_specialize)` | `-opt` won't make `f` a table / specialize it on its own |
| `@(no_alloc) f :: proc(...) { ... }` | compile error when `f`, or anything it calls, can allocate (or calls something that can't be checked: a closure, a proc value, an interface with unknown impls, an unlisted `core:` proc); in builds below `-o:size` its allocators also panic |
| `@(hot) f :: proc(...) { ... }` | with `-opt`, every decision against something inside `f` is a warning: a bounds check left in a loop, an indirect call, a closure not inlined, a vtable call, an allocation in a loop |
| `Pool(I)` | values of every implementation of interface `I`, one array per type; `I` must not be extended in another package |
| `append(&pool, v1, v2, ...)` | copies values (not pointers) into their type's array; a statement of its own |
| `for s in pool { ... }` | one loop per type, `s` is a `^T` and converts to `I`; `break`, `continue` and labels act on the whole loop |
| `len(pool)`, `clear(&pool)`, `delete(pool)` | as for a dynamic array |

```odin
@(table)
collatz :: proc(b: u8) -> int { ... }      // __collatz_table[b], a @(rodata) literal

@(specialize)
blur :: proc(dst, src: []int, radius: int) { ... }
blur(dst, src, 1)                          // blur__radius(dst, src, 1) with `$radius: int`

shapes: Pool(Shape)
append(&shapes, Rect{2, 3}, Circle{1})
for s in shapes do total += area(s)        // a direct call per type
```

`-opt` (on `build`, `run`, `check` and `emit`) also rewrites plain Odin where the result is provably the same:
- `fmt` print calls with a literal format write each piece directly, with no format parsing or `any` boxing
- indexes proven in bounds by their loop (`for i in 0..<len(a)`, `for x, i in a`, `for i := 0; i < len(a); i += 1`, and `a[i ± k]` when the range leaves room) get `#no_bounds_check`
- an array indexed by `i` on every pass of a loop with no early exit gets one bounds check before the loop instead of one per index (the panic comes before the loop runs)
- adjacent `make`/`new` freed only by `defer delete`/`defer free` in the same block become one allocation
- `x := make([]T, N)` with a constant `N` and a `defer delete(x)` in the same block goes on the stack when `x` doesn't escape (4 KB in a proc a goroutine can reach, 64 KB elsewhere; `@(no_stack_buffer)` opts out)
- procs over `bool`/`u8`/`i8` that are pure integer code and loop become tables; procs whose constant arguments bound a loop, or divide, shift or branch inside one, are specialized (at most 4 copies, not when every call passes the same constant); a call passing a closure literal (`proc[...]`) to a closure parameter the callee only calls gets a copy calling the literal's body directly, with its captures on the stack (at most 4 copies per proc, written in the caller's file; not when the callee uses a private name the caller can't see)

`-opt-report` in place of `-opt` also prints what it decided per proc, and why not where it didn't.

Example: [examples/negative_cost](examples/negative_cost).

## Goroutines and channels

Not syntax: a library, `import "vidar:sched"`. Goroutines are started from closures.

```odin
results := sched.make_chan(string)
sched.go(proc[url, results]() { fetch(url, results) })
r: string
switch sched.select(sched.on_recv(results, &r), sched.on_recv(timeout)) {
case 0: fmt.println(r)
case 1: fmt.println("timed out")
}
```

`go`, `Chan(T)`, `make_chan`, `send`, `recv`, `close`, `select`, `try_select`, `on_recv`, `on_send`, `sleep`, `yield`, `after`, `Wait_Group` (`add`, `done`, `wait`), `Mutex` (`lock`, `unlock`, `try_lock`), `blocking`, TCP (`listen_tcp`, `accept`, `dial`, `send`, `recv`, `send_file`), UDP (`udp_socket`, `bind`, `send_to`, `recv_from`), `wait_ready`, files (`open`, `read_at`, `write_at`, `stat`, `read_entire_file`, `write_entire_file`) and `resolve`. All of them park only the calling goroutine. See the [README](README.md#goroutines-and-channels).

Example: [examples/goroutines](examples/goroutines).

## Built-in macros

Available in every file with no import; a declaration of your own with the same name takes precedence.

| Macro | Meaning |
|---|---|
| `scoped! { ... }` | the block gets its own `context.temp_allocator`, freed on every exit path |
| `scoped!(allocator) { ... }` | same, with the arena's memory taken from `allocator` |
| `with_allocator!(a) { ... }` | `a` is the block's `context.allocator` |
| `locked!(&mutex) { ... }` | holds any `core:sync` lock for the block |
| `timed!("label") { ... }` / `timed! { ... }` | prints the block's duration to stderr (label defaults to the call site) |
| `track!("label") { ... }` / `track! { ... }` | gives the block a tracking `context.allocator` and prints every allocation still live at its end to stderr (label defaults to the call site); without `-debug` the block runs untracked |
| `track!(allocator) { ... }` / `track!(allocator, "label") { ... }` | same, tracking allocations made from `allocator`; the label is told apart by being a string literal |
| `do! { ...; take value }` | evaluates to the taken value; `return` and `or_return` inside it still leave the procedure. The block runs just before the enclosing statement (a declaration, assignment, expression statement or `return`), so nothing with side effects may come before it there, and it can't be on the right of `&&` / `\|\|` / `or_else` or in a ternary branch. Panics if the block ends without a `take` |
| `do!(T) { ... }` | same, with the result type given when it can't be inferred |
| `comptime! { ... }` | compile-time evaluation, see [above](#compile-time-evaluation) |
| `dbg!(expr)` | prints `[file:line] expr = value` to stderr and evaluates to the value |
| `check!(cond)` / `check!(cond, "msg")` | panics when `cond` is false, showing the expression and the values of non-literal comparison operands |
| `todo!()` / `todo!("msg")` | panics with "not yet implemented" |
| `unimplemented!()` / `unimplemented!("msg")` | panics with "not implemented" |

Examples: [examples/builtins](examples/builtins), [examples/scoped](examples/scoped).
