package model_view

import "core:fmt"
import "core:strings"

// private to package model, used from its other file
@(private) model__notify :: proc(s: ^model__Store) {
	for o in s.observers do append(&s.log, model__changed(o, s.value))
}

model__set :: proc(s: ^model__Store, v: int) {
	s.value = v
	model__notify(s)
}

model__summary :: proc(s: ^model__Store) -> string {
	return fmt.tprintf("value=%d log=[%s]", s.value, strings.join(s.log[:], "; "))
}
