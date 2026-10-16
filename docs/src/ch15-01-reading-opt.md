# Seeing What `-opt` Does

Let's start with a program of ordinary Odin, and look at what `-opt` makes of it.

```vidar,opt
squares :: proc(n: int) -> [dynamic]int {
	xs: [dynamic]int
	for i in 0..<n { append(&xs, i * i) }
	return xs
}

dot :: proc(a, b: []int) -> (d: int) {
	for x, i in a { d += x * b[i] }
	return
}

sum :: proc(a: []int) -> (t: int) {
	for i in 0..<len(a) do t += a[i]
	return
}

scratch :: proc() -> int {
	buf := make([]int, 64)
	defer delete(buf)
	for i in 0..<len(buf) do buf[i] = i
	return buf[10]
}

collatz :: proc(b: u8) -> int {
	n := int(b) + 1
	steps := 0
	for n != 1 {
		n = n / 2 if n % 2 == 0 else 3 * n + 1
		steps += 1
	}
	return steps
}

main :: proc() {
	xs := squares(5)
	defer delete(xs)
	fmt.println(xs[:], dot(xs[:], xs[:]), sum(xs[:]), scratch(), collatz(26))
}
```

<span class="caption">Listing 15-1: Plain Odin that `-opt` can improve</span>

```output
[0, 1, 4, 9, 16] 354 30 10 111
```

## The Report

`-opt-report` stands in for `-opt` and also prints every decision, as `file:line: name: label: reason`:

```console
$ vidar emit . -opt-report > /dev/null
main.vidar:1: squares: not specialized: every call passes n = 5, which LLVM folds without a copy
main.vidar:3: reserved: xs: reserved before the loop, 1 append per iteration
main.vidar:8: bounds hoisted: one check before the loop that b is long enough for every index; the indexes inside are unchecked
main.vidar:8: unchecked: every index here is proven in bounds, by its loop or by one check before it, so it gets #no_bounds_check
main.vidar:13: unchecked: every index here is proven in bounds by its loop, so it gets #no_bounds_check
main.vidar:18: stack buffer: buf: 64 elements (~512 bytes) on the stack instead of the heap; the defer's delete goes away
main.vidar:20: unchecked: every index here is proven in bounds by its loop, so it gets #no_bounds_check
main.vidar:24: collatz: table: 256 results, has a loop, pure integer code
main.vidar:37: fmt inlined: a compiled format: writes each piece directly, no format parsing or `any` boxing at run time
```

## The Output

`vidar emit . -opt` shows the result. Every line kept its place:

```odin
squares :: proc(n: int) -> [dynamic]int {
	xs: [dynamic]int
	reserve(&xs, len(xs) + n)
	for i in 0..<n { append(&xs, i * i) }
	return xs
}

dot :: proc(a, b: []int) -> (d: int) {
	__vidar.bounds_upto(len(a), 0, len(b)); for x, i in a { #no_bounds_check d += x * b[i] }
	return
}

sum :: proc(a: []int) -> (t: int) {
	for i in 0..<len(a) do #no_bounds_check t += a[i]
	return
}

scratch :: proc() -> int {
	__buf_buf: [64]int; buf := __buf_buf[:]
	/* delete(buf): buf is on the stack */
	for i in 0..<len(buf) do #no_bounds_check buf[i] = i
	return buf[10]
}

collatz :: #force_inline proc(b: u8) -> int { return __collatz_table[b] }
```

`squares` grows its array once, before the loop. `dot` checks once that `b` is long enough, then indexes it unchecked. `sum` drops a bounds check its loop already guarantees. `scratch`'s buffer lives on the stack. And `collatz` became a lookup in a 256-entry table that Vidar computed while compiling. The next sections explain each rewrite.

## Hint Labels

The label is the second field of each report line. Labels that start with "no" or "not" are decisions *against* a rewrite.

| Label | Meaning |
|---|---|
| `table`, `table 2D` / `no table` | a lookup table was made, or why not |
| `specialized ×N` / `not specialized` | N copies for constant arguments, or why not |
| `unchecked` | every index is proven in bounds |
| `bounds hoisted` | one check before the loop |
| `no bounds proof` | an index keeps its check inside a loop |
| `reserved` / `not reserved` | `reserve` added before an append loop, or why not |
| `grouped alloc` | adjacent allocations became one |
| `stack buffer` / `no stack buffer` | a constant-size `make` went on the stack, or why not |
| `#soa` / `not #soa` | an array of structs became `#soa`, or why not |
| `reordered` / `not reordered` | struct fields packed by alignment, or why not |
| `value interface` / `no value interface` | an interface array holds its values inline, or why not |
| `perfect hash` / `no perfect hash` | a string switch uses a perfect hash, or why not |
| `memo` / `no memo` | a self-recursive procedure is memoized, or why not |
| `fmt inlined` | a `fmt` call with a literal format was compiled |
| `json unmarshal` / `no json unmarshal` | a generated JSON reader, or why not |
| `closure inlined` / `closure not inlined` | a closure literal got a direct-call copy of its callee, or why not |
| `direct`, `devirtualized`, `vtable` | how an interface method call is made |
| `no direct call` | a call goes through a closure value |
| `cold failure` | an error path was marked unlikely |

## In the Editor

The language server shows the same decisions as inlay hints, without building with `-opt`: `table` after a procedure's name, `unchecked` after a statement, `direct` after a method call. The tooltip gives the reason. By default it shows decisions for a rewrite; set `optHints` to `"all"` to see decisions against too. A code lens over each procedure counts its decisions. See [Editors and the Language Server](ch16-03-language-server.md).

## Opting Out

Each automatic choice that changes a procedure's shape has an attribute that keeps a procedure out of it, for example to keep a baseline to benchmark against:

| Attribute | Keeps the procedure out of |
|---|---|
| `@(no_table)` | automatic lookup tables |
| `@(no_specialize)` | automatic specialized copies |
| `@(no_memo)` | automatic memoization |
| `@(no_stack_buffer)` | stack buffers for constant-size `make`s |
| `@(no_perfect_hash)` | perfect-hash string switches |
