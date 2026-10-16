# Owners, Borrows and Moves

Every value of a type with a destructor has exactly one *owner*: a local variable, a field of something that has an owner, an element of an owned container, or a parameter declared `#owned`. The owner destroys it. Everything else either *borrows* the value, using it while the owner keeps it, or receives it in a *move*, becoming the new owner.

## Copies Are Errors

If a `File` could be copied, both copies would be destroyed, and the file would be closed twice. So Vidar makes every copy of a destructible value a compile error:

```vidar,compile_fail
# File :: struct { name: string }
# open :: proc(name: string) -> File { fmt.println("open", name); return File{name} }
# file_close :: proc(f: ^File) {
# 	if f.name == "" do return
# 	fmt.println("close", f.name)
# }
# impl Destroy for File { destroy = file_close }
#
main :: proc() {
	f := open("a")
	g := f
}
```

<span class="caption">Listing 7-4: Copying a `File` is an error</span>

```error
error: 'f' is a File, which has impl Destroy, and 'g := f' would copy it; both copies would be destroyed. Borrow it with &f
```

There are three ways out, and the message suggests the first: borrow the value with `&f`, move it with `move!(f)`, or give the type a way to copy itself with `impl Clone`. The rest of this section covers borrowing and moving; the [next section](ch07-03-impl-clone.md) covers `impl Clone`.

These all count as copies:

- `:=` and `=` from a variable, a field, an element or `p^`;
- `v, ok := m[k]` and `v, ok := u.(File)`;
- returning a parameter;
- `new_clone(f)`;
- a variable inside a struct or array literal;
- appending a variable to a dynamic array.

They apply to every type that holds a `File` too: a `Log` with a `File` field, a `[2]File`, a `Maybe(File)`.

## Values Nothing Owns

A value with no owner would never be destroyed, so that's an error too. It happens when a call's result is thrown away, when it is passed straight into another call that only borrows it, or when it's assigned to `_`:

```vidar,compile_fail
# File :: struct { name: string }
# open :: proc(name: string) -> File { fmt.println("open", name); return File{name} }
# file_close :: proc(f: ^File) {
# 	if f.name == "" do return
# 	fmt.println("close", f.name)
# }
# impl Destroy for File { destroy = file_close }
#
main :: proc() {
	open("log")
}
```

```error
error: the File that open() returns is thrown away, so it would never be destroyed; keep it: x := open("log")
```

Give it an owner, `f := open("log")`, and it's destroyed at the end of the scope.

## Borrowing

Most of the time, code that receives a value only needs to use it for a while. That's a *borrow*, and it needs no copy.

**A pointer borrows.** `p := &f` is an ordinary pointer: `f` keeps owning the file.

**A by-value parameter borrows.** A procedure that takes a `File` by value can read it, but doesn't destroy it, and can't return or store it, since the caller still owns it:

```vidar
# File :: struct { name: string }
# open :: proc(name: string) -> File { fmt.println("open", name); return File{name} }
# file_close :: proc(f: ^File) {
# 	if f.name == "" do return
# 	fmt.println("close", f.name)
# }
# impl Destroy for File { destroy = file_close }
#
show :: proc(f: File) {
	fmt.println("showing", f.name)
}

main :: proc() {
	f := open("a")
	show(f)        // borrowed: f still owns the file
	show(f)
}
```

<span class="caption">Listing 7-5: A by-value parameter borrows the caller's value</span>

```output
open a
showing a
showing a
close a
```

**Loops and closures borrow.** `for f in files` and a closure that captures `f` by value read the value its owner keeps, and never destroy it. A closure that borrows a destructible value can't outlive the procedure, by the same rules as a closure that captures `&f` (see [How Long a Closure Can Live](ch04-04-closure-lifetimes.md)).

## Moving with `move!`

To hand a value to a new owner, *move* it. `move!(x)` gives `x`'s value and leaves `x` zero, so the old owner's destroy finds nothing to do:

```vidar
# File :: struct { name: string }
# open :: proc(name: string) -> File { fmt.println("open", name); return File{name} }
# file_close :: proc(f: ^File) {
# 	if f.name == "" do return
# 	fmt.println("close", f.name)
# }
# impl Destroy for File { destroy = file_close }
#
main :: proc() {
	f := open("a")
	g := move!(f)           // g owns the file now; f is zero
	fmt.println("f:", f.name == "", "g:", g.name)
}
```

<span class="caption">Listing 7-6: Moving a value to a new owner</span>

```output
open a
f: true g: a
close a
```

The file is closed once, by `g`. `f` is destroyed too, but it's zero, and `file_close` does nothing with a zero `File`.

`move!` takes a variable, a field or an element: something that can be left zero. It can't take a by-value parameter, because that is borrowed and its owner is the caller.

A *new* value doesn't need `move!`: the result of a call has no other owner, so `g := open("b")` and `files[0] = open("c")` move it in directly.

## Taking Ownership with `#owned`

A procedure that wants to keep a value it's given (store it in a struct, append it to a list, hand it on) declares the parameter `#owned`. The parameter then owns what it is passed: the procedure destroys it when it returns, unless it moves it somewhere else first.

```vidar
# File :: struct { name: string }
# open :: proc(name: string) -> File { fmt.println("open", name); return File{name} }
# file_close :: proc(f: ^File) {
# 	if f.name == "" do return
# 	fmt.println("close", f.name)
# }
# impl Destroy for File { destroy = file_close }
#
Archive :: struct { files: [dynamic]File }

store :: proc(a: ^Archive, #owned f: File) {
	append(&a.files, move!(f))      // the archive owns it now
}

inspect :: proc(#owned f: File) {
	fmt.println("inspecting", f.name)
}                                    // f is destroyed here

main :: proc() {
	a: Archive
	store(&a, open("one"))           // a new value moves in
	f := open("two")
	store(&a, move!(f))              // a local is moved in
	inspect(open("three"))
	fmt.println("archived", len(a.files))
}
```

<span class="caption">Listing 7-7: `#owned` parameters take the value over</span>

```output
open one
open two
open three
inspecting three
close three
archived 2
close two
close one
```

Callers pass an `#owned` parameter a new value, a `move!`, or (for a type with `impl Clone`) a copy. Passing a plain local would copy it, which is an error that suggests `move!`.

`#owned` is a Vidar directive, removed from the Odin output. A few rules apply:

- A procedure type can say it too: `Sink :: proc(#owned f: File)`. A procedure used as a procedure value must agree with the type about each destructible parameter, since the callers decide whether to destroy what they passed.
- A variadic parameter (`..File`) can't be `#owned`: it is a slice of values the caller keeps.
- Calls into `core:` always borrow.

## Returning Values

Returning a local moves it out, as [the previous section](ch07-01-impl-destroy.md#returning-moves-the-value-out) showed. Returning a by-value parameter would copy what the caller owns, so it's an error; declare the parameter `#owned` to take it over and return it.

## Summary

- A value with a destructor has one owner, which destroys it.
- Copies are compile errors, and so are values with no owner.
- Pointers, by-value parameters, loops and closures borrow.
- `move!(x)` moves a value to a new owner and leaves `x` zero.
- An `#owned` parameter takes over the value it's passed.
