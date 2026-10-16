## anon_struct_duplicate_field

An anonymous struct literal declares one field per name, so a name given twice would be two fields with the same name. Give each field once, or use two names:

```vidar
main :: proc() {
	a := { x = 1, y = 2 }
	_ = a
}
```

## anon_struct_nested_positional

A field's type comes from its value, and a positional literal like `{ 1, 2 }` doesn't say what type it is. Name the nested literal's fields, so it becomes an anonymous struct too, or write its type:

```vidar
Point :: struct { x, y: int }

main :: proc() {
	a := { pos = { x = 1, y = 2 } }
	b := { pos = Point{1, 2} }
	_, _ = a, b
}
```

## anon_struct_nil

`nil` is the zero value of many types, so it can't say which one the field should have. Give the value a type:

```vidar
main :: proc() {
	a := { p = (^int)(nil) }
	_ = a
}
```

## anon_struct_unnamed_field

An anonymous struct's fields are named by its literal, so every element needs `name = value`:

```vidar
main :: proc() {
	a := { x = 1, y = 2 }
	_ = a
}
```

## bodiless_not_method

Outside a `foreign` block, a procedure without a body (`---`) declares an interface method, and must be listed by an interface. Give the procedure a body, or list it in an interface:

```vidar
foo :: proc(x: int) {}

main :: proc() {}
```

## capture_global

Only locals are captured. A global (or a constant) is visible from the closure's body without capturing it, so take it out of the capture list:

```vidar
G := 1

main :: proc() {
	f := proc[]() -> int { return G }
	_ = f
}
```

## catch_must_leave_scope

After a declaration or assignment, the variables would be used unset if the `catch` block fell through, so it must leave the scope: `return`, `break`, `continue` or a panic.

```vidar
Error :: enum { None, Bad }
f :: proc() -> (int, Error) { return 1, .None }

main :: proc() {
	x := f() catch err {
		fmt.println(err)
		return
	}
	_ = x
}
```

## catch_on_compound_assign

`catch` follows a call that is the whole right-hand side of `:=` or `=`, or a call statement. Catch the call first, then use its value:

```vidar
Error :: enum { None, Bad }
f :: proc() -> (int, Error) { return 1, .None }

main :: proc() {
	x := 0
	y := f() catch unreachable
	x += y
	_ = x
}
```

## catch_typed_decl

`catch` declares its names the way `:=` does, from the call's results; a declared type isn't allowed. Declare with `:=`, and convert afterwards if needed:

```vidar
Error :: enum { None, Bad }
f :: proc() -> (int, Error) { return 1, .None }

main :: proc() {
	x := f() catch unreachable
	_ = x
}
```

## closure_capture_const_local

A local constant isn't a variable: the closure's body can use it without capturing it.

```vidar
main :: proc() {
	K :: 3
	f := proc[]() -> int { return K }
	_ = f
}
```

## closure_capture_field_write

A by-value capture is a copy that each call gets afresh, so writing to it (or to one of its fields) would be lost. Capture a pointer to change the original:

```vidar
Point :: struct { x, y: int }

main :: proc() {
	p := Point{1, 2}
	move := proc[&p]() { p.x += 1 }
	move()
	_ = p
}
```

## closure_capture_twice

Each name appears once in a capture list. Capture it by value or by pointer, not both:

```vidar
main :: proc() {
	n := 1
	f := proc[&n]() { n += 1 }
	_ = f
}
```

## closure_capture_unknown

The capture list names a variable that doesn't exist. Check the spelling, or declare it first:

```vidar
main :: proc() {
	zz := 1
	f := proc[zz]() -> int { return zz }
	_ = f
}
```

## closure_capture_write

A by-value capture is read-only: each call gets a fresh copy, so a change would be lost. Capture `&n` to change the variable itself:

```vidar
main :: proc() {
	n := 1
	counter := proc[&n]() -> int { n += 1; return n }
	_ = counter
}
```

## closure_captures_closure

A closure has a fixed amount of room for captures, so it can't hold a copy of another closure. Capture a pointer to it: a heap copy from `new_clone` when the new closure outlives this procedure.

```vidar
twice :: proc(f: closure(int) -> int) -> closure(int) -> int {
	fp := new_clone(f)
	return proc[fp](x: int) -> int { return fp^(fp^(x)) }
}

main :: proc() {}
```

## closure_named_args

Calls through a closure pass their arguments by position:

```vidar
main :: proc() {
	f := proc[](a: int) {}
	f(1)
}
```

## closure_needs_body

A capture list makes a closure literal, which needs a body in braces. For a closure type, write `closure(...)`:

```vidar
main :: proc() {
	x := 1
	f := proc[x]() -> int { return x }
	_ = f
}
```

## closure_outer_proc_local

A closure can capture only the locals of the procedure it's written in, or what its enclosing closure captured. Capture `x` in the outer closure first:

```vidar
main :: proc() {
	x := 1
	outer := proc[x]() {
		inner := proc[x]() -> int { return x }
		_ = inner
	}
	_ = outer
}
```

## closure_ref_append

The closure holds `&ticks`, a local of `run`, and would be kept in `w.on_frame` after `run` returns. Keep the state on the heap and capture that pointer instead:

```vidar
World :: struct { on_frame: [dynamic]closure(frame: int) }

run :: proc(w: ^World) {
	ticks := new_clone(0)
	append(&w.on_frame, proc[ticks](frame: int) { ticks^ += 1 })
}

main :: proc() {
	w: World
	run(&w)
}
```

## closure_ref_env_copy

Inside the outer closure, `k` is that closure's own copy, which is gone when its call returns, so the inner closure can't hold `&k`. Capture `k` by value:

```vidar
outer :: proc(k: int) -> closure() -> closure() -> int {
	return proc[k]() -> closure() -> int {
		return proc[k]() -> int { return k }
	}
}

main :: proc() { _ = outer(1) }
```

## closure_ref_field

The closure holds `&hits`, a local of `wire`, and is stored in a struct the caller keeps. Put the count on the heap:

```vidar
Button :: struct { on_click: closure() }

wire :: proc(b: ^Button) {
	hits := new_clone(0)
	b.on_click = proc[hits]() { hits^ += 1 }
}

main :: proc() {
	b: Button
	wire(&b)
}
```

## closure_ref_global

A global outlives every procedure, so it can't hold a closure that points at a local. Use a global for the state too, which needs no capture, or a heap pointer:

```vidar
on_tick: closure()
hits: int

install :: proc() {
	on_tick = proc[]() { hits += 1 }
}

main :: proc() { install() }
```

## closure_ref_named_result

Assigning a closure to a named result returns it, so it can't hold `&n` of a local. Capture a heap pointer:

```vidar
counter :: proc() -> (f: closure() -> int) {
	n := new_clone(0)
	f = proc[n]() -> int { n^ += 1; return n^ }
	return
}

main :: proc() { _ = counter() }
```

## closure_ref_param

A parameter lives in the procedure's frame like a local, so a returned closure can't hold `&f`. Make a heap copy and capture that:

```vidar
every :: proc(n: int, f: closure(t: int)) -> closure(t: int) {
	fp := new_clone(f)
	return proc[n, fp](t: int) { if t % n == 0 do fp^(t) }
}

main :: proc() { _ = every(2, proc[](t: int) {}) }
```

## closure_ref_passed_chain

Vidar follows the closure through `later` and `keep`, and finds that it ends up in `hs.all`, which outlives `register`. Give the closure state that lives as long:

```vidar
Handlers :: struct { all: [dynamic]closure() }

keep :: proc(hs: ^Handlers, f: closure()) {
	append(&hs.all, f)
}

later :: proc(hs: ^Handlers, f: closure()) {
	keep(hs, f)
}

register :: proc(hs: ^Handlers) {
	n := new_clone(0)
	g := proc[n]() { n^ += 1 }
	later(hs, g)
}

main :: proc() {
	hs: Handlers
	register(&hs)
}
```

## closure_ref_passed_go

A goroutine can run after `start` has returned, so it can't hold `&n` of `start`'s locals. Share heap state instead (or start the goroutine from `main`, whose locals live until the program exits):

```vidar
import "vidar:sched"

start :: proc() {
	n := new_clone(0)
	sched.go(proc[n]() { n^ += 1 })
}

main :: proc() { start() }
```

## closure_ref_passed_named

`spawn` passes its `task` parameter to `sched.go`, so passing it a closure that holds `&n` lets that pointer reach a goroutine. Use heap state:

```vidar
import "vidar:sched"

spawn :: proc(task: closure(), times := 1) {
	for _ in 0..<times do sched.go(task)
}

start :: proc() {
	n := new_clone(0)
	f := proc[n]() { n^ += 1 }
	spawn(times = 2, task = f)
}

main :: proc() { start() }
```

## closure_ref_passed_returned

`id` returns its parameter, so `f` is the same closure, holding `&n`, and returning it lets it outlive `n`. Capture a heap pointer:

