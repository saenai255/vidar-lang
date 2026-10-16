# Memory and Layout

## Allocations Freed Together

Adjacent `x := make([]E, n)` and `p := new(T)` that are only freed by a `defer delete(x)` or `defer free(p)` in the same block become one allocation, sliced up, and freed by the `defer` that runs last.

## Constant-Size Buffers on the Stack

A `make` with a constant size and a matching `defer delete` in the same block doesn't need the heap:

```odin
buf := make([]int, 64)              // before
defer delete(buf)

__buf_buf: [64]int; buf := __buf_buf[:]   // after: no allocation, no free
```

That's only safe if the slice can't outlive the procedure, so `buf` may only be indexed, measured with `len` and `cap`, looped over, and passed to procedures that don't keep it. Vidar follows calls into procedures with bodies, four calls deep, and knows which `core:fmt`, `core:slice`, `core:mem` and `core:math` procedures don't keep their arguments. Buffers go up to 4 KB in a procedure a goroutine can reach, and 64 KB elsewhere. `@(no_stack_buffer)` opts a procedure out.

## `#soa` Layout

A loop that reads two fields of a struct with ten still loads whole structs into the cache. A *structure of arrays*, Odin's `#soa`, stores each field in an array of its own, so the loop reads only what it uses. `-opt` makes that switch for a local array of a plain struct when some loop touches only some of its fields:

```vidar,opt
Body :: struct {
	x, y, z:    f32,
	vx, vy, vz: f32,
	mass:       f32,
	id:         int,
	name:       string,
}

main :: proc() {
	bodies := make([dynamic]Body, 0, 1000)
	defer delete(bodies)
	for i in 0..<1000 do append(&bodies, Body{x = f32(i), vx = 1, mass = 2, id = i})
	for &b in bodies do b.x += b.vx          // touches 2 of 9 fields
	total: f32
	for b in bodies do total += b.x
	fmt.println(total)
}
```

<span class="caption">Listing 15-2: A loop over two fields of a nine-field struct</span>

```output
500500
```

The struct must be plain (no `using`, tags, directives or parameters) with at least 3 fields or about 32 bytes. And every use of the array must mean the same on an `#soa` container: `a[i].f` reads and writes, whole-value copies of `a[i]`, `len`, `cap`, `for x in a`, `for &x in a` using only fields, and `append`, `clear`, `reserve`, `resize` and `delete`. Taking `&a[i]`, slicing, passing the array to a procedure, returning, reassigning or capturing it keeps the layout as it was.

## Struct Fields Reordered

A plain struct whose fields would pack tighter sorted by alignment, largest first, is written that way, as long as nothing can see its layout:

```odin
Record :: struct { flag: bool, id: i64, small: u8, value: f64 }   // 32 bytes as written
Record :: struct { id: i64, value: f64, flag: bool, small: u8 }   // 24 bytes after -opt
```

Positional literals of the type are rewritten with field names. Nothing may observe the layout: the type must never be measured (`size_of`, `offset_of`, `type_info_of`), cast, transmuted, used as a map key or converted to `any`, and no value holding it may reach code Vidar can't see, such as `core:` procedures. That keeps `fmt` and `encoding/json`, whose output follows the field order, on the order you wrote.
