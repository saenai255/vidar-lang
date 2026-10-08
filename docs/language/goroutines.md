# Goroutines and channels

`import "vidar:sched"` gives Go-style concurrency as a library, with no new syntax. `sched.go` runs a closure on a new goroutine, channels pass values between goroutines, and `sched.select` waits on several channel operations at once. Blocking calls look like ordinary calls. There is no `async`/`await`, so any proc can block.

```odin
import "vidar:sched"

worker :: proc(id: int, jobs: sched.Chan(int), results: sched.Chan(string)) {
	for {
		job, ok := sched.recv(jobs)           // blocks this goroutine only
		if !ok do return                      // channel closed
		sched.sleep(10 * time.Millisecond)
		sched.send(results, fmt.aprintf("worker %d did job %d", id, job))
	}
}

main :: proc() {
	jobs    := sched.make_chan(int, 10)       // buffered
	results := sched.make_chan(string)        // unbuffered
	for id in 0..<3 do sched.go(proc[id, jobs, results]() { worker(id, jobs, results) })
	for j in 0..<5 do sched.send(jobs, j)
	sched.close(jobs)

	timeout := sched.make_chan(bool, 1)
	sched.go(proc[timeout]() { sched.sleep(time.Second); sched.send(timeout, true) })
	for _ in 0..<5 {
		r: string
		switch sched.select(sched.on_recv(results, &r), sched.on_recv(timeout)) {
		case 0: fmt.println(r)
		case 1: fmt.println("timed out"); return
		}
	}
}
```

| Proc | |
|---|---|
| `go(proc[captures]() { ... })` | runs the closure on a new goroutine. The capture list decides what the goroutine gets: `[x]` copies `x` now, `[&x]` shares it |
| `make_chan(T, capacity = 0)`, `Chan(T)` | a channel and its type. Channels are handles, so copies share one queue. A zero `Chan(T)` is nil and blocks forever |
| `send(ch, v)` | blocks until a receiver takes `v`, or until there is room in the buffer |
| `v := recv(ch)`, `v, ok := recv(ch)` | blocks until a value arrives. `ok` is false once the channel is closed and drained |
| `close(ch)`, `chan_len(ch)`, `chan_cap(ch)` | close a channel, count buffered values, get the capacity |
| `select(cases...)`, `try_select(cases...)` | run the first case that can proceed and return its index. `select` waits; `try_select` returns -1 at once when nothing is ready |
| `on_recv(ch, &v = nil, ok = &b)`, `on_send(ch, v)` | the cases passed to `select` |
| `sleep(d)`, `yield()`, `after(d)` | pause this goroutine, let the others run; `after` is a channel that fires once `d` has passed, for `select` timeouts |
| `Wait_Group`, `add(&wg, n = 1)`, `done(&wg)`, `wait(&wg)` | wait for a set of goroutines |
| `Mutex`, `lock(&m)`, `unlock(&m)`, `try_lock(&m)` | a lock that parks the goroutine, not the thread, so it can be held across blocking calls |
| `listen_tcp`, `accept`, `dial`, `send(socket, buf)`, `recv(socket, buf)`, `close(socket)`, `send_file(socket, file)` | TCP |
| `udp_socket()`, `bind`, `send_to`, `recv_from`, `close(socket)` | UDP |
| `wait_ready(socket, .Receive / .Send)` | wait until a socket is readable or writable |
| `open(path, mode)`, `read_at`, `write_at`, `stat`, `close(file)`, `read_entire_file`, `write_entire_file` | files |
| `resolve("host:port")` | DNS lookup |
| `blocking(proc[captures]() { ... })` | runs the closure on a worker thread and parks this goroutine until it returns, for anything that blocks the thread and has no `sched` version: C libraries, `os` calls, heavy computation |

