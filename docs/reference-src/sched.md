## yield

```vidar
main :: proc() {
	sched.go(proc[]() { fmt.println("the other goroutine runs") })
	sched.yield()                    // let it run before main continues
	fmt.println("main continues")
}
```

```output
the other goroutine runs
main continues
```

## go

```vidar
main :: proc() {
	done := sched.make_chan(string)
	name := "worker"
	sched.go(proc[name, done]() { sched.send(done, fmt.aprintf("%s finished", name)) })
	fmt.println(sched.recv(done))
}
```

```output
worker finished
```

## blocking

```vidar
main :: proc() {
	answer := 0
	sched.blocking(proc[&answer]() {
		time.sleep(5 * time.Millisecond)     // would block the scheduler's thread
		answer = 42
	})
	fmt.println(answer)
}
```

```output
42
```

## sleep

Parks the calling goroutine for at least `d`; the others keep running.

```vidar
main :: proc() {
	sched.go(proc[]() { fmt.println("runs while main sleeps") })
	sched.sleep(10 * time.Millisecond)
	fmt.println("main woke up")
}
```

```output
runs while main sleeps
main woke up
```

## after

```vidar
main :: proc() {
	never := sched.make_chan(int)
	switch sched.select(sched.on_recv(never), sched.on_recv(sched.after(10 * time.Millisecond))) {
	case 0: fmt.println("got a value")
	case 1: fmt.println("timed out")
	}
}
```

```output
timed out
```

## listen_tcp

Opens a TCP socket listening on `endpoint`; port 0 picks a free one.

```vidar
main :: proc() {
	listener, err := sched.listen_tcp({net.IP4_Loopback, 0})
	if err != nil {
		fmt.println("listen failed:", err)
		return
	}
	defer sched.close(listener)
	ep, _ := net.bound_endpoint(listener)
	fmt.println("listening:", ep.port != 0)
}
```

```output
listening: true
```

## accept

Waits for the next connection on a listening socket, parking only this goroutine.

```vidar
serve :: proc(listener: net.TCP_Socket) {
	for {
		client, from, err := sched.accept(listener)
		if err != nil do return
		fmt.println("connection from", from)
		sched.go(proc[client]() { sched.close(client) })
	}
}
```

## dial

Connects to `endpoint`, parking only this goroutine.

```vidar
fetch_banner :: proc(ep: net.Endpoint) -> string {
	conn, err := sched.dial(ep, timeout = 2 * time.Second)
	if err != nil do return ""
	defer sched.close(conn)
	buf: [128]byte
	n, _ := sched.recv(conn, buf[:])
	return strings.clone(string(buf[:n]))
}
```

## socket_recv

Receives from a TCP socket into `buf`; with `all`, keeps going until `buf` is full. Usually called as `sched.recv(socket, buf)`.

```vidar
read_exact :: proc(conn: net.TCP_Socket, buf: []byte) -> bool {
	n, err := sched.socket_recv(conn, buf, all = true)
	return err == nil && n == len(buf)
}
```

## socket_send

Sends `buf` on a TCP socket. Usually called as `sched.send(socket, buf)`.

```vidar
say :: proc(conn: net.TCP_Socket, msg: string) -> bool {
	_, err := sched.socket_send(conn, transmute([]byte)msg)
	return err == nil
}
```

## socket_close

Closes a TCP socket. Usually called as `sched.close(socket)`.

```vidar
hang_up :: proc(conn: net.TCP_Socket) {
	sched.socket_close(conn)
}
```

## send_file

```vidar
serve_file :: proc(conn: net.TCP_Socket, path: string) {
	f, err := sched.open(path)
	if err != nil do return
	defer sched.close(f)
	sched.send_file(conn, f)          // the whole file, without copying it through memory
}
```

## wait_ready

```vidar
wait_for_input :: proc(conn: net.TCP_Socket) -> bool {
	return sched.wait_ready(conn, .Receive, timeout = time.Second) == .Ready
}
```

## udp_socket

```vidar
main :: proc() {
	sock, err := sched.udp_socket()
	fmt.println(err == nil)
	sched.close(sock)
}
```

```output
true
```

## bind

```vidar
main :: proc() {
	sock, _ := sched.udp_socket()
	defer sched.close(sock)
	err := sched.bind(sock, {net.IP4_Loopback, 0})
	fmt.println(err == nil)
}
```

```output
true
```

## send_to

```vidar
ping :: proc(to: net.Endpoint) {
	sock, _ := sched.udp_socket()
	defer sched.close(sock)
	sched.send_to(sock, transmute([]byte)string("ping"), to)
}
```

## recv_from

```vidar
echo_once :: proc(sock: net.UDP_Socket) {
	buf: [512]byte
	n, from, err := sched.recv_from(sock, buf[:])
	if err != nil do return
	sched.send_to(sock, buf[:n], from)
}
```

## udp_close

Closes a UDP socket. Usually called as `sched.close(socket)`.

