/** The bundled "vidar:rc" package: Rc(T), a value shared by several owners (impl Destroy and Clone). */
export const RC_IMPORT = "vidar:rc";

export const RC_SOURCE = String.raw`package rc

import "base:intrinsics"
import "base:runtime"
import "core:mem"

// Rc(T) shares one T between owners. A copy is another owner (impl Clone), and the last owner to be
// destroyed destroys the value and frees it. The zero Rc owns nothing.
Rc :: struct($T: typeid) {
	box: ^Box(T),
}

impl Destroy for Rc($T) { destroy = release }
impl Clone for Rc($T) { clone = share }

// Counts are atomic only when goroutines run on several threads.
@(private)
THREADS :: #config(VIDAR_THREADS, 1)

@(private)
Header :: struct {
	count:     int,
	// destroys the value and frees the box
	drop:      proc(h: ^Header),
	allocator: runtime.Allocator,
}

@(private)
Box :: struct($T: typeid) {
	using header: Header,
	value:        T,
}

// new takes over value: pass a new one, or move one in with move!(x).
new :: proc(#owned value: $T, allocator := context.allocator) -> Rc(T) {
	b, _ := mem.new(Box(T), allocator)
	b.count = 1
	b.allocator = allocator
	b.drop = proc(h: ^Header) {
		b := (^Box(T))(h)
		__vidar.destroy(&b.value)
		mem.free(b, b.allocator)
	}
	b.value = move!(value)
	return Rc(T){b}
}

// get gives the shared value, which lives as long as some owner does.
get :: proc(r: Rc($T)) -> ^T {
	return &r.box.value if r.box != nil else nil
}

// count is the number of owners (0 for the zero Rc).
count :: proc(r: Rc($T)) -> int {
	if r.box == nil do return 0
	when THREADS > 1 {
		return intrinsics.atomic_load(&r.box.count)
	} else {
		return r.box.count
	}
}

// share and release are what copies and the end of a scope call: a program doesn't call them itself.
share :: proc(r: Rc($T)) -> Rc(T) {
	retain(r.box)
	return r
}

release :: proc(r: ^Rc($T)) {
	drop(r.box)
	r.box = nil
}

@(private)
retain :: proc "contextless" (h: ^Header) {
	if h == nil do return
	when THREADS > 1 {
		intrinsics.atomic_add(&h.count, 1)
	} else {
		h.count += 1
	}
}

@(private)
drop :: proc(h: ^Header) {
	if h == nil do return
	left: int
	when THREADS > 1 {
		left = intrinsics.atomic_sub(&h.count, 1) - 1
	} else {
		h.count -= 1
		left = h.count
	}
	if left == 0 do h.drop(h)
}

// Generic code that holds an Rc as a plain T destroys and copies it through these, which take any Rc.
@(init, private="file")
register :: proc "contextless" () {
	__vidar.register_generic(#location().file_path, "Rc", proc(p: rawptr) {
		h := (^^Header)(p)
		drop(h^)
		h^ = nil
	}, proc(dst, src: rawptr) {
		h := (^^Header)(src)^
		retain(h)
		(^^Header)(dst)^ = h
	})
}
`;
