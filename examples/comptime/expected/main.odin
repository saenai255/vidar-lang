package main

import "core:fmt"

// `comptime expr` evaluates expr inside the transpiler and replaces it with the result.
// It can call comptime procs and regular procs, without `!`, and use macros.
// If expr cannot be evaluated at compile time, transpilation fails.

VERSION :: 3
TABLE_SIZE :: 16





// A regular proc: callable at run time, and foldable when its arguments are constants.
square :: proc(x: int) -> int {
	return x * x
}

// Lookup tables are built once, in the transpiler; the output holds only the literal.






















// Structs fold to compound literals.
Config :: struct {
	name:    string,
	workers: int,
	verbose: bool,
}





// A static assertion: folds to `true`, or stops compilation with a message.





// Strings: build banners, keys, tables of names...







// A macro whose code result is evaluated when it is folded.




main :: proc() {
	// Numbers
	f := 75025
	area := 257
	mask := 1023

	// Strings
	version := "v3.13"
	title := "======= comptime ======="

	// Arrays and structs: the target needs a known type
	squares: [TABLE_SIZE]int = { 0, 1, 4, 9, 16, 25, 36, 49, 64, 81, 100, 121, 144, 169, 196, 225 }
	primes: [8]int = { 2, 3, 5, 7, 11, 13, 17, 19 }
	cfg: Config = { name = "pool-8", workers = 8, verbose = true }

	// Assertions checked while transpiling
	_ = true

	// comptime do! { ... }: an inline compile-time block, no helper proc needed.
	// It folds to the value it returns; macros used inside it are folded too.
	month_starts: [12]int = { 0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334 }









	hex_digits := "0123456789abcdef"




	sum_of_cubes := 18496




	grade := "B"








	// Anything that depends on run-time values is a compile error, e.g.
	//     n := len(os.args)
	//     x := comptime square(n)    // error: 'n' is a runtime value ...

	fmt.println(title)
	fmt.println(f, area, mask, version)
	fmt.println(squares[TABLE_SIZE - 1], primes)
	fmt.println(cfg)
	fmt.println(month_starts, hex_digits, sum_of_cubes, grade)
}
