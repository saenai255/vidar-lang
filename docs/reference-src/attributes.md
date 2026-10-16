## cold

```vidar
@(cold)
report_failure :: proc(code: int) {
	fmt.println("failed with", code)
}

main :: proc() {
	for code in ([]int{0, 0, 3}) {
		if code != 0 do report_failure(code)
	}
}
```

```output
failed with 3
```

## deprecated

```vidar
@(deprecated = "use area2 instead")
area :: proc(w, h: int) -> int { return w * h }

area2 :: proc(w, h: int) -> int { return w * h }

main :: proc() {
	fmt.println(area2(2, 3))
}
```

```output
6
```

A call to `area` would compile, with a warning that shows the message.

## disabled

```vidar
VERBOSE :: false

@(disabled = !VERBOSE)
trace :: proc(msg: string) {
	fmt.println("trace:", msg)
}

main :: proc() {
	trace("starting")        // removed: VERBOSE is false
	fmt.println("done")
}
```

```output
done
```

## export

```vidar,no_run
@(export)
vidar_add :: proc "c" (a, b: i32) -> i32 {
	return a + b
}

main :: proc() {}
```

Built with `vidar build . -lib` or `-dll`, the library exports the symbol `vidar_add`.

## fini

```vidar
@(fini)
goodbye :: proc "contextless" () {
	// runs after main returns
}

main :: proc() {
	fmt.println("main")
}
```

```output
main
```

## hot

```vidar,opt
@(hot)
total :: proc(xs: []int) -> (t: int) {
	for i in 0..<len(xs) do t += xs[i]      // proven in bounds: no warning
	return
}

main :: proc() {
	fmt.println(total({1, 2, 3}))
}
```

```output
6
```

With `-opt`, anything `-opt` decided against inside `total` would be a warning. See [Promises the Compiler Checks](ch15-07-checked-promises.md#hot).

## init

```vidar
TABLE: [8]int

@(init)
fill_table :: proc "contextless" () {
	for i in 0..<len(TABLE) do TABLE[i] = i * i
}

main :: proc() {
	fmt.println(TABLE[7])
}
```

```output
49
```

## link_name

```vidar
foreign import libc "system:c"

foreign libc {
	@(link_name = "strlen")
	c_strlen :: proc "c" (s: cstring) -> uint ---
}

main :: proc() {
	fmt.println(c_strlen("vidar"))
}
```

```output
5
```

## memo

```vidar
@(memo)
paths :: proc(r, c: int) -> int {     // grid paths: exponential without the memo
	if r == 0 || c == 0 do return 1
	return paths(r - 1, c) + paths(r, c - 1)
}

main :: proc() {
	fmt.println(paths(16, 16))
}
```

```output
601080390
```

See [Tables, Memoization and Specialization](ch15-05-tables-and-specialization.md#memoization).

## no_alloc

```vidar
@(no_alloc)
sum :: proc(xs: []int) -> (t: int) {
	for x in xs do t += x
	return
}

main :: proc() {
	fmt.println(sum({1, 2, 3}))
}
```

```output
6
```

Adding an `append` or a `make` to `sum`, or a call to something that does, would be a compile error. See [Promises the Compiler Checks](ch15-07-checked-promises.md#no_alloc).

## no_memo

```vidar,opt
@(no_memo)
fib :: proc(n: int) -> int {          // -opt would memoize it; this keeps the plain version
	return n if n < 2 else fib(n - 1) + fib(n - 2)
}

main :: proc() {
	fmt.println(fib(20))
}
```

```output
6765
```

## no_perfect_hash

```vidar,opt
@(no_perfect_hash)
keyword :: proc(w: string) -> int {
	switch w {
	case "if": return 1
	case "else": return 2
	case "for": return 3
	case "in": return 4
	case "do": return 5
	case "when": return 6
	case "case": return 7
	case "switch": return 8
	}
	return 0
}

main :: proc() {
	fmt.println(keyword("when"), keyword("nope"))
}
```

```output
6 0
```

## no_specialize

```vidar,opt
@(no_specialize)
repeat :: proc(s: string, n: int) -> int {
	total := 0
	for _ in 0..<n do total += len(s)
	return total
}

main :: proc() {
	fmt.println(repeat("ab", 3), repeat("abc", 2))
}
```

```output
6 6
```

## no_stack_buffer

```vidar,opt
@(no_stack_buffer)
scratch :: proc() -> int {
	buf := make([]int, 32)       // stays on the heap
	defer delete(buf)
	for i in 0..<len(buf) do buf[i] = i
	return buf[31]
}

main :: proc() {
	fmt.println(scratch())
}
```

```output
31
```

## no_table

```vidar,opt
@(no_table)
popcount :: proc(b: u8) -> int {
	n := 0
	for i in 0..<8 do if b & (1 << uint(i)) != 0 do n += 1
	return n
}

main :: proc() {
	fmt.println(popcount(0xff), popcount(5))
}
```

```output
8 2
```

## private

```vidar,project=private-attr,file=main.vidar
package main

import "core:fmt"
import "geo"

main :: proc() {
	fmt.println(geo.area(3))
	// geo.square(3) would be an error: square is private to geo
}
```

```vidar,project=private-attr,file=geo/geo.vidar
package geo

@(private)
square :: proc(x: int) -> int { return x * x }

area :: proc(side: int) -> int { return square(side) }
```

```output
9
```

## require_results

```vidar
@(require_results)
parse :: proc(s: string) -> (int, bool) {
	return strconv.parse_int(s)
}

main :: proc() {
	n, ok := parse("12")
	fmt.println(n, ok)
}
```

```output
12 true
```

Calling `parse("12")` as a statement, ignoring its results, would be a compile error.

## specialize

```vidar
@(specialize)
scale_all :: proc(xs: []int, factor: int) {
	for &x in xs do x *= factor
}

main :: proc() {
	xs := []int{1, 2, 3}
	scale_all(xs, 4)                  // calls a copy with $factor = 4
	fmt.println(xs)
}
```

```output
[4, 8, 12]
```

## static

```vidar
next_id :: proc() -> int {
	@(static) counter := 0
	counter += 1
	return counter
}

main :: proc() {
	fmt.println(next_id(), next_id(), next_id())
}
```

```output
1 2 3
```

## table

```vidar
@(table)
digit_value :: proc(c: u8) -> int {
	switch c {
	case '0'..='9': return int(c - '0')
	case 'a'..='f': return int(c - 'a') + 10
	}
	return -1
}

main :: proc() {
	fmt.println(digit_value('7'), digit_value('c'), digit_value('z'))
}
```

```output
7 12 -1
```

See [Tables, Memoization and Specialization](ch15-05-tables-and-specialization.md#lookup-tables).

## thread_local

```vidar
@(thread_local)
scratch_count: int

main :: proc() {
	scratch_count += 1
	fmt.println(scratch_count)
}
```

```output
1
```
