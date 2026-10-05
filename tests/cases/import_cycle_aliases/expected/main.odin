package main

import "core:fmt"
import mdl "model_view"

main :: proc() {
	s := mdl.model__new_store()
	mdl.model__set(&s, 3)
	mdl.model__set(&s, 4)
	fmt.println(mdl.model__summary(&s))
}
