package a_b_c

import "core:fmt"


c__helper :: proc() -> string { return "c.helper" }

c__describe :: proc() -> string {
	return fmt.tprintf("c (depth from a: %d, %s)", a__depth(), a__helper())
}
