package main

import "core:fmt"
import gadget "gadget"
import widget "widget"

// deps/widget/deps/gadget links to deps/gadget: it is reached by two paths, and is one package
main :: proc() {
	t: gadget.Thing = widget.make_thing()
	fmt.println(t)
}
