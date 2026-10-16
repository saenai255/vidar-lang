# Memory and Scope

These macros take a block, `name! { ... }` or `name!(args) { ... }`, and run it with something set up beforehand and undone afterwards, on every path out of the block: its end, a `return`, a `break`, a panic's unwinding aside.

## `scoped!`: A Temp Allocator for a Block

`context.temp_allocator` is Odin's arena for short-lived memory: allocate freely, then free everything at once with `free_all`. The catch is "at once": a long-running loop that allocates temporaries on every iteration has to free them somewhere, and a `free_all` in the wrong place frees memory something else still uses.

`scoped!` gives a block a temp allocator of its own and frees everything allocated from it when the block ends:

```vidar
report :: proc(names: []string) {
	fmt.println(len(names), "names, the last one", names[len(names) - 1])
}

main :: proc() {
	for round in 0..<2 {
		scoped! {
			names := make([dynamic]string, context.temp_allocator)
			for i in 0..<1000 do append(&names, fmt.tprintf("item-%d-%d", round, i))
			report(names[:])
		}   // everything allocated from the temp allocator above is freed here
	}
}
```

<span class="caption">Listing 10-1: Each round's temporaries are freed when its block ends</span>

```output
1000 names, the last one item-0-999
1000 names, the last one item-1-999
```

`fmt.tprintf` allocates from `context.temp_allocator`, so inside the block it uses the block's arena too. Code called from the block sees the same `context`, so it does as well.

`scoped!(allocator) { ... }` takes the arena's memory from `allocator` instead of `context.allocator`.

## `with_allocator!`: Choose the Block's Allocator

`with_allocator!(a) { ... }` makes `a` the block's `context.allocator`, so every `make`, `new` and `append` in it, and in what it calls, allocates from `a`:

```vidar
main :: proc() {
	arena: mem.Arena
	buf: [1024]byte
	mem.arena_init(&arena, buf[:])
	with_allocator!(mem.arena_allocator(&arena)) {
		ys := make([]int, 4)            // from the arena, in buf
		fmt.println(len(ys), arena.offset)
	}
}
```

```output
4 32
```

## `locked!`: Hold a Lock for a Block

`locked!(&m) { ... }` locks `m`, runs the block, and unlocks it on every exit, so an early `return` can't leave it held. It works with any lock type from `core:sync`, and with `vidar:sched`'s `Mutex`:

```vidar
Counter :: struct {
	mu:    sync.Mutex,
	count: int,
}

bump :: proc(c: ^Counter, by: int) -> bool {
	locked!(&c.mu) {
		if by < 0 do return false      // unlocked here too
		c.count += by
	}
	return true
}

main :: proc() {
	c: Counter
	bump(&c, 2)
	fmt.println(bump(&c, -1), c.count)
}
```

```output
false 2
```
