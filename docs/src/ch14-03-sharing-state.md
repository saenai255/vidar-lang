# Sharing State

Channels pass values from one goroutine to another, which is often all the coordination a program needs. When goroutines do share memory, `vidar:sched` has a lock and a way to wait for a group.

## `Wait_Group`

A `Wait_Group` counts goroutines still working: `sched.add(&wg)` before starting one, `sched.done(&wg)` when it finishes, and `sched.wait(&wg)` parks until the count is back to zero.

## `Mutex`

`sched.Mutex` is a lock for goroutines: `sched.lock(&m)`, `sched.unlock(&m)` and `sched.try_lock(&m)`. Unlike `core:sync`'s locks, it parks the goroutine that waits for it, not the thread, so it can be held across a call that waits.

```vidar
import "vidar:sched"

main :: proc() {
	wg: sched.Wait_Group
	mu: sched.Mutex
	total := 0
	for i in 1..=4 {
		sched.add(&wg)
		sched.go(proc[i, &wg, &mu, &total]() {     // &total is shared; i is copied
			defer sched.done(&wg)
			sched.lock(&mu)
			defer sched.unlock(&mu)
			total += i
		})
	}
	sched.wait(&wg)
	fmt.println(total)
}
```

<span class="caption">Listing 14-5: Four goroutines adding to a shared total under a lock</span>

```output
10
```

[`locked!(&mu) { ... }`](ch10-01-memory-and-scope.md#locked-hold-a-lock-for-a-block) works with `sched.Mutex` too.

Capturing `&wg`, `&mu` and `&total` is safe here only because `main` waits for every goroutine before it returns. Starting a goroutine that holds `&x` of a local is an error everywhere but in `main`, whose locals live until the program exits; elsewhere, share state through a pointer from `new_clone`, or through channels. See [How Long a Closure Can Live](ch04-04-closure-lifetimes.md).

On one thread, which is the default, goroutines never run at the same time, so memory they share can't be corrupted by two of them at once; the lock above matters only once they run on [several threads](ch14-05-threads.md), or when a goroutine parks while it's halfway through an update.
