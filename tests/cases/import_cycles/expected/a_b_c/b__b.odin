package a_b_c

import "core:fmt"


// a different `Node` than a.Node
b__Node :: struct { id: int }

b__helper :: proc() -> string { return "b.helper" }

b__describe :: proc(id: int) -> string {
	n := b__Node{id}
	return fmt.tprintf("b(%d) -> %s", n.id, c__describe())
}
