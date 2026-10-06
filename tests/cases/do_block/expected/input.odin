package main

import "core:fmt"

Point :: struct { x, y: f32 }

classify :: proc(n: int) -> string {
	__do1_result: string; __do1: {
		if n < 2 { __do1_result = "small"; break __do1 };
		for d in 2..<n {
			if n % d == 0 { __do1_result = "composite"; break __do1 };
		}
		{ __do1_result = "prime"; break __do1 };
	}; return __do1_result
}

main :: proc() {
	xs := []int{3, 1, 4, 1, 5}
	__do2_result: int; __do2: {
		sum := 0
		for x in xs do sum += x
		{ __do2_result = sum; break __do2 };
	}; total := __do2_result * 2
	__do3_result: Point; __do3: {
		q := Point{1, 2}
		q.x += 10
		{ __do3_result = q; break __do3 };
	}; p := __do3_result
	__do4_result: f32; __do4: { { __do4_result = 3; break __do4 }; }; half := __do4_result
	__do5_result: f64; __do5: {
		if len(xs) == 0 { __do5_result = 0; break __do5 };
		{ __do5_result = f64(total) / 4; break __do5 };
	}; avg := __do5_result
	__do6_result: int; __do6: {
		__do7_result: int; __do7: { { __do7_result = 20; break __do7 }; }; inner := __do7_result
		{ __do6_result = inner + (1 if (inner == 20) else 0); break __do6 };
	}; nested := __do6_result
	fn := proc() -> int { return 7 }
	__do8_result: int; __do8: {
		f := proc() -> int { return 100 }
		{ __do8_result = f() + fn(); break __do8 };
	}; callback := __do8_result
	fmt.println(total, p, half / 2, avg, nested, callback)
	fmt.println(classify(1), classify(9), classify(7))
}
