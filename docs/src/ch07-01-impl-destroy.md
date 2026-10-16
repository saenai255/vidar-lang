# Destructors with `impl Destroy`

Throughout this chapter we'll use a small `File` type that prints when it's opened and closed, so that the output shows exactly when the destructor runs. A real one would hold an `os.Handle` and call `os.close`.

```vidar
File :: struct { name: string }

open :: proc(name: string) -> File {
	fmt.println("open", name)
	return File{name}
}

file_close :: proc(f: ^File) {
	if f.name == "" do return        // the zero value holds nothing
	fmt.println("close", f.name)
}

impl Destroy for File { destroy = file_close }

main :: proc() {
	a := open("a")
	b := open("b")
	fmt.println("working")
}
```

<span class="caption">Listing 7-1: A type with a destructor, destroyed at the end of `main`</span>

```output
open a
open b
working
close b
close a
```

`impl Destroy for File { destroy = file_close }` declares `File`'s destructor: a procedure that takes a `^File` and returns nothing. From then on, Vidar calls it for every local `File` when the local's scope ends. In the generated Odin, `a := open("a")` becomes `a := open("a"); defer file_close(&a)`, on the same line. Locals are destroyed in reverse order of declaration, so `b` goes before `a`.

## When Values Are Destroyed

A local is destroyed whenever its scope ends, on every path out of it:

- at the closing `}` of its block;
- on `return`, `break` and `continue`;
- on every `or_return`, `or_break` and `or_continue` that leaves its scope.

A loop body is a scope, so its locals are destroyed at the end of each iteration. That makes early returns safe:

```vidar
# File :: struct { name: string }
# open :: proc(name: string) -> File { fmt.println("open", name); return File{name} }
# file_close :: proc(f: ^File) {
# 	if f.name == "" do return
# 	fmt.println("close", f.name)
# }
# impl Destroy for File { destroy = file_close }
#
Error :: enum { None, Empty }

copy_file :: proc(from, to: string) -> Error {
	src := open(from)
	if from == "" do return .Empty     // src is closed here
	dst := open(to)
	fmt.println("copying")
	return .None                        // dst, then src, are closed here
}

main :: proc() {
	fmt.println(copy_file("in", "out"))
	for name in ([]string{"x", "y"}) {
		f := open(name)
		fmt.println("read", f.name)
	}                                   // f is closed at the end of each iteration
}
```

<span class="caption">Listing 7-2: Every path out of a scope destroys its locals</span>

```output
open in
open out
copying
close out
close in
None
open x
read x
close x
open y
read y
close y
```

(From here on, listings that use `File` hide its declaration.)

A `defer` written after a local in the same scope runs before the local is destroyed, so a `defer` can still use the value.

## The Zero Value Is Destroyed Too

`f: File` declares a `File` with its zero value, and it is destroyed like any other. So are a few other zero values you might not expect:

- a local that was returned, or moved somewhere else, is left zero, and its destroy still runs;
- a procedure that fails often returns a zero or half-built value along with the error, and that value is destroyed too.

So **a destroy procedure must accept the zero value** and do nothing with it. That's why `file_close` starts with `if f.name == "" do return`. For memory, it usually comes for free: `delete` and `free` ignore `nil`.

## Assigning Destroys the Old Value

Assigning to a variable that holds a `File` destroys the old `File`, after the new one is in place. The same goes for assigning to a field, to an element at a name or constant index (`files[i] = ...`), and through a pointer (`p^ = ...`):

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
	f := open("first")
	f = open("second")      // "first" is closed once "second" is stored
	fmt.println("using", f.name)
}
```

```output
open first
open second
close first
using second
close second
```

## Returning Moves the Value Out

A procedure that returns a local doesn't destroy it: the value *moves* to the caller, which now owns it and destroys it in turn. That's what makes constructors like `open` work. The returned local is left zero, so its own destroy does nothing.

## Types That Hold a `File`

A struct with a `File` field needs destroying too, and Vidar writes its destructor for you: it destroys the fields that need it, last field first. If the struct has an `impl Destroy` of its own, that procedure runs first, while the fields are still intact.

```vidar
# File :: struct { name: string }
# open :: proc(name: string) -> File { fmt.println("open", name); return File{name} }
# file_close :: proc(f: ^File) {
# 	if f.name == "" do return
# 	fmt.println("close", f.name)
# }
# impl Destroy for File { destroy = file_close }
#
Log :: struct {
	out:   File,
	level: int,
	err:   File,
}

main :: proc() {
	l := Log{out = open("out.log"), err = open("err.log")}
	pair := [2]File{open("x"), open("y")}
	maybe: Maybe(File) = open("m")
	fmt.println("working")
}
```

<span class="caption">Listing 7-3: Structs, arrays and `Maybe`s that hold a `File` are destroyed too</span>

```output
open out.log
open err.log
open x
open y
open m
working
close m
close y
close x
close err.log
close out.log
```

The same goes for every type that holds a destructible value:

- a fixed array destroys its elements, last first;
- a union or a `Maybe` destroys the variant it holds, if any;
- an instance of a parametric type, such as `Pair(File)`, destroys its fields like any struct.

Dynamic arrays and maps own their elements too; they have [a section of their own](ch07-04-containers.md).

## Declaring a Destructor

```vidar,ignore
impl Destroy for File { destroy = file_close }      // file_close :: proc(f: ^File)
impl Destroy for Box($T) { destroy = box_destroy }  // box_destroy :: proc(b: ^Box($T))
```

- The type is a named struct or union, and the `impl` goes in its package.
- The destroy procedure takes `^T`, returns nothing, and is declared with a body in the same package. It may not be `@(private)` unless the type is.
- A parametric type gets one impl for every instance, with a polymorphic procedure: `impl Destroy for Box($T)`. An impl for one instance (`Box(int)`) isn't supported.
- A file that holds a `T` must be able to call its destructor, so it must import `T`'s package; Vidar tells you when it doesn't.
- `Destroy` is built in while the program doesn't declare its own. A program with `Destroy :: interface { destroy }` gets an ordinary [interface](ch05-00-interfaces.md) instead, and nothing is destroyed automatically.

## Summary

- `impl Destroy for T { destroy = t_destroy }` gives `T` a destructor.
- Locals are destroyed at the end of their scope, on every path out of it, last declared first.
- Assigning destroys the old value; returning moves the value to the caller.
- Structs, arrays, unions and `Maybe`s that hold a `T` are destroyed with it.
- A destroy procedure must accept the zero value.

Destroying values automatically only works if each value is destroyed exactly once. The next section covers the rules that make sure of that.
