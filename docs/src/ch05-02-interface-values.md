# Interface Values and Dispatch

An *interface value* is what lets one variable hold a `Circle` now and a `Rect` later. This section covers how values become interface values, and what calling a method on one costs.

## An Interface Value Holds a Pointer

An interface value is two pointers: one to the data, and one to the vtable of the data's type. In the generated Odin it's `struct { data: rawptr, __vtable: ^VTable }`. It doesn't copy the value it refers to, and it doesn't own it.

That's why you convert a *pointer* to an interface, not a value:

```vidar
Shape :: interface { area }
area :: proc(s: Shape) -> f64 ---

Square :: struct { side: f64 }
square_area :: proc(s: ^Square) -> f64 { return s.side * s.side }
impl Shape for Square { area = square_area }

main :: proc() {
	sq := Square{2}
	s: Shape = &sq      // s refers to sq
	sq.side = 5         // so it sees this change
	fmt.println(area(s))
}
```

<span class="caption">Listing 5-2: An interface value refers to the value, it doesn't copy it</span>

```output
25
```

Converting a plain value is an error, because there would be nothing for the interface to point at:

```vidar,compile_fail
Shape :: interface { area }
area :: proc(s: Shape) -> f64 ---

Square :: struct { side: f64 }
square_area :: proc(s: ^Square) -> f64 { return s.side * s.side }
impl Shape for Square { area = square_area }

main :: proc() {
	sq := Square{2}
	s: Shape = sq
	_ = s
}
```

```error
error: 'sq' is a value; 'Shape' needs a pointer: &sq, or new_clone(sq) for a heap copy you own
```

The message offers both fixes. `&sq` refers to the local, which is right while the interface value doesn't outlive it. `new_clone(sq)` makes a copy on the heap that lives until you free it, which is right for a value that has to outlive the current procedure, such as one you return. The language server offers both as quick fixes.

## Where Conversions Happen

You can always convert explicitly, with the interface's name: `Shape(&sq)`. That works from a pointer to an implementing type, or from another `Shape`.

Vidar also converts automatically wherever the expected type is known to be the interface:

- a declaration with a type: `s: Shape = &sq`;
- an assignment to an interface variable: `s = &c`;
- a call argument: `describe(&sq)`;
- a `return` from a procedure that returns the interface;
- a named field in a struct literal: `Scene{hero = &sq}`;
- `append` to a `[dynamic]Shape`.

```vidar
Shape :: interface { area }
area :: proc(s: Shape) -> f64 ---

Square :: struct { side: f64 }
square_area :: proc(s: ^Square) -> f64 { return s.side * s.side }
impl Shape for Square { area = square_area }

Scene :: struct { hero: Shape }

unit :: proc() -> Shape {
	return new_clone(Square{1})          // a heap copy, since it outlives unit
}

main :: proc() {
	a, b := Square{2}, Square{3}
	shapes: [dynamic]Shape
	defer delete(shapes)
	append(&shapes, &a, &b, unit())
	scene := Scene{hero = &b}

	total := 0.0
	for s in shapes do total += area(s)
	fmt.println(total, area(scene.hero))
}
```

<span class="caption">Listing 5-3: Automatic conversions in `append`, a `return` and a struct literal</span>

```output
14 9
```

(`unit` leaks its square, to keep the listing short; Chapter 7 shows how to give that kind of value an owner.)

## What a Call Costs

A call on an interface value has to find the right implementation at run time. Vidar's dispatcher does that without an indirect call when it can: it compares the value's vtable pointer with the vtable of each type that implements the interface, and calls the matching procedure directly. Since the targets are known, Odin and LLVM can inline them.

| You call with | What happens | Cost |
|---|---|---|
| `^T` | `T`'s procedure, called directly | a plain call |
| an interface value | the dispatcher compares the vtable pointer with each implementation's, then calls the match directly | a compare per candidate, then a call LLVM can inline |
| an interface value, in the cases below | the call goes through the vtable | an indirect call |

The dispatcher knows every implementation, because they all have to live in the interface's package or its import cycle (see [Generic Impls, Proc Groups and Packages](ch05-03-generic-impls.md)). It falls back to calling through the vtable only when there are more than 8 candidates, or for vtables it can't name: those of a generic impl, and those of a base interface reached from another package.

With [`-opt`](ch15-01-reading-opt.md), the editor shows how each call is made, as an inlay hint after it: `direct`, `devirtualized` or `vtable`. And [`Pool(I)`](ch15-06-closures-and-interfaces.md) stores implementations by type, so a loop over them makes only direct calls.

## Interface Values Don't Own Anything

Because an interface value is a pointer, it never frees what it points to. Values you put behind an interface with `new_clone` are yours to free. If the implementing types have [destructors](ch07-00-destructors.md), destroy them through their owners, not through the interface.

## Summary

- An interface value is a pointer to the data plus a pointer to its type's vtable.
- Convert from a pointer: `&x` for a value that outlives the interface value, `new_clone(x)` for a heap copy.
- Conversions are automatic wherever the interface type is expected.
- A call on an interface value compares vtable pointers and calls the match directly; only unknown vtables or more than 8 candidates use an indirect call.