```vidar
id :: proc(f: closure() -> int) -> closure() -> int { return f }

counter :: proc() -> closure() -> int {
	n := new_clone(0)
	f := id(proc[n]() -> int { n^ += 1; return n^ })
	return f
}

main :: proc() { _ = counter() }
```

## closure_ref_passed_store

`keep` stores its parameter in a global, so the closure passed to it can't hold `&n` of a local:

```vidar
saved: closure()

keep :: proc(f: closure()) {
	saved = f
}

start :: proc() {
	n := new_clone(0)
	keep(proc[n]() { n^ += 1 })
}

main :: proc() { start() }
```

## closure_ref_returned

`n` lives in `counter`'s frame, which is gone once it returns, so the returned closure can't point at it. Keep the state on the heap:

```vidar
counter :: proc() -> closure() -> int {
	n := new_clone(0)
	return proc[n]() -> int { n^ += 1; return n^ }
}

main :: proc() { _ = counter() }
```

## closure_ref_returned_local

Copying the closure into another local doesn't change what it points at: `g` still holds `&n`. Keep the state on the heap:

```vidar
counter :: proc() -> closure() -> int {
	n := new_clone(0)
	f := proc[n]() -> int { n^ += 1; return n^ }
	g := f
	return g
}

main :: proc() { _ = counter() }
```

## closure_ref_struct_lit

Returning a struct that holds the closure returns the closure. Keep the state on the heap:

```vidar
Handler :: struct { on: closure() }

make_handler :: proc() -> Handler {
	hits := new_clone(0)
	return Handler{on = proc[hits]() { hits^ += 1 }}
}

main :: proc() { _ = make_handler() }
```

## closure_type_switch_by_ref

The variable a type switch binds is a copy that Odin doesn't let you take the address of. Capture it by value, or capture the union itself by pointer:

```vidar
main :: proc() {
	u: union { int, string } = 1
	#partial switch v in u {
	case int:
		f := proc[v]() -> int { return v }
		g := proc[&u]() { u = 2 }
		_, _ = f, g
	}
}
```

## compile_error_builtin

The macro rejected its argument on purpose, with `compile_error`. Pass it something it accepts:

```vidar
make_scaler :: proc!(T: Type) -> Expr {
	if type_name(T) == "string" { compile_error("make_scaler: cannot scale a string") }
	return quote(1)
}

main :: proc() { _ = make_scaler!(f64) }
```

## comptime_anon_proc

A comptime procedure is a declaration, `name :: proc!(...)`, at file scope or in a procedure; it can't be a value assigned to a variable:

```vidar
double :: proc!(n: int) -> int { return n * 2 }

main :: proc() {
	f := double!(4)
	_ = f
}
```

## comptime_bang_not_proc

The `!` goes after `proc` in the declaration, and after the name only at the call:

```vidar
fib :: proc!(n: int) -> int { return n }

main :: proc() { _ = fib!(3) }
```

## comptime_block_no_value

A `comptime!` block is a value, so it needs one: a single expression, or `take value` at the end:

```vidar
main :: proc() {
	x := comptime! { y := 1; take y + 1 }
	_ = x
}
```

## comptime_block_runtime_value

`n` only has a value when the program runs. Make it a constant, or compute the value at run time:

```vidar
main :: proc() {
	N :: 4
	x := comptime! {
		total := 0
		for i in 1..=N do total += i
		take total
	}
	_ = x
}
```

## comptime_call_compile_error

The macro rejected its argument on purpose, with `compile_error`. Pass it something it accepts:

```vidar
check_small :: proc!(n: int) -> int {
	if n > 3 do compile_error("too big")
	return n
}

main :: proc() {
	x := check_small!(2)
	_ = x
}
```

## comptime_call_no_value

`name!(...)` used as a value puts the procedure's result in its place, and `noop` has none. Call it as a statement, or give it a result:

```vidar
seven :: proc() -> int { return 7 }

main :: proc() {
	x := seven!()
	_ = x
}
```

## comptime_call_runtime_value

`square!(k)` runs `square` while compiling, when `k` has no value yet. Call it at run time, without the `!`, or pass a constant:

```vidar
square :: proc(x: int) -> int { return x * x }

main :: proc() {
	k := 3
	x := square(k)
	y := square!(3)
	_, _ = x, y
}
```

## comptime_old_syntax

Comptime procedures are declared with a `!` after `proc`:

```vidar
fib :: proc!(n: int) -> int { return n }

main :: proc() { _ = fib!(3) }
```

## comptime_proc_runtime_call

A procedure declared with `proc!` only exists while compiling, so it's called with a `!` and constant arguments. For a run-time call, declare it with `proc`:

```vidar
fib :: proc(n: int) -> int { return n }

main :: proc() {
	k := 3
	x := fib(k)
	y := fib!(3)
	_, _ = x, y
}
```

## comptime_return_in_block

`return` would leave the enclosing procedure; a `comptime!` block gives its value with `take`:

```vidar
main :: proc() {
	x := comptime! { y := 2; take y * 2 }
	_ = x
}
```

## comptime_unknown

Nothing called `squre` is declared: probably a typo.

```vidar
square :: proc(x: int) -> int { return x * x }

main :: proc() {
	x := square!(3)
	_ = x
}
```

## destroy_append_copy

Appending `f` would put a copy in the array while `f` keeps its own, and both would be destroyed. Move it in, or append a new value directly:

```vidar
# File :: struct { name: string }
# file_destroy :: proc(f: ^File) { if f.name != "" do fmt.println("close", f.name) }
# impl Destroy for File { destroy = file_destroy }
# open :: proc(name: string) -> File { return File{name} }
#
main :: proc() {
	files: [dynamic]File
	f := open("a")
	append(&files, move!(f))
	append(&files, open("b"))
}
```

## destroy_append_spread

`append(&a, ..b[:])` copies each element of `b` into `a`, and `b` keeps its own. Move them one at a time:

```vidar
# File :: struct { name: string }
# file_destroy :: proc(f: ^File) { if f.name != "" do fmt.println("close", f.name) }
# impl Destroy for File { destroy = file_destroy }
# open :: proc(name: string) -> File { return File{name} }
#
main :: proc() {
	a, b: [dynamic]File
	append(&b, open("x"))
	for i in 0..<len(b) do append(&a, move!(b[i]))
	clear(&b)
}
```

## destroy_assign_at

`assign_at` writes over an element without destroying what was there. Grow the array with `resize`, then assign, which destroys the old value:

```vidar
# File :: struct { name: string }
# file_destroy :: proc(f: ^File) { if f.name != "" do fmt.println("close", f.name) }
# impl Destroy for File { destroy = file_destroy }
# open :: proc(name: string) -> File { return File{name} }
#
main :: proc() {
	files: [dynamic]File
	resize(&files, 1)
	files[0] = open("a")
}
```

## destroy_blank

`_ = open("a")` throws the value away, so nothing would destroy it. Keep it in a variable, which destroys it at the end of the scope:

```vidar
# File :: struct { name: string }
# file_destroy :: proc(f: ^File) { if f.name != "" do fmt.println("close", f.name) }
# impl Destroy for File { destroy = file_destroy }
# open :: proc(name: string) -> File { return File{name} }
#
main :: proc() {
	f := open("a")
	_ = f.name
}
```

## destroy_borrow_proc_value

The procedure type takes its parameter `#owned`, so its callers hand the value over and won't destroy it; `show` only borrows it, so nothing would. Declare the parameter `#owned` in `show` too, or use a type that borrows:

```vidar
# File :: struct { name: string }
# file_destroy :: proc(f: ^File) { if f.name != "" do fmt.println("close", f.name) }
# impl Destroy for File { destroy = file_destroy }
# open :: proc(name: string) -> File { return File{name} }
#
show :: proc(#owned f: File) { fmt.println(f.name) }

main :: proc() {
	sink: proc(#owned f: File) = show
	sink(File{"a"})
}
```

## destroy_capture_escape

A closure that captures a destructible value by value borrows it, so it can't outlive the procedure that owns the value. Share the value through an `Rc`, which the closure can own a copy of on the heap, or keep the closure local:

```vidar
# File :: struct { name: string }
# file_destroy :: proc(f: ^File) { if f.name != "" do fmt.println("close", f.name) }
# impl Destroy for File { destroy = file_destroy }
# open :: proc(name: string) -> File { return File{name} }
#
logger :: proc() -> closure() {
	name := new_clone("log")
	return proc[name]() { fmt.println(name^) }
}

main :: proc() { logger()() }
```

## destroy_capture_escape_call

`remember` keeps its closure in a global, so the closure can't borrow `f`, which `setup` destroys when it returns. Capture what the callback needs, rather than the value with a destructor:

