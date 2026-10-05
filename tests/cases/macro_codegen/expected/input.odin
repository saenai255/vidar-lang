package main; import __vidar "vidar_runtime"

import "core:fmt"

Color :: struct { r, g, b: u8 }

// constant folding at compile time






// generate one statement per field









// build an expression from a list






// generate a closure




main :: proc() {
	fmt.println(1024)
	c := Color{255, 128, 0}
	fmt.println("Color.r:", c.r); fmt.println("Color.g:", c.g); fmt.println("Color.b:", c.b)
	fmt.println(((((0 + 1) + 2) + 3) + 4))
	double := (__vidar.Closure(proc(rawptr, f32) -> f32){call = proc(__env_raw: rawptr, x: f32) -> f32 { return x * 2 }, env = nil})
	fmt.println(double.call(double.env, 1.25))
}
