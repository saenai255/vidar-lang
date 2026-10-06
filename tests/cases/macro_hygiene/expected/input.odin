package main

import "core:fmt"

// swap :: proc!(a, b: Expr) -> Stmt — comptime, input.vidar:5

// times :: proc!(n: int, body: Stmt) -> Stmt — comptime, input.vidar:13

// declare :: proc!(name: Ident, value: Expr) -> Stmt — comptime, input.vidar:19

main :: proc() {
	// user variables named like the macro's internals are untouched
	tmp, i := 5, 2
	// swap!(tmp, i) — input.vidar:26
	tmp__1 := tmp
	tmp = i
	i = tmp__1
	fmt.println(tmp, i)

	count := 0
	// times!(3, { count += i }) — input.vidar:30
	for i__2 in 0..<3 {
		{
			count += i
		}
	}
	fmt.println("count:", count)

	// declare!(greeting, "hi") — input.vidar:33
	greeting := "hi"
	fmt.println(greeting)
}
