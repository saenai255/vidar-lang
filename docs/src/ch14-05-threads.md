# Running on Several Threads

By default, all goroutines share one thread. Build with `-define:VIDAR_THREADS=N` to run them on N threads, each with its own scheduler, run queue and event loop:

```console
$ vidar run . -define:VIDAR_THREADS=4
```

New goroutines are handed out round robin. A thread with nothing to run takes half of the runnable goroutines of another thread, so work spreads out even when it all started in one place. A goroutine may therefore resume on another thread after any call that parks or yields. Only `main`, and each scheduler thread's own stack, never moves.

## Why It's Opt-In

On one thread, memory that goroutines share without a lock is safe, since only one runs at a time. On several, it's a data race. So moving to several threads is a decision to check for those first, and the [race check](ch14-06-debugging.md#race-check) helps find them. With N above 1, channels, `select`, `Mutex` and `Wait_Group` also take a lock each, and `Rc` counts become atomic.

## What It Buys

From [`examples/fanout`](../../examples/fanout), on a 4-core linux/amd64 machine:

| Run | 1 thread | 2 threads | 4 threads |
|---|---|---|---|
| 64 CPU-bound jobs | 60 ms | 33 ms | 16 ms |
| 32 jobs that yield as they go, uneven, all started on thread 0 | 140 ms | 78 ms | 40 ms |

I/O-bound servers are another matter: an idle scheduler thread rechecks for work every 10 ms, which caps request rates, so for now prefer one thread for them.

## Thread-Local State

- Your own `@(thread_local)` variables aren't safe to use across a park in a goroutine: a read before and after it may be another thread's.
- A goroutine's `context.temp_allocator` is that of whichever thread it runs on at each call.
- `core:sync` locks park the whole thread; use `sched.Mutex` between goroutines.
