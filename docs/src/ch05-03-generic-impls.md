# Generic Impls, Proc Groups and Packages

The `impl` blocks so far bound one procedure per method for one named type. This section covers the other things an `impl` can do: implement an interface for every instance of a parametric type, bind proc groups and polymorphic procedures, and work across packages.

## Implementing an Interface for a Parametric Type

`Box :: struct($T: typeid) { value: T }` declares a family of types: `Box(int)`, `Box(string)`, and so on. One `impl` covers all of them when it names the type with its parameter, `Box($T)`, and binds procedures that take `^Box($T)`:

```vidar
Show :: interface { show }
show :: proc(s: Show) -> string ---

Box :: struct($T: typeid) { value: T }

box_show :: proc(b: ^Box($T)) -> string { return fmt.tprintf("Box(%v)", b.value) }

impl Show for Box($T) { show = box_show }

main :: proc() {
	a := Box(int){1}
	b := Box(string){"hi"}
	shows: [dynamic]Show
	defer delete(shows)
	append(&shows, &a, &b)
	for s in shows do fmt.println(show(s))
}
```

<span class="caption">Listing 5-4: One impl for every `Box(T)`</span>

```output
Box(1)
Box(hi)
```

Each instance that the program converts to the interface gets its own vtable, made by Odin, including instances that only generic code converts. Calls through a generic impl's values always go through the vtable, since the dispatcher can't name vtables that Odin makes per instance.

An impl can also cover just one instance, with procedures for that instance: `impl Show for Box(int) { show = int_box_show }`. A generic impl and an impl for one of its instances would overlap, so having both is an error.

## Binding a Proc Group

A method can be bound to a proc group. Vidar picks the member that takes `^T` first and has the method's number of parameters:

```vidar
Shape :: interface { area }
area :: proc(s: Shape) -> f64 ---

Square :: struct { side: f64 }
Circle :: struct { r: f64 }

square_area :: proc(s: ^Square) -> f64 { return s.side * s.side }
circle_area :: proc(c: ^Circle) -> f64 { return 3 * c.r * c.r }
areas :: proc{square_area, circle_area}

impl Shape for Square { area = areas }    // picks square_area
impl Shape for Circle { area = areas }    // picks circle_area

main :: proc() {
	sq := Square{2}
	c := Circle{1}
	shapes := []Shape{Shape(&sq), Shape(&c)}
	for s in shapes do fmt.println(area(s))
}
```

```output
4
3
```

A member that takes exactly `^T` wins over polymorphic ones. Two members that fit equally well, or none at all, are an error.

## Binding a Polymorphic Procedure

A procedure with a polymorphic receiver, such as `proc(x: ^$T)`, can be bound too; Vidar instantiates it for the impl's type:

```vidar
Labeled :: interface { label }
label :: proc(l: Labeled) -> string ---

Apple :: struct {}
Pear :: struct {}

type_label :: proc(x: ^$T) -> string { return fmt.tprintf("%v", typeid_of(T)) }

impl Labeled for Apple { label = type_label }
impl Labeled for Pear { label = type_label }

main :: proc() {
	a: Apple
	p: Pear
	fmt.println(label(&a), label(&p))
}
```

```output
Apple Pear
```

## Interfaces Across Packages

Calling another package's methods works like calling any of its procedures: `shapes.area(&c)`.

Implementing another package's interface has one restriction: the `impl` must be in the interface's package, or in a package in an import cycle with it, and so must the procedures it binds. Odin needs the method's proc group and all of its implementations in one package, and an import cycle is merged into one Odin package, so the cycle is enough. [Cyclic Imports](ch09-02-cyclic-imports.md) shows a game package whose `Entity` interface is implemented by a UI package that imports it back.

## Summary

- `impl I for Box($T)` covers every instance of a parametric type, with procedures taking `^Box($T)`.
- A method can be bound to a proc group or a polymorphic procedure; Vidar picks or instantiates the one for the type.
- An impl must live in the interface's package or its import cycle.