```vidar
main :: proc() {
	sock, _ := sched.udp_socket()
	sched.udp_close(sock)
	fmt.println("closed")
}
```

```output
closed
```

## resolve

```vidar
main :: proc() {
	ep4, _, err := sched.resolve("localhost:8080")
	fmt.println(err == nil, ep4.port)
}
```

```output
true 8080
```

## File

```vidar
size_of_file :: proc(path: string) -> i64 {
	f: sched.File
	err: nbio.FS_Error
	f, err = sched.open(path)
	if err != nil do return -1
	defer sched.close(f)
	_, size, _ := sched.stat(f)
	return size
}
```

## open

```vidar
main :: proc() {
	path := "/tmp/vidar-open-example.txt"
	sched.write_entire_file(path, transmute([]byte)string("hello"))
	f, err := sched.open(path)                     // {.Read} by default
	defer sched.close(f)
	fmt.println(err)
}
```

```output
None
```

## read_at

```vidar
main :: proc() {
	path := "/tmp/vidar-read-at-example.txt"
	sched.write_entire_file(path, transmute([]byte)string("hello world"))
	f, _ := sched.open(path)
	defer sched.close(f)
	buf: [5]byte
	n, _ := sched.read_at(f, 6, buf[:])
	fmt.println(string(buf[:n]))
}
```

```output
world
```

## write_at

```vidar
main :: proc() {
	path := "/tmp/vidar-write-at-example.txt"
	f, _ := sched.open(path, {.Read, .Write, .Create, .Trunc})
	defer sched.close(f)
	sched.write_at(f, 0, transmute([]byte)string("vidar"))
	_, size, _ := sched.stat(f)
	fmt.println(size)
}
```

```output
5
```

## stat

```vidar
main :: proc() {
	path := "/tmp/vidar-stat-example.txt"
	sched.write_entire_file(path, transmute([]byte)string("12345678"))
	f, _ := sched.open(path)
	defer sched.close(f)
	kind, size, _ := sched.stat(f)
	fmt.println(kind, size)
}
```

```output
Regular 8
```

## file_close

Closes a file. Usually called as `sched.close(file)`.

```vidar
main :: proc() {
	path := "/tmp/vidar-close-example.txt"
	sched.write_entire_file(path, {})
	f, _ := sched.open(path)
	fmt.println(sched.file_close(f))
}
```

```output
None
```

## read_entire_file

```vidar
main :: proc() {
	path := "/tmp/vidar-read-example.txt"
	sched.write_entire_file(path, transmute([]byte)string("line one\n"))
	data, err := sched.read_entire_file(path)
	defer delete(data)
	fmt.print(err, string(data))
}
```

```output
None line one
```

## write_entire_file

```vidar
main :: proc() {
	err := sched.write_entire_file("/tmp/vidar-write-example.txt", transmute([]byte)string("saved\n"))
	fmt.println(err)
}
```

```output
None
```

## send

A proc group: `chan_send` for a channel, `socket_send` for a TCP socket.

```vidar
main :: proc() {
	ch := sched.make_chan(int, 1)
	sched.send(ch, 7)                 // chan_send
	fmt.println(sched.recv(ch))
}
```

```output
7
```

## recv

A proc group: `chan_recv` for a channel, `socket_recv` for a TCP socket.

```vidar
main :: proc() {
	ch := sched.make_chan(string, 1)
	sched.send(ch, "hi")
	v, ok := sched.recv(ch)           // chan_recv
	fmt.println(v, ok)
}
```

```output
hi true
```

## close

A proc group: `chan_close`, `socket_close`, `udp_close` or `file_close`, by the argument's type.

```vidar
main :: proc() {
	ch := sched.make_chan(int, 1)
	sched.close(ch)
	_, ok := sched.recv(ch)
	fmt.println(ok)
}
```

```output
false
```

## Mutex

```vidar
main :: proc() {
	mu: sched.Mutex
	wg: sched.Wait_Group
	count := 0
	for _ in 0..<3 {
		sched.add(&wg)
		sched.go(proc[&mu, &wg, &count]() {
			defer sched.done(&wg)
			sched.lock(&mu)
			defer sched.unlock(&mu)
			sched.sleep(time.Millisecond)     // held across a park: fine with sched.Mutex
			count += 1
		})
	}
	sched.wait(&wg)
	fmt.println(count)
}
```

```output
3
```

## lock

```vidar
main :: proc() {
	mu: sched.Mutex
	sched.lock(&mu)
	fmt.println("holding the lock")
	sched.unlock(&mu)
}
```

```output
holding the lock
```

## unlock

```vidar
main :: proc() {
	mu: sched.Mutex
	sched.lock(&mu)
	sched.unlock(&mu)
	fmt.println(sched.try_lock(&mu))      // free again
	sched.unlock(&mu)
}
```

```output
true
```

## try_lock

```vidar
main :: proc() {
	mu: sched.Mutex
	fmt.println(sched.try_lock(&mu))      // took it
	fmt.println(sched.try_lock(&mu))      // already held
	sched.unlock(&mu)
}
```

