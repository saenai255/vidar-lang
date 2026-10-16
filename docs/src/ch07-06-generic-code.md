# Destructors in Generic Code

A polymorphic procedure doesn't know, when it's written, whether its `$T` has a destructor. Vidar handles that at run time, so generic code works with destructible types without naming them.

```vidar
# File :: struct { name: string }
# open :: proc(name: string) -> File { fmt.println("open", name); return File{name} }
# file_close :: proc(f: ^File) {
# 	if f.name == "" do return
# 	fmt.println("close", f.name)
# }
# impl Destroy for File { destroy = file_close }
#
Stack :: struct($T: typeid) { items: [dynamic]T }

push :: proc(s: ^Stack($T), #owned x: T) { append(&s.items, move!(x)) }
drop_top :: proc(s: ^Stack($T)) { pop(&s.items) }   // destroys the top when T needs it

main :: proc() {
	files: Stack(File)
	push(&files, open("a"))
	push(&files, open("b"))
	drop_top(&files)

	numbers: Stack(int)
	push(&numbers, 1)
	drop_top(&numbers)
	fmt.println("done")
}
```

<span class="caption">Listing 7-14: A generic stack that destroys what it drops</span>

```output
open a
open b
close b
done
close a
```

## How It Works

Locals of type `T` in generic code (and of types built from it, like `Pair(T)` or `[4]T`) are destroyed through a runtime helper, `__vidar.destroy`, which finds out what a type needs. Each package registers its types with `impl Destroy` when the program starts, and any other type is read from its type info the first time it's seen. After that, each instantiation keeps the answer, so a destroy in generic code costs a load and a branch. With `T = int` there's nothing to do, and the call compiles to nothing above `-o:none`.

Core's container procedures in generic code get the same treatment: `clear(&s.items)` with `items: [dynamic]T` destroys the elements when `T` needs it.

## Copies in Generic Code

A copy of a `T` in generic code is `__vidar.clone(x)`: it clones a value whose type has `impl Clone` (or is cloned field by field), and copies any other value as it is. A copy of a move-only value can't be refused at compile time, since the generic code doesn't know `T`. Instead:

- where the file can name the type (it's declared in the same package, or in one the file imports), Odin refuses to compile that instantiation, with an `#assert` that says the copy needs a destructible type to be cloned;
- anywhere else, the program stops at the copy, with a message that names the type and the line.

Parameters are borrowed, so a generic procedure that returns or stores its parameter copies it:

```vidar,ignore
keep :: proc(x: $T) -> T { return x }          // clones an Rc; stops for a File
take :: proc(#owned x: $T) -> T { return x }   // moves: works for both
```

Declare the parameter `#owned` when the procedure keeps the value.

## Gaps

Generic code has a few gaps that Vidar can't see through. A `T` returned by a call and thrown away, or passed straight into another call, is never destroyed. Assigning to an element of `T`s at a computed index (`a[i + 1] = v`), or to several targets at once, leaves the old value undestroyed. [Appendix H](appendix-08-limits.md#destructors) lists them all.
