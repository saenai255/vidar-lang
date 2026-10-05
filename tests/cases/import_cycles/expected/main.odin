package main

import "core:fmt"
import a "a_b_c"


// lib imports this package back, so main itself is part of a cycle.
VERSION :: "1.2"

helper :: proc() -> string { return "main.helper" }

main :: proc() {
	fmt.println(a.a__describe())
	fmt.println(lib__banner())
	// every package in the cycles declares `helper`; prefixes keep them apart
	fmt.println(helper(), a.a__helper())
}