```vidar
# File :: struct { name: string }
# file_destroy :: proc(f: ^File) { if f.name != "" do fmt.println("close", f.name) }
# impl Destroy for File { destroy = file_destroy }
# open :: proc(name: string) -> File { return File{name} }
#
callbacks: [dynamic]closure()

remember :: proc(cb: closure()) { append(&callbacks, cb) }

setup :: proc() {
	f := open("log")
	name := f.name
	remember(proc[name]() { fmt.println(name) })
}

main :: proc() { setup() }
```

## destroy_clone_alone

`impl Clone` makes copies of a type with a destructor legal. A type without `impl Destroy` can already be copied, so it doesn't need one. Remove the impl, or give the type a destructor as well:

```vidar
Point :: struct { x, y: int }

main :: proc() {
	p := Point{1, 2}
	q := p
	_ = q
}
```

## destroy_clone_signature

A clone procedure takes the value itself, `Handle`, not a pointer, and returns the copy:

```vidar
Handle :: struct { id: int }
handle_destroy :: proc(h: ^Handle) {}
handle_clone :: proc(h: Handle) -> Handle { return h }
impl Destroy for Handle { destroy = handle_destroy }
impl Clone for Handle { clone = handle_clone }

main :: proc() {}
```

## destroy_comma_ok

`f, ok := m["a"]` copies the map's value into `f`, and the map keeps its own. Take a pointer to the value instead:

```vidar
# File :: struct { name: string }
# file_destroy :: proc(f: ^File) { if f.name != "" do fmt.println("close", f.name) }
# impl Destroy for File { destroy = file_destroy }
# open :: proc(name: string) -> File { return File{name} }
#
main :: proc() {
	m: map[string]File
	m["a"] = open("a")
	if f, ok := &m["a"]; ok do fmt.println(f.name)
}
```

## destroy_copy

`g := f` would leave two owners of the same file. Borrow it with a pointer, or move it with `move!`:

```vidar
# File :: struct { name: string }
# file_destroy :: proc(f: ^File) { if f.name != "" do fmt.println("close", f.name) }
# impl Destroy for File { destroy = file_destroy }
# open :: proc(name: string) -> File { return File{name} }
#
main :: proc() {
	f := open("a")
	g := &f
	h := move!(f)
	fmt.println(g.name, h.name)
}
```

## destroy_copy_assign

`g = f` would copy `f` into `g`. Move it instead; the assignment destroys `g`'s old value:

```vidar
# File :: struct { name: string }
# file_destroy :: proc(f: ^File) { if f.name != "" do fmt.println("close", f.name) }
# impl Destroy for File { destroy = file_destroy }
# open :: proc(name: string) -> File { return File{name} }
#
main :: proc() {
	f := open("a")
	g := open("b")
	g = move!(f)
}
```

## destroy_copy_derived

`Log` holds a `File`, so copying a `Log` copies the file. Borrow it, move it, or give `File` an `impl Clone` so that `Log` can be cloned field by field:

```vidar
# File :: struct { name: string }
# file_destroy :: proc(f: ^File) { if f.name != "" do fmt.println("close", f.name) }
# impl Destroy for File { destroy = file_destroy }
# open :: proc(name: string) -> File { return File{name} }
#
Log :: struct {
	out:   File,
	level: int,
}

main :: proc() {
	a := Log{out = File{"log"}}
	b := move!(a)
	fmt.println(b.level)
}
```

## destroy_copy_field

`f := log.out` would copy the field while `log` keeps it. Borrow it with a pointer, or move it out with `move!`, which leaves the field zero:

```vidar
# File :: struct { name: string }
# file_destroy :: proc(f: ^File) { if f.name != "" do fmt.println("close", f.name) }
# impl Destroy for File { destroy = file_destroy }
# open :: proc(name: string) -> File { return File{name} }
#
Log :: struct {
	out:   File,
	level: int,
}

main :: proc() {
	log := Log{out = File{"log"}}
	f := &log.out
	fmt.println(f.name)
}
```

## destroy_copy_keyed

Putting a variable into an array literal copies it. Move it in:

```vidar
# File :: struct { name: string }
# file_destroy :: proc(f: ^File) { if f.name != "" do fmt.println("close", f.name) }
# impl Destroy for File { destroy = file_destroy }
# open :: proc(name: string) -> File { return File{name} }
#
main :: proc() {
	f := open("a")
	files := [2]File{1 = move!(f)}
	fmt.println(len(files))
}
```

## destroy_core_container

`core:container/queue`'s procedures copy and drop values without calling their destructors. Hold pointers in the queue, or use a dynamic array, which owns its elements:

```vidar
# File :: struct { name: string }
# file_destroy :: proc(f: ^File) { if f.name != "" do fmt.println("close", f.name) }
# impl Destroy for File { destroy = file_destroy }
# open :: proc(name: string) -> File { return File{name} }
#
main :: proc() {
	q: [dynamic]File
	append(&q, open("a"))
	fmt.println(len(q))
}
```

## destroy_delete_param

A by-value parameter borrows the array, so deleting it would free what the caller still owns. Take it over with `#owned`, or let the caller delete it:

```vidar
# File :: struct { name: string }
# file_destroy :: proc(f: ^File) { if f.name != "" do fmt.println("close", f.name) }
# impl Destroy for File { destroy = file_destroy }
# open :: proc(name: string) -> File { return File{name} }
#
close_all :: proc(#owned files: [dynamic]File) {
	delete(files)
}

main :: proc() {
	files: [dynamic]File
	append(&files, open("a"))
	close_all(move!(files))
}
```

## destroy_delete_slice

A slice is a view, and doesn't own its elements; deleting one would free them without destroying them. Use a dynamic array, which `delete` handles:

```vidar
# File :: struct { name: string }
# file_destroy :: proc(f: ^File) { if f.name != "" do fmt.println("close", f.name) }
# impl Destroy for File { destroy = file_destroy }
# open :: proc(name: string) -> File { return File{name} }
#
close_all :: proc(#owned files: [dynamic]File) {
	delete(files)
}

main :: proc() {}
```

## destroy_delete_value

`delete` of a destructible container destroys the elements and leaves the container empty, so it needs the variable that holds it, not a temporary. Keep the result first:

```vidar
# File :: struct { name: string }
# file_destroy :: proc(f: ^File) { if f.name != "" do fmt.println("close", f.name) }
# impl Destroy for File { destroy = file_destroy }
# open :: proc(name: string) -> File { return File{name} }
#
files :: proc() -> [dynamic]File { return nil }

main :: proc() {
	fs := files()
	delete(fs)
}
```

## destroy_dropped

A result nobody keeps would never be destroyed. Keep it:

```vidar
# File :: struct { name: string }
# file_destroy :: proc(f: ^File) { if f.name != "" do fmt.println("close", f.name) }
# impl Destroy for File { destroy = file_destroy }
# open :: proc(name: string) -> File { return File{name} }
#
main :: proc() {
	f := open("a")
	_ = f.name
}
```

## destroy_fixed_dynamic

A fixed-capacity dynamic array can't hold a destructible value yet. Use an ordinary dynamic array:

```vidar
# File :: struct { name: string }
# file_destroy :: proc(f: ^File) { if f.name != "" do fmt.println("close", f.name) }
# impl Destroy for File { destroy = file_destroy }
# open :: proc(name: string) -> File { return File{name} }
#
main :: proc() {
	files: [dynamic]File
	reserve(&files, 4)
	fmt.println(len(files))
}
```

## destroy_global

A package-level variable can't hold a destructible value yet, since nothing would destroy it. Keep it in `main`, or behind a pointer:

```vidar
# File :: struct { name: string }
# file_destroy :: proc(f: ^File) { if f.name != "" do fmt.println("close", f.name) }
# impl Destroy for File { destroy = file_destroy }
# open :: proc(name: string) -> File { return File{name} }
#
log_file: ^File

main :: proc() {
	f := open("log")
	log_file = &f
	fmt.println(log_file.name)
}
```

## destroy_if_init

A destructible value can't be declared in an `if`, `for` or `switch` initializer yet. Declare it before the statement:

```vidar
# File :: struct { name: string }
# file_destroy :: proc(f: ^File) { if f.name != "" do fmt.println("close", f.name) }
# impl Destroy for File { destroy = file_destroy }
# open :: proc(name: string) -> File { return File{name} }
#
main :: proc() {
	f := open("a")
	if f.name != "" {
		fmt.println(f.name)
	}
}
```

## destroy_impl_instance

`impl Destroy` covers every instance of a parametric type at once, with a polymorphic procedure. Write it for `Box($T)`:

```vidar
Box :: struct($T: typeid) { value: T }
box_free :: proc(b: ^Box($T)) {}
impl Destroy for Box($T) { destroy = box_free }

main :: proc() {}
```

## destroy_impl_not_struct

Destructors are for named structs and unions. Wrap the handle in a struct:

```vidar
Handle :: struct { fd: int }
handle_close :: proc(h: ^Handle) {}
impl Destroy for Handle { destroy = handle_close }

main :: proc() {}
```

## destroy_impl_signature

