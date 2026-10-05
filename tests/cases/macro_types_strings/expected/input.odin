package main

import "core:fmt"

Vec3 :: struct { x, y, z: f32 }

// one statement per field, built from a format string assembled at compile time











// generate a zero-checking proc for any numeric type




// strings and comparisons at compile time












// a macro that calls another macro in its expansion





nonzero_f32 :: proc(v: f32) -> bool { return v != 0 }
nonzero_int :: proc(v: int) -> bool { return v != 0 }

main :: proc() {
	fmt.println("Vec3(x, y, z)", 3)
	fmt.println(nonzero_f32(0), nonzero_int(3))
	fmt.println("A", "B", "C")
	if false { __macro_typecheck: string = (fmt.tprintf("%s\n%s\n%s", "=====", "vidar", "=====")); _ = __macro_typecheck }; fmt.println(fmt.tprintf("%s\n%s\n%s", "=====", "vidar", "====="))
}
