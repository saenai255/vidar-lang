# Failures in Odin

Everything in this section is plain Odin; it's here because Vidar's additions build on it.

## Errors Are Results

A procedure that can fail returns its error as its last result. The error can be an enum, a union of error types, a pointer, or a `bool` that says whether it worked:

```vidar
Error :: enum { None, Empty, Too_Long }

check_name :: proc(name: string) -> Error {
	if len(name) == 0 do return .Empty
	if len(name) > 8 do return .Too_Long
	return .None
}

first_char :: proc(s: string) -> (byte, bool) {
	if len(s) == 0 do return 0, false
	return s[0], true
}

main :: proc() {
	fmt.println(check_name(""), check_name("ada"))
	c, ok := first_char("vidar")
	fmt.println(rune(c), ok)
}
```

```output
Empty None
v true
```

## What Counts as a Failure

Odin's `or_return` and its relatives, and all of Vidar's additions, decide whether a call failed by looking at its **last result**. It is a failure when it is:

- `false`, for a `bool`; or
- anything but its zero value, for everything else: an enum other than its first member (here `.None`), a non-`nil` union or pointer.

That's why error enums start with a `None` member: its value is zero, and zero means success.

## `or_return`, `or_else`, `or_break` and `or_continue`

Odin has four operators that act on a failed last result:

```vidar
Error :: enum { None, Bad }

step :: proc(i: int) -> (int, Error) {
	if i > 2 do return 0, .Bad
	return i * 10, .None
}

sum_steps :: proc(n: int) -> (total: int, err: Error) {
	for i in 0..<n {
		v := step(i) or_return          // on failure, return (total, the error)
		total += v
	}
	return
}

main :: proc() {
	fmt.println(sum_steps(3))
	fmt.println(sum_steps(5))

	v := step(9) or_else -1             // on failure, use a default
	fmt.println(v)

	for i in 0..<10 {
		x := step(i) or_break           // on failure, leave the loop
		fmt.print(x, "")
	}
	fmt.println()
}
```

<span class="caption">Listing 6-1: Odin's operators for failed results</span>

```output
30 None
30 Bad
-1
0 10 20
```

Notice the second line: `sum_steps(5)` failed at `i = 3`, and returned the `total` it had reached so far, 30, along with the error. With named results, `or_return` sets only the error and returns, so the other results keep their values.

`or_return` passes the failure up *as it is*: the error that `step` returned becomes the error that `sum_steps` returns. That only works when both procedures use the same kind of error. When they don't, Odin makes you write the check out by hand:

```vidar,ignore
n, ok := strconv.parse_int(text)
if !ok do return 0, .Bad_Number
```

That's the first gap Vidar fills.
