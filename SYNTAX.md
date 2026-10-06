# Vidar syntax reference

Everything Vidar adds on top of Odin, in one place. Anything not listed here is plain Odin and passes through unchanged. The [README](README.md) explains how each feature lowers to Odin; [examples/](examples) has a runnable program per feature.

All new keywords are contextual: `closure`, `comptime`, `quote`, `interface`, `impl`, `catch` and `errdefer` stay usable as ordinary identifiers.

## Closures

| Syntax | Meaning |
|---|---|
| `proc[x](...) -> R { ... }` | closure capturing `x` by value (a copy taken when the closure is created) |
| `proc[&x](...) -> R { ... }` | closure capturing `x` by reference; `x` is moved to the heap so the closure can outlive the frame |
| `proc[x, &y, z](...) { ... }` | mixed capture list |
| `proc[](...) { ... }` | closure with no captures |
| `proc(...) { ... }` | (no brackets) an ordinary Odin proc, not a closure |
| `closure(params) -> results` | closure type; usable anywhere a type is (fields, params, results, `[dynamic]closure(int) -> int`, aliases) |
| `f(x)`, `s.handler(x)`, `make_adder(1)(2)` | calling a closure, exactly like a proc |

```odin
Op :: closure(a, b: int) -> (int, bool)

make_counter :: proc(start: int) -> closure() -> int {
	count := start
	return proc[&count]() -> int { count += 1; return count }
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

Example: [examples/closures](examples/closures).

## Interfaces

| Syntax | Meaning |
|---|---|
| `I :: interface { m, n, ... }` | interface declaration: lists its methods, in vtable order |
| `m :: proc(x: I, a: A) -> R ---` | method declaration: a top-level proc without a body whose first parameter is the interface |
| `impl I for T { m = t_m, n = t_n }` | implementation: binds every method to a proc declared with a body, taking `^T` first |
| `impl pkg.I for T { ... }` | implementing another package's interface (only from that package or one in an import cycle with it) |
| `m(&x, args)` with `x: T` | static call to `T`'s bound proc; works through pointers, fields, indexes and `&p^` |
| `m(i, args)` with `i: I` | dynamic call through the vtable |
| `pkg.m(...)` | calling another package's method, like any proc |
| `I(&x)` | explicit conversion from `^T` or an `I` |
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
- No interface embedding and no generic impls. There is no builtin cleanup interface; declare `Destroy :: interface { destroy }` yourself.

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
- `or_return value` and `catch` follow a call that is the whole right-hand side of `x := ...` / `x = ...`, or a bare call statement. The left-hand names receive the call's leading results; a typed declaration (`x: T := ...`) is not allowed.
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
| `name :: comptime proc(params) -> Kind { ... }` | a macro; runs inside the transpiler and never reaches the generated Odin |
| `name!(args)` | invoke a macro |
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
square :: comptime proc(x: Expr(i32)) -> Expr(i32) { return quote($x * $x) }

swap :: comptime proc(a, b: Expr) -> Stmt {
	return quote { tmp := $a; $a = $b; $b = tmp }   // `tmp` is renamed (hygiene)
}

repeat :: comptime proc(n: int = 2, body: Stmt) -> Stmt {
	out: [dynamic]Stmt
	for _ in 0..<n do append(&out, body)
	return quote { $out }
}

square!(k + 1)
swap!(a, b)
repeat!(4) { total += 10 }
```

Body language: a subset of Odin — `:=`, `if`/`else`, ternary `a if c else b`, `for` (C-style, ranges, `for x, i in arr`), `switch`, `[dynamic]` arrays with `append` and `len`, string `+` and slicing, and calls to other comptime procs.

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
| `match_arms(body)` | the arms of a `{ p1, p2 => value, ... }` block: structs with `patterns` and `value` |
| `block_value(T, body)` | what `do!` expands to: `body` hoisted before the current statement, its `return`s storing the result (`T` is `_` to infer it) |
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
- Inside a comptime body, call other comptime procs directly (`fib(n - 1)`), not with `!`. Expansion depth and evaluation steps are limited.
- A `Stmt` macro can also be invoked at file scope, e.g. to generate declarations.

Example: [examples/macros](examples/macros).

### `comptime` expressions

| Syntax | Meaning |
|---|---|
| `comptime expr` | evaluate `expr` at compile time and replace it with the result; a compile error if it can't be |
| `comptime do! { ...; return v }` | run a block at compile time; folds to `v` |

```odin
a := comptime fib(20)                      // a := 6765
primes: [5]int = comptime first_primes(5)  // { 2, 3, 5, 7, 11 }
total := comptime do! { s := 0; for i in 1..=10 do s += i; return s }  // 55
d := comptime square(k)                    // error: 'k' is a runtime value
```

Rules:
- Applies to the whole expression after it. Only a prefix when an expression follows on the same line; `comptime(x)` is a call.
- Comptime and regular procs are called directly, without `!`. Macros are expanded and their code is evaluated too.
- Numbers, strings and booleans fold to literals; arrays and structs to untyped compound literals.
- Anything that needs run-time values, `compile_error` and other evaluation errors stop compilation.

Example: [examples/comptime](examples/comptime).

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
| `format!("hi {name}, {x:.2f}")` | interpolated temp string; `{expr}` uses `%v`, `{expr:spec}` uses `%spec`, `{{` and `}}` are literal braces |
| `match!(value) { p => result, ... }` | the result of the first arm whose pattern matches `value`: a value (`==`), a range `lo..<hi` / `lo..=hi`, `p1, p2` for either, or `_` for anything (last arm only); panics when nothing matches. `value` is evaluated once |
| `match! { cond => result, ... }` | the result of the first arm whose condition holds |
| `do! { ...; return value }` | evaluates to the returned value; the block runs just before the enclosing statement, and `return` leaves the block, not the procedure |
| `do!(T) { ... }` | same, with the result type given when it can't be inferred |
| `dbg!(expr)` | prints `[file:line] expr = value` to stderr and evaluates to the value |
| `check!(cond)` / `check!(cond, "msg")` | panics when `cond` is false, showing the expression and the values of non-literal comparison operands |
| `todo!()` / `todo!("msg")` | panics with "not yet implemented" |
| `unimplemented!()` / `unimplemented!("msg")` | panics with "not implemented" |

Examples: [examples/builtins](examples/builtins), [examples/scoped](examples/scoped).
