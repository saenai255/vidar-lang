# How to Write Tests

A test is a procedure with the `@(test)` attribute and one parameter, `t: ^testing.T`. It checks results with `core:testing`'s procedures, and fails when one of them reports a problem, an `assert` fails, or the code panics.

```vidar,test
add_all :: proc(xs: []int, f: closure(int) -> int) -> (total: int) {
	for x in xs do total += f(x)
	return
}

@(test)
sums_squares :: proc(t: ^testing.T) {
	got := add_all({1, 2, 3}, proc[](x: int) -> int { return x * x })
	testing.expect_value(t, got, 14)
}

@(test)
uses_its_capture :: proc(t: ^testing.T) {
	offset := 10
	got := add_all({1, 2}, proc[offset](x: int) -> int { return x + offset })
	testing.expect(t, got == 23, "each element is offset by 10")
}
```

<span class="caption">Listing 12-1: Two tests of a procedure that takes a closure</span>

The checks you'll use most:

| Procedure | Fails the test when |
|---|---|
| `testing.expect(t, ok, msg?)` | `ok` is false |
| `testing.expectf(t, ok, format, args...)` | `ok` is false, with a formatted message |
| `testing.expect_value(t, got, want)` | `got != want`, printing both |
| `testing.fail_now(t, msg?)` | always, and stops the test |

`assert`, a panic, a failed bounds check and Vidar's [`check!`](ch10-02-debugging-and-assertions.md#check-assertions-that-say-what-went-wrong) also fail the test that hit them. A test that wants to stop early on a failure returns after the check, or uses `testing.fail_now`.

## Where Tests Go

Tests are ordinary procedures of the package they test, so they can call its private procedures. You can put them next to the code, or keep them in a file of their own in the same package, such as `tests.vidar`; that's what [`examples/testing`](../../examples/testing) does. `vidar new --lib` starts a library package with a test in it.

## Testing Errors

Vidar's error handling works in tests too. `catch` is a natural fit for a test that expects a call to succeed:

```vidar,test
Error :: enum { None, Bad_Number }

parse :: proc(text: string) -> (int, Error) {
	n := strconv.parse_int(text) or_return .Bad_Number
	return n, .None
}

@(test)
parses_numbers :: proc(t: ^testing.T) {
	n := parse("42") catch err {
		testing.expectf(t, false, "parse failed: %v", err)
		return
	}
	testing.expect_value(t, n, 42)
}

@(test)
rejects_words :: proc(t: ^testing.T) {
	_, err := parse("forty-two")
	testing.expect_value(t, err, Error.Bad_Number)
}
```

<span class="caption">Listing 12-2: Testing a procedure that can fail</span>
