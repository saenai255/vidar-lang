# Copying with `impl Clone`

Some types can be copied safely, as long as the copy is made the right way: a buffer copies its bytes into new memory, a reference-counted handle bumps its count. `impl Clone` tells Vidar how. Every copy that would have been an error becomes a call to the clone procedure instead, which returns a new value with an owner of its own, the way a C++ copy constructor does.

```vidar
Buffer :: struct { data: [dynamic]u8 }

buffer_destroy :: proc(b: ^Buffer) {
	delete(b.data)
}

buffer_clone :: proc(b: Buffer) -> Buffer {
	fmt.println("cloning", len(b.data), "bytes")
	out := Buffer{make([dynamic]u8, len(b.data))}
	copy(out.data[:], b.data[:])
	return out
}

impl Destroy for Buffer { destroy = buffer_destroy }
impl Clone for Buffer { clone = buffer_clone }

main :: proc() {
	a := Buffer{make([dynamic]u8, 3)}
	b := a              // a clone: a is used again below
	b.data[0] = 7
	fmt.println(a.data[:], b.data[:])
}
```

<span class="caption">Listing 7-8: A buffer whose copies are deep</span>

```output
cloning 3 bytes
[0, 0, 0] [7, 0, 0]
```

The clone procedure takes the value (`T`, not `^T`) and returns the copy. A type with `impl Clone` must also have `impl Destroy`. Inside a type's own clone and destroy procedures, copies of any value are left alone, so `buffer_clone` can return `out` and work with `b` freely.

## Where Clones Happen

Everywhere a copy was an error before, it's a clone: `:=` and `=` from a variable, field or element, returning a by-value parameter, a variable in a struct or array literal, `new_clone`, appending a variable, and passing a variable to an `#owned` parameter.

## The Last Use Moves Instead

Cloning costs something, and often the original isn't needed afterwards. So when a copy is the *last use* of a local, Vidar moves the value instead of cloning it: no clone procedure is called, and the local is left zero for its own destroy.

```vidar
# Buffer :: struct { data: [dynamic]u8 }
# buffer_destroy :: proc(b: ^Buffer) { delete(b.data) }
# buffer_clone :: proc(b: Buffer) -> Buffer {
# 	fmt.println("cloning", len(b.data), "bytes")
# 	out := Buffer{make([dynamic]u8, len(b.data))}
# 	copy(out.data[:], b.data[:])
# 	return out
# }
# impl Destroy for Buffer { destroy = buffer_destroy }
# impl Clone for Buffer { clone = buffer_clone }
#
main :: proc() {
	a := Buffer{make([dynamic]u8, 3)}
	b := a              // a is read below: cloned
	c := a              // a's last use: moved, no clone
	fmt.println(len(b.data), len(c.data))
}
```

<span class="caption">Listing 7-9: The last use of a local moves it</span>

```output
cloning 3 bytes
3 3
```

A copy counts as a last use only when the local plainly can't be read again: there's no later reference to it in the procedure, none in a `defer` or a closure, its address isn't taken, and the copy isn't in a loop that the local was declared outside of. Otherwise it's a clone. The editor shows which one each copy is, with a `move` or `clone` inlay hint.

A type without `impl Clone` still needs `move!` to move: Vidar doesn't guess whether a copy of a move-only value was meant.

## Structs Clone Field by Field

A struct whose destructible fields can all be cloned, and which has no `impl Destroy` of its own, can be copied too: Vidar writes a clone for it that clones each field. A struct *with* its own `impl Destroy` is move-only unless it has an `impl Clone` too, and then that procedure clones the whole value.

```vidar
# Buffer :: struct { data: [dynamic]u8 }
# buffer_destroy :: proc(b: ^Buffer) { delete(b.data) }
# buffer_clone :: proc(b: Buffer) -> Buffer {
# 	fmt.println("cloning", len(b.data), "bytes")
# 	out := Buffer{make([dynamic]u8, len(b.data))}
# 	copy(out.data[:], b.data[:])
# 	return out
# }
# impl Destroy for Buffer { destroy = buffer_destroy }
# impl Clone for Buffer { clone = buffer_clone }
#
Pair :: struct { left, right: Buffer, tag: int }

main :: proc() {
	p := Pair{Buffer{make([dynamic]u8, 1)}, Buffer{make([dynamic]u8, 2)}, 7}
	q := p             // clones left and right, copies tag
	fmt.println(len(q.left.data), len(q.right.data), q.tag, len(p.left.data))
}
```

```output
cloning 1 bytes
cloning 2 bytes
1 2 7 1
```

Arrays, unions, `Maybe`s and instances of parametric types are cloned element by element, or by the variant they hold, at run time.

## Summary

- `impl Clone for T { clone = t_clone }`, with `t_clone :: proc(x: T) -> T`, turns copies of `T` into calls to `t_clone`. `T` needs `impl Destroy` too.
- The last use of a local moves instead of cloning.
- Structs whose destructible fields can be cloned are cloned field by field.
