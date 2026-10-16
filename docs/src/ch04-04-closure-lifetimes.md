# How Long a Closure Can Live

A by-value capture is a copy, so a closure that captures only values can live as long as you like: return it, store it in a global, keep it in an array. A closure that captured `&x` is different. It holds a pointer into the stack frame where `x` lives, and once that frame is gone, the pointer dangles.

Keeping `x` alive while the closure runs is your job, as with any pointer in Odin. But the compiler catches the most common mistake: **a closure that holds `&x` of a local or parameter must not outlive the procedure that owns `x`.**

## Returning a Closure That Holds `&x`

Here is the mistake in its simplest form, a counter that keeps its state in a local:

```vidar,compile_fail
package main

counter :: proc() -> closure() -> int {
	n := 0
	return proc[&n]() -> int { n += 1; return n }
}

main :: proc() {
	c := counter()
	_ = c
}
```

<span class="caption">Listing 4-10: Returning a closure that points at a local</span>

```error
error: this closure captures &n and is returned (line 5), but 'n' lives in this proc's frame and is gone once it returns. Capture a pointer from new_clone(n) instead
```

`n` lives in `counter`'s frame, which is gone once `counter` returns, so every call to `c` would write to memory that something else may be using. The fix is the one from Listing 4-6: put `n` on the heap with `new_clone`, and capture that pointer by value.

## What the Compiler Checks

A closure holding `&x` of a local or parameter is an error when it is:

- **returned**, directly, through a local or a named result, or inside a struct literal;
- **stored** through a pointer, in a slice, or in a global;
- **appended** to a dynamic array the procedure doesn't own;
- **passed** to `sched.go`, which runs it on a goroutine that can outlive the procedure, or to a parameter that the called procedure lets escape by these same rules.

The last rule follows the closure into calls, in any package and through any chain of calls: Vidar works out, for each procedure, which of its parameters can escape, and checks every call against that. The error names the call and the line in the called procedure where the closure escapes:

```vidar,compile_fail
package main

handlers: [dynamic]closure()

register :: proc(f: closure()) {
	append(&handlers, f)
}

setup :: proc() {
	clicks := 0
	register(proc[&clicks]() { clicks += 1 })
}

main :: proc() { setup() }
```

```error
error: this closure captures &clicks and is passed to register (line 11), where it is appended to a global (line 6), but 'clicks' lives in this proc's frame and is gone once it returns. Capture a pointer from new_clone(clicks) instead
```

The fixes are always the same: capture a pointer from `new_clone(x)`, which lives until you free it, or capture by value if the closure only reads.

A few details:

- A procedure that returns its parameter hands the closure back to the caller, so `id(f)()` is fine, but `return id(f)` is an error.
- `main`'s locals live until the program exits, so a goroutine started from `main` may hold `&x` of them.
- A by-value capture of a value with a destructor *borrows* that value (see [Chapter 7](ch07-02-ownership.md)), so the same rules apply to it as to `&x`.

## What It Doesn't Check

The check follows the code it can see. It *trusts* calls it can't follow: a call through a procedure value or another closure, an interface method, a `foreign` procedure, or a procedure from `core:`. And it checks against the *procedure*, not the block: a closure that holds `&x` of a variable declared inside a loop body can still be called after that iteration is over. [Appendix H](appendix-08-limits.md#closures) lists the gaps.

## Summary

- Only closures holding `&x` can dangle; by-value captures never do.
- Returning, storing or appending such a closure, or passing it to something that does, is a compile error that suggests `new_clone`.
- The check trusts calls it can't follow, and works per procedure, not per block.

Closures let a procedure carry data; the next chapter covers interfaces, which let one call reach different types.
