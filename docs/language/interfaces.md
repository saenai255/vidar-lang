# Interfaces

An interface is a list of method names. Types implement it with an `impl` block, and you call a method like any other proc: the call is static when you pass a pointer to the type, and dynamic when you pass an interface value.

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

## The four pieces

### 1. Declare the interface

`Shape :: interface { area, scale }` lists the methods by name, in vtable order.

### 2. Declare each method

A method is a **top-level proc without a body**, whose first parameter is the interface:

```odin
area :: proc(s: Shape) -> f64 ---
```

Vidar checks both directions:

- every name an interface lists must be such a proc in the interface's package;
- every bodiless proc that takes an interface first must be listed by it.

Outside `foreign` blocks, `---` procs are only for interface methods.

### 3. Implement it

`impl I for T { m = t_m, ... }` binds each method to an ordinary proc. The proc must have a body and take `^T` first, followed by the method's other parameters.

- Vidar checks for missing, extra or duplicate bindings, the receiver type, and the parameter counts.
- Odin checks the parameter and result types.
- The implementing procs stay callable by their own names.

### 4. Call it

Each method becomes an Odin proc group: `area :: proc{__Shape_area, circle_area, rect_area, ...}`.

| You pass | Odin picks | Cost |
|---|---|---|
| `^T` | `T`'s proc | a static call, no vtable |
| an interface value | the dispatcher | a compare of the vtable pointer with each impl's, then a direct call Odin can inline |

The dispatcher knows every impl because they all live in the interface's package (or its import cycle). It falls back to an indirect call only for vtables it can't name (a base interface reached from another package, or a generic impl's), or when there are more than 8 candidates.

So a call reads the same whether it is static or dynamic, and generic code (`$T`) can call methods on any implementer. `x->m()` on an interface value is an error.

## Interface values

An interface value holds a pointer: `struct { data: rawptr, __vtable: ^VTable }`.

- **Explicit conversion:** `Shape(x)` converts from `^T` (or from another `Shape`).
- **Automatic conversion** happens wherever the expected type is known to be an interface: typed declarations, assignments, call arguments, `return`, named struct-literal fields, and `append` to a `[dynamic]Interface`.
- **Converting a plain value is an error.** Write `&x`, or `new_clone(x)` for a heap copy you own.

**The common mistake**, converting a plain value:

```odin
c := Circle{1}
s: Shape = c
```

```
main.vidar:11:13: error: 'c' is a value; 'Shape' needs a pointer: &c, or new_clone(c) for a heap copy you own
```

## Generic impls

`impl Shape for Box($T) { area = box_area, ... }` implements the interface for every instance of a parametric struct or union, with procs that take `^Box($T)` (or a more general pattern, such as `^$T`).

- Each instance the program converts gets its own vtable. The conversion is a polymorphic proc holding the vtable in a `@(static)` local, so Odin makes one per instance, generic code (`proc(xs: []$T)`) included.
- `impl Shape for Pair(int, f64)` implements one instance, with procs for that instance.
- An impl for an instance that a generic impl already covers (`Box(int)` next to `Box($T)`) is an error.

## Proc groups and polymorphic procs as bound methods

**A proc group.** `area = areas`, with `areas :: proc{circle_area, square_area}`, binds the member that takes `^T` first and has the method's parameter count.

- An exact `^T` wins over polymorphic members.
- Two members that fit equally are an ambiguity error, and so is a group with no member that fits.

**A polymorphic proc.** `label = type_label`, with `type_label :: proc(x: ^$T) -> string`, is instantiated for the impl's type. When its receiver is more general than `^T`, the method's proc group gets `__Shape_label_Square :: proc(^Square, ...)`, which calls it, so static calls on other pointer types still fail to compile.

## Packages

- Callers in other packages qualify methods like any other proc: `shapes.area(&c)`.
- An impl can implement another package's interface (`impl game.Entity for Button`) only when it is in the interface's package or in an import cycle with it, and the bound procs must be declared in that package or cycle. Odin needs the proc groups and all impls in one package.

See [Cyclic imports](cyclic-imports.md).

## Extending interfaces

`Item :: interface { using Named, using Sized, describe }` extends any number of interfaces, from this package or an imported one.

- An `Item` value converts implicitly to `Named` or `Sized`. Nothing is allocated: the child vtable embeds its bases' vtables.
- Inherited methods work on it: `name(item)`.
- `impl Item for T` binds the inherited methods too, and also implements every base declared in the same package (or import cycle), so `&t` converts to those as well.
- Diamonds are fine. Two different methods with the same name are an error.

## Example: extending and generic impls

```odin
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

Box :: struct($T: typeid) { value: T }
Show :: interface { show }
show :: proc(s: Show) -> string ---
box_show :: proc(b: ^Box($T)) -> string { return fmt.tprintf("Box(%v)", b.value) }
impl Show for Box($T) { show = box_show }      // one impl for every Box(T)

main :: proc() {
	f := File{"a.txt", 12}
	item: Item = &f
	fmt.println(describe(item))                // a.txt (12 bytes)
	n: Named = item                            // an Item converts to a base without allocating
	fmt.println(name(n), name(item))           // a.txt a.txt

	b1 := Box(int){1}
	b2 := Box(string){"hi"}
	shows: [dynamic]Show
	append(&shows, &b1, &b2)
	for s in shows do fmt.println(show(s))     // Box(1), then Box(hi)
}
```

## Cleanup

Cleanup is not built in. Declare it like any other interface:

```odin
Destroy :: interface { destroy }
destroy :: proc(d: Destroy) ---
```

Then call `destroy(&x)`, or `for d in trash do destroy(d)`.

## Related

- [`Pool(I)`](optimization.md#pooli) stores implementations by type so method calls are direct.
- [Inline interface arrays](optimization.md#interface-arrays-held-inline) under `-opt`.
- Limits: [Limits](../limits.md).
