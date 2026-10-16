## allocator

```vidar
main :: proc() {
	arena: mem.Arena
	buf: [256]byte
	mem.arena_init(&arena, buf[:])
	context.allocator = mem.arena_allocator(&arena)   // for the rest of main
	xs := make([]int, 4)                              // from the arena
	fmt.println(len(xs), arena.offset)
}
```

```output
4 32
```

[`with_allocator!`](reference-04-macros.md#with_allocator) sets it for one block.

## assertion_failure_proc

```vidar,should_panic
on_assert :: proc(prefix, message: string, loc: runtime.Source_Code_Location) -> ! {
	fmt.println("custom handler:", message)
	runtime.trap()
}

main :: proc() {
	context.assertion_failure_proc = on_assert
	assert(1 > 2, "math is broken")
}
```

```output
custom handler: math is broken
```

## logger

```vidar
main :: proc() {
	context.logger = log.create_console_logger(.Info)
	defer log.destroy_console_logger(context.logger)
	log.debug("not shown")
	log.info("started")
}
```

The console logger writes to stderr, as `[INFO ] --- [time] [main.vidar:6:main()] started`.

## random_generator

```vidar
main :: proc() {
	state := rand.create(42)
	context.random_generator = runtime.default_random_generator(&state)
	a := rand.int_max(100)
	state = rand.create(42)
	b := rand.int_max(100)
	fmt.println(a == b)       // the same seed gives the same numbers
}
```

```output
true
```

## temp_allocator

```vidar
main :: proc() {
	for i in 0..<3 {
		label := fmt.tprintf("item %d", i)   // tprintf allocates here
		fmt.println(label)
	}
	free_all(context.temp_allocator)
}
```

```output
item 0
item 1
item 2
```

[`scoped!`](reference-04-macros.md#scoped) gives a block a temp allocator of its own.

## user_index

```vidar
depth :: proc() -> int { return context.user_index }

main :: proc() {
	context.user_index = 3
	fmt.println(depth())
}
```

```output
3
```

## user_ptr

```vidar
Config :: struct { verbose: bool }

log_line :: proc(msg: string) {
	cfg := (^Config)(context.user_ptr)
	if cfg != nil && cfg.verbose do fmt.println(msg)
}

main :: proc() {
	cfg := Config{verbose = true}
	context.user_ptr = &cfg
	log_line("hello")
}
```

```output
hello
```
