package main; import __vidar "vidar_runtime"

import "core:fmt"

Error :: enum { None, Bad }

step :: proc(fail: bool) -> Error {
	return fail ? .Bad : .None
}

// errdefer must see `out` as it was when `step` failed, not zeroed
read :: proc(fail: bool) -> (out: []u8, err: Error) {
	out = make([]u8, 10)
	defer if __vidar.failed(err) { {
		fmt.println("  errdefer sees len", len(out), err)
		delete(out)
	} }
	__err1 := step(fail); if __vidar.failed(__err1) { err = .Bad; return }
	return
}

// unnamed results: the caller still gets zero values plus the error
make_pair :: proc(fail: bool) -> (__r0: int, __r1: string, __err: Error) {
	n := 7
	defer if __vidar.failed(__err) { fmt.println("  errdefer (unnamed) n =", n) }
	__err2 := step(fail); if __vidar.failed(__err2) { __err = .Bad; return }
	return n, "ok", .None
}

main :: proc() {
	out, err := read(true)
	fmt.println("read(true):", err)
	out2, err2 := read(false)
	fmt.println("read(false):", len(out2), err2)
	delete(out2)

	n, s, e := make_pair(true)
	fmt.println("make_pair(true):", n, s == "", e)
	n, s, e = make_pair(false)
	fmt.println("make_pair(false):", n, s, e)
}
