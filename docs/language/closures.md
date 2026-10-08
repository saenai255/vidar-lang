# Closures

A proc literal with a capture list is a closure. `[x]` copies `x` into the closure; `[&x]` captures it by reference: the closure holds `&x` and nothing is moved, so keeping `x` alive while the closure runs is up to you. The compiler catches the common mistake: a closure holding `&x` of a local or parameter that is returned (directly, through a local or named result, or in a struct literal), stored through a pointer, a slice or in a global, or appended to something the proc doesn't own, is an error that suggests `new_clone(x)`. Calls are followed too: passing it to `sched.go`, or to a parameter its proc lets escape by these same rules (in any package, through any chain of calls), is an error naming the call and the line in the callee where it escapes. A proc that returns a parameter hands the closure back, so `id(f)()` is fine and `return id(f)` is not. `main`'s locals live until the program exits, so a goroutine started from `main` may hold `&x` of them. A closure is a plain value: its captures are stored inside it, so copying, returning or appending a closure copies them, and nothing is ever allocated. For state that changes, or that outlives the frame, capture a pointer: `count := new_clone(0)` with `proc[count]`. `proc[]` is a closure with no captures. A plain `proc(...)` with no brackets is an ordinary Odin proc.

```odin
make_counter :: proc(start: int) -> closure() -> int {
	count := new_clone(start)
	return proc[count]() -> int { count^ += 1; return count^ }
}

main :: proc() {
	step := 10
	add := proc[step](x: int) -> int { return x + step }
	c := make_counter(0)
	c(); c()
	fmt.println(add(1), c())   // 11 3
}
```

- Closure types are written `closure(params) -> results`. They work anywhere a type does: struct fields, `[dynamic]closure(int) -> int`, parameters, return types, aliases.
- Closures are called like procs: `f(x)`, `s.handler(x)`, `make_adder(1)(2)`.
- A closure can capture another closure's captures (nested closures).
- By-value captures are read-only: each call gets a fresh copy, so assigning to one is a compile error. Capture `&x` or a pointer to change state.
- Captures must fit in the closure: 128 bytes by default, set with `-define:VIDAR_CLOSURE_ENV=<bytes>`. A closure that doesn't fit is a compile error naming it. A closure can't capture another closure by value (it would need more room than it has); capture `&f`, or `new_clone(f)` if it outlives the frame.
- Using an outer local without capturing it is a compile error that suggests the fix.
- A closure body can use the enclosing proc's constants and types, and its polymorphic parameters (`$T`, `$N`), without capturing them: they aren't values.

**How it lowers:** a closure value is `Closure(proc(Env, A...) -> R)`, a struct holding the proc and `env: Env`, a fixed `[N]u64` buffer the captures are copied into (136 bytes in all by default). The proc gets the buffer and reads its captures from it. A closure parameter that is called reads its proc into a local on entry (`__f_call := f.call`), so once the callee is inlined into the proc that built the closure, LLVM sees the target and the call becomes direct. The struct is declared once, in a generated `vidar_runtime` package, so closures can be passed between packages. Each closure literal becomes a call to a generated parapoly constructor, `__closure_N(captures...)`, so Odin infers the capture types itself. The constructor, with the body in it, is written at file scope. Local constants and types the body uses go with it: `Vec :: struct {...}` becomes `Vec :: __Local_0` in place, with `__Local_0 :: struct {...}` at file scope, so both name the same type. When the body uses something that only exists inside the proc (`$T`, a type built from it, `#procedure`), the constructor is declared inside the proc instead, just before the statement holding the closure.
