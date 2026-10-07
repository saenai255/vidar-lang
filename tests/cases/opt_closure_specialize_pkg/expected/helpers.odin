package main; import __vidar "vidar_runtime"

import "core:fmt"
import "core:strings"

// called from main.vidar, another file in the same package
visit :: proc(xs: []int, f: __vidar.Closure(proc(__vidar.Env, int) -> bool)) -> int { __f_call := f.call;
	n := 0
	for x in xs do if __f_call(f.env, x) do n += 1
	b := strings.builder_make()
	defer strings.builder_destroy(&b)
	strings.write_string(&b, "visit")
	fmt.println(strings.to_string(b), n)
	return n
}

@(private = "file")
twice :: proc(x: int) -> int { return 2 * x }

scaled :: proc(xs: []int, f: __vidar.Closure(proc(__vidar.Env, int))) { __f_call := f.call;
	for x in xs do __f_call(f.env, twice(x))
}
