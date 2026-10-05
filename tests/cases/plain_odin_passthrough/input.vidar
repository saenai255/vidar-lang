package main

import "core:fmt"

/*
	Plain Odin: vidar must emit this file byte-for-byte.
*/

Shape :: union { Circle, Rect }
Circle :: struct { r: f32 }
Rect :: struct { w, h: f32 }

area :: proc(s: Shape) -> f32 {
	switch v in s {
	case Circle: return 3.14159 * v.r * v.r
	case Rect:   return v.w * v.h
	}
	return 0
}

@(private="file")
sum :: proc(xs: ..f32) -> (total: f32) {
	for x in xs do total += x
	return
}

main :: proc() {
	shapes := [?]Shape{Circle{1}, Rect{2, 3}}
	areas: [dynamic]f32
	defer delete(areas)
	for s in shapes {
		append(&areas, area(s))
	}
	fmt.printf("%.2f\n", sum(..areas[:]))
	when ODIN_OS == .Darwin || ODIN_OS == .Linux {
		fmt.println("unix-ish") // trailing comment
	}
}
