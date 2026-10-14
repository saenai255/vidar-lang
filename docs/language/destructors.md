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
- **The zero value is destroyed too.** `f: File` declares a zero `File`, and it is destroyed like any other. A local that was returned is left zero. A proc that fails returns a zero value along with its error, and that value is destroyed as well. So **a destroy proc must accept the zero value** and do nothing with it.
- **Assigning** to a local, or through a pointer (`p^ = ...`), destroys the old value after the new one is stored.
- **Returning** a local moves it out: the caller owns the value and destroys it, and this proc doesn't.
- **Parameters are borrowed.** A proc that takes a `File` by value can read it but doesn't destroy it, and can't return or store it.

## Copies are errors

There is one owner for each value. A copy would be destroyed twice, so every copy is a compile error, with a hint to borrow instead:

```odin
f := open("a")
g := f                      // error: 'f' is a File, which has impl Destroy, and 'g := f' would copy it; ...
p := &f                     // fine: a pointer borrows it
use(f)                      // fine: by-value parameters borrow too
```

These count as copies: `:=` and `=` from a variable, field, element or `p^`; returning a parameter; `new_clone(f)`; capturing `f` by value in a closure (capture `&f`); and `for f in ...` over values. A value nothing owns is an error too: a call whose `File` result is thrown away, a `File` passed straight to another call (`use(open("a"))`), and `_ = open("a")`.

## Declaring it

```odin
impl Destroy for File { destroy = file_destroy }
```

- The target is a named struct or union, and the impl is in its package.
- The destroy proc takes `^T` and returns nothing. It must be declared with a body in the same package, and must not be `@(private)` unless the type is.
- A file that holds a `T` must be able to call the destroy proc, so it must import `T`'s package (vidar says so when it doesn't).
- `Destroy` is built in only while the program doesn't declare its own `Destroy`. With `Destroy :: interface { destroy }` in scope, `impl Destroy for T` is an ordinary interface impl, as before, and nothing is destroyed automatically.

## What it becomes

Every rewrite stays on its source line:

```odin
f := open("a"); defer file_destroy(&f)                                   // f := open("a")
{ __vidar_old := f; f = open("b"); file_destroy(&__vidar_old) }          // f = open("b")
{ defer f = {}; return f }                                               // return f
```

## Not supported yet

Each of these is a compile error for now, not a silent leak:

- a `T` inside another type: a struct field, union variant, array, slice, dynamic array, map, `Maybe(T)`, a parametric type's argument or `distinct T`. Hold a `^T` instead;
- package-level variables of type `T`;
- passing a `T` to a generic (`$T`) parameter, and `impl Destroy` for a parametric type;
- declaring a `T` in an `if`, `for` or `switch` initializer;
- assigning several values at once (`a, b = x, y`) when one is a `T`, or assigning to anything but a variable or `p^`;
- a local whose type vidar can't tell, when its value involves a `T`; write the type (`x: T = ...`).

Heap values (`new(T)`, `free`) are never destroyed automatically, as with a raw pointer in C++.

## Related

- [Interfaces](interfaces.md): `impl` for interfaces, and declaring your own `Destroy`.
- [Error handling](error-handling.md): `or_return`, `errdefer`.
- [Limits](../limits.md#destructors).