```output
true
false
```

## Chan

```vidar
producer :: proc(out: sched.Chan(int)) {
	for i in 1..=3 do sched.send(out, i)
	sched.close(out)
}

main :: proc() {
	ch := sched.make_chan(int)
	sched.go(proc[ch]() { producer(ch) })
	for {
		v := sched.recv(ch) or_break
		fmt.print(v, "")
	}
	fmt.println()
}
```

```output
1 2 3
```

## make_chan

```vidar
main :: proc() {
	unbuffered := sched.make_chan(int)
	buffered := sched.make_chan(string, 8)
	fmt.println(sched.chan_cap(unbuffered), sched.chan_cap(buffered))
}
```

```output
0 8
```

## chan_send

Usually called as `sched.send(ch, v)`.

```vidar
main :: proc() {
	ch := sched.make_chan(int, 2)
	sched.chan_send(ch, 1)
	sched.chan_send(ch, 2)
	fmt.println(sched.chan_len(ch))
}
```

```output
2
```

## chan_recv

Usually called as `sched.recv(ch)`. `ok` is false once the channel is closed and empty.

```vidar
main :: proc() {
	ch := sched.make_chan(int, 1)
	sched.send(ch, 5)
	sched.close(ch)
	a, ok1 := sched.chan_recv(ch)
	b, ok2 := sched.chan_recv(ch)
	fmt.println(a, ok1, b, ok2)
}
```

```output
5 true 0 false
```

## chan_close

Usually called as `sched.close(ch)`.

```vidar
main :: proc() {
	ch := sched.make_chan(int)
	sched.chan_close(ch)
	_, ok := sched.recv(ch)
	fmt.println(ok)
}
```

```output
false
```

## chan_len

```vidar
main :: proc() {
	ch := sched.make_chan(int, 4)
	sched.send(ch, 1)
	sched.send(ch, 2)
	fmt.println(sched.chan_len(ch))
}
```

```output
2
```

## chan_cap

```vidar
main :: proc() {
	fmt.println(sched.chan_cap(sched.make_chan(int, 16)))
}
```

```output
16
```

## Select_Case

What `on_recv` and `on_send` make, for `select`:

```vidar
main :: proc() {
	a := sched.make_chan(int, 1)
	b := sched.make_chan(int, 1)
	sched.send(b, 2)
	v: int
	cases := []sched.Select_Case{sched.on_recv(a, &v), sched.on_recv(b, &v)}
	fmt.println(sched.select(..cases), v)
}
```

```output
1 2
```

## on_recv

```vidar
main :: proc() {
	ch := sched.make_chan(int, 1)
	sched.close(ch)
	v: int
	open: bool
	switch sched.select(sched.on_recv(ch, &v, ok = &open)) {
	case 0: fmt.println("received; open:", open)
	}
}
```

```output
received; open: false
```

## on_send

```vidar
main :: proc() {
	ch := sched.make_chan(int, 1)
	switch sched.select(sched.on_send(ch, 9)) {
	case 0: fmt.println("sent", sched.recv(ch))
	}
}
```

```output
sent 9
```

## select

```vidar
main :: proc() {
	nums := sched.make_chan(int, 1)
	words := sched.make_chan(string, 1)
	sched.send(words, "hi")
	n: int
	w: string
	switch sched.select(sched.on_recv(nums, &n), sched.on_recv(words, &w)) {
	case 0: fmt.println("number", n)
	case 1: fmt.println("word", w)
	}
}
```

```output
word hi
```

## try_select

```vidar
main :: proc() {
	ch := sched.make_chan(int)
	fmt.println(sched.try_select(sched.on_recv(ch)))    // -1: nothing ready
}
```

```output
-1
```

## Wait_Group

```vidar
main :: proc() {
	wg: sched.Wait_Group
	for i in 0..<3 {
		sched.add(&wg)
		sched.go(proc[i, &wg]() {
			defer sched.done(&wg)
			sched.sleep(time.Duration(i) * time.Millisecond)
		})
	}
	sched.wait(&wg)
	fmt.println("all done")
}
```

```output
all done
```

## add

```vidar
main :: proc() {
	wg: sched.Wait_Group
	sched.add(&wg, 2)                 // two goroutines to wait for
	sched.go(proc[&wg]() { sched.done(&wg) })
	sched.go(proc[&wg]() { sched.done(&wg) })
	sched.wait(&wg)
	fmt.println("both finished")
}
```

```output
both finished
```

## done

```vidar
main :: proc() {
	wg: sched.Wait_Group
	sched.add(&wg)
	sched.go(proc[&wg]() {
		defer sched.done(&wg)            // on every path out
		fmt.println("working")
	})
	sched.wait(&wg)
}
```

```output
working
```

## wait

```vidar
main :: proc() {
	wg: sched.Wait_Group
	sched.wait(&wg)                       // nothing added: returns at once
	fmt.println("nothing to wait for")
}
```

```output
nothing to wait for
```
