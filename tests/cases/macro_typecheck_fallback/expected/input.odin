package main

import "core:fmt"
import "core:strings"

// vidar can't infer the type of a call into another package, so it emits a
// dead-code assignment that makes Odin check the Expr(string) constraint.




main :: proc() {
	name := "odin"
	if false { __macro_typecheck: string = (strings.to_upper(name)); _ = __macro_typecheck }; fmt.println(strings.to_upper(name))
	if false { __macro_typecheck: string = (strings.concatenate({ "plus", "plus" })); _ = __macro_typecheck }; if false { __macro_typecheck: string = (strings.to_upper(strings.concatenate({ "plus", "plus" }))); _ = __macro_typecheck }; fmt.println(strings.to_upper(strings.concatenate({ "plus", "plus" })))
}
