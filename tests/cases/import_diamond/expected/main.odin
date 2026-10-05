package main

import "core:fmt"
import left "left"
import right "right"

// main -> left -> base and main -> right -> base: base is loaded and emitted once
main :: proc() {
	l := left.make()
	r := right.make()
	fmt.println(l.call(l.env, 1), r.call(r.env, 1), left.name(), right.name())
}
