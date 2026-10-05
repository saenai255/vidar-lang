package main

import "core:fmt"


lib__banner :: proc() -> string { return fmt.tprintf("app v%s (%s)", VERSION, lib__helper()) }

lib__helper :: proc() -> string { return "lib.helper" }
