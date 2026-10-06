package main

import "core:fmt"






square :: proc(x: int) -> int {
	return x * x
}

Point :: struct { x, y: int }

N :: 6

main :: proc() {
	a := 6765
	b := 37
	c := "fib(10) = 55"
	primes: [5]int = { 2, 3, 5, 7, 11 }
	p: Point = { x = 3, y = 6 }
	d := square(7)
	neg := (-6)
	flags := true
	fmt.println(a, b, c, primes, p, d, neg, flags)
}



















