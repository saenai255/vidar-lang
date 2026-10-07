package main; import __vidar "vidar_runtime"

import "core:fmt"
import "core:strconv"

Error :: enum { None, Not_Found, Bad_Number, Too_Big }

Parse_Error :: union { string }

lookup :: proc(key: string) -> (string, Error) {
	switch key {
	case "port": return "8080", .None
	case "big":  return "99999", .None
	case "junk": return "x1", .None
	}
	return "", .Not_Found
}

check :: proc(n: int) -> Parse_Error {
	if n > 65535 do return fmt.tprintf("%d is out of range", n)
	return nil
}

// or_return <value>: propagate with a different error
// (strconv.parse_int reports failure with an ok-bool; Error is ours)
port :: proc(key: string) -> (int, Error) {
	text, __err1 := lookup(key); if __vidar.failed(__err1) do return {}, .Not_Found
	n, __err2 := strconv.parse_int(text); if __vidar.failed(__err2) do return {}, .Bad_Number
	__err3 := check(n); if __vidar.failed(__err3) do return {}, .Too_Big
	return n, .None
}

Buffer :: struct { data: [dynamic]int }

// errdefer: cleanup that only runs when the procedure fails
fill :: proc(key: string) -> (__r0: Buffer, __err: Error) {
	b := Buffer{}
	append(&b.data, 1, 2, 3)
	defer if __vidar.failed(__err) { {
		fmt.println("  errdefer: freeing buffer for", key)
		delete(b.data)
	} }
	p, __err4 := port(key); if __vidar.failed(__err4) { __err = .Not_Found; return }
	append(&b.data, p)
	return b, .None
}

// errdefer with named results
fill_named :: proc(key: string) -> (b: Buffer, err: Error) {
	defer if __vidar.failed(err) { fmt.println("  errdefer (named):", err) }
	__err5_v0, __err5 := port(key); if __vidar.failed(__err5) { err = .Bad_Number; return }; _ = __err5_v0
	return
}

main :: proc() {
	for key in ([]string{"port", "missing", "junk", "big"}) {
		n, err := port(key)
		fmt.println(key, "->", n, err)
	}

	fmt.println("fill:")
	ok_buf, e1 := fill("port")
	fmt.println("  ok:", ok_buf.data[:], e1)
	_, e2 := fill("junk")
	fmt.println("  failed:", e2)
	_, _ = fill_named("big")

	// catch: handle inline, with the error bound
	fmt.println("catch:")
	for key in ([]string{"port", "junk"}) {
		// n := port(key) catch err { ... } — input.vidar:71
		n, __err6 := port(key)
		if __vidar.failed(__err6) {
			err := __err6
			fmt.println("  could not read", key, "because", err)
			continue
		}
		fmt.println("  read", key, "=", n)
	}

	// catch without binding the error, on an assignment, and on a bare call
	total := 0
	{ // total = port("port") catch { ... } — input.vidar:80
		__err7_v0, __err7 := port("port")
		if __vidar.failed(__err7) {
			total = -1
			return
		}
		total = __err7_v0
	}
	{ // check(70000) catch e { ... } — input.vidar:84
		__err8 := check(70000)
		if __vidar.failed(__err8) { e := __err8; fmt.println("  check failed:", e) }
	}
	{ // port("junk") catch e { ... } — input.vidar:85
		_, __err9 := port("junk")
		if __vidar.failed(__err9) { e := __err9; fmt.println("  bare call with a value and an error:", e) }
	}
	fmt.println("  total:", total)

	// catch unreachable: the error "can't happen"; if it does, panic with it
	// sure := port("port") catch unreachable — input.vidar:89
	sure, __err10 := port("port")
	if __vidar.failed(__err10) do __vidar.unexpected(__err10)
	fmt.println("unreachable not hit:", sure)
}
