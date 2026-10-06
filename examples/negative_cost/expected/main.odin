package main; import __vidar "vidar_runtime"

// Code written at a high level that comes out faster than the plain Odin you'd write by hand.
// Every section prints a checksum; with --bench it also prints how long it took.
// bench/bench.js builds this with and without -opt and compares.

import "core:fmt"
import "core:os"
import "core:strings"
import "core:time"

BENCH := false

section :: proc(name: string, start: time.Tick, checksum: int) {
	if BENCH do fmt.printf("%-26s %.2f ms   %d\n", name, time.duration_milliseconds(time.tick_since(start)), checksum)
	else do fmt.printf("%-26s %d\n", name, checksum)
}

// ---- interfaces: a union over the implementations, dispatched by a switch ----

Shape :: struct { data: rawptr, __vtable: ^__Shape_VTable }
area :: proc{__Shape_area, circle_area, square_area, tri_area}
grow :: proc{__Shape_grow, circle_grow, square_grow, tri_grow}

Circle :: struct { r: f64 }
Square :: struct { side: f64 }
Tri    :: struct { b, h: f64 }

circle_area :: proc(c: ^Circle) -> f64 { return 3.0 * c.r * c.r }
circle_grow :: proc(c: ^Circle, k: f64) { c.r += k }
square_area :: proc(s: ^Square) -> f64 { return s.side * s.side }
square_grow :: proc(s: ^Square, k: f64) { s.side += k }
tri_area    :: proc(t: ^Tri) -> f64 { return t.b * t.h / 2 }
tri_grow    :: proc(t: ^Tri, k: f64) { t.b += k }





@(private) noise :: proc(x: int) -> int { return (x * 1103515245 + 12345) & 0xffff }

shapes :: proc(n, reps: int) {
	// the usual way: each shape allocated on its own, kept as interface values in no particular order
	context.allocator = context.temp_allocator
	list := make([dynamic]Shape, 0, n)
	pool: __Shape_Pool
	for i in 0..<n {
		v := f64(i % 7)
		switch noise(i) % 3 {
		case 0:
			append(&list, __Shape_from(new_clone(Circle{v})))
			append(&pool.Circle, Circle{v})
		case 1:
			append(&list, __Shape_from(new_clone(Square{v})))
			append(&pool.Square, Square{v})
		case:
			append(&list, __Shape_from(new_clone(Tri{v, 2})))
			append(&pool.Tri, Tri{v, 2})
		}
	}

	start := time.tick_now()
	sum := 0.0
	for _ in 0..<reps {
		for s in list {
			grow(s, 0.5)
			sum += area(s)
		}
	}
	section("interface array", start, int(sum))

	// Pool(Shape): each type's values in an array of their own, the loop body once per type
	start = time.tick_now()
	sum = 0.0
	for _ in 0..<reps {
		for &__s in pool.Circle { s := &__s;
			grow(s, 0.5)
			sum += area(s)
		}
		for &__s in pool.Square { s := &__s;
			grow(s, 0.5)
			sum += area(s)
		}
		for &__s in pool.Tri { s := &__s;
			grow(s, 0.5)
			sum += area(s)
		}
	}
	section("pool", start, int(sum))
	free_all(context.temp_allocator)
}

// ---- -opt: fmt with a literal format becomes a proc that writes the pieces ----

Slime :: struct { name: string, hp, max_hp: int, angry: bool }

status :: proc(n: int) {
	b := strings.builder_make()
	defer strings.builder_destroy(&b)
	s := Slime{"green slime", 7, 12, true}
	total := 0
	start := time.tick_now()
	for i in 0..<n {
		strings.builder_reset(&b)
		fmt.sbprintf(&b, "%s [%d/%d] angry=%v #%d\n", s.name, s.hp, s.max_hp, s.angry, i)
		total += strings.builder_len(b)
	}
	section("fmt.sbprintf", start, total)
}

// ---- -opt: indexes a loop proves in bounds go unchecked ----

checksum :: proc(a: []int, reps: int) -> (sum: int) {
	for _ in 0..<reps {
		for i := 0; i < len(a); i += 1 {
			sum += a[i] ~ noise(a[i] + i)
		}
	}
	return
}

bounds :: proc(n, reps: int) {
	a := make([]int, n)
	defer delete(a)
	for i in 0..<len(a) do a[i] = i * 7
	start := time.tick_now()
	section("loop with indexes", start, checksum(a, reps))
}

// ---- -opt: allocations freed together are made together ----