A destroy procedure takes a pointer to the value, `^File`, and returns nothing:

```vidar
File :: struct { fd: int }
file_close :: proc(f: ^File) {}
impl Destroy for File { destroy = file_close }

main :: proc() {}
```

## destroy_impl_wrong_method

`Destroy` has one method, `destroy`:

```vidar
File :: struct { fd: int }
file_close :: proc(f: ^File) {}
impl Destroy for File { destroy = file_close }

main :: proc() {}
```

## destroy_iterator

Each value an iterator procedure returns to a `for` loop would be dropped at the end of the iteration without being destroyed. Loop with an explicit call, so each value has an owner:

```vidar
# File :: struct { name: string }
# file_destroy :: proc(f: ^File) { if f.name != "" do fmt.println("close", f.name) }
# impl Destroy for File { destroy = file_destroy }
# open :: proc(name: string) -> File { return File{name} }
#
next :: proc(n: ^int) -> (File, bool) {
	n^ += 1
	return File{"x"}, n^ < 3
}

main :: proc() {
	n := 0
	for {
		f, ok := next(&n)
		if !ok do break
		fmt.println(f.name)
	}
}
```

## destroy_make_slice

A slice is a view and never destroys its elements, so it can't be where they live. Use a dynamic array:

```vidar
# File :: struct { name: string }
# file_destroy :: proc(f: ^File) { if f.name != "" do fmt.println("close", f.name) }
# impl Destroy for File { destroy = file_destroy }
# open :: proc(name: string) -> File { return File{name} }
#
main :: proc() {
	files := make([dynamic]File, 3)
	fmt.println(len(files))
}
```

## destroy_map_copy

A map of destructible values can't be cloned. Borrow it with a pointer, or move it:

```vidar
# File :: struct { name: string }
# file_destroy :: proc(f: ^File) { if f.name != "" do fmt.println("close", f.name) }
# impl Destroy for File { destroy = file_destroy }
# open :: proc(name: string) -> File { return File{name} }
#
main :: proc() {
	m: map[string]File
	n := move!(m)
	fmt.println(len(n))
}
```

## destroy_map_insert

`map_insert` overwrites a value without destroying the old one. Assign instead, which does:

```vidar
# File :: struct { name: string }
# file_destroy :: proc(f: ^File) { if f.name != "" do fmt.println("close", f.name) }
# impl Destroy for File { destroy = file_destroy }
# open :: proc(name: string) -> File { return File{name} }
#
main :: proc() {
	m: map[string]File
	m["a"] = open("a")
}
```

## destroy_map_key

A map's keys are copied around as it grows, so they can't be destructible. Key the map by something the value holds, such as its name:

```vidar
# File :: struct { name: string }
# file_destroy :: proc(f: ^File) { if f.name != "" do fmt.println("close", f.name) }
# impl Destroy for File { destroy = file_destroy }
# open :: proc(name: string) -> File { return File{name} }
#
main :: proc() {
	m: map[string]int
	f := open("a")
	m[f.name] = 1
	fmt.println(len(m))
}
```

## destroy_move_loop_value

`for f in files` borrows each element, so it can't move one. Loop over the indexes, and move each element out of the array, which leaves it zero:

```vidar
# File :: struct { name: string }
# file_destroy :: proc(f: ^File) { if f.name != "" do fmt.println("close", f.name) }
# impl Destroy for File { destroy = file_destroy }
# open :: proc(name: string) -> File { return File{name} }
#
main :: proc() {
	files: [dynamic]File
	append(&files, open("a"))
	kept: [dynamic]File
	for i in 0..<len(files) do append(&kept, move!(files[i]))
}
```

## destroy_move_param

A by-value parameter is borrowed, so its owner is the caller and it can't be moved. Declare it `#owned` to take it over:

```vidar
# File :: struct { name: string }
# file_destroy :: proc(f: ^File) { if f.name != "" do fmt.println("close", f.name) }
# impl Destroy for File { destroy = file_destroy }
# open :: proc(name: string) -> File { return File{name} }
#
keep :: proc(#owned f: File) -> File {
	return move!(f)
}

main :: proc() {}
```

## destroy_move_value

`move!` leaves what it moves from zero, so it needs a variable, field or element. A new value needs no `move!`:

```vidar
# File :: struct { name: string }
# file_destroy :: proc(f: ^File) { if f.name != "" do fmt.println("close", f.name) }
# impl Destroy for File { destroy = file_destroy }
# open :: proc(name: string) -> File { return File{name} }
#
main :: proc() {
	f := open("a")
	_ = f.name
}
```

## destroy_multi_assign

Assigning several destructible values in one statement isn't supported yet. Assign them one at a time:

```vidar
# File :: struct { name: string }
# file_destroy :: proc(f: ^File) { if f.name != "" do fmt.println("close", f.name) }
# impl Destroy for File { destroy = file_destroy }
# open :: proc(name: string) -> File { return File{name} }
#
main :: proc() {
	f := open("a")
	g := open("b")
	f = open("c")
	g = open("d")
}
```

## destroy_owned_copy

An `#owned` parameter takes the value over, so passing a variable would leave two owners. Move it there:

```vidar
File :: struct { name: string }
file_destroy :: proc(f: ^File) {}
impl Destroy for File { destroy = file_destroy }

consume :: proc(#owned x: File) {}

main :: proc() {
	f := File{"a"}
	consume(move!(f))
}
```

## destroy_owned_proc_value

`consume` destroys its parameter, but callers of a `proc(File)` keep and destroy what they pass, so the file would be destroyed twice. Make the procedure type say `#owned` too, or make `consume` borrow:

```vidar
# File :: struct { name: string }
# file_destroy :: proc(f: ^File) { if f.name != "" do fmt.println("close", f.name) }
# impl Destroy for File { destroy = file_destroy }
# open :: proc(name: string) -> File { return File{name} }
#
consume :: proc(#owned f: File) { fmt.println("consumed", f.name) }
apply :: proc(use: proc(#owned f: File), #owned f: File) { use(move!(f)) }

main :: proc() {
	f := File{"a"}
	apply(consume, move!(f))
}
```

## destroy_owned_variadic

A variadic parameter is a slice of values the caller keeps, so it can't be taken over. Take a dynamic array `#owned` instead:

```vidar
# File :: struct { name: string }
# file_destroy :: proc(f: ^File) { if f.name != "" do fmt.println("close", f.name) }
# impl Destroy for File { destroy = file_destroy }
# open :: proc(name: string) -> File { return File{name} }
#
close_all :: proc(#owned fs: [dynamic]File) {
	fmt.println(len(fs))
}

main :: proc() {
	fs: [dynamic]File
	append(&fs, File{"a"})
	close_all(move!(fs))
}
```

## destroy_pop_safe

`pop_safe` returns the element it removed, and dropping that result would leak it. Keep it:

```vidar
# File :: struct { name: string }
# file_destroy :: proc(f: ^File) { if f.name != "" do fmt.println("close", f.name) }
# impl Destroy for File { destroy = file_destroy }
# open :: proc(name: string) -> File { return File{name} }
#
main :: proc() {
	files: [dynamic]File
	append(&files, open("a"))
	if f, ok := pop_safe(&files); ok do fmt.println(f.name)
}
```

## destroy_range_literal

`0..<2 = open("a")` would copy one file into both elements. Give each element a value of its own:

```vidar
# File :: struct { name: string }
# file_destroy :: proc(f: ^File) { if f.name != "" do fmt.println("close", f.name) }
# impl Destroy for File { destroy = file_destroy }
# open :: proc(name: string) -> File { return File{name} }
#
main :: proc() {
	files := [2]File{open("a"), open("b")}
	fmt.println(len(files))
}
```

## destroy_return_param

A by-value parameter is borrowed, so returning it would copy what the caller owns. Take it `#owned`:

```vidar
# File :: struct { name: string }
# file_destroy :: proc(f: ^File) { if f.name != "" do fmt.println("close", f.name) }
# impl Destroy for File { destroy = file_destroy }
# open :: proc(name: string) -> File { return File{name} }
#
same :: proc(#owned f: File) -> File {
	return f
}

main :: proc() {}
```

## destroy_slice_literal

A slice literal would be the only owner of its elements, and a slice never destroys them. Build a dynamic array:

```vidar
# File :: struct { name: string }
# file_destroy :: proc(f: ^File) { if f.name != "" do fmt.println("close", f.name) }
# impl Destroy for File { destroy = file_destroy }
# open :: proc(name: string) -> File { return File{name} }
#
main :: proc() {
	files: [dynamic]File
	append(&files, open("a"), open("b"))
	fmt.println(len(files))
}
```

## destroy_soa

An `#soa` array can't hold a destructible value yet. Use a plain dynamic array:

