# Interfaces

```odin
Shape :: interface { area, scale }          // the interface lists its methods

area  :: proc(s: Shape) -> f64 ---          // each method: no body, the interface first
scale :: proc(s: Shape, k: f64) ---

Circle :: struct { r: f64 }

circle_area  :: proc(c: ^Circle) -> f64  { return math.PI * c.r * c.r }
circle_scale :: proc(c: ^Circle, k: f64) { c.r *= k }

impl Shape for Circle { area = circle_area, scale = circle_scale }

main :: proc() {
	c := Circle{1}
	fmt.println(area(&c))     // static: calls circle_area, no vtable
	s: Shape = &c             // implicit conversion from a pointer: s refers to c
	scale(s, 2)               // dynamic: through the vtable
	shapes: [dynamic]Shape
	append(&shapes, &c, new_clone(Circle{5}))
	fmt.println(area(s), area(Shape(&c)))
}
```

There is one way to declare, implement, convert to and call an interface, and every name in it is a top-level declaration you wrote.

- **Methods are top-level procs without a body.** `area :: proc(s: Shape) -> f64 ---` declares the method `area`. Its first parameter is the interface. The interface lists its methods by name, `Shape :: interface { area, scale }`, in vtable order. vidar checks both directions: every listed name must be such a proc in the interface's package, and every bodiless proc that takes an interface first must be listed by it. Outside `foreign` blocks, `---` procs are only for interface methods.
- **Implementations are ordinary procs.** `impl I for T { m = t_m, ... }` binds each method to a proc declared with a body that takes `^T` first, followed by the method's other parameters. vidar checks for missing, extra or duplicate bindings, the receiver type and the parameter counts. Odin checks the parameter and result types. The implementing procs stay callable by their own names.
- **Generic impls.** `impl Shape for Box($T) { area = box_area, ... }` implements the interface for every instance of a parametric struct or union, with procs that take `^Box($T)` (or a more general pattern, such as `^$T`). Each instance the program converts gets its own vtable: the conversion is a polymorphic proc holding the vtable in a `@(static)` local, so Odin makes one per instance, generic code (`proc(xs: []$T)`) included. `impl Shape for Pair(int, f64)` implements one instance, with procs for that instance. An impl for an instance that a generic impl already covers (`Box(int)` next to `Box($T)`) is an error.
- **Proc groups and polymorphic procs as bound methods.** `area = areas`, with `areas :: proc{circle_area, square_area}`, binds the member that takes `^T` first and has the method's parameter count: an exact `^T` wins over polymorphic members, and two members that fit equally are an ambiguity error, as is a group with no member that fits. A polymorphic proc (`label = type_label`, `type_label :: proc(x: ^$T) -> string`) is instantiated for the impl's type. When its receiver is more general than `^T`, the method's proc group gets `__Shape_label_Square :: proc(^Square, ...)`, which calls it, so static calls on other pointer types still fail to compile.
- **Calls are proc calls.** Each method becomes an Odin proc group: `area :: proc{__Shape_area, circle_area, rect_area, ...}`. Called with `^T`, Odin picks `T`'s proc, a static call with no vtable. Called with an interface value, it picks the dispatcher. Since every impl lives in the interface's package (or its cycle), the dispatcher knows them all: it compares the value's vtable pointer with each impl's and calls the bound proc directly, which Odin can inline. Only vtables it can't name (a base interface reached from another package, or a generic impl's) or more than 8 candidates fall back to the indirect call. So a call reads the same whether it is static or dynamic, and generic code (`$T`) can call methods on any implementer. `x->m()` on an interface value is an error.
- **Interface values hold a pointer.** The value is `struct { data: rawptr, __vtable: ^VTable }`. `Shape(x)` converts explicitly from `^T` (or another `Shape`). Conversions are also inserted automatically where the expected type is known to be an interface: typed declarations, assignments, call arguments, `return`, named struct-literal fields, and `append` to a `[dynamic]Interface`. Converting a plain value is an error. Write `&x`, or `new_clone(x)` for a heap copy you own.
- **Packages.** Callers in other packages qualify methods like any other proc: `shapes.area(&c)`. An impl can implement another package's interface (`impl game.Entity for Button`) only when it's in the interface's package or in an import cycle with it, and the bound procs must be declared in that package or cycle. That is because Odin needs the proc groups and all impls in one package.
- **Extending.** `Item :: interface { using Named, using Sized, describe }` extends any number of interfaces, from this package or an imported one. An `Item` value converts implicitly to `Named` or `Sized` (no allocation; the child vtable embeds its bases' vtables), and inherited methods work on it: `name(item)`. `impl Item for T` binds the inherited methods too, and also implements every base declared in the same package (or import cycle), so `&t` converts to those as well. Diamonds are fine; two different methods with the same name are an error.
- **Cleanup** is not built in. Declare it like any interface: `Destroy :: interface { destroy }` with `destroy :: proc(d: Destroy) ---`, then call `destroy(&x)` or `for d in trash do destroy(d)`.
