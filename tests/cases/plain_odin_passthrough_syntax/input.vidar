package main

import "core:fmt"

// Plain Odin only: vidar must emit this file byte-for-byte.

Dir :: enum { North, East, South, West }
Dirs :: bit_set[Dir]

Meters :: distinct f64

Pair :: struct($T: typeid) { a, b: T }

Entity :: struct {
	using pos: [2]f32,
	name:      string,
}

Value :: union { int, string, Pair(int) }

Error :: enum { None, Bad }

half :: proc(x: int) -> (int, Error) {
	if x % 2 != 0 do return 0, .Bad
	return x / 2, .None
}

quarter :: proc(x: int) -> (r: int, err: Error) {
	h := half(x) or_return
	return half(h)
}

swap :: proc(p: ^Pair($T)) { p.a, p.b = p.b, p.a }

to_string :: proc{int_to_string, dir_to_string}
int_to_string :: proc(x: int) -> string { return fmt.tprint(x) }
dir_to_string :: proc(d: Dir) -> string { return fmt.tprint(d) }

describe :: proc(v: Value) -> string {
	switch x in v {
	case int:       return fmt.tprintf("int %d", x)
	case string:    return fmt.tprintf("string %q", x)
	case Pair(int): return fmt.tprintf("pair %d,%d", x.a, x.b)
	}
	return "nil"
}

main :: proc() {
	d := Dirs{.North, .South}
	d += {.East}
	fmt.println(.East in d, .West in d, card(d))

	#partial switch Dir.South {
	case .South: fmt.println("south")
	}

	m: Meters = 3.5
	fmt.println(m * 2)

	p := Pair(int){1, 2}
	swap(&p)
	fmt.println(p)

	e := Entity{pos = {1, 2}, name = "e"}
	e.x += 10
	fmt.println(e.pos, e.name)

	fmt.println(describe(42), describe("hi"), describe(Pair(int){3, 4}))
	q, err := quarter(12)
	fmt.println(q, err)
	_, err2 := quarter(6)
	fmt.println(err2)

	fmt.println(to_string(7), to_string(Dir.West))

	nums := [?]int{5, 3, 8}
	total := 0
	for n, i in nums {
		defer total += i
		if n < 4 do continue
		total += n
	}
	fmt.println("total:", total)

	when ODIN_OS == .Darwin || ODIN_OS == .Linux || ODIN_OS == .Windows {
		fmt.println("desktop")
	}
}
