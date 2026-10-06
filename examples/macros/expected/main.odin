package main; import __vidar "vidar_runtime"

import "core:fmt"

// Comptime procs run inside the transpiler and are invoked with `name!(...)`.
// Expr(T) parameters must be expressions of type T at the call site.
// square :: proc!(x: Expr(i32)) -> Expr(i32) — comptime, main.vidar:7

// Plain parameter types take compile-time constants; the result folds to a literal.
// fib :: proc!(n: int) -> int — comptime, main.vidar:12

// A statement macro. `tmp` is hygienic: it can't collide with the caller's names.
// swap :: proc!(a, b: Expr) -> Stmt — comptime, main.vidar:17

// A trailing Stmt parameter can be passed as a block after the call.
// Parameters can have defaults: code for Expr/Stmt/Type, constants otherwise.
// repeat :: proc!(n: int = 2, body: Stmt) -> Stmt — comptime, main.vidar:27

// stringify gives the source text of a code argument.
// expect :: proc!(cond: Expr(bool)) -> Stmt — comptime, main.vidar:34

// Type parameters and reflection: a printer for any struct.
// show :: proc!(T: Type, value: Expr) -> Expr(string) — comptime, main.vidar:42

// type_of_expr gives the type of an argument, so the caller doesn't have to spell it.
// zero_like :: proc!(x: Expr) -> Expr — comptime, main.vidar:54

// Ident parameters splice unhygienically, so a macro can declare names on purpose.
// define_twice :: proc!(name: Ident, value: int) -> Stmt — comptime, main.vidar:60

// Macros can generate closures, and reject bad input with compile_error.
// make_scaler :: proc!(T: Type, k: Expr) -> Expr — comptime, main.vidar:65

Point :: struct { x, y: i32 }

main :: proc() {
	k: i32 = 7
	// square!(k + 1) — main.vidar:74
	fmt.println("square:", (k + 1) * (k + 1))
	// fib!(20) — main.vidar:75
	fmt.println("fib(20):", 6765)

	tmp, other := 1, 2
	// swap!(tmp, other) — main.vidar:78
	tmp__1 := tmp
	tmp = other
	other = tmp__1
	fmt.println("swapped:", tmp, other)

	total := 0
	// repeat!(4) { total += 10 } — main.vidar:82
	{
		total += 10
	}
	{
		total += 10
	}
	{
		total += 10
	}
	{
		total += 10
	}
	// repeat! { total += 1 } — main.vidar:83
	{
		total += 1
	}
	{
		total += 1
	}
	fmt.println("repeated:", total)

	// expect!(total == 42) — main.vidar:86
	if !(total == 42) {
		fmt.println("expectation failed: total == 42")
	}
	// expect!(total < 0) — main.vidar:87
	if !(total < 0) {
		fmt.println("expectation failed: total < 0")
	}

	p := Point{3, -4}
	// show!(Point, p) — main.vidar:90
	if false { __macro_typecheck: string = fmt.tprintf("Point{{x = %v, y = %v}}", p.x, p.y); _ = __macro_typecheck }
	fmt.println(fmt.tprintf("Point{{x = %v, y = %v}}", p.x, p.y))
	// zero_like!(p) — main.vidar:91
	fmt.println("zero_like:", Point{})

	// define_twice!(answer, 21) — main.vidar:93
	answer := 21 * 2
	fmt.println("answer:", answer)

	// make_scaler!(f64, 3) — main.vidar:96
	triple := __vidar.Closure(proc(rawptr, f64) -> f64){call = proc(__env_raw: rawptr, x: f64) -> f64 {
		return x * 3
	}, env = nil}
	fmt.println("scaled:", triple.call(triple.env, 1.5))
}
