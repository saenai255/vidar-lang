# Debugging Concurrent Programs

Concurrent programs fail in ways sequential ones don't: every goroutine waits for another, or two of them write the same variable at once. `vidar:sched` has three tools for that.

## Deadlocks

If every goroutine is blocked on a channel, `Mutex`, `Wait_Group` or `select`, and no I/O or timer is pending, nothing can ever happen again. The program panics instead of hanging, and prints every goroutine, what it waits on, and where it was started:

```vidar
import "vidar:sched"

main :: proc() {
	ch := sched.make_chan(int)
	sched.recv(ch)            // nobody will ever send
}
```

```text
vidar:sched: all goroutines are asleep - deadlock!

goroutine 1 [chan receive 0x104675958] (main):
	parked at main.vidar(5:2)
```

## The Goroutine Dump

The same dump is printed on `SIGQUIT` (Ctrl-\\ in a terminal, or `kill -QUIT <pid>`), so a program that seems stuck can be asked where each goroutine is:

```text
goroutine 4 [select] on thread 1:
	parked at main.vidar(22:3)
		case 0: receive on 0x7f45a0000f88
		case 1: send on 0x7f45a0001008
	started at main.vidar(18:2)
```

Under `vidar run`, locations are `.vidar` lines. For a binary run by hand, pipe its stderr through `vidar map <out-dir>`. The dump is on except in `-o:speed` builds; `-define:VIDAR_SCHED_DEBUG=true` or `false` overrides that.

## The Scheduler Trace

`-define:VIDAR_SCHED_TRACE=true` makes each scheduler thread record its events: starting a goroutine, each run, parks with what they wait on, wakes, steals, I/O, and idle waits. They're written as Chrome trace JSON when `main` returns, on a deadlock and on `SIGQUIT`, to `vidar-trace.json`, or to the file `VIDAR_TRACE_FILE` names. Open it in [Perfetto](https://ui.perfetto.dev) to see which goroutine ran where. Without the define, it compiles to nothing.

## Race Check

`-define:VIDAR_RACE=true`, given to `vidar run`, `build` or `check`, reports two writes to the same variable from different goroutines with nothing ordering them. It prints both places and keeps going:

```text
vidar:sched: race: goroutine 3 writes 0x56494b42fbd0 at main.vidar(56:4)
	goroutine 2 wrote it at main.vidar(56:4)
	and no channel operation, sched.Mutex, sched.Wait_Group or sched.go orders the two
```

It watches assignments to globals and to locals captured through a pointer, including their fields and fixed-array elements. It doesn't watch reads, memory reached through pointers, slices, dynamic arrays or maps, or writes made by passing `&x` to a procedure. Each goroutine carries a vector clock, and channels, locks, wait groups and `go` order them, so it never reports two writes that are ordered, but it can miss some races. It's meant for `VIDAR_THREADS` above 1, and works at 1 too, where it finds the writes that would race on several.

## Summary

- `sched.go` runs a closure as a goroutine; channels pass values, and `select` waits on several.
- A goroutine that waits parks; the others keep running. `blocking` handles calls that would block the thread.
- `Mutex` and `Wait_Group` coordinate shared state; several threads are opt-in.
- Deadlocks panic with a dump of every goroutine, and a trace and a race check are a define away.
