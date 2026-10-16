# Goroutines and Channels

<div class="warning">

**Goroutines are disabled for now.** They crash too often on some platforms (linux/arm64 among them), so importing `vidar:sched` is a compile error unless `VIDAR_GOROUTINES=1` is set in the environment. This chapter describes how they work when enabled; its programs are compiled by the test suite but not run.

</div>

Many programs do several things at once: a server talks to many clients, a crawler waits on many downloads, a game loads assets while it draws. Odin gives you threads and locks for that. Threads are heavy, though, and code that waits on many things at once, written with threads and callbacks, is hard to follow.

Vidar's `vidar:sched` package offers what Go does: *goroutines*, which are cheap functions running concurrently, and *channels*, which pass values between them. A goroutine that waits, for a message, a timer or a socket, *parks*, and the scheduler runs another one on the same thread. Code that waits looks like ordinary sequential code: there's no `async`, no `await` and no callbacks, and any procedure can wait.

```vidar
import "vidar:sched"

main :: proc() {
	results := sched.make_chan(string)
	for id in 0..<3 {
		sched.go(proc[id, results]() {
			sched.send(results, fmt.aprintf("worker %d done", id))
		})
	}
	for _ in 0..<3 do fmt.println(sched.recv(results))
}
```

`vidar:sched` is a library, not new syntax: `sched.go` takes a [closure](ch04-00-closures.md), and channels, `select`, locks and I/O are procedures. It comes with the compiler, written in Vidar.

- [Starting Goroutines and Passing Messages](ch14-01-goroutines-and-channels.md)
- [Waiting on Several Things with `select`](ch14-02-select.md)
- [Sharing State](ch14-03-sharing-state.md)
- [I/O That Parks Only the Goroutine](ch14-04-io.md)
- [Running on Several Threads](ch14-05-threads.md)
- [Debugging Concurrent Programs](ch14-06-debugging.md)

The [`vidar:sched` reference](reference-07-sched.md) lists every procedure.