```vidar
# File :: struct { name: string }
# file_destroy :: proc(f: ^File) { if f.name != "" do fmt.println("close", f.name) }
# impl Destroy for File { destroy = file_destroy }
# open :: proc(name: string) -> File { return File{name} }
#
main :: proc() {
	files: [dynamic]File
	fmt.println(len(files))
}
```

## destroy_temporary

`show` borrows its parameter, so the file passed straight into it has no owner, and would never be destroyed. Keep it in a variable first:

```vidar
# File :: struct { name: string }
# file_destroy :: proc(f: ^File) { if f.name != "" do fmt.println("close", f.name) }
# impl Destroy for File { destroy = file_destroy }
# open :: proc(name: string) -> File { return File{name} }
#
show :: proc(f: File) { fmt.println(f.name) }

main :: proc() {
	f := open("a")
	show(f)
}
```

## do_after_call

The `do!` block runs before the statement it's in, so here it would run before `side()`, out of order. Compute it in a statement of its own:

```vidar
side :: proc() -> int { return 1 }

main :: proc() {
	s := side()
	n := s + do! { take 1 }
	_ = n
}
```

## do_in_defer

A deferred statement runs later, but the `do!` block would run now. Compute the value first:

```vidar
main :: proc() {
	v := do! { take 1 }
	defer fmt.println(v)
}
```

## do_no_take

A `do!` block is a value, and gives it with `take`:

```vidar
main :: proc() {
	x := do! { y := 1; take y }
	_ = x
}
```

## do_short_circuit

The `do!` block would run even when `&&` skips its right side. Compute it in a statement of its own, under an `if` if it must not always run:

```vidar
main :: proc() {
	ready := false
	ok := false
	if ready do ok = do! { take true }
	_ = ok
}
```

## do_take_in_nested_proc

`take` gives the value of the `do!` block it's directly in; a procedure inside the block returns with `return`:

```vidar
main :: proc() {
	n := do! {
		f := proc() -> int { return 1 }
		take f()
	}
	_ = n
}
```

## do_ternary_branch

The `do!` block would run even when its branch isn't taken. Use an `if` statement:

```vidar
main :: proc() {
	n := 1
	if !true do n = do! { take 2 }
	_ = n
}
```

## do_two_values

A `do!` block has one value. To give several, take a struct:

```vidar
main :: proc() {
	x := do! {
		pair := [2]int{1, 2}
		take pair
	}
	_ = x
}
```

## duplicate_global

Two declarations at file scope have the same name. Rename one:

```vidar
x :: 1
y :: 2

main :: proc() {}
```

## errdefer_no_results

`errdefer` runs when the procedure returns a failure, which it can only tell from a last result that is an error or a `bool`. Use `defer`, or give the procedure an error result:

```vidar
Error :: enum { None, Failed }

run :: proc() -> Error {
	errdefer fmt.println("failed")
	return .None
}

main :: proc() { run() }
```

## iface_anonymous

An interface's methods are declared against its name, so it must be a named constant at file scope:

```vidar
Shape :: interface { area }
area :: proc(s: Shape) -> f64 ---

main :: proc() {
	x: Shape
	_ = x
}
```

## iface_arrow_call

Interface methods are procedures, called with the value first:

```vidar
# Shape :: interface { area }
# area :: proc(s: Shape) -> f64 ---
# Sq :: struct { s: f64 }
# sq_area :: proc(q: ^Sq) -> f64 { return q.s * q.s }
# impl Shape for Sq { area = sq_area }
#
main :: proc() {
	q := Sq{2}
	s: Shape = &q
	_ = area(s)
}
```

## iface_bad_arity

An implementation takes the receiver plus every other parameter of the method, here `k`:

```vidar
Shape :: interface { scale }
scale :: proc(s: Shape, k: f64) ---
Sq :: struct { s: f64 }
sq_scale :: proc(q: ^Sq, k: f64) { q.s *= k }
impl Shape for Sq { scale = sq_scale }

main :: proc() {}
```

## iface_bad_receiver

An implementation takes a pointer to the type first, so that methods can change the value:

```vidar
Shape :: interface { area }
area :: proc(s: Shape) -> f64 ---
Sq :: struct { s: f64 }
sq_area :: proc(q: ^Sq) -> f64 { return q.s * q.s }
impl Shape for Sq { area = sq_area }

main :: proc() {}
```

## iface_duplicate_impl

A type implements an interface once. Remove the second `impl`:

```vidar
# Shape :: interface { area }
# area :: proc(s: Shape) -> f64 ---
# Sq :: struct { s: f64 }
# sq_area :: proc(q: ^Sq) -> f64 { return q.s * q.s }
# impl Shape for Sq { area = sq_area }
#
main :: proc() {}
```

## iface_empty

An interface with no methods would have nothing to call. List its methods:

```vidar
Shape :: interface { area }
area :: proc(s: Shape) -> f64 ---

main :: proc() {}
```

## iface_extends_conflicting_impls

`impl B for T` already implements `A` for `T`, since `B` extends it, and binds `a` to `t_a`. A second `impl A for T` binding it differently would make `a(&t)` mean two things. Drop the second impl, or bind the same procedure:

```vidar
A :: interface { a }
a :: proc(x: A) ---
B :: interface { using A, b }
b :: proc(x: B) ---
T :: struct {}
t_a :: proc(t: ^T) {}
t_b :: proc(t: ^T) {}
impl B for T { a = t_a, b = t_b }

main :: proc() {}
```

## iface_extends_cycle

An interface can't include itself, even through another one. Move the shared methods into a third interface that both extend:

```vidar
Base :: interface { base }
base :: proc(x: Base) ---
A :: interface { using Base, a }
a :: proc(x: A) ---
B :: interface { using Base, b }
b :: proc(x: B) ---

main :: proc() {}
```

## iface_extends_missing_inherited

An impl of an extended interface binds the inherited methods too:

```vidar
A :: interface { a }
a :: proc(x: A) ---
B :: interface { using A, b }
b :: proc(x: B) ---
T :: struct {}
t_a :: proc(t: ^T) {}
t_b :: proc(t: ^T) {}
impl B for T { a = t_a, b = t_b }

main :: proc() {}
```

## iface_extends_not_interface

`using` in an interface names another interface. Structs are included in structs, not interfaces:

```vidar
Named :: interface { name }
name :: proc(x: Named) -> string ---
A :: interface { using Named, a }
a :: proc(x: A) ---

main :: proc() {}
```

## iface_extends_twice

Each base is listed once:

```vidar
A :: interface { a }
a :: proc(x: A) ---
B :: interface { using A, b }
b :: proc(x: B) ---

main :: proc() {}
```

## iface_extends_unrelated

An `A` value converts to `B` only if `A` extends `B`. Make it extend `B`, or pass something that implements `B`:

```vidar
B :: interface { b }
b :: proc(x: B) ---
A :: interface { using B, a }
a :: proc(x: A) ---
use_b :: proc(x: B) {}
f :: proc(x: A) { use_b(x) }

main :: proc() {}
```

## iface_extra_method

An `impl` binds the interface's methods, and only those. Add the method to the interface, or call the procedure directly:

```vidar
Shape :: interface { area, perimeter }
area :: proc(s: Shape) -> f64 ---
perimeter :: proc(s: Shape) -> f64 ---
Sq :: struct { s: f64 }
sq_area :: proc(q: ^Sq) -> f64 { return q.s * q.s }
sq_perimeter :: proc(q: ^Sq) -> f64 { return 4 * q.s }
impl Shape for Sq { area = sq_area, perimeter = sq_perimeter }

main :: proc() {}
```

## iface_listed_twice

Each method is listed once:

```vidar
Shape :: interface { area }
area :: proc(s: Shape) -> f64 ---

main :: proc() {}
```

## iface_method_has_body

A method is declared without a body; the bodies belong to the implementations. To share code between implementations, write an ordinary procedure that calls the method:

```vidar
Shape :: interface { area }
area :: proc(s: Shape) -> f64 ---

double_area :: proc(s: Shape) -> f64 { return 2 * area(s) }

main :: proc() {}
```

## iface_method_undeclared

Each method the interface lists needs its declaration: a procedure without a body that takes the interface first.

```vidar
Shape :: interface { area }
area :: proc(s: Shape) -> f64 ---

main :: proc() {}
```

## iface_method_unlisted

A bodiless procedure that takes the interface first is a method, so the interface must list it:

```vidar
Shape :: interface { area, perimeter }
area :: proc(s: Shape) -> f64 ---
perimeter :: proc(s: Shape) -> f64 ---

main :: proc() {}
```

## iface_method_wrong_first

A method's first parameter is the interface itself:

```vidar
Shape :: interface { area }
area :: proc(s: Shape) -> f64 ---

main :: proc() {}
```

## iface_missing_method

An `impl` binds every method of the interface:

```vidar
Shape :: interface { area, name }
area :: proc(s: Shape) -> f64 ---
name :: proc(s: Shape) -> string ---
Sq :: struct { s: f64 }
sq_area :: proc(q: ^Sq) -> f64 { return q.s * q.s }
sq_name :: proc(q: ^Sq) -> string { return "square" }
impl Shape for Sq { area = sq_area, name = sq_name }

main :: proc() {}
```

