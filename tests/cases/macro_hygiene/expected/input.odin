package main

import "core:fmt"



















main :: proc() {
	// user variables named like the macro's internals are untouched
	tmp, i := 5, 2
	tmp__1 := tmp; tmp = i; i = tmp__1
	fmt.println(tmp, i)

	count := 0
	for i__2 in 0..<3 { { count += i } }
	fmt.println("count:", count)

	greeting := "hi"
	fmt.println(greeting)
}
