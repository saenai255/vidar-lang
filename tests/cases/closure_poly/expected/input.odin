package main; import __vidar "vidar_runtime"

import "core:fmt"

// Closures inside polymorphic procs: their bodies use $T, $N and local types
// built from them, so each closure's helper is declared inside the proc.

sum_with :: proc(xs: []$T, k: T) -> T {
	__closure_0 :: proc(__c0: $T0) -> __vidar.Closure(proc(__vidar.Env, T, T) -> T) {
		__Caps :: struct {
			k: T0,
		}
		#assert(size_of(__Caps) <= __vidar.CLOSURE_ENV, "closure at input.vidar:9: its captures don't fit in VIDAR_CLOSURE_ENV bytes; capture a pointer, or build with -define:VIDAR_CLOSURE_ENV=<bytes>")
		__Env :: struct { using __caps: __Caps, __pad: [__vidar.CLOSURE_ENV - size_of(__Caps)]byte }
		return __vidar.Closure(proc(__vidar.Env, T, T) -> T){
			call = proc(__env_raw: __vidar.Env, a, b: T) -> T { __env := transmute(__Env)__env_raw; return a + b + __env.k },
			env = transmute(__vidar.Env)__Env{__caps = {__c0}},
		}
	}
	add := __closure_0(k)
	acc: T
	for x in xs do acc = add.call(add.env, acc, x)
	return acc
}

Box :: struct($T: typeid) { value: T }

boxes :: proc(xs: []$T, scale: T) -> [dynamic]Box(T) {
	Item :: Box(T)
	WIDTH :: size_of(T)
	out: [dynamic]Item
	__closure_1 :: proc(__c0: $T0) -> __vidar.Closure(proc(__vidar.Env, T) -> Item) {
		__Caps :: struct {
			scale: T0,
		}
		#assert(size_of(__Caps) <= __vidar.CLOSURE_ENV, "closure at input.vidar:21: its captures don't fit in VIDAR_CLOSURE_ENV bytes; capture a pointer, or build with -define:VIDAR_CLOSURE_ENV=<bytes>")
		__Env :: struct { using __caps: __Caps, __pad: [__vidar.CLOSURE_ENV - size_of(__Caps)]byte }
		return __vidar.Closure(proc(__vidar.Env, T) -> Item){
			call = proc(__env_raw: __vidar.Env, x: T) -> Item { __env := transmute(__Env)__env_raw; return Item{x * __env.scale + T(WIDTH)} },
			env = transmute(__vidar.Env)__Env{__caps = {__c0}},
		}
	}
	wrap := __closure_1(scale)
	for x in xs do append(&out, wrap.call(wrap.env, x))
	return out
}

fill :: proc($N: int, start: int) -> (out: [N]int) {
	count := 0
	__closure_3 :: proc(__c0: $T0) -> __vidar.Closure(proc(__vidar.Env, int) -> int) {
		__Caps :: struct {
			count: T0,
		}
		#assert(size_of(__Caps) <= __vidar.CLOSURE_ENV, "closure at input.vidar:28: its captures don't fit in VIDAR_CLOSURE_ENV bytes; capture a pointer, or build with -define:VIDAR_CLOSURE_ENV=<bytes>")
		__Env :: struct { using __caps: __Caps, __pad: [__vidar.CLOSURE_ENV - size_of(__Caps)]byte }
		return __vidar.Closure(proc(__vidar.Env, int) -> int){
			call = proc(__env_raw: __vidar.Env, i: int) -> int { __env := transmute(__Env)__env_raw;
		__env.count^ += 1
		// a closure inside a closure, both using $N
		__closure_2 :: proc(__c0: $T0) -> __vidar.Closure(proc(__vidar.Env) -> int) {
			__Caps :: struct {
				i: T0,
			}
			#assert(size_of(__Caps) <= __vidar.CLOSURE_ENV, "closure at input.vidar:31: its captures don't fit in VIDAR_CLOSURE_ENV bytes; capture a pointer, or build with -define:VIDAR_CLOSURE_ENV=<bytes>")
			__Env :: struct { using __caps: __Caps, __pad: [__vidar.CLOSURE_ENV - size_of(__Caps)]byte }
			return __vidar.Closure(proc(__vidar.Env) -> int){
				call = proc(__env_raw: __vidar.Env) -> int { __env := transmute(__Env)__env_raw; return __env.i * N },
				env = transmute(__vidar.Env)__Env{__caps = {__c0}},
			}
		}
		inner := __closure_2(i)
		return inner.call(inner.env)
	},
			env = transmute(__vidar.Env)__Env{__caps = {__c0}},
		}
	}
	step := __closure_3(&count)
	for i in 0..<N do out[i] = start + step.call(step.env, i)
	fmt.println("steps:", count)
	return
}

