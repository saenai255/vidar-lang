# Starting Goroutines and Passing Messages

## Starting a Goroutine

`sched.go(f)` runs the closure `f` on a new goroutine and returns at once. The capture list decides what the goroutine gets: `[x]` copies `x` when the goroutine is started, and `[&x]` shares the variable with it.

```vidar
import "vidar:sched"

main :: proc() {
	done := sched.make_chan(int, 10)
	for i in 0..<10 {
		sched.go(proc[i, done]() { sched.send(done, i * i) })   // each goroutine gets its own i
	}
	sum := 0
	for _ in 0..<10 do sum += sched.recv(done)
	fmt.println(sum)
}
```

<span class="caption">Listing 14-1: Ten goroutines, each sending a result</span>

```output
285
```

Each goroutine has its own stack, so `defer`, `context`, [destructors](ch07-00-destructors.md) and everything else work inside it as they do anywhere. A goroutine inherits the `context` of the code that started it.

When `main` returns, the program exits, even if goroutines are still running, as in Go. To wait for them, use a channel, as above, or a [`Wait_Group`](ch14-03-sharing-state.md).

## Channels

A channel passes values of one type from one goroutine to another. `sched.make_chan(T)` makes one, and `sched.Chan(T)` is its type:

- `sched.send(ch, v)` sends `v`. On an *unbuffered* channel, `make_chan(T)`, it waits until a receiver takes the value. On a *buffered* one, `make_chan(T, n)`, it waits only while the buffer holds `n` values.
- `v := sched.recv(ch)` waits until a value arrives. `v, ok := sched.recv(ch)` also says whether the channel is still open: `ok` is false once it's closed and empty.
- `sched.close(ch)` closes it: receivers drain what's left, then get `ok = false`.
- `sched.chan_len(ch)` counts the buffered values, and `sched.chan_cap(ch)` is the capacity.

Channels are handles, so copies share one queue, and capturing a channel by value in a closure is the usual way to hand it to a goroutine. A zero `Chan(T)` is nil, and blocks forever.

Closing a channel is how a producer says it's done:

```vidar
import "vidar:sched"

producer :: proc(n: int, out: sched.Chan(int)) {
	for i in 0..<n do sched.send(out, i * i)
	sched.close(out)
}

main :: proc() {
	squares := sched.make_chan(int)
	sched.go(proc[squares]() { producer(5, squares) })
	total := 0
	for {
		v, ok := sched.recv(squares)
		if !ok do break               // closed and drained
		total += v
	}
	fmt.println("sum of squares:", total)
}
```

<span class="caption">Listing 14-2: A producer that closes its channel when it's done</span>

```output
sum of squares: 30
```

## Workers

A common shape is a pool of workers taking jobs from one channel and sending results to another:

```vidar
import "vidar:sched"

worker :: proc(id: int, jobs: sched.Chan(int), results: sched.Chan(int)) {
	for {
		job, ok := sched.recv(jobs)     // parks this goroutine only
		if !ok do return
		sched.send(results, job * 10)
	}
}

main :: proc() {
	jobs := sched.make_chan(int, 10)
	results := sched.make_chan(int)
	for id in 0..<3 do sched.go(proc[id, jobs, results]() { worker(id, jobs, results) })
	for j in 1..=5 do sched.send(jobs, j)
	sched.close(jobs)
	total := 0
	for _ in 0..<5 do total += sched.recv(results)
	fmt.println(total)
}
```

<span class="caption">Listing 14-3: Three workers sharing a job queue</span>

```output
150
```

## How Goroutines Run

- **Stackful coroutines on one OS thread** by default, as in Go with `GOMAXPROCS=1`. [Several threads](ch14-05-threads.md) are opt-in.
- **Never preempted.** A goroutine runs until it parks or yields (`sched.yield()`). A long loop that never calls into `sched` holds up the others.
- **256 KB of stack each**, with a guard page below; deep recursion in a goroutine crashes on the guard page. `-define:VIDAR_STACK_SIZE=<bytes>` changes it. The stacks of finished goroutines are reused.
