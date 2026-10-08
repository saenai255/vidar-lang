package main

import "core:fmt"
import greeter "greeter"

main :: proc() {
	fmt.println(greeter.hello("wizard"))
}
