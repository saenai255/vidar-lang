package main; import __vidar "vidar_runtime"

import "core:fmt"

Color :: struct { r, g, b: u8 }

// constant folding at compile time
// pow :: proc!(base, exp: int) -> int — comptime, input.vidar:8

// generate one statement per field
// print_fields :: proc!(T: Type, v: Expr) -> Stmt — comptime, input.vidar:15

// build an expression from a list
// sum_of :: proc!(n: int) -> Expr(int) — comptime, input.vidar:25

// generate a closure
// scaler :: proc!(T: Type, k: int) -> Expr — comptime, input.vidar:32

main :: proc() {
	// pow!(2, 10) — input.vidar:37
	fmt.println(1024)
	c := Color{255, 128, 0}
	// print_fields!(Color, c) — input.vidar:39
	fmt.println("Color.r:", c.r)
	fmt.println("Color.g:", c.g)
	fmt.println("Color.b:", c.b)
	// sum_of!(4) — input.vidar:40
	fmt.println((((0 + 1) + 2) + 3) + 4)
	// scaler!(f32, 2) — input.vidar:41
	double := __vidar.Closure(proc(rawptr, f32) -> f32){call = proc(__env_raw: rawptr, x: f32) -> f32 {
		return x * 2
	}, env = nil}
	fmt.println(double.call(double.env, 1.25))
}
