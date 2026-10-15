# Destructors

`impl Destroy for T` gives a type a destructor. Vidar then calls it for every local of that type when the local's scope ends, the way C++ and Rust do, so cleanup can't be forgotten on an early `return` or an `or_return`. The later examples use a `File` type declared the same way, with a `file_destroy` proc.

```odin
Buffer :: struct { data: []byte }

buffer_destroy :: proc(b: ^Buffer) {
	delete(b.data)                   // nil for the zero value, which delete ignores
}

impl Destroy for Buffer { destroy = buffer_destroy }

make_buffer :: proc(n: int) -> Buffer {
	return Buffer{make([]byte, n)}
}

checksum :: proc(n: int) -> (sum: int, err: Error) {
	b := make_buffer(n)              // freed on every return below
	if n == 0 do return 0, .Empty
	for x in b.data do sum += int(x)
	return
}
```

A type without `impl Destroy` is unaffected, and a program without any `impl Destroy` is transpiled exactly as before. A type with `impl Destroy` can't be copied, unless it also has [`impl Clone`](#clone), which turns each copy into a call to its clone proc. [`vidar:rc`](#shared-values-vidarrc) uses both for `Rc(T)`, a value shared by several owners.

## What gets destroyed, and when

- **A local** of a type with `impl Destroy` is destroyed when its scope ends: at the closing `}`, on `return`, `break` or `continue`, and on every `or_return`. A loop body destroys its locals on each iteration. Locals are destroyed in reverse order of declaration, after any `defer` written later in the same scope.
- **Types that hold one are destroyed too.** A struct with a `File` field gets a destructor of its own, `__Log_destroy`, which destroys its fields last first. If the struct also has `impl Destroy`, its proc runs first, while the fields are still there. Fixed arrays (`[4]File`, `[Color]File`) destroy their elements last first, a union or `Maybe(File)` destroys the variant it holds, and so does an instance of a parametric type (`Pair(File)`).
- **The zero value is destroyed too.** `f: File` declares a zero `File`, and it is destroyed like any other. A local that was returned is left zero. A proc that fails returns a zero value along with its error, and that value is destroyed as well. So **a destroy proc must accept the zero value** and do nothing with it.
- **Assigning** to a local, a field, an element (`files[i]`, with a name or constant index) or through a pointer (`p^ = ...`) destroys the old value after the new one is stored.
- **Returning** a local moves it out: the caller owns the value and destroys it, and this proc doesn't.
- **Parameters are borrowed.** A proc that takes a `File` by value can read it but doesn't destroy it, and can't return or store it. An [`#owned` parameter](#moving-values) takes the value over instead.

```odin
Log :: struct {
	out:   File,
	level: int,
	err:   File,
}

make_log :: proc() -> Log {
	l := Log{out = open("out"), err = open("err")}    // fresh values move into the literal
	return l
}
// a Log local is destroyed by closing err, then out
```

## Copies are errors

There is one owner for each value. A copy would be destroyed twice, so every copy is a compile error (unless the type has [`impl Clone`](#clone)), with a hint to borrow or move instead:

```odin
f := open("a")
g := f                      // error: 'f' is a File, which has impl Destroy, and 'g := f' would copy it; ...
p := &f                     // fine: a pointer borrows it
use(f)                      // fine: by-value parameters borrow too
```

These count as copies: `:=` and `=` from a variable, field, element or `p^`; returning a parameter; `new_clone(f)`; a variable inside a struct or array literal; capturing `f` by value in a closure (capture `&f`); and `for f in ...` over values. They apply to every type that holds a `File` as well (`Log`, `[2]File`, `Maybe(File)`). A value nothing owns is an error too: a call whose `File` result is thrown away, a `File` passed straight to another call (`use(open("a"))`), and `_ = open("a")`.

## Moving values

`move!(x)` evaluates to `x`'s value and leaves `x` zero, so the value has a new owner and `x`'s own `defer` destroys nothing. It takes a variable, field or element, not a parameter (which is borrowed).

```odin
f := open("a")
g := move!(f)              // g owns the file; f is zero now
```

An `#owned` parameter takes over the value it is passed, instead of borrowing it. The proc destroys it when it returns, unless it returns it or moves it somewhere else:

```odin
store :: proc(dst: ^File, #owned f: File) {
	dst^ = move!(f)                  // f is zero now, and its destroy does nothing
}

keep :: proc(#owned f: File) -> File { return f }    // moves out

store(&slot, open("b"))      // a new value moves in
store(&slot, move!(f))       // so does a moved one
store(&slot, f)              // error for a File, a clone for a type with impl Clone
```

`#owned` is a vidar directive; it is removed from the Odin output. Calls through proc values and into `core:` always borrow.

## Clone

`impl Clone for T` makes copies of `T` legal: each one calls the clone proc, which returns a new value with its own owner, the way a C++ copy constructor does. `T` must also have `impl Destroy`.

```odin
Handle :: struct { id: int, refs: ^int }

handle_clone :: proc(h: Handle) -> Handle {
	h.refs^ += 1
	return h                 // a type's own clone and destroy procs copy it as it is
}

impl Destroy for Handle { destroy = handle_destroy }
impl Clone for Handle { clone = handle_clone }

g := h                       // g := handle_clone(h)
p := Pair{h, g}              // each field is a clone
same :: proc(h: Handle) -> Handle { return h }      // a borrowed parameter is cloned when returned
```

- Every place a copy was an error before is a clone instead: `:=` and `=` from a variable, field or element, returning a parameter, a variable in a literal, `new_clone`, and passing to an `#owned` parameter. Capturing by value and `for x in ...` over values are still errors, since nothing would destroy those copies.
- **Structs are cloned field by field** when every field that needs destroying can be cloned and the struct has no `impl Destroy` of its own: vidar writes `__Pair_clone`. A struct with its own `impl Destroy` is move-only unless it has `impl Clone` too, and then that proc clones the whole value.
- Arrays, unions, `Maybe` and instances of parametric types are cloned at run time, element by element or by the variant they hold.

## Shared values: `vidar:rc`

`import "vidar:rc"` gives `Rc(T)`, a counted owner of one `T` on the heap. Copies share the value, and the last owner to be destroyed destroys it (with its own `impl Destroy`, if it has one) and frees it.

```odin
import "vidar:rc"

r := rc.new(open("shared"))      // rc.new takes the File over (#owned)
{
	s := r                       // a second owner
	fmt.println(rc.count(r))     // 2
	fmt.println(rc.get(s).name)  // get gives ^File
}                                // s is released here
f := open("b")
t := rc.new(move!(f))
```

- `rc.new(value, allocator := context.allocator)`, `rc.get(r) -> ^T` and `rc.count(r) -> int`. The zero `Rc` owns nothing.
- Counts are plain integers, and atomic only when built with `-define:VIDAR_THREADS=N` for N > 1.
- Cycles leak: two `Rc`s that hold each other are never released.

## Generic code

Generic code works with destructible types without naming them. Its locals of type `T` (or `Pair(T)`, `[4]T`, ...) are destroyed through `__vidar.destroy`, which finds out at run time what a type needs. Each package registers its types with `impl Destroy` when the program starts, and any other type is read from its type info the first time. After that first lookup, each instantiation keeps the answer, so a destroy costs a load and a branch. With `T = int` the call is empty, and compiles to nothing above `-o:none`.

```odin
// package lib: knows nothing about File
make_pair :: proc(mk: proc(string) -> $T) -> Pair(T) {
	p := Pair(T){mk("a"), mk("b")}     // destroyed here unless returned
	return p
}
```

A copy in generic code is `__vidar.clone(x)`, which clones a value whose type has `impl Clone` (or is cloned field by field), and copies any other value as it is. A copy of a move-only value can't be refused by vidar, since it doesn't know `T`:

- where the file can name the type (it is declared in the same package, or in one the file imports), Odin refuses to compile that instantiation: `Compile time assertion: ... this copies a value whose type has impl Destroy`;
- anywhere else, the program stops at the copy: `lib.vidar(4:2): a File was copied, but its type has impl Destroy, so both copies would be destroyed`.

Since parameters are borrowed, a generic proc that returns or stores its parameter (`keep :: proc(x: $T) -> T { return x }`) copies it: that clones an `Rc`, and stops for a `File`. Declare the parameter `#owned` to take the value over instead (`keep :: proc(#owned x: $T) -> T`).

The same run-time destroy covers a local whose type vidar can't tell, such as the result of a proc it doesn't read.

## Declaring it

```odin
impl Destroy for File { destroy = file_destroy }    // file_destroy :: proc(f: ^File)
impl Clone for Handle { clone = handle_clone }      // handle_clone :: proc(h: Handle) -> Handle
impl Destroy for Box($T) { destroy = box_destroy }  // box_destroy :: proc(b: ^Box($T))
```

- The target is a named struct or union, and the impl is in its package.
- The destroy proc takes `^T` and returns nothing; the clone proc takes `T` and returns the copy. Each must be declared with a body in the same package, and must not be `@(private)` unless the type is. Inside them, copies of any value are left alone.
- **A parametric type** implements them for every instance at once, with generic procs: `impl Destroy for Box($T)`. Fields that need destroying are destroyed after the impl's proc, as for other structs. An impl for one instance (`Box(int)`) is not supported.
- A file that holds a `T` must be able to call its destructor, so it must import `T`'s package (vidar says so when it doesn't).
- `Destroy` is built in only while the program doesn't declare its own `Destroy`. With `Destroy :: interface { destroy }` in scope, `impl Destroy for T` is an ordinary interface impl, as before, and nothing is destroyed automatically.

## What it becomes

Every rewrite stays on its source line:

```odin
f := open("a"); defer file_destroy(&f)                                   // f := open("a")
{ __vidar_old := f; f = open("b"); file_destroy(&__vidar_old) }          // f = open("b")
{ defer f = {}; return f }                                               // return f
h2 := handle_clone(h); defer handle_destroy(&h2)                         // h2 := h, with impl Clone
g := __vidar.take(&f); defer file_destroy(&g)                            // g := move!(f)
f := f; defer file_destroy(&f)                                           // #owned f: File, on entry
l := make_log(); defer __Log_destroy(&l)                                 // l := make_log()
arr := [2]File{open("x"), open("y")}; defer __vidar.destroy(&arr)        // arrays, unions, Maybe, generic code
```

`__Log_destroy` (and `__Pair_clone`) is written at the end of the file that declares the type. When anything is destroyed, cloned or checked at run time, the program also gets `vidar_runtime/destroy.odin`, and each file declaring a destructible type registers it in an `@(init)` proc.

## Not supported yet

Each of these is a compile error for now, not a silent leak:

- a `T` in a slice, dynamic array, map or `distinct T`. Hold a `^T` instead;
- package-level variables of type `T`;
- `impl Destroy` or `impl Clone` for one instance of a parametric type (`Box(int)`);
- capturing a `T` by value in a closure, even with `impl Clone`;
- declaring a `T` in an `if`, `for` or `switch` initializer;
- assigning several values at once (`a, b = x, y`) when one is a `T`, or assigning to a target with side effects (`files[next()] = ...`).

Generic code has gaps vidar can't see: a `T` returned by a call and thrown away, or passed straight to another call, is never destroyed, and a `T` declared in an `if`/`for`/`switch` initializer isn't either. Generic code that holds an instance of a parametric type as a plain `T` (a `Box(int)` passed as `$T`) can't destroy it, since its procs exist only per instance, and stops the program; `Rc` is the exception, since `vidar:rc` registers procs that take any instance. Heap values (`new(T)`, `free`) are never destroyed automatically, as with a raw pointer in C++.

## Related

- [Interfaces](interfaces.md): `impl` for interfaces, and declaring your own `Destroy`.
- [Error handling](error-handling.md): `or_return`, `errdefer`.
- [Limits](../limits.md#destructors).