smooth :: proc(src: []f32) -> f32 {
	tmp := make([]f32, len(src))
	out := make([]f32, len(src))
	weights := make([]f32, 3)
	defer delete(tmp)
	defer delete(out)
	defer delete(weights)
	weights[0], weights[1], weights[2] = 0.25, 0.5, 0.25
	for i in 1..<len(src) - 1 do tmp[i] = src[i - 1] * weights[0] + src[i] * weights[1] + src[i + 1] * weights[2]
	for i in 1..<len(tmp) - 1 do out[i] = (tmp[i - 1] + tmp[i] + tmp[i + 1]) / 3
	return out[len(out) / 2]
}

allocs :: proc(calls: int) {
	src := []f32{1, 4, 2, 8, 5, 7, 3, 6, 9, 0, 2, 4}
	start := time.tick_now()
	sum: f32
	for _ in 0..<calls do sum += smooth(src)
	section("scratch allocations", start, int(sum))
}

// ---- @(specialize): a copy per set of constant arguments ----


box_blur :: #force_no_inline proc(dst, src: []int, radius: int) {
	for i in radius..<len(src) - radius {
		s := 0
		for k in -radius..=radius do s += src[i + k]
		dst[i] = s / (2 * radius + 1)
	}
}

box_blur_plain :: #force_no_inline proc(dst, src: []int, radius: int) {
	for i in radius..<len(src) - radius {
		s := 0
		for k in -radius..=radius do s += src[i + k]
		dst[i] = s / (2 * radius + 1)
	}
}

blur :: proc(n, reps: int) {
	src := make([]int, n)
	dst := make([]int, n)
	defer delete(src)
	defer delete(dst)
	for i in 0..<n do src[i] = noise(i)
	// two radii, so the optimizer can't fold one constant into the plain proc
	start := time.tick_now()
	for _ in 0..<reps {
		box_blur_plain(dst, src, 1)
		box_blur_plain(dst, src, 3)
	}
	section("blur, radius at run time", start, dst[n / 2])
	start = time.tick_now()
	for _ in 0..<reps {
		box_blur__radius(dst, src, 1)
		box_blur__radius(dst, src, 3)
	}
	section("blur, @(specialize)", start, dst[n / 2])
}

// ---- @(table): every result computed once ----

// steps the Collatz sequence takes from b + 1 down to 1

collatz :: #force_inline proc(b: u8) -> int { return __collatz_table[b] }









collatz_plain :: proc(b: u8) -> int {
	n := int(b) + 1
	steps := 0
	for n != 1 {
		n = n / 2 if n % 2 == 0 else 3 * n + 1
		steps += 1
	}
	return steps
}

steps :: proc(n, reps: int) {
	data := make([]u8, n)
	defer delete(data)
	for i in 0..<n do data[i] = u8(noise(i))
	start := time.tick_now()
	total := 0
	for _ in 0..<reps do for b in data do total += collatz_plain(b)
	section("collatz, computed", start, total)
	start = time.tick_now()
	total = 0
	for _ in 0..<reps do for b in data do total += collatz(b)
	section("collatz, @(table)", start, total)
}

main :: proc() {
	BENCH = len(os.args) > 1 && os.args[1] == "--bench"
	scale := 50 if BENCH else 1
	shapes(30_000 if BENCH else 3_000, 2 * scale)
	status(20_000 * scale)
	bounds(100_000, 10 * scale)
	allocs(20_000 * scale)
	blur(100_000, 2 * scale)
	steps(100_000, scale)
}

// ---- generated by vidar ----

__Shape_VTable :: struct {
	area: proc(self: Shape) -> f64,
	grow: proc(self: Shape, k: f64),
}

__Shape_area :: proc(s: Shape) -> f64 {
	if s.__vtable == &__Shape_vtable_Circle { return circle_area(auto_cast s.data) }
	if s.__vtable == &__Shape_vtable_Square { return square_area(auto_cast s.data) }
	if s.__vtable == &__Shape_vtable_Tri { return tri_area(auto_cast s.data) }
	return s.__vtable.area(s)
}

__Shape_grow :: proc(s: Shape, k: f64) {
	if s.__vtable == &__Shape_vtable_Circle { circle_grow(auto_cast s.data, k); return }
	if s.__vtable == &__Shape_vtable_Square { square_grow(auto_cast s.data, k); return }
	if s.__vtable == &__Shape_vtable_Tri { tri_grow(auto_cast s.data, k); return }
	s.__vtable.grow(s, k)
}