## iface_not_interface

`impl X for T` names an interface first, then the type that implements it:

```vidar
# Shape :: interface { area }
# area :: proc(s: Shape) -> f64 ---
# Sq :: struct { s: f64 }
# sq_area :: proc(q: ^Sq) -> f64 { return q.s * q.s }
# impl Shape for Sq { area = sq_area }
#
main :: proc() {}
```

## iface_old_member_syntax

An interface lists its methods by name, and each is declared as a procedure of its own:

```vidar
Shape :: interface { area }
area :: proc(s: Shape) -> f64 ---

main :: proc() {}
```

## iface_value_conversion

An interface value points at its data, so it's made from a pointer. Use `&q` while `q` outlives the interface value, or `new_clone(q)` for a heap copy:

```vidar
# Shape :: interface { area }
# area :: proc(s: Shape) -> f64 ---
# Sq :: struct { s: f64 }
# sq_area :: proc(q: ^Sq) -> f64 { return q.s * q.s }
# impl Shape for Sq { area = sq_area }
#
main :: proc() {
	q := Sq{}
	s: Shape = &q
	_ = s
}
```

## iface_value_conversion_explicit

`Sq{2}` is a temporary value with no address. Put it in a variable, or on the heap:

```vidar
# Shape :: interface { area }
# area :: proc(s: Shape) -> f64 ---
# Sq :: struct { s: f64 }
# sq_area :: proc(q: ^Sq) -> f64 { return q.s * q.s }
# impl Shape for Sq { area = sq_area }
#
main :: proc() {
	q := Sq{2}
	_ = area(Shape(&q))
}
```

## impl_bind_literal

An `impl` binds names of procedures declared with a body, so the method's proc group can include them. Declare the procedure, then bind it:

```vidar
# Shape :: interface { area }
# area :: proc(s: Shape) -> f64 ---
# Sq :: struct { s: f64 }
# sq_area :: proc(q: ^Sq) -> f64 { return q.s * q.s }
# impl Shape for Sq { area = sq_area }
#
main :: proc() {}
```

## impl_bind_method

Binding `area` to `area` would make the method its own implementation. Bind a procedure that takes `^Sq`:

```vidar
# Shape :: interface { area }
# area :: proc(s: Shape) -> f64 ---
# Sq :: struct { s: f64 }
# sq_area :: proc(q: ^Sq) -> f64 { return q.s * q.s }
# impl Shape for Sq { area = sq_area }
#
main :: proc() {}
```

## impl_bound_twice

Each method is bound once:

```vidar
# Shape :: interface { area }
# area :: proc(s: Shape) -> f64 ---
# Sq :: struct { s: f64 }
# sq_area :: proc(q: ^Sq) -> f64 { return q.s * q.s }
# impl Shape for Sq { area = sq_area }
#
main :: proc() {}
```

## impl_generic_concrete_receiver

A generic impl covers every `Box(T)`, so it needs procedures that take any `^Box($T)`. For one instance, write an impl for that instance instead:

```vidar
Shape :: interface { area }
area :: proc(s: Shape) -> f64 ---
Box :: struct($T: typeid) { v: T }
int_area :: proc(b: ^Box(int)) -> f64 { return f64(b.v) }
impl Shape for Box(int) { area = int_area }

main :: proc() {}
```

## impl_generic_overlap

`Box($T)` already covers `Box(int)`, so a call on a `Box(int)` would have two implementations. Keep one: the generic impl can handle `int` itself, with a `when` on `T`:

```vidar
Shape :: interface { area }
area :: proc(s: Shape) -> f64 ---
Box :: struct($T: typeid) { v: T }
box_area :: proc(b: ^Box($T)) -> f64 {
	when T == int do return 1
	else do return f64(b.v)
}
impl Shape for Box($T) { area = box_area }

main :: proc() {}
```

## impl_group_ambiguous

Both members of the group fit a `Box(int)` equally well, so Vidar can't choose. Bind the one you mean directly:

```vidar
Shape :: interface { area }
area :: proc(s: Shape) -> f64 ---
Box :: struct($T: typeid) { v: T }
box_area :: proc(b: ^Box($T)) -> f64 { return f64(b.v) }
impl Shape for Box(int) { area = box_area }

main :: proc() {}
```

## impl_group_no_member

No member of the group takes `^Sq` with the method's parameters. Add one, or bind a procedure directly:

```vidar
Shape :: interface { area }
area :: proc(s: Shape) -> f64 ---
Circle :: struct { r: f64 }
Sq :: struct { s: f64 }
circle_area :: proc(c: ^Circle) -> f64 { return c.r }
sq_area :: proc(q: ^Sq) -> f64 { return q.s * q.s }
areas :: proc{circle_area, sq_area}
impl Shape for Sq { area = areas }

main :: proc() {}
```

## impl_in_proc

`impl` blocks go at file scope, next to the types they're for:

```vidar
# Shape :: interface { area }
# area :: proc(s: Shape) -> f64 ---
# Sq :: struct { s: f64 }
# sq_area :: proc(q: ^Sq) -> f64 { return q.s * q.s }
# impl Shape for Sq { area = sq_area }
#
main :: proc() {}
```

## impl_not_binding

An `impl` binds methods to procedures declared elsewhere, with `method = proc_name`:

```vidar
# Shape :: interface { area }
# area :: proc(s: Shape) -> f64 ---
# Sq :: struct { s: f64 }
# sq_area :: proc(q: ^Sq) -> f64 { return q.s * q.s }
# impl Shape for Sq { area = sq_area }
#
main :: proc() {}
```

## impl_not_parametric

`Circle` takes no parameters, so `Circle(int)` isn't a type. Implement the interface for `Circle`:

```vidar
Shape :: interface { area }
area :: proc(s: Shape) -> f64 ---
Circle :: struct { r: f64 }
c_area :: proc(c: ^Circle) -> f64 { return c.r }
impl Shape for Circle { area = c_area }

main :: proc() {}
```

## macro_arg_type

The macro's parameter is `Expr(i32)`, so its argument must be an expression of type `i32`:

```vidar
square :: proc!(x: Expr(i32)) -> Expr(i32) { return quote($x * $x) }

main :: proc() { _ = square!(3) }
```

## macro_arg_typed_var

`v` is an `f64`, and the macro takes an `i32`. Convert the argument, or declare the variable with the right type:

```vidar
square :: proc!(x: Expr(i32)) -> Expr(i32) { return quote($x * $x) }

main :: proc() {
	v: f64 = 2
	_ = square!(i32(v))
}
```

## macro_bad_splice

Inside a quote, `$` is followed by a name, `$x`, or a parenthesized compile-time expression, `$(x + 1)`. For a literal `$`, write `$$`:

```vidar
one :: proc!() -> Expr { n := 1; return quote($n + 1) }

main :: proc() { _ = one!() }
```

## macro_division_by_zero

The macro divided by zero while compiling. Check the argument first, and report a clearer error:

```vidar
d :: proc!(n: int) -> int {
	if n == 0 do compile_error("d!: n must not be 0")
	return 10 / n
}

main :: proc() { _ = d!(2) }
```

## macro_fields_of_non_struct

`type_fields` lists a struct's fields, and an array has none. Pass a struct type:

```vidar
f :: proc!(T: Type) -> int { return len(type_fields(T)) }

Point :: struct { x, y: int }

main :: proc() { _ = f!(Point) }
```

## macro_ident_list_not_names

A `[]Ident` parameter takes a list of names, each optionally with `&`. Compute the value first, and pass its name:

```vidar
fn :: proc!(captures: []Ident, body: Stmt) -> Expr {
	return quote(proc[$captures]() { $body })
}

main :: proc() {
	a := 1
	b := a + 1
	f := fn!({b}) {}
	f()
}
```

## macro_ident_param

An `Ident` parameter takes a bare name:

```vidar
decl :: proc!(name: Ident) -> Stmt { return quote { $name := 1 } }

main :: proc() {
	decl!(total)
	_ = total
}
```

## macro_index_out_of_bounds

Compile-time code is bounds-checked like run-time code. Index within the array:

```vidar
f :: proc!() -> int { xs := [dynamic]int{1, 2}; return xs[1] }

main :: proc() { _ = f!() }
```

## macro_reads_runtime_global

A global variable only has its value at run time. Make it a constant, or pass the value in:

```vidar
COUNTER :: 5

get :: proc!() -> int { return COUNTER }

main :: proc() { _ = get!() }
```

## macro_recursive

The macro's expansion calls the macro again, forever. Give the recursion a base case that returns plain code:

```vidar
times :: proc!(n: int, x: Expr) -> Expr {
	if n <= 1 do return x
	return quote($x + times!($(n - 1), $x))
}

main :: proc() { _ = times!(3, 2) }
```

