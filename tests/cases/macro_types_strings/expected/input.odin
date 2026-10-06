package main

import "core:fmt"

Vec3 :: struct { x, y, z: f32 }

// one statement per field, built from a format string assembled at compile time
// field_count :: proc!(T: Type) -> int — comptime, input.vidar:8

// describe :: proc!(T: Type) -> string — comptime, input.vidar:10

// generate a zero-checking proc for any numeric type
// nonzero :: proc!(T: Type, name: Ident) -> Stmt — comptime, input.vidar:20

// strings and comparisons at compile time
// grade :: proc!(score: int) -> string — comptime, input.vidar:25

// repeat :: proc!(s: string, n: int) -> string — comptime, input.vidar:31

// a macro that calls another macro in its expansion
// banner :: proc!(title: string) -> Expr(string) — comptime, input.vidar:38

// nonzero!(f32, nonzero_f32) — input.vidar:43
nonzero_f32 :: proc(v: f32) -> bool {
	return v != 0
}
// nonzero!(int, nonzero_int) — input.vidar:44
nonzero_int :: proc(v: int) -> bool {
	return v != 0
}

main :: proc() {
	// describe!(Vec3) — input.vidar:47
	// field_count!(Vec3) — input.vidar:47
	fmt.println("Vec3(x, y, z)", 3)
	fmt.println(nonzero_f32(0), nonzero_int(3))
	// grade!(95) — input.vidar:49
	// grade!(85) — input.vidar:49
	// grade!(10) — input.vidar:49
	fmt.println("A", "B", "C")
	// banner!("vidar") — input.vidar:50
	if false { __macro_typecheck: string = fmt.tprintf("%s\n%s\n%s", "=====", "vidar", "====="); _ = __macro_typecheck }
	fmt.println(fmt.tprintf("%s\n%s\n%s", "=====", "vidar", "====="))
}
