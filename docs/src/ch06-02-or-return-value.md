# Returning a Different Error

When a call fails with one kind of error and your procedure reports another, write the error to return after `or_return`:

```vidar
Error :: enum { None, Bad_Number, Out_Of_Range }

parse_port :: proc(text: string) -> (int, Error) {
	n := strconv.parse_int(text) or_return .Bad_Number    // a bool failure becomes .Bad_Number
	if n < 1 || n > 65535 do return 0, .Out_Of_Range
	return n, .None
}

main :: proc() {
	fmt.println(parse_port("8080"))
	fmt.println(parse_port("eighty"))
	fmt.println(parse_port("99999"))
}
```

<span class="caption">Listing 6-2: `or_return` with the error to return</span>

```output
8080 None
0 Bad_Number
0 Out_Of_Range
```

If `strconv.parse_int` fails, `parse_port` returns at once, with the zero value for each result before the last and `.Bad_Number` as the error. If it succeeds, `n` holds the number.

`or_return value` works for any kind of failure, `bool` or error value, and returns any value your procedure's last result can hold. Unlike Odin's `or_return`, it doesn't need named results when there are several, since it knows what to return.

## Named Results

When the procedure's results are named, `or_return value` sets only the error result and returns, the way Odin's `or_return` does. The other results keep whatever they held when the call failed. That matters for [`errdefer`](ch06-04-errdefer.md), which runs after it and sees them.

## Where It Can Go

`or_return value` follows a call that is:

- the whole right-hand side of a declaration, `x := f() or_return .Err`, or an assignment, `x = f() or_return .Err`; the names on the left get the call's results before the last;
- a statement on its own, `f() or_return .Err`.

It can't go inside a larger expression, or after a declaration with a type (`x: int = f() or_return .Err`); declare with `:=` instead.

## A Value Starting with `-` or `&`

In Odin, `f() or_return - 1` is arithmetic: `or_return`, then subtract 1 from the result. So a value starting with `-` or `&` after `or_return` is ambiguous, and Vidar rejects it:

```vidar,compile_fail
f :: proc() -> (int, bool) { return 5, true }

g :: proc() -> (r: int, ok: int) {
	x := f() or_return -1
	return x, 0
}
```

```error
error: ambiguous '-' after 'or_return'
```

Write `or_return (-1)` for the error value, or `(f() or_return) - 1` for the arithmetic.
