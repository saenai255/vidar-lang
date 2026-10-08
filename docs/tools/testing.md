# Testing

`vidar test <dir|file.vidar> [-opt] [--run <name>[,<name>...]] [-- odin flags]` transpiles the program to a temp directory and runs `odin test` on it, so `@(test)` procs taking `t: ^testing.T` work as they do in Odin. [examples/testing](../../examples/testing) keeps its tests in a file of their own, `tests.vidar`, in the same package:

```odin
@(test)
eval_errors :: proc(t: ^testing.T) {
	_, err := eval("1 +")
	testing.expect_value(t, err, Error.Unknown_Op)
}
```

- `--run eval_errors` runs only that test; it is `-define:ODIN_TEST_NAMES=main.eval_errors` with the package filled in, and a name that already has a package (`main.eval_errors`) is used as is. Flags after `--`, such as `-define:ODIN_TEST_THREADS=1`, go to `odin test`. With several test threads, a panic's location and another test's log line can land on one line of output, and that location isn't mapped; `-define:ODIN_TEST_THREADS=1` avoids it.
- Failed `testing.expect`s, failed `assert`s and panics are reported at their `.vidar` file and line, on both stdout and stderr: `[examples/testing/tests.vidar:19:eval_arithmetic()] expected got to be 15, got 14`.
- The exit status is `odin test`'s: 0 when every test passed.

**How locations are mapped:** Odin prints locations as `/path/out/main.odin(12:5)` (compile errors, panics, asserts, bounds checks) or `[main.odin:12:proc()]` (`core:log` and `core:testing`). `vidar run` and `vidar test` pass the program's stderr (and, for `test`, stdout) through a filter that rewrites both shapes with the emitter's line map, the same one used for compile errors. Only paths of files vidar generated are rewritten, and a line vidar added with no source line of its own (helper code) keeps its generated location; everything else passes through unchanged, line by line as it is printed. A partial line, such as a prompt, is written out once the program has been quiet for 50 ms. `vidar build` can't wrap the program it builds, so it writes the map to `<out>/vidar.map.json` instead, and `./out/game/game 2>&1 | vidar map out/game` (or `vidar map out/game < crash.log`) rewrites the output afterwards.
