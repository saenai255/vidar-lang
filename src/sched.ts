/**
 * The "vidar:sched" package, bundled with the compiler: goroutines, channels, select and
 * blocking I/O. Goroutines are stackful coroutines on one OS thread: a small assembly routine
 * swaps stacks, and blocking I/O parks the goroutine on a core:nbio operation, so the scheduler
 * polls the event loop when nothing else can run. A goroutine is started from a closure:
 * `sched.go(proc[x]() { ... })`.
 */

export const SCHED_IMPORT = "vidar:sched";

export const SCHED_SOURCE = String.raw`package sched

import "base:runtime"
import "core:mem"
import "core:mem/virtual"
import "core:nbio"
import "core:net"
import "core:sync"
import "core:thread"
import "core:time"

when ODIN_OS == .Darwin && ODIN_ARCH == .arm64 {
	foreign import switcher "switch_darwin_arm64.asm"
} else when ODIN_OS == .Linux && ODIN_ARCH == .arm64 {
	foreign import switcher "switch_linux_arm64.asm"
} else when ODIN_OS == .Linux && ODIN_ARCH == .amd64 {
	foreign import switcher "switch_linux_amd64.asm"
} else {
	#panic("vidar:sched: goroutines are not supported on this target yet")
}

@(default_calling_convention = "c")
foreign switcher {
	vidar_switch :: proc(save: ^rawptr, to: rawptr) ---
	vidar_entry :: proc() ---
}

STACK_SIZE :: #config(VIDAR_STACK_SIZE, 256 * mem.Kilobyte)
GUARD_SIZE :: 16 * mem.Kilobyte
POLL_EVERY :: 61
WORKERS :: #config(VIDAR_WORKERS, 4)

@(private)
G :: struct {
	sp:    rawptr,
	stack: []byte,
	task:  closure(),
	ctx:   runtime.Context,
	next:  ^G,
}

@(private)
Scheduler :: struct {
	inited:      bool,
	main:        G,
	cur:         ^G,
	head, tail:  ^G,
	zombie:      ^G,
	io_waiting:  int,
	since_poll:  int,
	free_stacks: [dynamic][]byte,
	loop:        ^nbio.Event_Loop,
}

@(private, thread_local)
sched: Scheduler

@(private)
sched_init :: proc() {
	if sched.inited do return
	sched.inited = true
	sched.cur = &sched.main
	sched.free_stacks.allocator = runtime.heap_allocator()
	err := nbio.acquire_thread_event_loop()
	assert(err == nil, "vidar:sched: could not start the I/O event loop")
	sched.loop = nbio.current_thread_event_loop()
}

@(private)
ready :: proc(g: ^G) {
	g.next = nil
	if sched.tail == nil {
		sched.head = g
	} else {
		sched.tail.next = g
	}
	sched.tail = g
}

@(private)
pop_ready :: proc() -> ^G {
	g := sched.head
	if g == nil do return nil
	sched.head = g.next
	if sched.head == nil do sched.tail = nil
	return g
}

// The next goroutine to run; polls the event loop now and then, and blocks on it when nothing is runnable.
@(private)
pick :: proc() -> ^G {
	sched.since_poll += 1
	if sched.io_waiting > 0 && sched.since_poll >= POLL_EVERY {
		sched.since_poll = 0
		nbio.tick(0)
	}
	for {
		if g := pop_ready(); g != nil do return g
		if sched.io_waiting == 0 do panic("all goroutines are asleep - deadlock!")
		sched.since_poll = 0
		// ops done without the kernel complete at tick start, then the tick blocks anyway
		nbio.tick(0)
		if g := pop_ready(); g != nil do return g
		nbio.tick()
	}
}

// A finished goroutine can't free its own stack, so the next one to run does.
@(private)
reap :: proc() {
	z := sched.zombie
	if z == nil || z == sched.cur do return
	sched.zombie = nil
	append(&sched.free_stacks, z.stack)
	free(z, runtime.heap_allocator())
}

// Suspends the current goroutine until something makes it ready again.
@(private)
park :: proc() {
	from := sched.cur
	next := pick()
	if next == from do return
	sched.cur = next
	vidar_switch(&from.sp, next.sp)
	reap()
}

@(private)
block_forever :: proc() -> ! {
	sched_init()
	for {
		park()
	}
}

// Lets the other runnable goroutines run before this one continues.
yield :: proc() {
	sched_init()
	ready(sched.cur)
	park()
}

@(private)
new_stack :: proc() -> []byte {
	if len(sched.free_stacks) > 0 do return pop(&sched.free_stacks)
	stack, err := virtual.reserve_and_commit(STACK_SIZE)
	assert(err == nil, "vidar:sched: out of memory for a goroutine stack")
	virtual.protect(raw_data(stack), GUARD_SIZE, virtual.Protect_No_Access)
	return stack
}

// Runs the closure on a new goroutine, with the caller's context.
go :: proc(task: closure()) {
	sched_init()
	g := new(G, runtime.heap_allocator())
	g.stack = new_stack()
	g.task = task
	g.ctx = context
	top := (uintptr(raw_data(g.stack)) + uintptr(len(g.stack))) &~ 15
	when ODIN_ARCH == .arm64 {
		// vidar_switch's frame: x19..x28, x29, x30, d8..d15
		frame := ([^]uintptr)(rawptr(top - 160))
		mem.zero(frame, 160)
		frame[0] = uintptr(g)
		frame[11] = uintptr(rawptr(vidar_entry))
	} else {
		// r15, r14, r13, r12, rbx, rbp, return address
		frame := ([^]uintptr)(rawptr(top - 72))
		mem.zero(frame, 72)
		frame[3] = uintptr(g)
		frame[6] = uintptr(rawptr(vidar_entry))
	}
	g.sp = frame
	ready(g)
}

@(private, export, link_name = "vidar_go_start")
go_start :: proc "c" (g: ^G) {
	context = g.ctx
	reap()
	g.task()
	sched.zombie = g
	next := pick()
	sched.cur = next
	vidar_switch(&g.sp, next.sp)
	unreachable()
}

// ---- I/O: start an nbio operation, park, resume from its callback ----

@(private)
Io_Wait :: struct {
	g:      ^G,
	result: nbio.Operation,
	task:   closure(),
	ctx:    runtime.Context,
}

@(private)
io_done :: proc(op: ^nbio.Operation) {
	w := (^Io_Wait)(op.user_data[0])
	w.result = op^
	sched.io_waiting -= 1
	ready(w.g)
}

// Starts op and parks until its callback (on this thread's loop, or a worker's) resumes us.
@(private)
await_op :: proc(op: ^nbio.Operation) -> nbio.Operation {
	w := Io_Wait{g = sched.cur}
	op.user_data[0] = &w
	sched.io_waiting += 1
	nbio.exec(op)
	park()
	return w.result
}

// ---- worker threads: each runs its own event loop, for blocking calls and (outside Linux) files ----

@(private)
Workers :: struct {
	once:  sync.Once,
	loops: [WORKERS]^nbio.Event_Loop,
	ready: sync.Sema,
	next:  int,
}

@(private)
workers: Workers

@(private)
worker_main :: proc(slot: ^^nbio.Event_Loop) {
	err := nbio.acquire_thread_event_loop()
	assert(err == nil, "vidar:sched: could not start a worker event loop")
	slot^ = nbio.current_thread_event_loop()
	sync.sema_post(&workers.ready)
	for {
		nbio.tick()
	}
}

// The next worker's event loop, round robin; the workers start on first use.
@(private)
worker_loop :: proc() -> ^nbio.Event_Loop {
	sync.once_do(&workers.once, proc() {
		for &slot in workers.loops {
			thread.create_and_start_with_poly_data(&slot, worker_main, self_cleanup = true)
		}
		for _ in 0..<WORKERS do sync.sema_wait(&workers.ready)
	})
	workers.next = (workers.next + 1) % WORKERS
	return workers.loops[workers.next]
}

// Runs on a worker: hands the finished operation back to the goroutine's own loop.
@(private)
worker_done :: proc(op: ^nbio.Operation) {
	w := (^Io_Wait)(op.user_data[0])
	w.result = op^
	// not 0: a zero timeout arriving between pick's poll and wait wouldn't end the wait
	back := nbio.prep_timeout(time.Nanosecond, resume_from_worker, sched_loop_of(op))
	back.user_data[0] = w
	nbio.exec(back)
}

@(private)
resume_from_worker :: proc(op: ^nbio.Operation) {
	w := (^Io_Wait)(op.user_data[0])
	sched.io_waiting -= 1
	ready(w.g)
}

@(private)
sched_loop_of :: proc(op: ^nbio.Operation) -> ^nbio.Event_Loop {
	return (^nbio.Event_Loop)(op.user_data[1])
}

// Like await_op, for an operation prepared on a worker's loop with worker_done as its callback.
@(private)
await_on_worker :: proc(op: ^nbio.Operation) -> nbio.Operation {
	w := Io_Wait{g = sched.cur}
	op.user_data[0] = &w
	op.user_data[1] = sched.loop
	sched.io_waiting += 1
	nbio.exec(op)
	park()
	return w.result
}

@(private)
run_blocking :: proc(op: ^nbio.Operation) {
	w := cast(^Io_Wait)op.user_data[0]
	temp := context.temp_allocator
	context = w.ctx
	context.temp_allocator = temp
	w.task()
	worker_done(op)
}

// Runs task on a worker thread and parks this goroutine until it returns; the other goroutines keep running.
// Use it for calls that block the thread: DNS, C libraries, anything without a sched version.
// The task runs on another thread, so it must not touch goroutine state without synchronizing.
blocking :: proc(task: closure()) {
	sched_init()
	// nothing else could run meanwhile, so skip starting the workers
	if sched.head == nil && sched.io_waiting == 0 {
		task()
		return
	}
	w := Io_Wait{g = sched.cur, task = task, ctx = context}
	op := nbio.prep_timeout(0, run_blocking, worker_loop())
	op.user_data[0] = &w
	op.user_data[1] = sched.loop
	sched.io_waiting += 1
	nbio.exec(op)
	park()
}

// File operations run on io_uring on Linux; elsewhere nbio does them synchronously, so they go to a worker.
@(private)
FILES_ON_WORKERS :: ODIN_OS != .Linux

@(private)
file_loop :: proc() -> ^nbio.Event_Loop {
	when FILES_ON_WORKERS do return worker_loop()
	else do return nil
}

@(private)
file_cb :: proc() -> nbio.Callback {
	when FILES_ON_WORKERS do return worker_done
	else do return io_done
}

@(private)
await_file :: proc(op: ^nbio.Operation) -> nbio.Operation {
	when FILES_ON_WORKERS do return await_on_worker(op)
	else do return await_op(op)
}

// ---- timers ----

sleep :: proc(d: time.Duration) {
	sched_init()
	await_op(nbio.prep_timeout(d, io_done))
}

// A channel that receives true once d has passed, for select timeouts.
after :: proc(d: time.Duration) -> Chan(bool) {
	c := make_chan(bool, 1)
	go(proc[d, c]() {
		sleep(d)
		chan_send(c, true)
	})
	return c
}

// ---- TCP ----

listen_tcp :: proc(endpoint: nbio.Endpoint, backlog := 1000) -> (nbio.TCP_Socket, nbio.Network_Error) {
	sched_init()
	return nbio.listen_tcp(endpoint, backlog)
}

accept :: proc(socket: nbio.TCP_Socket, timeout := nbio.NO_TIMEOUT) -> (nbio.TCP_Socket, nbio.Endpoint, nbio.Accept_Error) {
	sched_init()
	r := await_op(nbio.prep_accept(socket, io_done, timeout))
	return r.accept.client, r.accept.client_endpoint, r.accept.err
}

dial :: proc(endpoint: nbio.Endpoint, timeout := nbio.NO_TIMEOUT) -> (nbio.TCP_Socket, nbio.Network_Error) {
	sched_init()
	r := await_op(nbio.prep_dial(endpoint, io_done, timeout))
	return r.dial.socket, r.dial.err
}

socket_recv :: proc(socket: nbio.TCP_Socket, buf: []byte, all := false, timeout := nbio.NO_TIMEOUT) -> (int, nbio.Recv_Error) {
	sched_init()
	bufs := [1][]byte{buf}
	r := await_op(nbio.prep_recv(socket, bufs[:], io_done, all, timeout))
	return r.recv.received, r.recv.err
}

socket_send :: proc(socket: nbio.TCP_Socket, buf: []byte, timeout := nbio.NO_TIMEOUT) -> (int, nbio.Send_Error) {
	sched_init()
	bufs := [1][]byte{buf}
	r := await_op(nbio.prep_send(socket, bufs[:], io_done, timeout = timeout))
	return r.send.sent, r.send.err
}

socket_close :: proc(socket: nbio.TCP_Socket) {
	sched_init()
	await_op(nbio.prep_close(socket, io_done))
}

// Sends nbytes of file (all of it by default) over the socket, without copying it through user space.
send_file :: proc(socket: nbio.TCP_Socket, file: File, offset := 0, nbytes := nbio.SEND_ENTIRE_FILE, timeout := nbio.NO_TIMEOUT) -> (int, nbio.Send_File_Error) {
	sched_init()
	r := await_op(nbio.prep_sendfile(socket, file, io_done, offset, nbytes, timeout = timeout))
	return r.sendfile.sent, r.sendfile.err
}

// Waits until the socket can be read from (.Receive) or written to (.Send) without blocking.
wait_ready :: proc(socket: nbio.Any_Socket, event: nbio.Poll_Event, timeout := nbio.NO_TIMEOUT) -> nbio.Poll_Result {
	sched_init()
	r := await_op(nbio.prep_poll(socket, event, io_done, timeout))
	return r.poll.result
}

// ---- UDP ----

udp_socket :: proc(family: nbio.Address_Family = .IP4) -> (nbio.UDP_Socket, nbio.Create_Socket_Error) {
	sched_init()
	return nbio.create_udp_socket(family)
}

bind :: proc(socket: nbio.UDP_Socket, endpoint: nbio.Endpoint) -> net.Bind_Error {
	return net.bind(socket, endpoint)
}

send_to :: proc(socket: nbio.UDP_Socket, buf: []byte, to: nbio.Endpoint, timeout := nbio.NO_TIMEOUT) -> (int, nbio.Send_Error) {
	sched_init()
	bufs := [1][]byte{buf}
	r := await_op(nbio.prep_send(socket, bufs[:], io_done, to, timeout = timeout))
	return r.send.sent, r.send.err
}

recv_from :: proc(socket: nbio.UDP_Socket, buf: []byte, timeout := nbio.NO_TIMEOUT) -> (int, nbio.Endpoint, nbio.Recv_Error) {
	sched_init()
	bufs := [1][]byte{buf}
	r := await_op(nbio.prep_recv(socket, bufs[:], io_done, timeout = timeout))
	return r.recv.received, r.recv.source, r.recv.err
}

udp_close :: proc(socket: nbio.UDP_Socket) {
	sched_init()
	await_op(nbio.prep_close(socket, io_done))
}

// ---- DNS (on a worker thread: the resolver blocks) ----

resolve :: proc(hostname_and_maybe_port: string) -> (ep4, ep6: nbio.Endpoint, err: net.Network_Error) {
	Result :: struct { ep4, ep6: nbio.Endpoint, err: net.Network_Error }
	r := new(Result)
	defer free(r)
	blocking(proc[hostname_and_maybe_port, r]() {
		r.ep4, r.ep6, r.err = net.resolve(hostname_and_maybe_port)
	})
	return r.ep4, r.ep6, r.err
}

// ---- files ----

File :: nbio.Handle

open :: proc(path: string, mode: nbio.File_Flags = {.Read}, perm := nbio.Permissions_Default_File) -> (File, nbio.FS_Error) {
	sched_init()
	r := await_file(nbio.prep_open(path, file_cb(), mode, perm, l = file_loop()))
	return r.open.handle, r.open.err
}

// Reads at offset (the file position is not used); with all, keeps reading until buf is full or the file ends.
read_at :: proc(file: File, offset: int, buf: []byte, all := false) -> (int, nbio.FS_Error) {
	sched_init()
	r := await_file(nbio.prep_read(file, offset, buf, file_cb(), all, l = file_loop()))
	return r.read.read, r.read.err
}

write_at :: proc(file: File, offset: int, buf: []byte, all := true) -> (int, nbio.FS_Error) {
	sched_init()
	r := await_file(nbio.prep_write(file, offset, buf, file_cb(), all, l = file_loop()))
	return r.write.written, r.write.err
}

stat :: proc(file: File) -> (type: nbio.File_Type, size: i64, err: nbio.FS_Error) {
	sched_init()
	r := await_file(nbio.prep_stat(file, file_cb(), l = file_loop()))
	return r.stat.type, r.stat.size, r.stat.err
}

file_close :: proc(file: File) -> nbio.FS_Error {
	sched_init()
	r := await_file(nbio.prep_close(file, file_cb(), l = file_loop()))
	return r.close.err
}

read_entire_file :: proc(path: string, allocator := context.allocator) -> (data: []byte, err: nbio.FS_Error) {
	f := open(path) or_return
	defer file_close(f)
	_, size := stat(f) or_return
	data = make([]byte, int(size), allocator)
	n: int
	n, err = read_at(f, 0, data, all = true)
	if err == .EOF do err = nil
	return data[:n], err
}

write_entire_file :: proc(path: string, data: []byte, truncate := true) -> nbio.FS_Error {
	mode: nbio.File_Flags = {.Write, .Create}
	if truncate do mode += {.Trunc}
	f := open(path, mode) or_return
	defer file_close(f)
	_, err := write_at(f, 0, data)
	return err
}

send  :: proc{chan_send, socket_send}
recv  :: proc{chan_recv, socket_recv}
close :: proc{chan_close, socket_close, udp_close, file_close}

// ---- mutexes that park the goroutine, not the thread ----

Mutex :: struct {
	locked:  bool,
	waiters: Wait_Queue,
}

lock :: proc(m: ^Mutex) {
	sched_init()
	if !m.locked {
		m.locked = true
		return
	}
	w := Waiter{g = sched.cur}
	enqueue(&m.waiters, &w)
	park()
}

// Hands the lock straight to the longest waiter, if any.
unlock :: proc(m: ^Mutex) {
	assert(m.locked, "unlock of an unlocked sched.Mutex")
	if w := dequeue(&m.waiters); w != nil {
		ready(w.g)
	} else {
		m.locked = false
	}
}

try_lock :: proc(m: ^Mutex) -> bool {
	if m.locked do return false
	m.locked = true
	return true
}

// ---- channels ----

@(private)
Select_State :: struct {
	fired: int,
}

@(private)
Waiter :: struct {
	g:          ^G,
	elem:       rawptr,
	ok:         bool,
	sel:        ^Select_State,
	case_index: int,
	prev, next: ^Waiter,
}

@(private)
Wait_Queue :: struct {
	head, tail: ^Waiter,
}

@(private)
enqueue :: proc(q: ^Wait_Queue, w: ^Waiter) {
	w.prev, w.next = q.tail, nil
	if q.tail == nil do q.head = w
	else do q.tail.next = w
	q.tail = w
}

@(private)
unlink :: proc(q: ^Wait_Queue, w: ^Waiter) {
	if w.prev == nil do q.head = w.next
	else do w.prev.next = w.next
	if w.next == nil do q.tail = w.prev
	else do w.next.prev = w.prev
	w.prev, w.next = nil, nil
}

// The first waiter that can still be woken; claims its select if it is in one.
@(private)
dequeue :: proc(q: ^Wait_Queue) -> ^Waiter {
	for w := q.head; w != nil; w = q.head {
		unlink(q, w)
		if w.sel == nil do return w
		if w.sel.fired < 0 {
			w.sel.fired = w.case_index
			return w
		}
	}
	return nil
}

Raw_Chan :: struct {
	elem_size:    int,
	capacity:     int,
	buf:          []byte,
	head, count:  int,
	closed:       bool,
	recvq, sendq: Wait_Queue,
}

// A channel is a handle: copies share one queue. The zero Chan is nil and blocks forever.
Chan :: struct($T: typeid) {
	raw: ^Raw_Chan,
}

make_chan :: proc($T: typeid, capacity := 0) -> Chan(T) {
	c := new(Raw_Chan)
	c.elem_size = size_of(T)
	c.capacity = capacity
	c.buf = make([]byte, capacity * size_of(T))
	return {c}
}

@(private)
slot :: proc(c: ^Raw_Chan, i: int) -> rawptr {
	return &c.buf[((c.head + i) % c.capacity) * c.elem_size]
}

@(private)
try_send_raw :: proc(c: ^Raw_Chan, elem: rawptr) -> bool {
	if c.closed do panic("send on closed channel")
	if w := dequeue(&c.recvq); w != nil {
		mem.copy(w.elem, elem, c.elem_size)
		w.ok = true
		ready(w.g)
		return true
	}
	if c.count < c.capacity {
		mem.copy(slot(c, c.count), elem, c.elem_size)
		c.count += 1
		return true
	}
	return false
}

@(private)
try_recv_raw :: proc(c: ^Raw_Chan, out: rawptr) -> (done, ok: bool) {
	if c.count > 0 {
		mem.copy(out, slot(c, 0), c.elem_size)
		c.head = (c.head + 1) % c.capacity
		c.count -= 1
		if w := dequeue(&c.sendq); w != nil {
			mem.copy(slot(c, c.count), w.elem, c.elem_size)
			c.count += 1
			w.ok = true
			ready(w.g)
		}
		return true, true
	}
	if w := dequeue(&c.sendq); w != nil {
		mem.copy(out, w.elem, c.elem_size)
		w.ok = true
		ready(w.g)
		return true, true
	}
	if c.closed {
		mem.zero(out, c.elem_size)
		return true, false
	}
	return false, false
}

// Blocks until a receiver takes v, or until there is room in the buffer.
chan_send :: proc(c: Chan($T), v: T) {
	sched_init()
	v := v
	if c.raw == nil do block_forever()
	if try_send_raw(c.raw, &v) do return
	w := Waiter{g = sched.cur, elem = &v}
	enqueue(&c.raw.sendq, &w)
	park()
	if !w.ok do panic("send on closed channel")
}

// Blocks until a value arrives; ok is false once the channel is closed and drained.
chan_recv :: proc(c: Chan($T)) -> (v: T, ok: bool) #optional_ok {
	sched_init()
	if c.raw == nil do block_forever()
	if done, got := try_recv_raw(c.raw, &v); done do return v, got
	w := Waiter{g = sched.cur, elem = &v}
	enqueue(&c.raw.recvq, &w)
	park()
	return v, w.ok
}

chan_close :: proc(c: Chan($T)) {
	sched_init()
	if c.raw == nil do panic("close of nil channel")
	if c.raw.closed do panic("close of closed channel")
	c.raw.closed = true
	for w := dequeue(&c.raw.recvq); w != nil; w = dequeue(&c.raw.recvq) {
		mem.zero(w.elem, c.raw.elem_size)
		w.ok = false
		ready(w.g)
	}
	for w := dequeue(&c.raw.sendq); w != nil; w = dequeue(&c.raw.sendq) {
		w.ok = false
		ready(w.g)
	}
}

chan_len :: proc(c: Chan($T)) -> int { return c.raw.count if c.raw != nil else 0 }
chan_cap :: proc(c: Chan($T)) -> int { return c.raw.capacity if c.raw != nil else 0 }

// ---- select ----

Select_Case :: struct {
	ch:      ^Raw_Chan,
	is_send: bool,
	elem:    rawptr,
	ok:      ^bool,
}

// A receive for select: the value goes to out^ and whether it arrived (not closed) to ok^; both are optional.
on_recv :: proc(c: Chan($T), out: ^T = nil, ok: ^bool = nil) -> Select_Case {
	return {c.raw, false, out, ok}
}

// A send of v for select.
on_send :: proc(c: Chan($T), v: T) -> Select_Case {
	return {c.raw, true, new_clone(v, runtime.heap_allocator()), nil}
}

// Waits until one case can proceed, runs it and returns its index.
select :: proc(cases: ..Select_Case) -> int {
	return select_cases(cases, false)
}

// Like select, but returns -1 at once when no case is ready.
try_select :: proc(cases: ..Select_Case) -> int {
	return select_cases(cases, true)
}

@(private)
select_cases :: proc(cases: []Select_Case, nonblocking: bool) -> int {
	sched_init()
	scratch := make([][]byte, len(cases), runtime.heap_allocator())
	for &c, i in cases {
		if c.ch != nil && c.elem == nil {
			scratch[i] = make([]byte, max(c.ch.elem_size, 1), runtime.heap_allocator())
			c.elem = raw_data(scratch[i])
		}
	}
	index, ok := select_raw(cases, nonblocking)
	if index >= 0 && cases[index].ok != nil do cases[index].ok^ = ok
	for c, i in cases {
		if c.is_send do free(c.elem, runtime.heap_allocator())
		delete(scratch[i], runtime.heap_allocator())
	}
	delete(scratch, runtime.heap_allocator())
	if index >= 0 && cases[index].is_send && !ok do panic("send on closed channel")
	return index
}

@(private)
select_raw :: proc(cases: []Select_Case, nonblocking: bool) -> (index: int, ok: bool) {
	for &c, i in cases {
		if c.ch == nil do continue
		if c.is_send {
			if try_send_raw(c.ch, c.elem) do return i, true
		} else {
			if done, got := try_recv_raw(c.ch, c.elem); done do return i, got
		}
	}
	if nonblocking do return -1, false

	sel := Select_State{fired = -1}
	waiters := make([]Waiter, len(cases), runtime.heap_allocator())
	defer delete(waiters, runtime.heap_allocator())
	for &c, i in cases {
		if c.ch == nil do continue
		waiters[i] = Waiter{g = sched.cur, elem = c.elem, sel = &sel, case_index = i}
		enqueue(&c.ch.sendq if c.is_send else &c.ch.recvq, &waiters[i])
	}
	park()
	for &c, i in cases {
		if c.ch == nil || i == sel.fired do continue
		q := &c.ch.sendq if c.is_send else &c.ch.recvq
		for w := q.head; w != nil; w = w.next {
			if w == &waiters[i] {
				unlink(q, w)
				break
			}
		}
	}
	return sel.fired, waiters[sel.fired].ok
}

// ---- wait groups ----

Wait_Group :: struct {
	count:   int,
	waiters: Wait_Queue,
}

add :: proc(wg: ^Wait_Group, n := 1) {
	wg.count += n
	if wg.count < 0 do panic("negative wait group counter")
	if wg.count == 0 {
		for w := dequeue(&wg.waiters); w != nil; w = dequeue(&wg.waiters) do ready(w.g)
	}
}

done :: proc(wg: ^Wait_Group) { add(wg, -1) }

wait :: proc(wg: ^Wait_Group) {
	sched_init()
	if wg.count == 0 do return
	w := Waiter{g = sched.cur}
	enqueue(&wg.waiters, &w)
	park()
}
`;

