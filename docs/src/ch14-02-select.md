# Waiting on Several Things with `select`

`sched.select` waits on several channel operations at once and runs the first one that can proceed. It returns the index of that case:

```vidar
import "vidar:sched"

main :: proc() {
	slow := sched.make_chan(string)
	sched.go(proc[slow]() {
		sched.sleep(500 * time.Millisecond)
		sched.send(slow, "too late")
	})
	msg: string
	switch sched.select(sched.on_recv(slow, &msg), sched.on_recv(sched.after(10 * time.Millisecond))) {
	case 0: fmt.println(msg)
	case 1: fmt.println("timed out")
	}
}
```

<span class="caption">Listing 14-4: A receive with a timeout</span>

```output
timed out
```

The cases:

- `sched.on_recv(ch, &v)` receives into `v`; `&v` can be left out to drop the value, and `ok = &b` says whether the channel was open.
- `sched.on_send(ch, v)` sends `v`.

`sched.after(d)` is a channel that receives `true` once `d` has passed, made for timeouts like this one. `sched.sleep(d)` pauses the calling goroutine.

## Not Waiting: `try_select`

`sched.try_select` is `select` without the wait: it returns -1 at once when no case is ready.

```vidar
import "vidar:sched"

main :: proc() {
	ch := sched.make_chan(int, 1)
	i: int
	switch sched.try_select(sched.on_recv(ch, &i)) {
	case 0:  fmt.println("got", i)
	case -1: fmt.println("nothing ready")
	}
	sched.send(ch, 7)
	switch sched.try_select(sched.on_recv(ch, &i)) {
	case 0:  fmt.println("got", i)
	case -1: fmt.println("nothing ready")
	}
}
```

```output
nothing ready
got 7
```
