# Testing

`vidar test` runs your `@(test)` procs. It transpiles the program to a temp directory and runs `odin test` on it, so procs taking `t: ^testing.T` work as they do in Odin.

```bash
vidar test <dir|file.vidar> [-opt] [--run <name>[,<name>...]] [-- odin flags]
```

[examples/testing](../../examples/testing) keeps its tests in a file of their own, `tests.vidar`, in the same package:

```odin
@(test)
eval_errors :: proc(t: ^testing.T) {
	_, err := eval("1 +")
	testing.expect_value(t, err, Error.Unknown_Op)
}
```

## Example run

`tests/vidar_test/failing` has three tests that are meant to fail. Running it prints (trimmed):

```
[FATAL] --- [tests/vidar_test/failing/main.vidar:38:assert_fails()] runtime assertion: twice is not three
[ERROR] --- [tests/vidar_test/failing/main.vidar:31:expect_fails()] expected scale.call(scale.env, 1) to be 31, got 30
...
Finished 4 tests in 163µs. 3 tests failed.
 - main.assert_fails 	runtime assertion: twice is not three
 - main.expect_fails 	expected scale.call(scale.env, 1) to be 31, got 30
 - main.index_fails  	Signal caught: Unhandled_Trap
```

Every location points into the `.vidar` file, not the generated Odin.

## Running some tests

- **`--run eval_errors`** runs only that test. It is `-define:ODIN_TEST_NAMES=main.eval_errors` with the package filled in. A name that already has a package (`main.eval_errors`) is used as is.
- **Flags after `--`**, such as `-define:ODIN_TEST_THREADS=1`, go to `odin test`.
- **The exit status** is `odin test`'s: 0 when every test passed.

> [!NOTE]
> With several test threads, a panic's location and another test's log line can land on one line of output, and that location isn't mapped. `-define:ODIN_TEST_THREADS=1` avoids it.

## Failures at `.vidar` lines

Failed `testing.expect`s, failed `assert`s and panics are reported at their `.vidar` file and line, on both stdout and stderr:

```
[examples/testing/tests.vidar:19:eval_arithmetic()] expected got to be 15, got 14
```

## How locations are mapped

Odin prints locations in two shapes:

| Shape | Printed by |
|---|---|
| `/path/out/main.odin(12:5)` | compile errors, panics, asserts, bounds checks |
| `[main.odin:12:proc()]` | `core:log` and `core:testing` |

`vidar run` and `vidar test` pass the program's stderr (and, for `test`, stdout) through a filter that rewrites both shapes with the emitter's line map, the same one used for compile errors.

- Only paths of files vidar generated are rewritten.
- A line vidar added with no source line of its own (helper code) keeps its generated location.
- Everything else passes through unchanged, line by line as it is printed.
- A partial line, such as a prompt, is written out once the program has been quiet for 50 ms.

**`vidar build`** can't wrap the program it builds, so it writes the map to `<out>/vidar.map.json` instead. Rewrite the output afterwards:

```bash
./out/game/game 2>&1 | vidar map out/game
vidar map out/game < crash.log
```