- **Goroutines are stackful coroutines** on one OS thread, as in Go with `GOMAXPROCS=1`. Each one has its own stack, so `defer`, `scoped!`, `context` and everything else work unchanged inside it. A goroutine inherits the `context` of the code that started it.
- **Stacks** are 256 KB with a guard page below them. Deep recursion inside a goroutine crashes on the guard page. Set the size with `-define:VIDAR_STACK_SIZE=<bytes>`. Stacks of finished goroutines are reused.
- **Every `sched` call that waits parks only the calling goroutine.**
  - Sockets and timers go through `core:nbio` (io_uring on Linux, kqueue on macOS, IOCP on Windows) on the scheduler's thread. When no goroutine can run, the scheduler blocks in the event loop until one can.
  - Files use io_uring on Linux. On other systems nbio would read regular files synchronously, so file operations go to a worker thread instead.
  - `blocking(...)` and `resolve` (the DNS resolver blocks) also run on a worker. There are 4 worker threads, each with its own event loop; set the number with `-define:VIDAR_WORKERS=<n>`.
  - **Several threads:** `-define:VIDAR_THREADS=N` (default 1) runs goroutines on N threads, each with its own scheduler, run queue and event loop. New goroutines are handed out round robin. A thread with nothing to run takes half of the runnable goroutines of another thread (the first after it that has any), whether they have run or not, so a goroutine may resume on another thread after any call that parks or yields; a wakeup queues a goroutine on the thread it last ran on, or was taken by. Only `main` (and each scheduler thread's own stack) never moves. The scheduler reads its thread-local state through a call LLVM can't merge or move, so nothing of the old thread's survives a switch. Your own `@(thread_local)` variables don't get that: one read in a goroutine before and after a park may be another thread's, and LLVM may even keep the first thread's address. Channels, `select`, `Mutex` and `Wait_Group` take a lock each, and only when `N > 1`. Memory that goroutines share without `sched.Mutex` or channels, which is safe on one thread, is a data race on several, which is why this is opt-in (the race check below finds some of them). A goroutine's `context.temp_allocator` is the temp allocator of whichever thread it runs on at each call; a temp-allocator guard (`runtime.DEFAULT_TEMP_ALLOCATOR_TEMP_GUARD`) frees nothing in a goroutine then, though `free_all` does. [examples/fanout](../../examples/fanout) runs 64 CPU-bound jobs: 60 ms on 1 thread, 33 on 2, 16 on 4 (4-core linux/amd64). With `--uneven` it runs 32 jobs that yield as they go, every fourth one 8 times longer and all of those started on thread 0, so only moving goroutines that have run spreads them: 101 ms at 4 threads before goroutines moved, 40 after (78 at 2, 140 at 1; on a loaded 4-core linux/amd64 VM). Outside Linux, file operations go to the workers too; `-define:VIDAR_FILES_ON_WORKERS=true` does that on Linux, to test that path there. A finished operation is handed back to the scheduler's event loop, which wakes the goroutine.
  - When no other goroutine is runnable or waiting on I/O, `blocking` runs the closure inline instead, since nothing could run in the meantime; a program that calls it only at startup never starts the workers.
  - A closure passed to `blocking` runs on another thread, with the goroutine's `context` but that thread's temp allocator. It must not touch state other goroutines use unless it synchronizes, and `context.allocator` must be thread-safe (the default heap allocator is).
  - Plain blocking calls such as `os.read`, `time.sleep` or `core:sync` locks still block every goroutine. Use the `sched` version, or wrap the call in `blocking`.
- **Deadlocks are detected**: if every goroutine is blocked on a channel, `Mutex`, `Wait_Group` or `select` and no I/O or timer is pending, the program panics with `all goroutines are asleep - deadlock!`. With several threads, the last thread to go idle checks: every thread idle, with no I/O pending, and every run queue empty.
- **Goroutine dump:** on a deadlock, and on SIGQUIT (Ctrl-\\, unix), every goroutine is printed to stderr before the panic: its number, what it is parked on (`chan send` / `chan receive` with the channel's address, each case of a `select`, `sched.Mutex`, `sched.Wait_Group`, `sleep`, the kind of I/O, `sched.blocking`), where it parked, where `sched.go` started it, and with several threads which thread runs it. Under `vidar run` the locations are `.vidar` lines; for a binary run by hand, `vidar map <out> < log` rewrites them. A location inside a closure body that captures variables still shows as a generated `.odin` line. The dump is on except in `-o:speed` builds; `-define:VIDAR_SCHED_DEBUG=true` turns it on there, `false` turns it off. The deadlock panic itself stays either way.
  ```
  goroutine 1 [chan receive 0x5612ec2a8098] (main):
  	parked at main.vidar(26:2)

  goroutine 4 [select] on thread 1:
  	parked at main.vidar(22:3)
  		case 0: receive on 0x7f45a0000f88
  		case 1: send on 0x7f45a0001008
  	started at main.vidar(18:2)
  ```
- **Scheduler trace:** `-define:VIDAR_SCHED_TRACE=true` makes each scheduler thread record its events in a ring buffer: `go`, each goroutine run (a slice per run), park with what it parked on, wake, steal, I/O submit and completion, and idle waits, with timestamps. When `main` returns (Odin's `@(fini)`), on a deadlock and on SIGQUIT, they are written as Chrome trace JSON to `vidar-trace.json` in the working directory, or to the file `VIDAR_TRACE_FILE` names; open it in [Perfetto](https://ui.perfetto.dev) or `chrome://tracing`. A thread keeps its last 65,536 events (`-define:VIDAR_TRACE_EVENTS=<power of two>`). A program that ends with `os.exit` writes nothing. Without the define it compiles to nothing.
- **Race check:** `-define:VIDAR_RACE=true`, given to `vidar run` / `build` / `check` (vidar then marks the writes to watch, and passes the define on to Odin), reports two writes to the same variable from different goroutines with nothing ordering them, prints both sites and keeps going:
  ```
  vidar:sched: race: goroutine 3 writes 0x56494b42fbd0 at main.odin(56:4)
  	goroutine 2 wrote it at main.odin(56:4)
  	and no channel operation, sched.Mutex, sched.Wait_Group or sched.go orders the two
  ```
  - **Watched:** assignments (`=`, `+=`, ...) to a global variable, or to a local captured by reference (`&x`), and to fields and fixed-array elements of those held in place. Each watched address has a shadow entry with its last writer and that writer's clock.
  - **Ordering:** each goroutine has a vector clock (64 slots; goroutine numbers share slots modulo 64), and so has each channel, `Mutex` and `Wait_Group`. `go` and every operation on those join the clocks both ways, which orders more than the operation does. So the check never reports two ordered writes, but misses some races.
  - **Not watched:** reads (a write racing with a read isn't reported), memory reached through a pointer, a slice, a dynamic array or a map, writes made by passing `&x` to a proc (`append(&xs, ...)`, `sched.recv` into `&x`), parameters and loop variables captured by reference, closures run by `blocking`, and `core:sync` or atomics as ordering. Each address is reported once. At most `VIDAR_RACE_TABLE` addresses (65,536, a power of two) are watched, 3/4 of them used before it stops adding.
  - It is meant for `VIDAR_THREADS>1`, and works at 1 thread too, where it finds the writes that would race on several. Without the define nothing is generated.
- **When `main` returns, the program exits**, even if goroutines are still running, as in Go.
- **The package is written in Vidar** ([src/sched.ts](../../src/sched.ts)) and bundled with the compiler. It is emitted as an ordinary package (`vidar_sched/`) next to your code, together with a 30-line assembly routine per target that swaps stacks: darwin/arm64, linux/arm64, linux/amd64 and windows/amd64 (the amd64 ones assembled with `nasm`). Other targets fail with a compile-time `#panic`. On Windows the routine also saves `xmm6` to `xmm15` (callee-saved there) and switches the thread's stack bounds in the TIB with the stack, since `__chkstk` and exception dispatch check them; `vidar_entry` has unwind info, so a stack walk ends at the bottom of a goroutine's stack. The language server completes its members, and go-to-definition opens its source.

See [examples/goroutines](../../examples/goroutines) for workers, a closed channel, `select` with a timeout, `try_select` and a TCP echo server. [examples/sched_io](../../examples/sched_io) covers `blocking`, files, DNS, UDP, `Mutex` and `after`.
