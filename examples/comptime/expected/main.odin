package main

import "core:fmt"

// `name!(args)` runs a proc inside the transpiler and replaces the call with its result.
// Procs declared as `name :: proc!` only exist at compile time; any other proc can be
// called with `!` too, when its arguments are constants. `comptime! { ... }` runs a
// whole block at compile time: every call in it behaves as if it had a `!`.
// If something needs a run-time value, transpilation fails.

VERSION :: 3
TABLE_SIZE :: 16

// fib :: proc!(n: int) -> int — comptime, main.vidar:14

// A regular proc: callable at run time, and at compile time with `square!(...)`.
square :: proc(x: int) -> int {
	return x * x
}

// Lookup tables are built once, in the transpiler; the output holds only the literal.
// squares_table :: proc!(n: int) -> [dynamic]int — comptime, main.vidar:24

// first_primes :: proc!(n: int) -> [dynamic]int — comptime, main.vidar:30

// Structs fold to compound literals.
Config :: struct {
	name:    string,
	workers: int,
	verbose: bool,
}

// default_config :: proc!(workers: int) -> Config — comptime, main.vidar:53

// A static assertion: folds to `true`, or stops compilation with a message.
// static_assert :: proc!(ok: bool, msg: string) -> bool — comptime, main.vidar:58

// Strings: build banners, keys, tables of names...
// banner :: proc!(title: string, width: int) -> string — comptime, main.vidar:64

// A macro: its code is expanded, and evaluated when it is used at compile time.
// cube :: proc!(x: Expr) -> Expr — comptime, main.vidar:72

main :: proc() {
	// Numbers
	// fib!(25) — main.vidar:78
	f := 75025
	// square!(TABLE_SIZE) — main.vidar:79
	area := 256 + 1
	// comptime! { (1 << 10) - 1 } — main.vidar:80
	mask := 1023

	// Strings
	// comptime! { fmt.tprintf("v%d.%d", VERSION, fib(7)) } — main.vidar:83
	version := "v3.13"
	// banner!("comptime", 24) — main.vidar:84
	title := "======= comptime ======="

	// Arrays and structs: the target needs a known type
	// squares_table!(TABLE_SIZE) — main.vidar:87
	squares: [TABLE_SIZE]int = {0, 1, 4, 9, 16, 25, 36, 49, 64, 81, 100, 121, 144, 169, 196, 225}
	// first_primes!(8) — main.vidar:88
	primes: [8]int = {2, 3, 5, 7, 11, 13, 17, 19}
	// default_config!(8) — main.vidar:89
	cfg: Config = {name = "pool-8", workers = 8, verbose = true}

	// Assertions checked while transpiling
	// static_assert!(...) — main.vidar:92

	// comptime! { ... }: an inline compile-time block, no helper proc needed.
	// It folds to the value it takes; macros used inside it are folded too.
	// comptime! { ... } — main.vidar:96
	month_starts: [12]int = {0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334}
	// comptime! { ... } — main.vidar:106
	hex_digits := "0123456789abcdef"
	// comptime! { ... } — main.vidar:111
	sum_of_cubes := i64(18496)

	// Integers wrap like they do at run time
	// comptime! { u8(200) + u8(100) } — main.vidar:118
	wrapped := u8(44)

	// Anything that depends on run-time values is a compile error, e.g.
	//     n := len(os.args)
	//     x := square!(n)    // error: 'square!' cannot run at compile time: 'n' is a runtime value ...

	fmt.println(title)
	fmt.println(f, area, mask, version)
	fmt.println(squares[TABLE_SIZE - 1], primes)
	fmt.println(cfg)
	fmt.println(month_starts, hex_digits, sum_of_cubes, wrapped)
}