__Shape_identity :: #force_inline proc(v: Shape) -> Shape { return v }

__Shape_from :: proc{__Shape_from_Circle, __Shape_from_Square, __Shape_from_Tri, __Shape_identity}

__Shape_Pool :: struct {
	Circle: [dynamic]Circle,
	Square: [dynamic]Square,
	Tri: [dynamic]Tri,
}

__Shape_Pool_len :: #force_inline proc(p: __Shape_Pool) -> int { return len(p.Circle) + len(p.Square) + len(p.Tri) }

__Shape_Pool_clear :: proc(p: ^__Shape_Pool) { clear(&p.Circle); clear(&p.Square); clear(&p.Tri) }

__Shape_Pool_delete :: proc(p: __Shape_Pool) { delete(p.Circle); delete(p.Square); delete(p.Tri) }

@(rodata)
__Shape_vtable_Circle := __Shape_VTable{
	area = proc(self: Shape) -> f64 { return circle_area((^Circle)(self.data)) },
	grow = proc(self: Shape, k: f64) { circle_grow((^Circle)(self.data), k) },
}

__Shape_from_Circle :: proc(p: ^Circle) -> Shape { return {data = p, __vtable = &__Shape_vtable_Circle} }

@(rodata)
__Shape_vtable_Square := __Shape_VTable{
	area = proc(self: Shape) -> f64 { return square_area((^Square)(self.data)) },
	grow = proc(self: Shape, k: f64) { square_grow((^Square)(self.data), k) },
}

__Shape_from_Square :: proc(p: ^Square) -> Shape { return {data = p, __vtable = &__Shape_vtable_Square} }

@(rodata)
__Shape_vtable_Tri := __Shape_VTable{
	area = proc(self: Shape) -> f64 { return tri_area((^Tri)(self.data)) },
	grow = proc(self: Shape, k: f64) { tri_grow((^Tri)(self.data), k) },
}

__Shape_from_Tri :: proc(p: ^Tri) -> Shape { return {data = p, __vtable = &__Shape_vtable_Tri} }

// box_blur with radius known at compile time
box_blur__radius :: #force_no_inline proc(dst: []int, src: []int, $radius: int) {
	for i in radius..<len(src) - radius {
		s := 0
		for k in -radius..=radius do s += src[i + k]
		dst[i] = s / (2 * radius + 1)
	}
}

// collatz(x) for every x, computed by vidar
@(rodata)
__collatz_table := [256]int{
	0, 1, 7, 2, 5, 8, 16, 3,
	19, 6, 14, 9, 9, 17, 17, 4,
	12, 20, 20, 7, 7, 15, 15, 10,
	23, 10, 111, 18, 18, 18, 106, 5,
	26, 13, 13, 21, 21, 21, 34, 8,
	109, 8, 29, 16, 16, 16, 104, 11,
	24, 24, 24, 11, 11, 112, 112, 19,
	32, 19, 32, 19, 19, 107, 107, 6,
	27, 27, 27, 14, 14, 14, 102, 22,
	115, 22, 14, 22, 22, 35, 35, 9,
	22, 110, 110, 9, 9, 30, 30, 17,
	30, 17, 92, 17, 17, 105, 105, 12,
	118, 25, 25, 25, 25, 25, 87, 12,
	38, 12, 100, 113, 113, 113, 69, 20,
	12, 33, 33, 20, 20, 33, 33, 20,
	95, 20, 46, 108, 108, 108, 46, 7,
	121, 28, 28, 28, 28, 28, 41, 15,
	90, 15, 41, 15, 15, 103, 103, 23,
	116, 116, 116, 23, 23, 15, 15, 23,
	36, 23, 85, 36, 36, 36, 54, 10,
	98, 23, 23, 111, 111, 111, 67, 10,
	49, 10, 124, 31, 31, 31, 80, 18,
	31, 31, 31, 18, 18, 93, 93, 18,
	44, 18, 44, 106, 106, 106, 44, 13,
	119, 119, 119, 26, 26, 26, 119, 26,
	18, 26, 39, 26, 26, 88, 88, 13,
	39, 39, 39, 13, 13, 101, 101, 114,
	26, 114, 52, 114, 114, 70, 70, 21,
	52, 13, 13, 34, 34, 34, 127, 21,
	83, 21, 127, 34, 34, 34, 52, 21,
	21, 96, 96, 21, 21, 47, 47, 109,
	47, 109, 65, 109, 109, 47, 47, 8,
}
