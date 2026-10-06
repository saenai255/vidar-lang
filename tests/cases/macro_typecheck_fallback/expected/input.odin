package main

import "core:fmt"
import "core:strings"

// vidar can't infer the type of a call into another package, so it emits a
// dead-code assignment that makes Odin check the Expr(string) constraint.
// shout :: proc!(s: Expr(string)) -> Expr(string) — comptime, input.vidar:8

// say :: proc!(s: Expr(string)) -> Stmt — comptime, input.vidar:12

main :: proc() {
	name := "odin"
	// shout!(name) — input.vidar:18
	if false { __macro_typecheck: string = strings.to_upper(name); _ = __macro_typecheck }
	fmt.println(strings.to_upper(name))
	// shout!(strings.concatenate({"plus", "plus"})) — input.vidar:19
	if false { __macro_typecheck: string = strings.concatenate({"plus", "plus"}); _ = __macro_typecheck }
	if false { __macro_typecheck: string = strings.to_upper(strings.concatenate({"plus", "plus"})); _ = __macro_typecheck }
	fmt.println(strings.to_upper(strings.concatenate({"plus", "plus"})))

	// the check goes before the statement, so it must stay under the `do`
	quiet := true
	// say!(strings.to_lower("LOUD")) — input.vidar:23
	if !quiet { if false { __macro_typecheck: string = (strings.to_lower("LOUD")); _ = __macro_typecheck }; fmt.println(strings.to_lower("LOUD")) }
	fmt.println("quiet")
}
