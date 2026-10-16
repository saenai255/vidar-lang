# Closures

Odin has procedure values: you can store a procedure in a variable, pass it to another procedure, and call it later. What a procedure value can't do is remember anything. A procedure literal written inside `main` can't see `main`'s local variables, so any data it needs has to be passed in on every call, or stored in a global.

A *closure* is a procedure value that carries data with it. In Vidar, you write one by putting a *capture list* after `proc`:

```vidar
main :: proc() {
	step := 10
	add := proc[step](x: int) -> int { return x + step }
	fmt.println(add(1), add(5))
}
```

```output
11 15
```

`add` captured `step`, so its body can use it whenever `add` is called. Closures are what make procedures like `count_if` in [Chapter 3](ch03-00-first-program.md) useful: the caller decides what to count, and passes along whatever data that decision needs.

Vidar's closures are plain values. A closure is a small struct: the procedure, plus a fixed-size buffer that holds a copy of its captures. Creating, copying, storing or returning a closure never allocates, and there is no garbage collector to clean up after it. That design brings a few rules, which this chapter explains:

- [Capturing Values](ch04-01-capturing-values.md): capture lists, and what a by-value capture can and can't do.
- [Capturing by Pointer](ch04-02-capturing-by-pointer.md): changing the caller's variables, and keeping state between calls.
- [Closure Types](ch04-03-closure-types.md): `closure(...)` types, storing and passing closures, and how big they are.
- [How Long a Closure Can Live](ch04-04-closure-lifetimes.md): the mistakes the compiler catches when a closure outlives what it points to.
