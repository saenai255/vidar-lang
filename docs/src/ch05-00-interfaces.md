# Interfaces

Sometimes one piece of code has to work with values of several types: a list of shapes of different kinds, a logger that writes to a file or to memory, a game entity that may be a player or a monster. Odin's tools for that are unions, which need every type listed in one place, and structs of procedure pointers, which you fill in and keep consistent by hand.

An *interface* is a list of operations that several types provide. Code written against the interface works with any of those types, including ones added later, in other files or packages.

```vidar
Shape :: interface { area }

area :: proc(s: Shape) -> f64 ---

Square :: struct { side: f64 }
square_area :: proc(s: ^Square) -> f64 { return s.side * s.side }
impl Shape for Square { area = square_area }

main :: proc() {
	sq := Square{3}
	s: Shape = &sq
	fmt.println(area(s))
}
```

```output
9
```

In Vidar, interfaces fit Odin's style: a method is an ordinary procedure, an implementation is an ordinary procedure, and calling a method looks like calling any procedure. When the compiler knows the concrete type at a call, the call is a direct call; only a call on an interface value is dispatched, and even that usually avoids an indirect call.

This chapter covers:

- [Defining and Implementing an Interface](ch05-01-defining-interfaces.md): the four pieces of an interface.
- [Interface Values and Dispatch](ch05-02-interface-values.md): converting to an interface, and what a call costs.
- [Generic Impls, Proc Groups and Packages](ch05-03-generic-impls.md): implementing an interface for every instance of a parametric type, and across packages.
- [Extending Interfaces](ch05-04-extending-interfaces.md): interfaces built from other interfaces.
