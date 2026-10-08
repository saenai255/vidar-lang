# Error handling

Odin's multiple results and `or_return` stay as they are. Three small additions cover the cases they don't:

```odin
load_config :: proc(path: string) -> (Config, Error) {
	data := os.read_entire_file(path) or_return .Read_Failed    // propagate a different error
	defer delete(data)

	parsed := json.parse(data) catch err {                     // handle inline, error bound to `err`
		log.errorf("bad config %s: %v", path, err)
		return {}, .Bad_Format
	}

	buf := make([]u8, 1024)
	errdefer delete(buf)                                        // runs only if we return a failure
	cfg := Config{raw = buf}
	validate(&cfg) or_return
	n := strconv.parse_int("42") catch unreachable             // can't fail; panics with the error if it does
	return cfg, nil
}
```

| Form | Meaning |
|---|---|
| `x := f() or_return <value>` | if `f` fails, return zero values plus `<value>` as the error |
| `x := f() catch err { ... }` | if `f` fails, run the block with the error bound to `err` (the name is optional) |
| `x := f() catch unreachable` | if `f` fails, panic with the error, reporting the source line |
| `errdefer stmt` | a `defer` that only runs when the procedure returns a failure |

- **"Fails"** follows `or_return`: the last result is `false` (an ok-bool), or not nil/zero (an error enum, union or pointer). It works for your procs and for `core:` procs alike, through a small generic check in the runtime package.
- **`or_return <value>` and `catch`** go after a call that is the whole right-hand side of `x := ...` or `x = ...`, or after a bare call statement. The declared names get the call's leading results.
- **A value starting with `-` or `&`** is ambiguous after `or_return`, because in Odin `f() or_return - 1` subtracts from the result. vidar rejects it: write `or_return (-1)` for the error value, or `(f() or_return) - 1` for the arithmetic.
- **A `catch` block after a declaration or assignment must leave the scope** (`return`, `break`, `continue`, `panic`); otherwise the values would be used unset. After a bare call it may fall through.
- **`errdefer`** looks at the procedure's last result after `return` has set it. Unnamed results are given names in the generated code, which doesn't change how the procedure is called.
- **`or_return <value>` with named results** works like Odin's `or_return`: it sets only the error result and returns, so `errdefer` sees the other results as they were when the call failed.
- **Lowering:** everything becomes plain Odin on the same line: `x, e := f(); if failed(e) { ... }` and `defer if failed(err) { ... }`.
