# Loops and Bounds Checks

Odin checks every index against the length of what it indexes, and panics when it's out of range. That's a compare and a branch per access, and in a tight loop it can stop LLVM from vectorizing. Usually the loop itself already guarantees the index is in range. `-opt` notices when it does.

## Checks a Loop Already Guarantees

The check is dropped, with `#no_bounds_check` on the statement, when both of these hold:

1. The index comes from a loop over the array's length:
   - `for i in 0..<len(a)`
   - `for x, i in a`
   - `for i := 0; i < len(a); i += 1`
2. Nothing in the loop can change `a`'s length: `a` is a local or parameter that isn't reassigned, appended to, or reachable through a pointer.

Constant offsets count too: `a[i + 1]` in `for i in 0..<len(a) - 1`, and `a[i - 2]` in `for i in 2..<len(a)`.

## Checks Moved Before the Loop

Some loops index an array by the loop variable without looping over *its* length:

```vidar,opt
dot :: proc(a, b: []int) -> (d: int) {
	for x, i in a { d += x * b[i] }     // b's length is unknown here
	return
}

main :: proc() {
	fmt.println(dot({1, 2, 3}, {4, 5, 6}))
}
```

```output
32
```

These get **one** check before the loop, that `b` is long enough for every index the loop will use, and the indexes inside go unchecked:

```odin
__vidar.bounds_upto(len(a), 0, len(b)); for x, i in a { #no_bounds_check d += x * b[i] }
```

It applies when the loop runs over `lo..<n`, or `for x, i in a`, has no `break`, `return` or `or_*` in it, and indexes by plain `i` on every pass, outside any `if`. The check fails with the same index the loop would have failed on, but before the first iteration rather than at the one that would have failed.

## `reserve` Before Append Loops

A loop whose trip count is known before it starts, and that appends to a dynamic array, gets a `reserve` before it, so the array grows once instead of several times:

```odin
xs: [dynamic]int
reserve(&xs, len(xs) + n)           // added by -opt
for i in 0..<n {
	append(&xs, i * i)
}
```

Known trip counts are ranges (`a..<b`, `a..=b`), loops over a slice, array, dynamic array or string, and C-style loops `for i := a; i < n; i += 1`. Appends under an `if` count as the branch that appends most, so the reserve is an upper bound; since a reserve can't be undone, that's only done for elements of at most 16 bytes. The rewrite is skipped when the body can `break`, `continue` or `return`, when the loop can change its bounds, or when it reassigns, clears, resizes or takes the address of the array.