const SWITCH_DARWIN_ARM64 = String.raw`	.section __TEXT,__text
	.build_version macos, 10, 0

	.extern _vidar_go_start

	; vidar_switch(save, to): pushes callee-saved registers, stores sp in *save, resumes the stack at to
	.global _vidar_switch
	.align 2
_vidar_switch:
	sub sp, sp, #160
	stp x19, x20, [sp, #0]
	stp x21, x22, [sp, #16]
	stp x23, x24, [sp, #32]
	stp x25, x26, [sp, #48]
	stp x27, x28, [sp, #64]
	stp x29, x30, [sp, #80]
	stp d8,  d9,  [sp, #96]
	stp d10, d11, [sp, #112]
	stp d12, d13, [sp, #128]
	stp d14, d15, [sp, #144]
	mov x2, sp
	str x2, [x0]
	mov sp, x1
	ldp x19, x20, [sp, #0]
	ldp x21, x22, [sp, #16]
	ldp x23, x24, [sp, #32]
	ldp x25, x26, [sp, #48]
	ldp x27, x28, [sp, #64]
	ldp x29, x30, [sp, #80]
	ldp d8,  d9,  [sp, #96]
	ldp d10, d11, [sp, #112]
	ldp d12, d13, [sp, #128]
	ldp d14, d15, [sp, #144]
	add sp, sp, #160
	ret

	; a new goroutine's first resume lands here, with its G in x19
	.global _vidar_entry
	.align 2
_vidar_entry:
	mov x0, x19
	bl _vidar_go_start
	brk #0
`;

