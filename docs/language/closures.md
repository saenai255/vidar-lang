# Closures

A proc literal with a capture list in square brackets is a closure.

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

## Capture lists

| Written | Meaning |
|---|---|
| `proc[x](...)` | copies `x` into the closure |
| `proc[&x](...)` | captures `x` by reference: the closure holds `&x` and nothing is moved |
| `proc[]()` | a closure with no captures |
| `proc(...)` | no brackets: an ordinary Odin proc |

**A closure is a plain value.** Its captures are stored inside it, so copying, returning or appending a closure copies them. Nothing is ever allocated.

**For state that changes, or that outlives the frame, capture a pointer:** `count := new_clone(0)` with `proc[count]`, as in `make_counter` above.

## Rules

- **Closure types** are written `closure(params) -> results`. They work anywhere a type does: struct fields, `[dynamic]closure(int) -> int`, parameters, return types, aliases.
- **Calling:** closures are called like procs: `f(x)`, `s.handler(x)`, `make_adder(1)(2)`.
- **Nesting:** a closure can capture another closure's captures.
- **By-value captures are read-only.** Each call gets a fresh copy, so assigning to one is a compile error. Capture `&x` or a pointer to change state.
- **Captures must fit.** A closure has 128 bytes for them by default; change it with `-define:VIDAR_CLOSURE_ENV=<bytes>`. A closure that doesn't fit is a compile error that names it. A closure can't capture another closure by value (it would need more room than it has): capture `&f`, or `new_clone(f)` if it outlives the frame.
- **Forgetting a capture is a compile error.** Using an outer local without capturing it fails, and the message suggests the fix.
- **No capture needed** for the enclosing proc's constants and types, or its polymorphic parameters (`$T`, `$N`): they aren't values.

## Lifetime: what the compiler checks

Keeping `x` alive while a `[&x]` closure runs is up to you. The compiler catches the common mistake: **a closure holding `&x` of a local or parameter must not outlive `x`.**

**It is an error when such a closure is:**

- returned: directly, through a local or named result, or in a struct literal;
- stored through a pointer, in a slice, or in a global;
- appended to something the proc doesn't own;
- passed to `sched.go`, or to a parameter its proc lets escape by these same rules, in any package and through any chain of calls.

The error suggests `new_clone(x)`. For calls it names the call and the line in the callee where the closure escapes.

**Details:**

- A proc that returns a parameter hands the closure back, so `id(f)()` is fine and `return id(f)` is not.
- `main`'s locals live until the program exits, so a goroutine started from `main` may hold `&x` of them.
- The check trusts what it can't see. See [Limits](../limits.md).

## How it lowers

A closure value is `Closure(proc(Env, A...) -> R)`: a struct holding the proc and `env: Env`, a fixed `[N]u64` buffer that the captures are copied into. By default that is 136 bytes in all. The proc receives the buffer and reads its captures from it.

- **Calls become direct once inlined.** A closure parameter that is called reads its proc into a local on entry (`__f_call := f.call`). Once the callee is inlined into the proc that built the closure, LLVM sees the target and the call becomes direct.
- **One shared type.** The struct is declared once, in a generated `vidar_runtime` package, so closures can be passed between packages.
- **Each closure literal is a constructor call.** It becomes `__closure_N(captures...)`, a generated parapoly constructor, so Odin infers the capture types itself. The constructor, with the body in it, is written at file scope.
- **Local constants and types travel with it.** `Vec :: struct {...}` becomes `Vec :: __Local_0` in place, with `__Local_0 :: struct {...}` at file scope, so both name the same type.
- **Exception:** when the body uses something that only exists inside the proc (`$T`, a type built from it, `#procedure`), the constructor is declared inside the proc instead, just before the statement holding the closure.

See also: [Goroutines](goroutines.md) (`sched.go` takes a closure), [`-opt` and closures](optimization.md#closures-passed-as-literals).
