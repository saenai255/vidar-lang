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

A type without `impl Destroy` is unaffected, and a program without any `impl Destroy` is transpiled exactly as before.

## What gets destroyed, and when

- **A local** of a type with `impl Destroy` is destroyed when its scope ends: at the closing `}`, on `return`, `break` or `continue`, and on every `or_return`. A loop body destroys its locals on each iteration. Locals are destroyed in reverse order of declaration, after any `defer` written later in the same scope.
- **Types that hold one are destroyed too.** A struct with a `File` field gets a destructor of its own, `__Log_destroy`, which destroys its fields last first. If the struct also has `impl Destroy`, its proc runs first, while the fields are still there. Fixed arrays (`[4]File`, `[Color]File`) destroy their elements last first, a union or `Maybe(File)` destroys the variant it holds, and so does an instance of a parametric type (`Pair(File)`).
- **The zero value is destroyed too.** `f: File` declares a zero `File`, and it is destroyed like any other. A local that was returned is left zero. A proc that fails returns a zero value along with its error, and that value is destroyed as well. So **a destroy proc must accept the zero value** and do nothing with it.
- **Assigning** to a local, a field, an element (`files[i]`, with a name or constant index) or through a pointer (`p^ = ...`) destroys the old value after the new one is stored.
- **Returning** a local moves it out: the caller owns the value and destroys it, and this proc doesn't.
- **Parameters are borrowed.** A proc that takes a `File` by value can read it but doesn't destroy it, and can't return or store it.

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

There is one owner for each value. A copy would be destroyed twice, so every copy is a compile error, with a hint to borrow instead:

```odin
f := open("a")
g := f                      // error: 'f' is a File, which has impl Destroy, and 'g := f' would copy it; ...
p := &f                     // fine: a pointer borrows it
use(f)                      // fine: by-value parameters borrow too
```

These count as copies: `:=` and `=` from a variable, field, element or `p^`; returning a parameter; `new_clone(f)`; a variable inside a struct or array literal; capturing `f` by value in a closure (capture `&f`); and `for f in ...` over values. They apply to every type that holds a `File` as well (`Log`, `[2]File`, `Maybe(File)`). A value nothing owns is an error too: a call whose `File` result is thrown away, a `File` passed straight to another call (`use(open("a"))`), and `_ = open("a")`.

## Generic code

Generic code works with destructible types without naming them. Its locals of type `T` (or `Pair(T)`, `[4]T`, ...) are destroyed through `__vidar.destroy`, which finds out at run time what a type needs. Each package registers its types with `impl Destroy` when the program starts, and any other type is read from its type info the first time. After that first lookup, each instantiation keeps the answer, so a destroy costs a load and a branch. With `T = int` the call is empty, and compiles to nothing above `-o:none`.

```odin
// package lib: knows nothing about File
make_pair :: proc(mk: proc(string) -> $T) -> Pair(T) {
	p := Pair(T){mk("a"), mk("b")}     // destroyed here unless returned
	return p
}
```

A copy in generic code can't be refused by vidar, since it doesn't know `T`:

- where the file can name the type (it is declared in the same package, or in one the file imports), Odin refuses to compile that instantiation: `Compile time assertion: ... this copies a value whose type has impl Destroy`;
- anywhere else, the program stops at the copy: `lib.vidar(4:2): a File was copied, but its type has impl Destroy, so both copies would be destroyed`.

Since parameters are borrowed, a generic proc that returns or stores its parameter (`keep :: proc(x: $T) -> T { return x }`) copies it, and can't be used with a destructible type. Generic code that only reads its parameters, or builds its own values, can.

The same run-time destroy covers a local whose type vidar can't tell, such as the result of a proc it doesn't read.

## Declaring it

```odin
impl Destroy for File { destroy = file_destroy }
```

- The target is a named struct or union, and the impl is in its package.
- The destroy proc takes `^T` and returns nothing. It must be declared with a body in the same package, and must not be `@(private)` unless the type is.
- A file that holds a `T` must be able to call its destructor, so it must import `T`'s package (vidar says so when it doesn't).
- `Destroy` is built in only while the program doesn't declare its own `Destroy`. With `Destroy :: interface { destroy }` in scope, `impl Destroy for T` is an ordinary interface impl, as before, and nothing is destroyed automatically.

## What it becomes

Every rewrite stays on its source line:

```odin
f := open("a"); defer file_destroy(&f)                                   // f := open("a")
{ __vidar_old := f; f = open("b"); file_destroy(&__vidar_old) }          // f = open("b")
{ defer f = {}; return f }                                               // return f
l := make_log(); defer __Log_destroy(&l)                                 // l := make_log()
arr := [2]File{open("x"), open("y")}; defer __vidar.destroy(&arr)        // arrays, unions, Maybe, generic code
```

`__Log_destroy` is written at the end of the file that declares `Log`. When anything is destroyed or checked at run time, the program also gets `vidar_runtime/destroy.odin`, and each file declaring a destructible type registers it in an `@(init)` proc.

## Not supported yet

Each of these is a compile error for now, not a silent leak:

- a `T` in a slice, dynamic array, map or `distinct T`. Hold a `^T` instead;
- package-level variables of type `T`;
- `impl Destroy` for a parametric type (`Box($T)`);
- declaring a `T` in an `if`, `for` or `switch` initializer;
- assigning several values at once (`a, b = x, y`) when one is a `T`, or assigning to a target with side effects (`files[next()] = ...`).

Generic code has gaps vidar can't see: a `T` returned by a call and thrown away, or passed straight to another call, is never destroyed, and a `T` declared in an `if`/`for`/`switch` initializer isn't either. Heap values (`new(T)`, `free`) are never destroyed automatically, as with a raw pointer in C++.

## Related

- [Interfaces](interfaces.md): `impl` for interfaces, and declaring your own `Destroy`.
- [Error handling](error-handling.md): `or_return`, `errdefer`.
- [Limits](../limits.md#destructors).
