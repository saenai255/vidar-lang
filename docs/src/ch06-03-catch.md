# Handling a Failure in Place with `catch`

Not every failure should be passed up. Sometimes the right thing is to log it and move on, to use a fallback, or to stop a loop. `catch` runs a block when a call fails, right where the call is:

```vidar
Error :: enum { None, Bad }

step :: proc(i: int) -> (int, Error) {
	if i > 2 do return 0, .Bad
	return i * 10, .None
}

main :: proc() {
	for i in 0..<5 {
		v := step(i) catch err {
			fmt.println("step", i, "failed:", err)
			continue
		}
		fmt.println("step", i, "gave", v)
	}
}
```

<span class="caption">Listing 6-3: Handling each failure in the loop that made it</span>

```output
step 0 gave 0
step 1 gave 10
step 2 gave 20
step 3 failed: Bad
step 4 failed: Bad
```

The name after `catch` is bound to the failed result for the block; leave it out (`catch { ... }`) if you don't need it.

## The Block Must Leave

After a declaration or an assignment, the `catch` block must leave the scope, with `return`, `break`, `continue` or a panic. If it fell through, the code after it would use `v`, which the failed call never set. Vidar makes that an error:

```vidar,compile_fail
Error :: enum { None, Bad }
f :: proc() -> (int, Error) { return 1, .None }

main :: proc() {
	x := f() catch err {
		fmt.println(err)
	}
	fmt.println(x)
}
```

```error
error: a 'catch' block after a declaration or assignment must leave the scope
```

After a call that is a statement on its own, nothing is left unset, so the block may fall through:

```vidar
Error :: enum { None, Bad }
save :: proc(name: string) -> Error { return .Bad if name == "" else .None }

main :: proc() {
	save("") catch err { fmt.println("not saved:", err) }
	fmt.println("carrying on")
}
```

```output
not saved: Bad
carrying on
```

## `catch unreachable`

Some calls can't fail, given what you know: parsing a constant, opening a file the program just wrote. `catch unreachable` says so. If the call fails anyway, the program panics at that line:

```vidar,should_panic
main :: proc() {
	n := strconv.parse_int("42") catch unreachable
	fmt.println(n)
	m := strconv.parse_int("forty-two") catch unreachable
	fmt.println(m)
}
```

```output
42
```

```error
main.vidar(4:31) panic: unexpected failure
```

That's more useful than ignoring the error with `_`, and shorter than writing the check: the panic points at the line that broke the assumption.

## Where It Can Go

`catch` goes in the same places as `or_return value`: after a call that is the whole right-hand side of `x := ...` or `x = ...`, or a statement on its own. It can't follow a declaration with a type or a compound assignment like `x += f()`.
