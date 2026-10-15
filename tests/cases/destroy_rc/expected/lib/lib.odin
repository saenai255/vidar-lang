package lib; import __vidar "../vidar_runtime"

// generic code that knows nothing about Rc or File
Pair :: struct($T: typeid) { a, b: T }

// copies of x are clones: an Rc is shared, a type without impl Clone stops the program
dup :: proc(x: $T) -> Pair(T) {
	p := Pair(T){__vidar.clone(x), __vidar.clone(x)}; defer __vidar.destroy(&p)
	{ defer __vidar.forget(&p); return p }
}

keep :: proc(x: $T) -> T { return __vidar.clone(x) }

// takes x over, so it works for move-only types too
take_over :: proc( x: $T) -> T { x := x; defer __vidar.destroy(&x); { defer __vidar.forget(&x); return x } }
