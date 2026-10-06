package main

import "core:fmt"
import "core:strconv"

Point :: struct { x, y: f32 }

classify :: proc(n: int) -> string {
	// do! { ... } — input.vidar:9
	__do1_result: string
	__do1: {
		if n < 2 {
			__do1_result = "small"
			break __do1
		}
		for d in 2..<n {
			if n % d == 0 {
				__do1_result = "composite"
				break __do1
			}
		}
		__do1_result = "prime"
		break __do1
	}
	return __do1_result
}

// `return` inside do! leaves the procedure, like `or_return` does
parse_double :: proc(s: string) -> (int, bool) {
	// do!(int) { ... } — input.vidar:20
	__do2_result: int
	__do2: {
		n, ok := strconv.parse_int(s)
		if !ok do return 0, false
		__do2_result = n * 2
		break __do2
	}
	v := __do2_result
	return v, true
}

main :: proc() {
	xs := []int{3, 1, 4, 1, 5}
	// do! { ... } — input.vidar:30
	__do3_result: int
	__do3: {
		sum := 0
		for x in xs do sum += x
		__do3_result = sum
		break __do3
	}
	total := __do3_result * 2
	// do! { ... } — input.vidar:35
	__do4_result: Point
	__do4: {
		q := Point{1, 2}
		q.x += 10
		__do4_result = q
		break __do4
	}
	p := __do4_result
	// do!(f32) { take 3 } — input.vidar:40
	__do5_result: f32
	__do5: {
		__do5_result = 3
		break __do5
	}
	half := __do5_result
	// do! { ... } — input.vidar:41
	__do6_result: f64
	__do6: {
		if len(xs) == 0 {
			__do6_result = 0
			break __do6
		}
		__do6_result = f64(total) / 4
		break __do6
	}
	avg := __do6_result
	// do! { ... } — input.vidar:45
	__do7_result: int
	__do7: {
		// do! { take 20 } — input.vidar:46
		__do8_result: int
		__do8: {
			__do8_result = 20
			break __do8
		}
		inner := __do8_result
		__do7_result = inner + 1
		break __do7
	}
	nested := __do7_result
	fn := proc() -> int { return 7 }
	// do! { ... } — input.vidar:50
	__do9_result: int
	__do9: {
		f := proc() -> int {
			return 100
		}
		__do9_result = f() + fn()
		break __do9
	}
	callback := __do9_result
	// do! { ... } — input.vidar:54
	__do10_result: int
	__do10: {
		for x, i in xs {
			if x == 4 {
				__do10_result = i
				break __do10
			}
		}
		__do10_result = -1
		break __do10
	}
	first := __do10_result
	// do! { take 1 } — input.vidar:60
	// do! { take 2 } — input.vidar:60
	__do11_result: int
	__do11: {
		__do11_result = 1
		break __do11
	}
	__do12_result: int
	__do12: {
		__do12_result = 2
		break __do12
	}
	both := __do11_result + __do12_result
	fmt.println(total, p, half / 2, avg, nested, callback, first, both)
	fmt.println(classify(1), classify(9), classify(7))
	fmt.println(parse_double("21"), parse_double("x"))
}
