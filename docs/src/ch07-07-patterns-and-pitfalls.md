# Patterns and Pitfalls

This section collects common designs built on destructors, and the things the compiler doesn't protect you from. The [`examples/raii`](../../examples/raii) program puts most of them together.

## Patterns

### A guard: run code when a scope ends

A struct whose destructor undoes what making it did. Unlike a `defer`, a guard is a value: it can be returned from a procedure and stored in a struct.

```vidar
Lock :: struct { held: bool }

Guard :: struct { lock: ^Lock }

guard_release :: proc(g: ^Guard) {
	if g.lock == nil do return
	g.lock.held = false
	fmt.println("unlocked")
}

impl Destroy for Guard { destroy = guard_release }

acquire :: proc(l: ^Lock) -> Guard {
	l.held = true
	fmt.println("locked")
	return Guard{l}
}

Error :: enum { None, Failed }

update :: proc(l: ^Lock, fail: bool) -> Error {
	g := acquire(l)
	if fail do return .Failed       // unlocked on this return too
	fmt.println("updated")
	return .None
}

main :: proc() {
	l: Lock
	fmt.println(update(&l, false))
	fmt.println(update(&l, true))
}
```

<span class="caption">Listing 7-15: A lock guard</span>

```output
locked
updated
unlocked
None
locked
unlocked
Failed
```

### Cleanup on every error path

Each value made so far is destroyed on the `or_return` that fails, and nothing else is. A sequence of steps that each acquire something needs no cleanup code at all:

```vidar
# File :: struct { name: string }
# file_close :: proc(f: ^File) {
# 	if f.name == "" do return
# 	fmt.println("close", f.name)
# }
# impl Destroy for File { destroy = file_close }
#
Error :: enum { None, Refused }

connect :: proc(host: string) -> (File, Error) {
	if host == "bad" do return {}, .Refused
	fmt.println("open", host)
	return File{host}, .None
}

handshake :: proc(a, b: string) -> Error {
	first := connect(a) or_return
	second := connect(b) or_return     // on failure: first is closed
	fmt.println("exchanging")
	return .None                       // second, then first, are closed
}

main :: proc() {
	fmt.println(handshake("x", "y"))
	fmt.println(handshake("x", "bad"))
}
```

```output
open x
open y
exchanging
close y
close x
None
open x
close x
Refused
```

### A struct of resources

A struct whose fields are destructible needs no destroy procedure of its own: it's destroyed field by field, last first. Give it an `impl Destroy` only for what the fields can't do themselves, such as flushing; it runs before them.

```vidar,ignore
Server :: struct {
	listener: Conn,
	clients:  [dynamic]Conn,       // each Conn is closed, then the array freed
	by_name:  map[string]Conn,
}
```

### Building and returning

A local that is returned moves out, so constructors are ordinary procedures. A constructor that fails partway returns what it built with the error, and the caller destroys it, even when it uses `or_return`:

```vidar,ignore
make_server :: proc() -> (s: Server, err: Error) {
	s.listener = listen() or_return     // on failure, s goes back with the error and is destroyed there
	return
}
```

### Taking a value out of a container

`pop` and `delete_key` give you the value; `move!` through a pointer leaves a zero element behind:

```vidar,ignore
last := pop(&files)                  // last owns it now
_, f := delete_key(&by_name, "bob")  // so does f
p := &files[0]
mine := move!(p^)                    // files[0] is a zero File now
```

## Pitfalls

What Vidar doesn't check, or does differently from what you might expect:

- **Destroy procedures get zero values.** A local declared without a value, a moved-from local, the value returned along with an error, and the elements `resize` adds are all destroyed. Check for the zero value and return.
- **Pointers outlive what they point to.** `p := &f` is a plain pointer. Nothing stops it from being kept somewhere that outlives `f`, as with any Odin pointer. The same goes for `files[:]` after `files` is destroyed or `append` reallocates it, and for `&m[k]` after the map grows.
- **A borrowing closure is checked against the procedure, not the block.** A closure that captures `f` by value can't be returned or stored outside the procedure, but inside it, nothing stops it from being called after `f`'s block has ended.
- **`move!` leaves zero behind.** Reading a moved-from variable gives the zero value, not an error. Keep moves at the end of a variable's use.
- **Clone procedures don't run on a last use.** A copy that ends a local's use moves it instead. Don't count clone calls, and don't make a clone procedure do anything but copy.
- **Destruction order is reverse declaration order,** after any `defer` written later in the same block. A `defer` in an outer block runs after an inner block's locals are gone.
- **Heap values are yours.** `new(File)` and `new_clone(f)` give pointers, and `free` doesn't destroy. Destroy first (`file_close(p)`), then free, or use an `Rc`.
- **`os.exit`, `panic` and `runtime.trap` skip destroys,** as they skip `defer`.
- **A map is destroyed in no particular order,** as it's iterated in none.
- **Core procedures that copy elements aren't checked.** `slice.clone`, `slice.concatenate` and the like copy each element as plain bytes, so both copies get destroyed. Copy in a loop instead, with clones or `move!`.
- **`Rc` counts are atomic only with `-define:VIDAR_THREADS=N` (N above 1).** At one thread, the default, sharing an `Rc` between threads you start yourself races.
- **A `Destroy` interface of your own turns all of this off.** With `Destroy :: interface { ... }` in scope, `impl Destroy for T` is an ordinary interface impl, and nothing is destroyed automatically.

## Not Supported Yet

Each of these is a compile error for now, rather than a silent leak:

- a destructible `T` in an `#soa` array, a fixed-capacity dynamic array, a `distinct T`, a map key, an Odin package's container type, or a package-level variable;
- a slice that would own `T`s: `make([]T, n)`, `[]T{...}`, `delete` of a `[]T`;
- `impl Destroy` or `impl Clone` for one instance of a parametric type (`Box(int)`);
- declaring a `T` in an `if`, `for` or `switch` initializer;
- assigning several values at once (`a, b = x, y`) when one is a `T`, or assigning to a target with side effects (`files[next()] = ...`);
- a range in an array literal (`[4]T{0..<4 = x}`), which would copy one value into each element.

## Summary

Destructors let you write cleanup once, next to the type, and have it run on every path. Ownership rules keep that safe: one owner per value, borrows for everything that only looks, moves and clones for everything that keeps. The rules apply only to types with `impl Destroy`; the rest of your program is plain Odin, as before.

The next chapter is a short one, about a small convenience: struct literals that don't need a type.
