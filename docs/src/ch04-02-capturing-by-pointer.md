# Capturing by Pointer

A by-value capture is a snapshot. When a closure needs to change something, or to see changes made after it was created, it captures a pointer instead.

## `[&x]`: Capturing a Pointer to a Local

`proc[&x]` stores the address of `x` in the closure. The body still writes plain `x`, and every use goes through the pointer, so reads see the current value and writes change the variable itself:

```vidar
main :: proc() {
	hits := 0
	hit := proc[&hits]() { hits += 1 }
	hit()
	hit()
	hit()
	fmt.println(hits)
}
```

<span class="caption">Listing 4-5: A closure that changes the caller's variable</span>

```output
3
```

Odin has no references, so `[&x]` is a pointer capture underneath: the closure holds `&x`, and nothing is moved or copied. Vidar's messages and the editor call it "capture by reference".

The capture list mixes both kinds freely. Here `add` reads `scale` by value and adds into `total` through a pointer:

```vidar
main :: proc() {
	total := 0
	scale := 10
	add := proc[&total, scale](n: int) { total += n * scale }
	add(2)
	add(3)
	fmt.println(total)
}
```

```output
50
```

## The Pointer Must Stay Valid

A pointer to a local is only valid while the local exists. A closure that captured `&hits` must not be called after the procedure that owns `hits` has returned. The compiler catches the common ways to get this wrong, such as returning such a closure; [How Long a Closure Can Live](ch04-04-closure-lifetimes.md) covers what it checks.

## State That Outlives the Frame

So how does a closure keep state between calls after its creator returns? The state has to live somewhere that outlives the creator's frame: on the heap. Allocate it yourself, and capture the pointer *by value*:

```vidar
make_counter :: proc(start: int) -> closure() -> int {
	count := new_clone(start)      // a ^int on the heap
	return proc[count]() -> int {
		count^ += 1
		return count^
	}
}

main :: proc() {
	c := make_counter(10)
	c()
	c()
	fmt.println(c())
}
```

<span class="caption">Listing 4-6: A counter whose state lives on the heap</span>

```output
13
```

`count` is a `^int`, and the closure holds a copy of that pointer. The copy is read-only like any by-value capture, but what it points to isn't, so `count^ += 1` changes the shared integer. Freeing it is your job, as with anything you allocate in Odin; [Shared Values with `vidar:rc`](ch07-05-rc.md) shows a way to have it freed automatically.

Several closures can share the same state by capturing the same pointer:

```vidar
Counter :: struct {
	inc: closure() -> int,
	get: closure() -> int,
}

make_counter :: proc(start: int) -> Counter {
	count := new_clone(start)
	return Counter{
		inc = proc[count]() -> int { count^ += 1; return count^ },
		get = proc[count]() -> int { return count^ },
	}
}

main :: proc() {
	c := make_counter(0)
	c.inc()
	c.inc()
	fmt.println(c.get())
}
```

<span class="caption">Listing 4-7: Two closures sharing one counter</span>

```output
2
```

## Capturing Another Closure

A closure can't capture another closure by value: a closure is as big as the room it has for captures, so a copy of one would never fit inside another. Capture a pointer to it instead: `&f` while `f` is a local that outlives the new closure, or a heap copy from `new_clone(f)` otherwise.

```vidar
compose :: proc(f, g: closure(int) -> int) -> closure(int) -> int {
	fp, gp := new_clone(f), new_clone(g)
	return proc[fp, gp](x: int) -> int { return gp^(fp^(x)) }
}

main :: proc() {
	double := proc[](x: int) -> int { return x * 2 }
	inc := proc[](x: int) -> int { return x + 1 }
	fmt.println(compose(double, inc)(5))
}
```

<span class="caption">Listing 4-8: Composing two closures through pointers to them</span>

```output
11
```

Capturing `f` directly is an error that says the same:

```vidar,compile_fail
twice :: proc(f: closure(int) -> int) -> closure(int) -> int {
	return proc[f](x: int) -> int { return f(f(x)) }
}
```

```error
error: 'f' is a closure, and a closure can't hold a copy of another one
```

## Summary

- `proc[&x]` captures a pointer to `x`: the closure reads and writes the variable itself.
- The pointer is only valid while `x` exists.
- State that must outlive the frame goes on the heap: capture a pointer from `new_clone(...)` by value.
- A closure captures another closure through a pointer.
