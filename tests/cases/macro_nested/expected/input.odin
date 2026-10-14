package main

import "core:fmt"
import "base:runtime"

PACTMP := "/tmp"
// run_in_context!(take_first!(lookup_dir(PACTMP))) — input.vidar:7
PACDIR := (proc "contextless"() -> string {
	context = runtime.default_context()
	// take_first!(lookup_dir(PACTMP)) — input.vidar:7
	return (proc "contextless"() -> string {
		first__2, _ := lookup_dir(PACTMP)
		return first__2
	})()
})()

lookup_dir :: proc "contextless" (base: string) -> (string, bool) {
    return base, true
}

// A macro whose argument is another macro call: type_of_expr sees through it.
// run_in_context :: proc!(expr: Expr) -> Expr — comptime, input.vidar:14

// take_first :: proc!(call: Expr) -> Expr — comptime, input.vidar:24

// twice :: proc!(x: Expr) -> Expr — comptime, input.vidar:34

// A macro whose expansion calls another macro.
// quad :: proc!(x: Expr) -> Expr — comptime, input.vidar:39

// sum :: proc!(a: Expr(int), b: Expr(int)) -> Expr — comptime, input.vidar:44

main :: proc() {
    fmt.println(PACDIR)
    // quad!(twice!(3)) — input.vidar:50
    // twice!(3) — input.vidar:50
    // twice!(3) — input.vidar:50
    fmt.println(int(((3 * 2) * 2) + ((3 * 2) * 2)))
    // sum!(twice!(1), quad!(2)) — input.vidar:51
    // twice!(1) — input.vidar:51
    // quad!(2) — input.vidar:51
    fmt.println((1 * 2) + int((2 * 2) + (2 * 2)))
    f := 1.5
    // quad!(twice!(f)) — input.vidar:53
    // twice!(f) — input.vidar:53
    // twice!(f) — input.vidar:53
    fmt.println(int(((f * 2) * 2) + ((f * 2) * 2)))
    stmts()
}

// A macro returning statements, passed as an Expr argument and spliced as a statement.
// say :: proc!(x: Expr) -> Stmt — comptime, input.vidar:58

// run :: proc!(s: Expr) -> Stmt — comptime, input.vidar:62

stmts :: proc() {
    // run!(say!("from a statement macro")) — input.vidar:67
    // say!("from a statement macro") — input.vidar:67
    fmt.println("from a statement macro")
}
