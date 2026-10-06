package main

import "core:fmt"

// fib :: proc!(n: int) -> int — comptime, input.vidar:5

fib_iter :: proc(n: int) -> int {
	a, b := 0, 1
	for _ in 0..<n do a, b = b, a + b
	return a
}

square :: proc(x: int) -> int {
	return x * x
}

square32 :: proc(x: i32) -> i32 {
	return x * x
}

Point :: struct { x, y: int }

N :: 6

main :: proc() {
	// fib!(20) — input.vidar:29
	a := 6765
	// square!(N) — input.vidar:30
	b := 36 + 1
	// fmt.tprintf!("fib(%d) = %d", 10, fib!(10)) — input.vidar:31
	c := "fib(10) = 55"
	// first_primes!(5) — input.vidar:32
	primes: [5]int = {2, 3, 5, 7, 11}
	// make_point!(3) — input.vidar:33
	p: Point = {x = 3, y = 6}
	d := square(7)
	// comptime! { -N } — input.vidar:35
	neg := -6
	// comptime! { N > 3 && N < 10 } — input.vidar:36
	flags := true
	fmt.println(a, b, c, primes, p, d, neg, flags)

	// integers behave as they do at run time
	// comptime! { 1 << 40 } — input.vidar:40
	big := 1099511627776
	// fib_iter!(90) — input.vidar:41
	f90 := 2880067194370816120
	// square32!(100000) — input.vidar:42
	wrapped := i32(1410065408)
	// comptime! { u8(255) + 1 } — input.vidar:43
	byte_wrap := u8(0)
	fmt.println(big, f90, wrapped, wrapped == square32(100000), byte_wrap)
}

// first_primes :: proc!(n: int) -> [dynamic]int — comptime, input.vidar:47

// make_point :: proc!(v: int) -> Point — comptime, input.vidar:62
