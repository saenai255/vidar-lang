# Closures, Interfaces and `Pool`

## Closures Passed as Literals

A call through a closure value is an indirect call, which LLVM can't inline. When a closure literal is passed straight to a procedure, `-opt` does what Rust does with closures: it makes a copy of the procedure in which the closure's body is called directly.

```vidar,opt
for_each :: proc(xs: []int, f: closure(int)) {
	for x in xs do f(x)
}

main :: proc() {
	total, k := 0, 3
	for_each({1, 2, 3}, proc[&total, k](x: int) { total += x * k })
	fmt.println(total)
}
```

```output
18
```

The call becomes `for_each__closure0({1, 2, 3}, &total, k)`, a copy of `for_each` whose `f(x)` is a direct call to the closure's body, with the captures in an environment on the copy's stack. Nothing is allocated, and LLVM can inline the body.

It applies when the callee is a plain procedure with a body that only *calls* the parameter. If it stores, passes on, returns, compares or captures the closure, the call is left as it was. Each call gets its own copy, up to 4 per procedure. The copy is written in the caller's file, so a callee in another file or package qualifies when its body uses nothing private the caller can't see. Closure values held in variables aren't specialized.

## Interface Calls

A method call on an interface value already avoids the vtable when it can (see [What a Call Costs](ch05-02-interface-values.md#what-a-call-costs)). The editor's `-opt` hints show which it is: `direct` for a call on `^T`, `devirtualized` for a dispatcher call, `vtable` for an indirect one.

## Interface Arrays Held Inline

A local `[dynamic]I` whose elements all come from `new_clone(value)` is a list of pointers to separate heap allocations. `-opt` makes it hold the values themselves, as `union { T1, T2, ... }`:

| Before | After |
|---|---|
| `append(&xs, new_clone(Circle{1}))` | `append(&xs, Circle{1})` |
| `for s in xs` | `for &s in xs` |
| `grow(s, k)` | a switch that calls the implementation directly |

It applies when the interface has no bases, and the array is only appended such clones, looped over, indexed for method calls, measured, cleared and deleted. Not when an implementation is over 64 bytes, or a method uses its receiver other than through its fields, since it could keep a pointer that would dangle once the array grows.

## `Pool(I)`

`Pool(I)` holds values of every type implementing `I`, one dynamic array per type, instead of one array of interface values. `for s in pool` becomes one loop per type, in which `s` is a `^T`, so method calls are direct calls Odin can inline:

```vidar
Shape :: interface { area }
area :: proc(s: Shape) -> f64 ---

Rect :: struct { w, h: f64 }
Circle :: struct { r: f64 }

rect_area :: proc(r: ^Rect) -> f64 { return r.w * r.h }
circle_area :: proc(c: ^Circle) -> f64 { return 3 * c.r * c.r }

impl Shape for Rect { area = rect_area }
impl Shape for Circle { area = circle_area }

main :: proc() {
	shapes: Pool(Shape)
	defer delete(shapes)
	append(&shapes, Rect{2, 3}, Circle{2})   // copies each value into its type's array
	append(&shapes, Rect{1, 1})
	total := 0.0
	for s in shapes do total += area(s)      // a Rect loop, then a Circle loop
	fmt.println(len(shapes), total)
}
```

<span class="caption">Listing 15-6: A `Pool` of shapes</span>

```output
3 19
```

- Values of one type keep their order; types are visited in the order of their `impl` blocks.
- `append` takes values, not pointers, as a statement of its own. `len`, `clear` and `delete` work too.
- `break`, `continue` and labels act on the whole loop.
- Every implementation of `I` must be known, so `I` must not be extended by an interface in another package, and none of its impls can be for a parametric type.
- `for s, i in pool`, with an index, is an error: there's no single index across the arrays.

## Error Paths Are Cold

With `-opt`, every failure path of Vidar's [error handling](ch06-00-error-handling.md) is marked unlikely with `intrinsics.expect`, so LLVM lays out the success path first. Plain Odin `or_return` that is a whole statement is written out the same way, so its failure path is cold too.
