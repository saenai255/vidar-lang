# Cleaning Up After a Failure with `errdefer`

A procedure that builds something up often allocates as it goes. If it succeeds, the caller takes what it built; if it fails halfway, it must free what it allocated so far. `defer` runs on every path, which is wrong for the success case. `errdefer` runs only when the procedure returns a failure:

```vidar
Error :: enum { None, Bad }

step :: proc(i: int) -> (int, Error) {
	if i > 2 do return 0, .Bad
	return i * 10, .None
}

collect :: proc(n: int) -> (values: [dynamic]int, err: Error) {
	errdefer {
		fmt.println("  failed: freeing", len(values), "values")
		delete(values)
	}
	for i in 0..<n {
		append(&values, step(i) or_return)
	}
	return values, .None
}

main :: proc() {
	ok := collect(2) catch unreachable
	fmt.println(ok[:])
	delete(ok)

	_, err := collect(5)
	fmt.println(err)
}
```

<span class="caption">Listing 6-4: Freeing a half-built result only on failure</span>

```output
[0, 10]
  failed: freeing 3 values
Bad
```

On success, `collect` hands the array to its caller and the `errdefer` doesn't run. On failure, `or_return` returns, the `errdefer` sees the failure and frees what was collected so far.

## How It Decides

`errdefer` looks at the procedure's last result *after* `return` has set it, using the same rule as everything else in this chapter: `false`, or anything but zero, is a failure. So the procedure needs a result to look at: `errdefer` in a procedure without results is an error.

Like `defer`, it takes a statement or a block, and several `errdefer`s run in reverse order, interleaved with the `defer`s of the same scope.

When the results aren't named, Vidar names them in the generated code so that `errdefer` can read them. That doesn't change how the procedure is called.

## Error Paths Are Cold

With [`-opt`](ch15-00-optimization.md), Vidar marks every failure path of `catch`, `or_return value` and `errdefer` as unlikely, so LLVM lays out the success path first. `catch unreachable`'s panic is marked cold even without `-opt`.

## Summary

- Odin's last-result convention stays; Vidar adds tools on top of it.
- `or_return value` returns your own error for any failed call.
- `catch` handles a failure in place; after a declaration its block must leave the scope; `catch unreachable` panics.
- `errdefer` cleans up only when the procedure fails.

Freeing on failure is one half of resource management. The next chapter covers the other half: freeing things automatically, on every path.