const SWITCH_LINUX_ARM64 = String.raw`	.text

	// vidar_switch(save, to): pushes callee-saved registers, stores sp in *save, resumes the stack at to
	.global vidar_switch
	.type vidar_switch, %function
	.align 2
vidar_switch:
	sub sp, sp, #160
	stp x19, x20, [sp, #0]
	stp x21, x22, [sp, #16]
	stp x23, x24, [sp, #32]
	stp x25, x26, [sp, #48]
	stp x27, x28, [sp, #64]
	stp x29, x30, [sp, #80]
	stp d8,  d9,  [sp, #96]
	stp d10, d11, [sp, #112]
	stp d12, d13, [sp, #128]
	stp d14, d15, [sp, #144]
	mov x2, sp
	str x2, [x0]
	mov sp, x1
	ldp x19, x20, [sp, #0]
	ldp x21, x22, [sp, #16]
	ldp x23, x24, [sp, #32]
	ldp x25, x26, [sp, #48]
	ldp x27, x28, [sp, #64]
	ldp x29, x30, [sp, #80]
	ldp d8,  d9,  [sp, #96]
	ldp d10, d11, [sp, #112]
	ldp d12, d13, [sp, #128]
	ldp d14, d15, [sp, #144]
	add sp, sp, #160
	ret

	// a new goroutine's first resume lands here, with its G in x19
	.global vidar_entry
	.type vidar_entry, %function
	.align 2
vidar_entry:
	mov x0, x19
	bl vidar_go_start
	brk #0

	.section .note.GNU-stack,"",%progbits
`;

const SWITCH_LINUX_AMD64 = String.raw`bits 64

extern vidar_go_start
global vidar_switch
global vidar_entry

section .note.GNU-stack
section .text

;; vidar_switch(save, to): pushes callee-saved registers, stores rsp in *save, resumes the stack at to
vidar_switch:
	push rbp
	push rbx
	push r12
	push r13
	push r14
	push r15
	mov [rdi], rsp
	mov rsp, rsi
	pop r15
	pop r14
	pop r13
	pop r12
	pop rbx
	pop rbp
	ret

;; a new goroutine's first resume lands here, with its G in r12 and rsp 16-byte aligned
vidar_entry:
	mov rdi, r12
	call vidar_go_start wrt ..plt
	ud2
`;

/** Assembly files emitted next to the "vidar:sched" package. */
export const SCHED_ASM: [string, string][] = [
  ["switch_darwin_arm64.asm", SWITCH_DARWIN_ARM64],
  ["switch_linux_arm64.asm", SWITCH_LINUX_ARM64],
  ["switch_linux_amd64.asm", SWITCH_LINUX_AMD64],
];
