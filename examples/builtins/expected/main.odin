package main; import __vidar "vidar_runtime"

import "core:fmt"
import "core:mem"
import "core:sync"
import "core:thread"

// Every macro here is built into Vidar: no definitions, no imports.

area :: proc(w, h: int) -> int {
	// check!(w >= 0, "width must not be negative") — main.vidar:11
	{
		__check_lhs := w
		__check_rhs: type_of(__check_lhs) = 0
		if !(__check_lhs >= __check_rhs) {
			__vidar.check_failed_cmp("w >= 0", "width must not be negative", "w", __check_lhs, "", __check_rhs)
		}
	} // on failure, also prints the value of `w`
	// check!(h >= 0) — main.vidar:12
	{
		__check_lhs := h
		__check_rhs: type_of(__check_lhs) = 0
		if !(__check_lhs >= __check_rhs) {
			__vidar.check_failed_cmp("h >= 0", "", "h", __check_lhs, "", __check_rhs)
		}
	}
	return w * h
}

parse_mode :: proc(s: string) -> int {
	switch s {
	case "fast": return 1
	case "safe": return 2
	case "gpu":  // unimplemented!("no GPU backend") — main.vidar:20
		__vidar.not_done("not implemented", "no GPU backend")
	}
	// todo!("decide what unknown modes do") — main.vidar:22
	__vidar.not_done("not yet implemented", "decide what unknown modes do")
}

grade :: proc(score: int) -> string {
	// do! { ... } — main.vidar:26
	__do1_result: string
	__do1: {
		if score >= 90 {
			__do1_result = "A"
			break __do1
		}
		if score >= 75 {
			__do1_result = "B"
			break __do1
		}
		__do1_result = "C"
		break __do1
	}
	return __do1_result
}

main :: proc() {
	name := "vidar"

	// dbg!: prints the source location, expression and value to stderr, and passes the value through
	// dbg!(area(3, 4)) — main.vidar:37
	total := __vidar.dbg(area(3, 4), "area(3, 4)", "main.vidar:37") + 1
	fmt.println("total:", total)

	// check!: an assert that explains itself
	// check!(total == 13) — main.vidar:41
	{
		__check_lhs := total
		__check_rhs: type_of(__check_lhs) = 13
		if !(__check_lhs == __check_rhs) {
			__vidar.check_failed_cmp("total == 13", "", "total", __check_lhs, "", __check_rhs)
		}
	}
	// check!(len(name) > 0, "name is required") — main.vidar:42
	{
		__check_lhs := len(name)
		__check_rhs: type_of(__check_lhs) = 0
		if !(__check_lhs > __check_rhs) {
			__vidar.check_failed_cmp("len(name) > 0", "name is required", "len(name)", __check_lhs, "", __check_rhs)
		}
	}

	// with_allocator!: a block that allocates from a specific allocator
	tracker: mem.Tracking_Allocator
	mem.tracking_allocator_init(&tracker, context.allocator)
	// with_allocator!(mem.tracking_allocator(&tracker)) { ... } — main.vidar:47
	{
		context.allocator = mem.tracking_allocator(&tracker)
		{
			xs := make([dynamic]int)
			append(&xs, 1, 2, 3)
			fmt.println("with_allocator: allocations tracked:", len(tracker.allocation_map))
			delete(xs)
		}
	}
	fmt.println("with_allocator: all freed:", len(tracker.allocation_map) == 0)

	// locked!: the lock is held for the block and released on every exit
	mutex: sync.Mutex
	counter := 0
	threads: [4]^thread.Thread
	for &t in threads {
		t = thread.create_and_start_with_poly_data2(&mutex, &counter, proc(m: ^sync.Mutex, c: ^int) {
			for _ in 0..<1000 {
				// locked!(m) { c^ += 1 } — main.vidar:62
				{
					m__2 := m
					__vidar.lock(m__2)
					defer __vidar.unlock(m__2)
					{
						c^ += 1
					}
				}
			}
		})
	}
	for t in threads {
		thread.join(t)
		thread.destroy(t)
	}
	fmt.println("locked: counter =", counter)

	// timed!: how long a block took, printed to stderr
	// timed!("busy loop") { ... } — main.vidar:73
	{
		start__3 := __vidar.timer_start()
		defer __vidar.timer_report("busy loop", "main.vidar:73", start__3)
		{
			x := 0
			for i in 0..<1_000_000 do x += i
			_ = x
		}
	}

	// track!: in -debug builds, prints every allocation the block left live, to stderr
	kept: []int
	// track!("cache") { ... } — main.vidar:81
	{
		context.allocator = __vidar.track_begin(context.allocator)
		defer __vidar.track_end(context.allocator, "cache", "main.vidar:81")
		{
			scratch := make([dynamic]int)
			append(&scratch, 1, 2, 3)
			delete(scratch)
			kept = make([]int, 8)
		}
	}
	delete(kept)

	// do!: a block that evaluates to the value it takes
	// do! { ... } — main.vidar:90
	__do4_result: int
	__do4: {
		count := 0
		for n in 2..<30 {
			prime := true
			for d in 2..<n {
				if n % d == 0 do prime = false
			}
			if prime do count += 1
		}
		__do4_result = count
		break __do4
	}
	primes := __do4_result
	// do! { ... } — main.vidar:101
	__do5_result: int
	__do5: {
		for x in ([]int{3, 7, 8, 5}) {
			if x % 2 == 0 {
				__do5_result = x
				break __do5
			}
		}
		__do5_result = -1
		break __do5
	}
	first_even := __do5_result
	fmt.println("do:", primes, first_even, grade(95), grade(80), grade(12))

	fmt.println("mode:", parse_mode("safe"))
}
