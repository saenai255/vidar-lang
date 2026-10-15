/** The bundled "vidar:rc" package: Rc(T), a value shared by several owners (impl Destroy and Clone), and Weak(T). */
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

// Weak(T) refers to an Rc's value without owning it, so two values that refer to each other through
// one of each are still destroyed. upgrade gives an owner while the value lives. The zero Weak refers
// to nothing.
Weak :: struct($T: typeid) {
	box: ^Box(T),
}

impl Destroy for Weak($T) { destroy = weak_release }
impl Clone for Weak($T) { clone = weak_share }

// Counts are atomic only when goroutines run on several threads.
@(private)
THREADS :: #config(VIDAR_THREADS, 1)

@(private)
Header :: struct {
	count:     int,
	// the Weak(T)s, plus one while any Rc is left: the box is freed when it reaches 0
	weak:      int,
	// destroys the value
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
	b.count, b.weak = 1, 1
	b.allocator = allocator
	b.drop = proc(h: ^Header) {
		b := (^Box(T))(h)
		__vidar.destroy(&b.value)
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

// downgrade gives a Weak that refers to r's value without keeping it alive.
downgrade :: proc(r: Rc($T)) -> Weak(T) {
	weak_retain(r.box)
	return Weak(T){r.box}
}

// upgrade gives another owner of w's value, or the zero Rc once its last owner has destroyed it.
upgrade :: proc(w: Weak($T)) -> Rc(T) {
	if w.box == nil do return {}
	when THREADS > 1 {
		for {
			c := intrinsics.atomic_load(&w.box.count)
			if c == 0 do return {}
			if _, ok := intrinsics.atomic_compare_exchange_weak(&w.box.count, c, c + 1); ok do break
		}
	} else {
		if w.box.count == 0 do return {}
		w.box.count += 1
	}
	return Rc(T){w.box}
}

// alive is whether w's value still has an owner.
alive :: proc(w: Weak($T)) -> bool {
	if w.box == nil do return false
	when THREADS > 1 {
		return intrinsics.atomic_load(&w.box.count) > 0
	} else {
		return w.box.count > 0
	}
}

// share, release, weak_share and weak_release are what copies and the end of a scope call: a program
// doesn't call them itself.
share :: proc(r: Rc($T)) -> Rc(T) {
	retain(r.box)
	return r
}

release :: proc(r: ^Rc($T)) {
	drop(r.box)
	r.box = nil
}

weak_share :: proc(w: Weak($T)) -> Weak(T) {
	weak_retain(w.box)
	return w
}

weak_release :: proc(w: ^Weak($T)) {
	weak_drop(w.box)
	w.box = nil
}

@(private)
weak_retain :: proc "contextless" (h: ^Header) {
	if h == nil do return
	when THREADS > 1 {
		intrinsics.atomic_add(&h.weak, 1)
	} else {
		h.weak += 1
	}
}

@(private)
weak_drop :: proc(h: ^Header) {
	if h == nil do return
	left: int
	when THREADS > 1 {
		left = intrinsics.atomic_sub(&h.weak, 1) - 1
	} else {
		h.weak -= 1
		left = h.weak
	}
	if left == 0 do mem.free(h, h.allocator)
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
	if left == 0 {
		h.drop(h)
		weak_drop(h)
	}
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
	__vidar.register_generic(#location().file_path, "Weak", proc(p: rawptr) {
		h := (^^Header)(p)
		weak_drop(h^)
		h^ = nil
	}, proc(dst, src: rawptr) {
		h := (^^Header)(src)^
		weak_retain(h)
		(^^Header)(dst)^ = h
	})
}
`;
