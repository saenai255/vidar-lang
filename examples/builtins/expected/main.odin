package main; import __vidar "vidar_runtime"

import "core:fmt"
import "core:mem"
import "core:sync"
import "core:thread"

// Every macro here is built into Vidar: no definitions, no imports.

Point :: struct { x, y: f32 }

area :: proc(w, h: int) -> int {
	{ __check_lhs := w; __check_rhs: type_of(__check_lhs) = 0; if !(__check_lhs >= __check_rhs) { __vidar.check_failed_cmp("w >= 0", "width must not be negative", "w", __check_lhs, "", __check_rhs) }; } // on failure, also prints the value of `w`
	{ __check_lhs := h; __check_rhs: type_of(__check_lhs) = 0; if !(__check_lhs >= __check_rhs) { __vidar.check_failed_cmp("h >= 0", "", "h", __check_lhs, "", __check_rhs) }; }
	return w * h
}

parse_mode :: proc(s: string) -> int {
	switch s {
	case "fast": return 1
	case "safe": return 2
	case "gpu":  __vidar.not_done("not implemented", "no GPU backend")
	}
	__vidar.not_done("not yet implemented", "decide what unknown modes do")
}

main :: proc() {
	// format!: string interpolation
	name := "vidar"
	p := Point{1.5, -2}
	fmt.println(__vidar.tprintf("hello %v, p = %v, x = %.2f, sum = %v", name, p, p.x, (p.x + p.y)))
	fmt.println(__vidar.tprintf("{{literal braces}} and 100%%"))

	// dbg!: prints the source location, expression and value to stderr, and passes the value through
	total := __vidar.dbg(area(3, 4), "area(3, 4)", "main.vidar:35") + 1
	fmt.println("total:", total)

	// check!: an assert that explains itself
	{ __check_lhs := total; __check_rhs: type_of(__check_lhs) = 13; if !(__check_lhs == __check_rhs) { __vidar.check_failed_cmp("total == 13", "", "total", __check_lhs, "", __check_rhs) }; }
	{ __check_lhs := len(name); __check_rhs: type_of(__check_lhs) = 0; if !(__check_lhs > __check_rhs) { __vidar.check_failed_cmp("len(name) > 0", "name is required", "len(name)", __check_lhs, "", __check_rhs) }; }

	// with_allocator!: a block that allocates from a specific allocator
	tracker: mem.Tracking_Allocator
	mem.tracking_allocator_init(&tracker, context.allocator)
	{ context.allocator = mem.tracking_allocator(&tracker); {
		xs := make([dynamic] int);
		append(&xs, 1, 2, 3);
		fmt.println("with_allocator: allocations tracked:", len(tracker.allocation_map));
		delete(xs);
	}; }
	fmt.println("with_allocator: all freed:", len(tracker.allocation_map) == 0)

	// locked!: the lock is held for the block and released on every exit
	mutex: sync.Mutex
	counter := 0
	threads: [4]^thread.Thread
	for &t in threads {
		t = thread.create_and_start_with_poly_data2(&mutex, &counter, proc(m: ^sync.Mutex, c: ^int) {
			for _ in 0..<1000 {
				{ m__1 := m; __vidar.lock(m__1); defer __vidar.unlock(m__1); { c^ += 1 }; }
			}
		})
	}
	for t in threads {
		thread.join(t)
		thread.destroy(t)
	}
	fmt.println("locked: counter =", counter)

	// timed!: how long a block took, printed to stderr
	{ start__2 := __vidar.timer_start(); defer __vidar.timer_report("busy loop", "main.vidar:71", start__2); {
		x := 0;
		for i in 0..<1_000_000 do x += i;
		_ = x;
	}; }

	// track!: in -debug builds, prints every allocation the block left live, to stderr
	kept: []int
	{ context.allocator = __vidar.track_begin(context.allocator); defer __vidar.track_end(context.allocator, "cache", "main.vidar:79"); {
		scratch := make([dynamic] int);
		append(&scratch, 1, 2, 3);
		delete(scratch);
		kept = make([] int, 8); // reported: still live when the block ends
	}; }
	delete(kept)

	fmt.println("mode:", parse_mode("safe"))
}
