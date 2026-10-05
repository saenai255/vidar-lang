package a_b_c

import "core:fmt"


// a -> b -> c -> a: a three-package cycle
a__Node :: struct { name: string }

a__helper :: proc() -> string { return "a.helper" }

a__depth :: proc() -> int { return 1 }

a__describe :: proc() -> string {
	n := a__Node{"a"}
	return fmt.tprintf("%s -> %s", n.name, b__describe(3))
}
