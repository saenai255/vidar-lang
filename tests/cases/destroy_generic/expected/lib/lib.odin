package lib; import __vidar "../vidar_runtime"

import "core:fmt"

// generic code that knows nothing about File
Pair :: struct($T: typeid) { a, b: T }

// builds its values, so it owns them: the pair is destroyed by its caller
make_pair :: proc(mk: proc(string) -> $T) -> Pair(T) {
	p := Pair(T){mk("p0"), mk("p1")}; defer __vidar.destroy(&p)
	{ defer __vidar.forget(&p); return p }
}

// a local of type T is destroyed here, whatever T is
scratch :: proc(mk: proc(string) -> $T) {
	t := mk("scratch"); defer __vidar.destroy(&t)
	fmt.println("in scratch")
}

// borrowing is fine
name_of :: proc(x: $T) -> string {
	return fmt.tprint(x)
}

// a generic copy of a type without a destructor is an ordinary copy
first :: proc(xs: []$T) -> T {
	__vidar.check_copy(type_of(xs[0])); x := xs[0]; defer __vidar.destroy(&x)
	{ defer __vidar.forget(&x); return x }
}
