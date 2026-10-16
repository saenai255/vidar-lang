# Defining and Implementing an Interface

An interface takes four pieces, and each is an ordinary top-level declaration. We'll build one for shapes that can report their area and their name, and be scaled.

## 1. Declare the Interface

```vidar,ignore
Shape :: interface { area, name, scale }
```

The interface lists its methods by name. The order is the order of its *vtable*, the table of procedures that an interface value points to.

## 2. Declare Each Method

A method is a top-level procedure **without a body** (`---`), whose first parameter is the interface:

```vidar,ignore
area  :: proc(s: Shape) -> f64 ---
name  :: proc(s: Shape) -> string ---
scale :: proc(s: Shape, k: f64) ---
```

The rest of the signature is the method's: `scale` takes a factor and returns nothing. Vidar checks both directions: every name the interface lists must be declared like this in the interface's package, and every bodiless procedure that takes the interface first must be listed by it. Outside `foreign` blocks, bodiless procedures are only for interface methods.

## 3. Write the Implementations

An implementation is an ordinary procedure with a body that takes a **pointer to the type** first, followed by the method's other parameters:

```vidar,ignore
Circle :: struct { r: f64 }
Rect   :: struct { w, h: f64 }

circle_area  :: proc(c: ^Circle) -> f64    { return math.PI * c.r * c.r }
circle_name  :: proc(c: ^Circle) -> string { return "circle" }
circle_scale :: proc(c: ^Circle, k: f64)   { c.r *= k }

rect_area  :: proc(r: ^Rect) -> f64    { return r.w * r.h }
rect_name  :: proc(r: ^Rect) -> string { return "rect" }
rect_scale :: proc(r: ^Rect, k: f64)   { r.w *= k; r.h *= k }
```

The receiver is a pointer so that a method like `scale` can change the value.

## 4. Bind Them with `impl`

`impl Shape for Circle { ... }` says that `Circle` implements `Shape`, and which procedure is each method:

```vidar,ignore
impl Shape for Circle { area = circle_area, name = circle_name, scale = circle_scale }

impl Shape for Rect {
	area  = rect_area,
	name  = rect_name,
	scale = rect_scale,
}
```

Vidar checks that every method is bound exactly once, that each procedure's first parameter is `^Circle` (or `^Rect`), and that it has the method's number of parameters. Odin then checks the parameter and result types when it compiles the result. `impl` blocks go at file scope.

## Using It

Here's the whole program, with a procedure that works on any `Shape`:

```vidar
Shape :: interface { area, name, scale }

area  :: proc(s: Shape) -> f64 ---
name  :: proc(s: Shape) -> string ---
scale :: proc(s: Shape, k: f64) ---

Circle :: struct { r: f64 }
Rect   :: struct { w, h: f64 }

circle_area  :: proc(c: ^Circle) -> f64    { return math.PI * c.r * c.r }
circle_name  :: proc(c: ^Circle) -> string { return "circle" }
circle_scale :: proc(c: ^Circle, k: f64)   { c.r *= k }

rect_area  :: proc(r: ^Rect) -> f64    { return r.w * r.h }
rect_name  :: proc(r: ^Rect) -> string { return "rect" }
rect_scale :: proc(r: ^Rect, k: f64)   { r.w *= k; r.h *= k }

impl Shape for Circle { area = circle_area, name = circle_name, scale = circle_scale }
impl Shape for Rect { area = rect_area, name = rect_name, scale = rect_scale }

describe :: proc(s: Shape) {
	fmt.printfln("%s with area %.2f", name(s), area(s))
}

main :: proc() {
	c := Circle{1}
	r := Rect{2, 3}

	describe(&c)
	describe(&r)

	scale(&r, 2)                 // a static call: rect_scale(&r, 2)
	fmt.println(area(&r))
	fmt.println(rect_area(&r))   // the implementation is still an ordinary proc
}
```

<span class="caption">Listing 5-1: The `Shape` interface, two implementations, and calls through it</span>

```output
circle with area 3.14
rect with area 6.00
24
24
```

Notice how the method is called: `area(s)`, `scale(&r, 2)`. A method is a procedure, so you call it like one, with the value first. Odin's `x->m()` syntax isn't used for interface methods.

What `area` means depends on what you pass it:

- **A pointer to the concrete type**, like `scale(&r, 2)`: Vidar calls `rect_scale` directly. There's no interface value and no vtable involved; it's exactly the call you'd write by hand.
- **An interface value**, like `area(s)` inside `describe`: the call is *dispatched* to the implementation of whatever type `s` holds.

Under the hood, each method becomes an Odin *proc group* of a dispatcher plus every procedure bound to it: `area :: proc{__Shape_area, circle_area, rect_area}`. Odin's overload resolution picks the right one from the argument's type. That's why a call reads the same whether it's static or dynamic, and why polymorphic code (`$T`) can call a method on any implementing type. It's also why method names are package-level names: two interfaces in one package can't both have a method called `write`.

## The Compiler Checks Your Work

Leave out a method, and the `impl` is an error that names it:

```vidar,compile_fail
Shape :: interface { area, name }
area :: proc(s: Shape) -> f64 ---
name :: proc(s: Shape) -> string ---

Square :: struct { side: f64 }
square_area :: proc(s: ^Square) -> f64 { return s.side * s.side }
impl Shape for Square { area = square_area }
```

```error
error: impl of 'Shape' for 'Square' is missing: name
```

Bind a procedure that takes the value instead of a pointer to it, and the message says what the first parameter should be:

```vidar,compile_fail
Shape :: interface { area }
area :: proc(s: Shape) -> f64 ---

Square :: struct { side: f64 }
square_area :: proc(s: Square) -> f64 { return s.side * s.side }
impl Shape for Square { area = square_area }
```

```error
error: the first parameter of 'square_area' must have type ^Square to implement 'area'
```

## Summary

- `I :: interface { m, ... }` lists the methods.
- `m :: proc(x: I, ...) -> R ---` declares each one, with the interface first and no body.
- `impl I for T { m = t_m, ... }` binds procedures that take `^T` first.
- Methods are called like procedures: statically with `^T`, dynamically with an interface value.
