## scoped

```vidar
main :: proc() {
	for round in 0..<3 {
		scoped! {
			label := fmt.tprintf("round %d", round)   // from the block's own temp allocator
			fmt.println(label)
		}                                           // freed here
	}
}
```

```output
round 0
round 1
round 2
```

See [Memory and Scope](ch10-01-memory-and-scope.md#scoped-a-temp-allocator-for-a-block).

## with_allocator

```vidar
main :: proc() {
	arena: mem.Arena
	buf: [512]byte
	mem.arena_init(&arena, buf[:])
	with_allocator!(mem.arena_allocator(&arena)) {
		xs := make([dynamic]int)          // from the arena
		append(&xs, 1, 2, 3)
		fmt.println(xs[:], arena.offset > 0)
	}
}
```

```output
[1, 2, 3] true
```

## locked

```vidar
Account :: struct {
	mu:      sync.Mutex,
	balance: int,
}

withdraw :: proc(a: ^Account, amount: int) -> bool {
	locked!(&a.mu) {
		if a.balance < amount do return false   // unlocked here too
		a.balance -= amount
	}
	return true
}

main :: proc() {
	a := Account{balance = 100}
	fmt.println(withdraw(&a, 30), withdraw(&a, 500), a.balance)
}
```

```output
true false 70
```

## timed

```vidar
main :: proc() {
	timed!("build table") {
		table: [1000]int
		for i in 0..<len(table) do table[i] = i * i
		fmt.println(table[999])
	}
}
```

```output
998001
```

It also prints `[timed] build table: ...` with the time to stderr.

## track

```vidar
main :: proc() {
	track!("parse") {
		kept := make([]int, 8)       // still live when the block ends
		tmp := make([]int, 4)
		delete(tmp)
		_ = kept
	}
}
```

Built with `-debug`, the block's end prints the allocation that was never freed, `kept`'s 64 bytes, with its location, to stderr. Without `-debug` the block runs untracked.

## do

```vidar
main :: proc() {
	scores := []int{72, 95, 88}
	best := do! {
		top := 0
		for s in scores do top = max(top, s)
		take top
	}
	grade := do! {
		if best >= 90 do take "A"
		take "B"
	}
	fmt.println(best, grade)
}
```

```output
95 A
```

See [Blocks That Produce a Value](ch10-03-do-blocks.md).

## comptime

```vidar
main :: proc() {
	mask := comptime! { (1 << 12) - 1 }
	squares: [5]int = comptime! {
		out: [dynamic]int
		for i in 0..<5 do append(&out, i * i)
		take out
	}
	fmt.println(mask, squares)
}
```

```output
4095 [0, 1, 4, 9, 16]
```

See [Running Code at Compile Time](ch11-03-compile-time-evaluation.md#comptime-blocks).

## dbg

```vidar
main :: proc() {
	width, height := 3, 4
	area := dbg!(width * height) * 2
	fmt.println(area)
}
```

```output
24
```

On stderr: `[main.vidar:3] width * height = 12`.

## check

```vidar,should_panic
main :: proc() {
	xs := []int{1, 2, 3}
	check!(len(xs) > 0)
	check!(xs[0] + xs[1] == xs[2], "sums")
	check!(len(xs) == 4)
}
```

```error
panic: check failed: len(xs) == 4
	len(xs) = 3
```

## move

```vidar
Box :: struct { name: string }

box_destroy :: proc(b: ^Box) {
	if b.name != "" do fmt.println("destroy", b.name)
}

impl Destroy for Box { destroy = box_destroy }

main :: proc() {
	a := Box{"crate"}
	b := move!(a)                // b owns it; a is zero
	fmt.println(a.name == "", b.name)
}
```

```output
true crate
destroy crate
```

See [Owners, Borrows and Moves](ch07-02-ownership.md#moving-with-move).

## todo

```vidar,should_panic
parse_header :: proc(data: []byte) -> int {
	todo!("headers")
}

main :: proc() {
	fmt.println(parse_header({}))
}
```

```error
panic: not yet implemented: headers
```

## unimplemented

```vidar,should_panic
encode :: proc(format: string) -> string {
	switch format {
	case "json": return "{}"
	}
	unimplemented!("only json")
}

main :: proc() {
	fmt.println(encode("json"))
	fmt.println(encode("xml"))
}
```

```output
{}
```

```error
panic: not implemented: only json
```