## macro_returns_type

A macro's result is code or a value, not a type. Return an expression that uses the type:

```vidar
zero_int :: proc!() -> Expr { return quote(int(0)) }

main :: proc() { _ = zero_int!() }
```

## macro_runtime_arg

A plain parameter type takes a compile-time constant, and `n` is a run-time variable. Pass a constant, or take the argument as code with `Expr`:

```vidar
twice :: proc!(n: Expr) -> Expr { return quote($n * 2) }

main :: proc() {
	n := 3
	_ = twice!(n)
}
```

## macro_step_limit

The macro's body ran too long, which usually means a loop that never ends. Give the loop an end:

```vidar
count_to :: proc!(n: int) -> int {
	i := 0
	for i < n do i += 1
	return i
}

main :: proc() { _ = count_to!(10) }
```

## macro_void_in_expr

A macro without a result can only be a statement. Call it as one, or give it a result:

```vidar
noop :: proc!() { }

main :: proc() {
	noop!()
}
```

## macro_wrong_arity

The macro takes one argument. Pass one, or give the macro a second parameter:

```vidar
twice :: proc!(x: Expr) -> Expr { return quote($x * 2) }

main :: proc() { _ = twice!(1) }
```

## memo_and_no_memo

`@(memo)` asks for memoization and `@(no_memo)` forbids it. Keep the one you mean:

```vidar
@(memo)
f :: proc(n: int) -> int { return n }

main :: proc() {}
```

## memo_bad_key

The memo table is keyed by the parameters, and a slice can't be a map key. Pass something that can, such as an index into the slice:

```vidar
@(memo)
total_from :: proc(i: int) -> int { return 0 if i >= 5 else i + total_from(i + 1) }

main :: proc() { _ = total_from(0) }
```

## nested_plain_proc

A procedure literal without a capture list is plain Odin, and can't see the enclosing procedure's locals. Make it a closure that captures what it uses:

```vidar
main :: proc() {
	x := 1
	f := proc[x]() -> int { return x }
	_ = f
}
```

## no_alloc_chain

`step` doesn't allocate itself, but it calls `spawn`, which calls `push`, which appends. Move the allocation out of the `@(no_alloc)` path: here, reserve room up front and only fill it in `step`:

```vidar
World :: struct { ids: [16]int, count: int }

push :: proc(w: ^World, id: int) { w.ids[w.count] = id; w.count += 1 }
spawn :: proc(w: ^World) { push(w, w.count) }

@(no_alloc)
step :: proc(w: ^World) { if w.count < 10 do spawn(w) }

main :: proc() {
	w: World
	step(&w)
}
```

## no_alloc_closure

Vidar can't know what a closure parameter will call, so it can't promise `apply` doesn't allocate. Take a plain procedure it can follow, or drop the attribute:

```vidar
double :: proc(x: int) -> int { return x * 2 }

@(no_alloc)
apply :: proc(x: int) -> int { return double(x) }

main :: proc() { _ = apply(1) }
```

## no_alloc_core

`strings.clone` allocates a copy. Return the string itself, or have the caller pass a buffer:

```vidar
@(no_alloc)
name :: proc(s: string) -> string { return s }

main :: proc() { _ = name("x") }
```

## no_alloc_interface

One implementation of `area`, `big_area`, allocates, and `total` might call it. Remove the allocation from the implementation:

```vidar
Shape :: interface { area }
area :: proc(s: Shape) -> f64 ---

Small :: struct { r: f64 }
Big :: struct { r: f64 }

small_area :: proc(s: ^Small) -> f64 { return s.r }
big_area :: proc(b: ^Big) -> f64 { return b.r }

impl Shape for Small { area = small_area }
impl Shape for Big { area = big_area }

@(no_alloc)
total :: proc(xs: []Shape) -> (t: f64) {
	for x in xs do t += area(x)
	return
}

main :: proc() { _ = total(nil) }
```

## no_alloc_make

`make` allocates. Take the output buffer from the caller instead:

```vidar
@(no_alloc)
squares :: proc(out: []int) {
	for i in 0..<len(out) do out[i] = i * i
}

main :: proc() {
	buf: [3]int
	squares(buf[:])
}
```

## no_alloc_map

Inserting into a map can grow it. Count into something of fixed size, or drop the attribute:

```vidar
@(no_alloc)
count :: proc(counts: ^[26]int, word: string) {
	if len(word) > 0 && word[0] >= 'a' && word[0] <= 'z' do counts[word[0] - 'a'] += 1
}

main :: proc() {
	counts: [26]int
	count(&counts, "a")
}
```

## no_alloc_not_proc

`@(no_alloc)` describes a procedure. Put it on one:

```vidar
limit := 3

@(no_alloc)
get_limit :: proc() -> int { return limit }

main :: proc() { _ = get_limit() }
```

## no_alloc_unlisted

Vidar only trusts `core:` procedures it knows don't allocate, and `os.read_entire_file` does. Read outside the `@(no_alloc)` procedure, and pass the data in:

```vidar
@(no_alloc)
count_lines :: proc(data: []byte) -> (n: int) {
	for b in data do if b == '\n' do n += 1
	return
}

main :: proc() { _ = count_lines(transmute([]byte)string("a\nb\n")) }
```

## no_table_not_proc

`@(no_table)` describes a procedure. Put it on one:

```vidar
X :: 3

@(no_table)
f :: proc(b: u8) -> int { return int(b) + X }

main :: proc() {}
```

## not_captured

A closure can only use the outer locals it captures. Add `x` to the capture list:

```vidar
main :: proc() {
	x := 1
	f := proc[x]() -> int { return x }
	_ = f
}
```

## or_return_ambiguous

`f() or_return - 1` could mean "return `-1` as the error" or "subtract 1 from the result". Parenthesize the one you mean:

```vidar
f :: proc() -> (int, bool) { return 5, true }

g :: proc() -> (r: int, ok: bool) {
	x := (f() or_return) - 1
	return x, true
}

main :: proc() { _, _ = g() }
```

## or_return_value_nested

`or_return value` follows a call that is the whole right-hand side. Get the value in a statement of its own:

```vidar
Error :: enum { None, Bad }
f :: proc() -> (int, Error) { return 1, .None }
g :: proc(x: int) -> int { return x }

h :: proc() -> Error {
	v := f() or_return .Bad
	_ = g(v)
	return .None
}

main :: proc() {}
```

## or_return_value_no_results

`or_return` returns from the procedure with an error, and `main` has no result to return it in. Handle the failure with `catch` instead:

```vidar
Error :: enum { None, Bad }
f :: proc() -> (int, Error) { return 1, .None }

main :: proc() {
	x := f() catch err {
		fmt.println(err)
		return
	}
	_ = x
}
```

## or_return_value_typed_decl

`or_return value` declares its names the way `:=` does. Drop the type:

```vidar
Error :: enum { None, Bad }
f :: proc() -> (int, Error) { return 1, .None }

h :: proc() -> Error {
	x := f() or_return .Bad
	_ = x
	return .None
}

main :: proc() {}
```

## parse_attribute_without_decl

An attribute describes a declaration, and an assignment isn't one. Declare the variable:

```vidar
main :: proc() {
	@(static) x := 1
	_ = x
}
```

## parse_unterminated_block

A `{` is missing its `}`:

```vidar
main :: proc() {
	x := 1
	_ = x
}
```

## pool_append_pointer

A `Pool` keeps its own copy of each value, in an array per type. Append the value, not a pointer to it:

```vidar
# Shape :: interface { area }
# area :: proc(s: Shape) -> f64 ---
# Sq :: struct { s: f64 }
# sq_area :: proc(q: ^Sq) -> f64 { return q.s * q.s }
# impl Shape for Sq { area = sq_area }
#
main :: proc() {
	p: Pool(Shape)
	defer delete(p)
	q := new(Sq)
	defer free(q)
	append(&p, q^)
}
```

## pool_append_unknown

A `Pool(Shape)` holds the types that implement `Shape`, and `x` is an `int`. Append one of those types:

```vidar
# Shape :: interface { area }
# area :: proc(s: Shape) -> f64 ---
# Sq :: struct { s: f64 }
# sq_area :: proc(q: ^Sq) -> f64 { return q.s * q.s }
# impl Shape for Sq { area = sq_area }
#
main :: proc() {
	p: Pool(Shape)
	defer delete(p)
	append(&p, Sq{1})
}
```

## pool_append_value

Appending to a `Pool` has no result. Make it a statement, and use `len` if you need the count:

```vidar
# Shape :: interface { area }
# area :: proc(s: Shape) -> f64 ---
# Sq :: struct { s: f64 }
# sq_area :: proc(q: ^Sq) -> f64 { return q.s * q.s }
# impl Shape for Sq { area = sq_area }
#
main :: proc() {
	p: Pool(Shape)
	defer delete(p)
	append(&p, Sq{})
	n := len(p)
	_ = n
}
```

