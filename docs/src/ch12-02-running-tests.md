# Running Tests

`vidar test` transpiles the package into a temporary directory and runs `odin test` on it:

```console
$ vidar test .
[INFO ] --- [2026-10-16 09:12:40] Starting test runner with 2 threads. Set with -define:ODIN_TEST_THREADS=n.
[INFO ] --- [2026-10-16 09:12:40] The random seed sent to every test is: 15151305563346. Set with -define:ODIN_TEST_RANDOM_SEED=n.
[INFO ] --- [2026-10-16 09:12:40] Memory tracking is enabled. Tests will log their memory usage if there's an issue.
[INFO ] --- [2026-10-16 09:12:40] < Final Mem/ Total Mem> <  Peak Mem> (#Free/Alloc) :: [package.test_name]
Finished 2 tests in 210µs. All tests were successful.
```

The exit status is `odin test`'s: 0 when every test passed, so `vidar test` works in CI as it is.

## When a Test Fails

Here's a test that fails, in a package of its own:

```vidar,test,should_panic
scale :: proc(n: int) -> closure(int) -> int {
	return proc[n](x: int) -> int { return x * n }
}

@(test)
scales_by_three :: proc(t: ^testing.T) {
	triple := scale(3)
	testing.expect_value(t, triple(10), 31)
}
```

<span class="caption">Listing 12-3: A test that fails</span>

```error
[ERROR] --- [2026-10-16 09:12:40] [main.vidar:8:scales_by_three()] expected triple.call(triple.env, 10) to be 31, got 30
Finished 1 test in 1.006666ms. The test failed.
 - main.scales_by_three 	expected triple.call(triple.env, 10) to be 31, got 30
```

The location, `main.vidar:8`, is the `testing.expect_value` line of the `.vidar` file, not of the generated Odin. Failed `assert`s and panics are mapped the same way, on both stdout and stderr. The expression in the message is a different story: `testing.expect_value` prints the text of its argument as Odin compiled it, so the call through the closure shows up as the generated `triple.call(triple.env, 10)`.

## Running Some of the Tests

- `vidar test . --run scales_by_three` runs only that test. It's `-define:ODIN_TEST_NAMES=main.scales_by_three` with the package name filled in; a name that already has a package, `main.scales_by_three`, is used as it is. Several names are separated by commas.
- Flags after `--` go to `odin test`: `vidar test . -- -define:ODIN_TEST_THREADS=1` runs the tests one at a time.
- `vidar test . --watch` runs the tests again whenever a `.vidar` file of the program changes.
- `vidar test . -opt` runs them against the `-opt` build.

With several test threads, a panic's location and another test's log line can end up on one line of output, and that location isn't mapped. `-define:ODIN_TEST_THREADS=1` avoids it.

## How Locations Are Mapped

Odin prints locations in two shapes: `/path/out/main.odin(12:5)` for compile errors, panics, asserts and bounds checks, and `[main.odin:12:proc()]` for `core:log` and `core:testing`. `vidar run` and `vidar test` pass the program's output through a filter that rewrites both, using the same line map as for compile errors. Only paths of files Vidar generated are rewritten, and a line Vidar added with no source line of its own, such as helper code, keeps its generated location.

## Summary

- A test is a `@(test)` procedure taking `^testing.T`; `vidar test` runs them with `odin test`.
- Failures, asserts and panics are reported at `.vidar` lines.
- `--run` picks tests, and flags after `--` go to `odin test`.

The next chapter puts everything so far together in a command-line program.
