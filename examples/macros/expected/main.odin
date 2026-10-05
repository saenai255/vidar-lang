package main; import __vidar "vidar_runtime"

import "core:fmt"

// Comptime procs run inside the transpiler and are invoked with `name!(...)`.
// Expr(T) parameters must be expressions of type T at the call site.




// Plain parameter types take compile-time constants; the result folds to a literal.




// A statement macro. `tmp` is hygienic: it can't collide with the caller's names.








// A trailing Stmt parameter can be passed as a block after the call.
// Parameters can have defaults: code for Expr/Stmt/Type, constants otherwise.






// stringify gives the source text of a code argument.







// Type parameters and reflection: a printer for any struct.











// type_of_expr gives the type of an argument, so the caller doesn't have to spell it.





// Ident parameters splice unhygienically, so a macro can declare names on purpose.




// Macros can generate closures, and reject bad input with compile_error.





Point :: struct { x, y: i32 }

main :: proc() {
	k: i32 = 7
	fmt.println("square:", ((k + 1) * (k + 1)))
	fmt.println("fib(20):", 6765)

	tmp, other := 1, 2
	tmp__1 := tmp; tmp = other; other = tmp__1
	fmt.println("swapped:", tmp, other)

	total := 0
	{ total += 10 }; { total += 10 }; { total += 10 }; { total += 10 }
	{ total += 1 }; { total += 1 }
	fmt.println("repeated:", total)

	if !(total == 42) { fmt.println("expectation failed: total == 42") }
	if !(total < 0) { fmt.println("expectation failed: total < 0") }

	p := Point{3, -4}
	if false { __macro_typecheck: string = (fmt.tprintf("Point{{x = %v, y = %v}}", p.x, p.y)); _ = __macro_typecheck }; fmt.println(fmt.tprintf("Point{{x = %v, y = %v}}", p.x, p.y))
	fmt.println("zero_like:", Point { })

	answer := 21 * 2
	fmt.println("answer:", answer)

	triple := (__vidar.Closure(proc(rawptr, f64) -> f64){call = proc(__env_raw: rawptr, x: f64) -> f64 { return x * 3 }, env = nil})
	fmt.println("scaled:", triple.call(triple.env, 1.5))
}