## pool_for_index

A `Pool` is an array per type, so there's no one index across it. Count in the loop if you need one:

```vidar
# Shape :: interface { area }
# area :: proc(s: Shape) -> f64 ---
# Sq :: struct { s: f64 }
# sq_area :: proc(q: ^Sq) -> f64 { return q.s * q.s }
# impl Shape for Sq { area = sq_area }
#
main :: proc() {
	p: Pool(Shape)
	defer delete(p)
	i := 0
	for s in p {
		_ = s
		i += 1
	}
}
```

## pool_generic_impl

A `Pool` needs one array type per implementation, and a generic impl covers many. Use a `[dynamic]Shape`:

```vidar
Shape :: interface { area }
area :: proc(s: Shape) -> f64 ---
Box :: struct($T: typeid) { v: T }
box_area :: proc(b: ^Box($T)) -> f64 { return f64(b.v) }
impl Shape for Box($T) { area = box_area }

main :: proc() {
	shapes: [dynamic]Shape
	defer delete(shapes)
}
```

## pool_not_interface

`Pool` takes an interface, and holds the types that implement it. For values of one type, use a dynamic array:

```vidar
# Shape :: interface { area }
# area :: proc(s: Shape) -> f64 ---
# Sq :: struct { s: f64 }
# sq_area :: proc(q: ^Sq) -> f64 { return q.s * q.s }
# impl Shape for Sq { area = sq_area }
#
main :: proc() {
	p: Pool(Shape)
	defer delete(p)
	squares: [dynamic]Sq
	defer delete(squares)
}
```

## specialize_and_no_specialize

`@(specialize)` asks for specialized copies and `@(no_specialize)` forbids them. Keep the one you mean:

```vidar
@(specialize)
f :: proc(n: int) -> int { return n }

main :: proc() {}
```

## specialize_and_table

Each of these attributes replaces the procedure's body in its own way, so only one can apply. Pick one:

```vidar
@(table)
f :: proc(b: bool) -> int { return 1 }

main :: proc() {}
```

## specialize_not_proc

`@(specialize)` describes a procedure. Put it on one:

```vidar
N :: 5

@(specialize)
scale :: proc(x, k: int) -> int { return x * k }

main :: proc() { _ = scale(N, 2) }
```

## stmt_macro_in_expr

A macro returning `Stmt` produces statements, which can't be a value. Call it as a statement, or return an `Expr`:

```vidar
one :: proc!() -> Expr { return quote(1) }

main :: proc() { y := one!(); _ = y }
```

## table_three_params

A table has one entry per combination of inputs, so it takes one or two small parameters. Split the procedure, or drop the attribute:

```vidar
@(table)
add :: proc(a, b: u8) -> int { return int(a) + int(b) }

main :: proc() {}
```

## table_two_params_enum

A two-dimensional table takes two parameters of type `bool`, `u8` or `i8`. Convert the enum, or make it the only parameter:

```vidar
Color :: enum { Red, Green }

@(table)
shade :: proc(c: u8, dark: bool) -> int { return int(c) * (2 if dark else 1) }

main :: proc() { _ = shade(u8(Color.Green), true) }
```

## table_wide_param

A table stores one result per possible input, which is fine for a `u8` (256) and not for an `int`. Narrow the parameter, or drop the attribute:

```vidar
@(table)
sq :: proc(a: u8) -> int { return int(a) * int(a) }

main :: proc() {}
```

## closure_ref_passed_pkg

`events.on` stores its closure in a package-level variable, so the closure outlives `listen`, and can't hold `&hits`. Vidar follows the call into the other package to find that out. Keep the count on the heap:

```vidar,project=err-closure-ref-passed-pkg,file=main.vidar
package main

import "events"

listen :: proc() {
	hits := new_clone(0)
	events.on(proc[hits]() { hits^ += 1 })
}

main :: proc() {
	listen()
	events.fire()
}
```

```vidar,project=err-closure-ref-passed-pkg,file=events/events.vidar
package events

handler: closure()

on :: proc(f: closure()) {
	handler = f
}

fire :: proc() {
	handler()
}
```

## collection_missing_dir

`vidar.toml` maps `lib` to a directory that doesn't exist, or that has no package called `thing` in it. Point the collection at the directory that holds the package:

```toml,project=err-collection-missing-dir,file=vidar.toml
[collections]
lib = "./vendor"
```

```vidar,project=err-collection-missing-dir,file=main.vidar
package main

import "lib:thing"

main :: proc() { _ = thing.answer }
```

```vidar,project=err-collection-missing-dir,file=vendor/thing/thing.vidar
package thing

answer :: 42
```

## destroy_unimported

`main` holds a `files.File`, so it destroys one, and the generated code calls `file_destroy` from package `files`. Odin needs an import for that. Import the package in the file that holds the value, even if nothing else in the file names it:

```vidar,project=err-destroy-unimported,file=main.vidar
package main

import "core:fmt"
import "files"
import "mid"

main :: proc() {
	f := mid.get()
	fmt.println(f.name)
}
```

```vidar,project=err-destroy-unimported,file=mid/mid.vidar
package mid

import "../files"

get :: proc() -> files.File { return files.File{"mid"} }
```

```vidar,project=err-destroy-unimported,file=files/files.vidar
package files

File :: struct { name: string }
file_destroy :: proc(f: ^File) {}
impl Destroy for File { destroy = file_destroy }
```

## impl_outside_cycle

An interface's method is one Odin proc group, which must list every implementation, so an `impl` lives in the interface's package, or in a package in an import cycle with it. Move the type and its `impl` into `shapes`, or have `shapes` import this package back:

```vidar,project=err-impl-outside-cycle,file=main.vidar
package main

import "shapes"

main :: proc() {
	q := shapes.Sq{2}
	_ = shapes.area(&q)
}
```

```vidar,project=err-impl-outside-cycle,file=shapes/shapes.vidar
package shapes

Shape :: interface { area }
area :: proc(s: Shape) -> f64 ---

Sq :: struct { s: f64 }
sq_area :: proc(q: ^Sq) -> f64 { return q.s }
impl Shape for Sq { area = sq_area }
```

## missing_member

The package has no declaration of that name: check the spelling, or that it's declared in the package you imported.

```vidar,project=err-missing-member,file=main.vidar
package main

import "lib"

main :: proc() { _ = lib.x }
```

```vidar,project=err-missing-member,file=lib/lib.vidar
package lib

x :: 1
```

## missing_package

A relative import names a directory, relative to the importing file, and there's no package there. Check the path:

```vidar,project=err-missing-package,file=main.vidar
package main

import "util"

main :: proc() { _ = util.ok }
```

```vidar,project=err-missing-package,file=util/util.vidar
package util

ok :: true
```

## package_goroutines_disabled

Goroutines are disabled for now, because they crash too often on some platforms. To use `vidar:sched` anyway, set `VIDAR_GOROUTINES=1` in the environment:

```bash
VIDAR_GOROUTINES=1 vidar run .
```

## package_name_mismatch

Every file in a directory belongs to the same package and starts with the same `package` line. Change the line, or move the file to a directory of its own:

```vidar,project=err-package-name-mismatch,file=main.vidar
package main

main :: proc() { _ = x }
```

```vidar,project=err-package-name-mismatch,file=z_other.vidar
package main

x :: 1
```

## pool_open_iface

A `Pool(Shape)` keeps one array per type that implements `Shape`, so it needs all of them, and an interface in another package that extends `Shape` could add more. Use a `[dynamic]Shape` for the open interface, or keep the extension in `shapes`:

```vidar,project=err-pool-open-iface,file=main.vidar
package main

import "shapes"

Solid :: interface { using shapes.Shape, volume }
volume :: proc(s: Solid) -> f64 ---

main :: proc() {}
```

```vidar,project=err-pool-open-iface,file=shapes/shapes.vidar
package shapes

Shape :: interface { area }
area :: proc(s: Shape) -> f64 ---

Sq :: struct { s: f64 }
sq_area :: proc(q: ^Sq) -> f64 { return 1 }
impl Shape for Sq { area = sq_area }

all: [dynamic]Shape
```

## private_macro

`@(private)` keeps a declaration, macros included, inside its package. Remove the attribute to share it:

```vidar,project=err-private-macro,file=main.vidar
package main

import "lib"

main :: proc() { _ = lib.twice!(2) }
```

```vidar,project=err-private-macro,file=lib/lib.vidar
package lib

twice :: proc!(n: int) -> int { return n * 2 }
```

## private_member

`@(private)` keeps a declaration inside its package. Remove the attribute, or call a public procedure that uses it:

```vidar,project=err-private-member,file=main.vidar
package main

import "lib"

main :: proc() { _ = lib.reveal() }
```

```vidar,project=err-private-member,file=lib/lib.vidar
package lib

@(private) secret :: proc() -> int { return 1 }

reveal :: proc() -> int { return secret() }
```
