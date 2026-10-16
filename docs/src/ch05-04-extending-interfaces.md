# Extending Interfaces

An interface can include the methods of other interfaces with `using`, the way an Odin struct can include another struct's fields:

```vidar,ignore
Item :: interface { using Named, using Sized, describe }
```

`Item` has `Named`'s methods, `Sized`'s methods, and its own `describe`. An `Item` value converts to a `Named` or a `Sized` without allocating anything: the vtable of an extended interface embeds its bases' vtables.

```vidar
Named :: interface { name }
Sized :: interface { size }
Item  :: interface { using Named, using Sized, describe }

name     :: proc(n: Named) -> string ---
size     :: proc(s: Sized) -> int ---
describe :: proc(i: Item) -> string ---

File :: struct { n: string, bytes: int }

file_name     :: proc(f: ^File) -> string { return f.n }
file_size     :: proc(f: ^File) -> int { return f.bytes }
file_describe :: proc(f: ^File) -> string { return fmt.tprintf("%s (%d bytes)", f.n, f.bytes) }

impl Item for File { name = file_name, size = file_size, describe = file_describe }

print_name :: proc(n: Named) { fmt.println(name(n)) }

main :: proc() {
	f := File{"a.txt", 12}
	item: Item = &f
	fmt.println(describe(item))
	print_name(item)          // an Item converts to its base
	fmt.println(size(item))   // inherited methods work on it directly
	s: Sized = &f             // impl Item for File also implements Sized
	fmt.println(size(s))
}
```

<span class="caption">Listing 5-5: `Item` extends `Named` and `Sized`</span>

```output
a.txt (12 bytes)
a.txt
12
12
```

`impl Item for File` binds every method, inherited ones included, and also implements each base declared in the same package (or import cycle), so `&f` converts to `Named` and `Sized` directly as well.

A few rules keep this unambiguous:

- Bases can come from this package or an imported one.
- Diamonds are fine: two bases that share a base of their own give it once.
- An interface can't extend itself, list a base twice, or end up with two different methods of the same name.
- A type that implements both an interface and one of its bases must bind the shared methods the same way in both impls.

## Summary

That's interfaces: a list of methods, implemented by ordinary procedures and called like them, with direct calls when the type is known and cheap dispatch when it isn't. Next, we'll look at the error handling Vidar adds to Odin's.