apply :: proc(x: $T, f: __vidar.Closure(proc(__vidar.Env, T) -> T)) -> T { __f_call := f.call; return __f_call(f.env, __f_call(f.env, x)) }

twice_plus :: proc(x: $T, d: T) -> T {
	// passed straight to a proc, and with no captures
	__closure_4 :: proc(__c0: $T0) -> __vidar.Closure(proc(__vidar.Env, T) -> T) {
		__Caps :: struct {
			d: T0,
		}
		#assert(size_of(__Caps) <= __vidar.CLOSURE_ENV, "closure at input.vidar:43: its captures don't fit in VIDAR_CLOSURE_ENV bytes; capture a pointer, or build with -define:VIDAR_CLOSURE_ENV=<bytes>")
		__Env :: struct { using __caps: __Caps, __pad: [__vidar.CLOSURE_ENV - size_of(__Caps)]byte }
		return __vidar.Closure(proc(__vidar.Env, T) -> T){
			call = proc(__env_raw: __vidar.Env, v: T) -> T { __env := transmute(__Env)__env_raw; return v + __env.d },
			env = transmute(__vidar.Env)__Env{__caps = {__c0}},
		}
	}
	r := apply(x, __closure_4(d))
	zero := __vidar.Closure(proc(__vidar.Env) -> T){call = proc(__env_raw: __vidar.Env) -> T { return T(0) }}
	return r + zero.call(zero.env)
}

each :: proc(xs: []int, f: __vidar.Closure(proc(__vidar.Env, int))) { __f_call := f.call; for x in xs do __f_call(f.env, x) }

// with -opt, each isn't copied for this closure: the copy would be at file scope, where T isn't
count_as :: proc($T: typeid, xs: []int) -> T {
	acc: T
	__closure_5 :: proc(__c0: $T0) -> __vidar.Closure(proc(__vidar.Env, int)) {
		__Caps :: struct {
			acc: T0,
		}
		#assert(size_of(__Caps) <= __vidar.CLOSURE_ENV, "closure at input.vidar:53: its captures don't fit in VIDAR_CLOSURE_ENV bytes; capture a pointer, or build with -define:VIDAR_CLOSURE_ENV=<bytes>")
		__Env :: struct { using __caps: __Caps, __pad: [__vidar.CLOSURE_ENV - size_of(__Caps)]byte }
		return __vidar.Closure(proc(__vidar.Env, int)){
			call = proc(__env_raw: __vidar.Env, x: int) { __env := transmute(__Env)__env_raw; __env.acc^ += T(x) / 2 },
			env = transmute(__vidar.Env)__Env{__caps = {__c0}},
		}
	}
	each(xs, __closure_5(&acc))
	return acc
}

main :: proc() {
	fmt.println(sum_with([]int{1, 2, 3}, 1), sum_with([]f64{0.5, 1.5}, 0.25))
	bs := boxes([]int{1, 2}, 10)
	defer delete(bs)
	fmt.println(bs[0].value, bs[1].value)
	fmt.println(fill(4, 100))
	fmt.println(twice_plus(1, 2), twice_plus(f32(1.5), 1))
	fmt.println(count_as(int, []int{1, 2, 3}), count_as(f64, []int{1, 2, 3}))
}
