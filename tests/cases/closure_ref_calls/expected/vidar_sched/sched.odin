package sched; import __vidar "../vidar_runtime"

import "base:intrinsics"
import "base:runtime"
import "core:c/libc"
import "core:mem"
import "core:mem/virtual"
import "core:nbio"
import "core:net"
import "core:slice"
import "core:sync"
import "core:thread"
import "core:time"

when ODIN_OS == .Darwin && ODIN_ARCH == .arm64 {
	foreign import switcher "switch_darwin_arm64.asm"
} else when ODIN_OS == .Linux && ODIN_ARCH == .arm64 {
	foreign import switcher "switch_linux_arm64.asm"
} else when ODIN_OS == .Linux && ODIN_ARCH == .amd64 {
	foreign import switcher "switch_linux_amd64.asm"
} else when ODIN_OS == .Windows && ODIN_ARCH == .amd64 {
	foreign import switcher "switch_windows_amd64.asm"
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
// goroutines run on this many threads; above 1, each thread runs its own scheduler, and an idle
// thread takes half of another's runnable goroutines
THREADS :: #config(VIDAR_THREADS, 1)
@(private)
MULTI :: THREADS > 1
// how long an idle thread waits before looking for goroutines to take from the others
@(private)
IDLE_POLL :: 10 * time.Millisecond
// where each goroutine started and what it waits on, printed on a deadlock and on SIGQUIT; on
// unless built with -o:speed (-define:VIDAR_SCHED_DEBUG=true turns it on there, false turns it off)
SCHED_DEBUG :: #config(VIDAR_SCHED_DEBUG, ODIN_OPTIMIZATION_MODE < .Speed)
// each thread keeps its last TRACE_EVENTS scheduler events (go, run, park, wake, steal, I/O, idle),
// written at exit, on a deadlock and on SIGQUIT as Chrome trace JSON (Perfetto, chrome://tracing) to
// vidar-trace.json, or to the file $VIDAR_TRACE_FILE names
TRACE :: #config(VIDAR_SCHED_TRACE, false)
TRACE_EVENTS :: #config(VIDAR_TRACE_EVENTS, 1 << 16)
#assert(TRACE_EVENTS > 0 && TRACE_EVENTS & (TRACE_EVENTS - 1) == 0, "VIDAR_TRACE_EVENTS must be a power of two")
// goroutines get numbers, and record what they wait on
@(private)
IDS :: SCHED_DEBUG || TRACE || RACE
// -define:VIDAR_RACE=true, given to vidar too (it marks the writes to watch): reports two writes to
// a global or a captured local, from different goroutines, with nothing ordering them
RACE :: #config(VIDAR_RACE, false)
// the size of each vector clock (goroutine numbers share slots modulo this), and of the table of
// watched addresses
@(private)
RACE_SLOTS :: 64 when RACE else 0
RACE_TABLE :: #config(VIDAR_RACE_TABLE, 1 << 16)
#assert(RACE_TABLE > 0 && RACE_TABLE & (RACE_TABLE - 1) == 0, "VIDAR_RACE_TABLE must be a power of two")
@(private)
Clock :: [RACE_SLOTS]u32

@(private)
G :: struct {
	sp:    rawptr,
	stack: []byte,
	task:  __vidar.Closure(proc(__vidar.Env)),
	ctx:   runtime.Context,
	next:  ^G,
	// with several threads: the scheduler it runs on or is queued on, whether it has started,
	// whether it is a thread's own stack (never moves), and whether it is running or still
	// switching away (another thread must not resume it yet)
	owner:   ^Scheduler,
	started: bool,
	pinned:  bool,
	running: bool,
	// with SCHED_DEBUG: its number, where sched.go started it, what it waits on ("" while it can
	// run), where it parked, and the list of every goroutine
	id:         int,
	go_loc:     runtime.Source_Code_Location,
	wait:       Wait,
	wait_on:    rawptr,
	wait_cases: []Select_Case,
	wait_loc:   runtime.Source_Code_Location,
	all_prev, all_next: ^G,
	// with RACE: its own clock, and the clocks of others it knows it comes after
	clock: u32,
	vc:    Clock,
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
	// with several threads: other threads add to the run queue, and wake this one
	q_lock:      sync.Mutex,
	wake:        sync.Sema,
	is_proc:     bool,
	index:       int,
	// with several threads: the goroutine just switched away from, which switched() releases
	prev:        ^G,
	// with TRACE: this thread's ring of events, and how many it has recorded
	trace:       []Trace_Event,
	trace_n:     int,
}

@(private, thread_local)
sched: Scheduler
// with several threads: &sched, read through self()
@(private, thread_local)
sched_self: ^Scheduler

// with several threads: every thread's scheduler, and where new goroutines go next
@(private)
procs: [THREADS]^Scheduler
@(private)
next_proc: int
@(private)
procs_once: sync.Once
@(private)
procs_up: sync.Sema
// with several threads: how many have nothing to run and no I/O pending, and how many times one
// has stopped being idle; a deadlock is every thread idle with every run queue empty
@(private)
idle_threads: int
@(private)
idle_epoch: int
@(private)
dead: bool

// with SCHED_DEBUG: every goroutine that hasn't finished, for the dump
@(private)
all_gs: ^G
@(private)
all_lock: sync.Mutex
@(private)
next_gid: int
@(private)
sigquit_once: sync.Once

// locks that exist only with several threads
@(private)
mlock :: #force_inline proc(m: ^sync.Mutex) { when MULTI do sync.mutex_lock(m) }
@(private)
munlock :: #force_inline proc(m: ^sync.Mutex) { when MULTI do sync.mutex_unlock(m) }

// The running thread's scheduler. With several threads a goroutine may resume on another thread
// after any switch, and LLVM takes a thread-local's address as constant within a function (its
// address intrinsic is pure), so a function that switches, or anything it is inlined into, could
// keep the old thread's. Every use outside of a thread's own setup reads it again here: a call LLVM
// can't inline, and whose volatile load it can't merge with another call's or move.
@(private)
self :: #force_inline proc "contextless" () -> ^Scheduler {
	when MULTI do return self_now()
	else do return &sched
}

@(private)
self_now :: #force_no_inline proc "contextless" () -> ^Scheduler {
	return intrinsics.volatile_load(&sched_self)
}

@(private)
sched_init :: #force_inline proc() {
	when MULTI {
		if self_now() != nil do return
	} else {
		if sched.inited do return
	}
	sched_start()
}

// Sets up this thread's scheduler; runs on the thread's own stack, before it switches.
@(private)
sched_start :: #force_no_inline proc() {
	sched.inited = true
	sched.cur = &sched.main
	// the thread's own stack: it runs here and nowhere else
	sched.main.started = true
	sched.main.pinned = true
	sched.main.running = true
	sched.main.owner = &sched
	sched.free_stacks.allocator = runtime.heap_allocator()
	err := nbio.acquire_thread_event_loop()
	assert(err == nil, "vidar:sched: could not start the I/O event loop")
	sched.loop = nbio.current_thread_event_loop()
	when TRACE {
		if !sched.is_proc && trace_start._nsec == 0 do trace_start = time.tick_now()
		sched.trace = make([]Trace_Event, TRACE_EVENTS, runtime.heap_allocator())
	}
	when IDS {
		// the program's main goroutine; scheduler threads' own stacks aren't goroutines
		if !sched.is_proc {
			sched.main.id = sync.atomic_add(&next_gid, 1) + 1
			sched.main.clock = 1
			track(&sched.main)
			sync.once_do(&sigquit_once, install_sigquit)
		}
	}
	when MULTI {
		intrinsics.volatile_store(&sched_self, &sched)
		// the first thread to get here is thread 0; it starts the others, which skip this
		if sched.is_proc do return
		sync.once_do(&procs_once, proc() {
			procs[0] = &sched
			for i in 1..<THREADS do thread.create_and_start_with_poly_data(i, proc_main, self_cleanup = true)
			for _ in 1..<THREADS do sync.sema_wait(&procs_up)
		})
	} else {
		procs[0] = &sched
	}
}

// A scheduler thread: its own scheduler, parked forever, so it only runs goroutines.
@(private)
proc_main :: proc(i: int) {
	sched.is_proc = true
	sched.index = i
	sched_init()
	procs[i] = &sched
	sync.sema_post(&procs_up)
	block_forever()
}

@(private)
ready :: proc(g: ^G) {
	me := self()
	p := me
	when MULTI do if g.owner != nil do p = g.owner
	mlock(&p.q_lock)
	g.next = nil
	if p.tail == nil {
		p.head = g
	} else {
		p.tail.next = g
	}
	p.tail = g
	munlock(&p.q_lock)
	trace(.Wake, g, p.index)
	when MULTI {
		if p != me {
			sync.sema_post(&p.wake)
			nbio.wake_up(p.loop)
		}
	}
}

@(private)
pop_ready :: proc() -> ^G {
	p := self()
	mlock(&p.q_lock)
	defer munlock(&p.q_lock)
	g := p.head
	if g == nil do return nil
	p.head = g.next
	if p.head == nil do p.tail = nil
	return g
}

// A goroutine another thread may take: not a thread's own stack, and not still switching away from
// its thread (woken before it finished parking).
@(private)
stealable :: #force_inline proc(g: ^G) -> bool {
	return !g.pinned && !sync.atomic_load(&g.running)
}

// With several threads: half of another thread's runnable goroutines (at least one), taken from
// the first thread after this one that has any. The first is returned, the rest queued here.
@(private)
steal :: proc() -> ^G {
	when MULTI {
		me := self()
		for k in 1..<THREADS {
			p := procs[(me.index + k) % THREADS]
			if p == nil do continue
			sync.mutex_lock(&p.q_lock)
			n := 0
			for g := p.head; g != nil; g = g.next do if stealable(g) do n += 1
			take := (n + 1) / 2
			first, last, prev: ^G
			for g := p.head; g != nil && take > 0; {
				after := g.next
				if stealable(g) {
					if prev == nil do p.head = after
					else do prev.next = after
					if p.tail == g do p.tail = prev
					g.next = nil
					if last == nil do first = g
					else do last.next = g
					last = g
					take -= 1
				} else {
					prev = g
				}
				g = after
			}
			sync.mutex_unlock(&p.q_lock)
			if first == nil do continue
			for g := first; g != nil; g = g.next {
				g.owner = me
				trace(.Steal, g, p.index)
			}
			if rest := first.next; rest != nil {
				first.next = nil
				mlock(&me.q_lock)
				if me.tail == nil do me.head = rest
				else do me.tail.next = rest
				me.tail = last
				munlock(&me.q_lock)
			}
			return first
		}
	}
	return nil
}

// The next goroutine to run; polls the event loop now and then, and blocks on it when nothing is runnable.
@(private)
pick :: proc() -> ^G {
	me := self()
	me.since_poll += 1
	if me.io_waiting > 0 && me.since_poll >= POLL_EVERY {
		me.since_poll = 0
		nbio.tick(0)
	}
	when MULTI {
		// other threads may still wake a goroutine here, so an idle thread waits instead of declaring a deadlock
		for {
			if g := pop_ready(); g != nil do return g
			if g := steal(); g != nil do return g
			me.since_poll = 0
			if me.io_waiting > 0 {
				nbio.tick(0)
				if g := pop_ready(); g != nil do return g
				trace(.Idle, nil)
				nbio.tick(IDLE_POLL)
				trace(.Idle_End, nil)
			} else {
				// the thread that makes them all idle looks for a deadlock
				if sync.atomic_add(&idle_threads, 1) + 1 == THREADS do check_deadlock()
				trace(.Idle, nil)
				sync.sema_wait_with_timeout(&me.wake, IDLE_POLL)
				trace(.Idle_End, nil)
				sync.atomic_add(&idle_epoch, 1)
				sync.atomic_sub(&idle_threads, 1)
			}
		}
	} else {
		for {
			if g := pop_ready(); g != nil do return g
			if me.io_waiting == 0 do deadlock()
			me.since_poll = 0
			// ops done without the kernel complete at tick start, then the tick blocks anyway
			nbio.tick(0)
			if g := pop_ready(); g != nil do return g
			trace(.Idle, nil)
			nbio.tick()
			trace(.Idle_End, nil)
		}
	}
}

@(private)
deadlock :: proc() -> ! {
	when SCHED_DEBUG do dump_goroutines("all goroutines are asleep - deadlock!")
	when TRACE do write_trace()
	panic("all goroutines are asleep - deadlock!")
}

// With several threads: panics when every thread is idle and every run queue is empty. An idle
// thread has no I/O pending and runs nothing, so nothing can make a goroutine runnable again. No
// thread may stop being idle while the queues are read (the epoch doesn't move), or it may have
// taken a goroutine from a queue already read.
@(private)
check_deadlock :: proc() {
	when MULTI {
		epoch := sync.atomic_load(&idle_epoch)
		if sync.atomic_load(&idle_threads) != THREADS do return
		for p in procs {
			if p == nil do return
			sync.mutex_lock(&p.q_lock)
			empty := p.head == nil
			sync.mutex_unlock(&p.q_lock)
			if !empty do return
		}
		if sync.atomic_load(&idle_threads) != THREADS || sync.atomic_load(&idle_epoch) != epoch do return
		if _, first := sync.atomic_compare_exchange_strong(&dead, false, true); !first do return
		deadlock()
	}
}

// Runs on the goroutine just switched to: the one switched away from may now be taken by another
// thread (its registers are saved), and a finished one's stack is freed (it can't free its own).
@(private)
switched :: proc() {
	me := self()
	when MULTI {
		if prev := me.prev; prev != nil {
			me.prev = nil
			sync.atomic_store(&prev.running, false)
		}
	}
	z := me.zombie
	if z == nil || z == me.cur do return
	me.zombie = nil
	append(&me.free_stacks, z.stack)
	free(z, runtime.heap_allocator())
}

// Switches this thread from the current goroutine, from, to next; from is a finished goroutine, or
// else one another thread may take once the switch is done.
@(private)
switch_to :: #force_inline proc(me: ^Scheduler, from, next: ^G, finished: bool) {
	when MULTI {
		next.owner = me
		sync.atomic_store(&next.running, true)
		me.prev = nil if finished else from
	}
	me.cur = next
	vidar_switch(&from.sp, next.sp)
}

// Suspends the current goroutine until something makes it ready again. It may resume on another
// thread: nothing read from self() before this call is valid after it.
@(private)
park :: proc() {
	from := self().cur
	trace(.Park, from, 0, from.wait)
	next := pick()
	trace(.Run, next)
	if next != from {
		switch_to(self(), from, next, false)
		switched()
	}
	when IDS do from.wait = .None
}

// With SCHED_DEBUG or TRACE, records what the current goroutine is about to park on.
@(private)
waiting :: #force_inline proc(what: Wait, on: rawptr, loc: runtime.Source_Code_Location) {
	when IDS {
		g := self().cur
		g.wait, g.wait_on, g.wait_loc = what, on, loc
	}
}

@(private)
block_forever :: proc(what := Wait.Forever, loc := #caller_location) -> ! {
	sched_init()
	for {
		waiting(what, nil, loc)
		park()
	}
}

// Lets the other runnable goroutines run before this one continues.
yield :: proc() {
	sched_init()
	ready(self().cur)
	park()
}

@(private)
new_stack :: proc() -> []byte {
	me := self()
	if len(me.free_stacks) > 0 do return pop(&me.free_stacks)
	stack, err := virtual.reserve_and_commit(STACK_SIZE)
	assert(err == nil, "vidar:sched: out of memory for a goroutine stack")
	virtual.protect(raw_data(stack), GUARD_SIZE, virtual.Protect_No_Access)
	return stack
}

// Runs the closure on a new goroutine, with the caller's context.
go :: proc(task: __vidar.Closure(proc(__vidar.Env)), loc := #caller_location) {
	sched_init()
	g := new(G, runtime.heap_allocator())
	when IDS {
		g.id = sync.atomic_add(&next_gid, 1) + 1
		g.go_loc = loc
		track(g)
		trace(.Go, self().cur, g.id)
	}
	g.stack = new_stack()
	g.task = task
	when RACE {
		// everything the parent did so far comes before the child
		parent := self().cur
		s := race_slot(parent.id)
		parent.vc[s] = max(parent.vc[s], parent.clock)
		g.vc = parent.vc
		g.clock = 1
		parent.clock += 1
	}
	g.ctx = context
	top := (uintptr(raw_data(g.stack)) + uintptr(len(g.stack))) &~ 15
	when ODIN_ARCH == .arm64 {
		// vidar_switch's frame: x19..x28, x29, x30, d8..d15
		frame := ([^]uintptr)(rawptr(top - 160))
		mem.zero(frame, 160)
		frame[0] = uintptr(g)
		frame[11] = uintptr(rawptr(vidar_entry))
	} else when ODIN_OS == .Windows {
		// vidar_switch's frame: xmm6..xmm15, the TIB's StackBase, StackLimit and DeallocationStack,
		// r15, r14, r13, r12, rsi, rdi, rbx, rbp, return address; above it a zero return address,
		// which ends stack walks (unwinding, debuggers) at vidar_entry
		frame := ([^]uintptr)(rawptr(top - 272))
		mem.zero(frame, 272)
		frame[20] = uintptr(raw_data(g.stack)) + uintptr(len(g.stack))
		frame[21] = uintptr(raw_data(g.stack)) + GUARD_SIZE
		frame[22] = uintptr(raw_data(g.stack))
		frame[26] = uintptr(g)
		frame[31] = uintptr(rawptr(vidar_entry))
	} else {
		// r15, r14, r13, r12, rbx, rbp, return address
		frame := ([^]uintptr)(rawptr(top - 72))
		mem.zero(frame, 72)
		frame[3] = uintptr(g)
		frame[6] = uintptr(rawptr(vidar_entry))
	}
	g.sp = frame
	when MULTI {
		// round robin; an idle thread can also take it
		g.owner = procs[(sync.atomic_add(&next_proc, 1)) % THREADS]
	}
	ready(g)
}

// The temp allocator of whichever thread the goroutine runs on at the time of each call, since it
// may move between threads. Its data isn't the thread's own, so a temp-allocator guard
// (runtime.DEFAULT_TEMP_ALLOCATOR_TEMP_GUARD) frees nothing; free_all does.
@(private)
temp_here :: proc(data: rawptr, mode: runtime.Allocator_Mode, size, alignment: int, old_memory: rawptr, old_size: int, loc := #caller_location) -> ([]byte, runtime.Allocator_Error) {
	a := runtime.default_context().temp_allocator
	return a.procedure(a.data, mode, size, alignment, old_memory, old_size, loc)
}

@(private, export, link_name = "vidar_go_start")
go_start :: proc "c" (g: ^G) {
	context = g.ctx
	when MULTI {
		context.temp_allocator = {temp_here, nil}
		g.started = true
	}
	switched()
	g.task.call(g.task.env)
	when SCHED_DEBUG do untrack(g)
	trace(.Exit, g)
	me := self()
	me.zombie = g
	next := pick()
	trace(.Run, next)
	switch_to(me, g, next, true)
	unreachable()
}

// ---- debugging: the goroutine dump ----

// What a parked goroutine waits on.
@(private)
Wait :: enum u8 {
	None, Forever, Chan_Send, Chan_Recv, Chan_Send_Nil, Chan_Recv_Nil, Select, Mutex, Wait_Group, Sleep, Blocking,
	IO, IO_Accept, IO_Close, IO_Dial, IO_Read, IO_Recv, IO_Send, IO_Write, IO_Poll, IO_Send_File, IO_Open, IO_Stat,
}

@(private, rodata)
WAIT_NAMES := [Wait]string{
	.None          = "",
	.Forever       = "forever",
	.Chan_Send     = "chan send",
	.Chan_Recv     = "chan receive",
	.Chan_Send_Nil = "chan send (nil chan)",
	.Chan_Recv_Nil = "chan receive (nil chan)",
	.Select        = "select",
	.Mutex         = "sched.Mutex",
	.Wait_Group    = "sched.Wait_Group",
	.Sleep         = "sleep",
	.Blocking      = "sched.blocking",
	.IO            = "I/O",
	.IO_Accept     = "I/O accept",
	.IO_Close      = "I/O close",
	.IO_Dial       = "I/O dial",
	.IO_Read       = "I/O read",
	.IO_Recv       = "I/O receive",
	.IO_Send       = "I/O send",
	.IO_Write      = "I/O write",
	.IO_Poll       = "I/O poll",
	.IO_Send_File  = "I/O send file",
	.IO_Open       = "I/O open",
	.IO_Stat       = "I/O stat",
}

@(private)
all_tail: ^G

@(private)
track :: proc(g: ^G) {
	when SCHED_DEBUG {
		mlock(&all_lock)
		g.all_prev, g.all_next = all_tail, nil
		if all_tail == nil do all_gs = g
		else do all_tail.all_next = g
		all_tail = g
		munlock(&all_lock)
	}
}

@(private)
untrack :: proc(g: ^G) {
	when SCHED_DEBUG {
		mlock(&all_lock)
		if g.all_prev == nil do all_gs = g.all_next
		else do g.all_prev.all_next = g.all_next
		if g.all_next == nil do all_tail = g.all_prev
		else do g.all_next.all_prev = g.all_prev
		munlock(&all_lock)
	}
}

@(private)
print_hex :: proc "contextless" (p: rawptr) {
	digits := "0123456789abcdef"
	buf: [2 + 2 * size_of(uintptr)]byte
	x := uintptr(p)
	i := len(buf)
	for {
		i -= 1
		buf[i] = digits[x & 15]
		x >>= 4
		if x == 0 do break
	}
	buf[i - 1], buf[i - 2] = 'x', '0'
	runtime.print_string(string(buf[i - 2:]))
}

// Prints every goroutine to stderr: its number, what it waits on and where, and where it started.
// Generated locations are .odin lines; vidar run (or vidar map) shows them as .vidar lines.
@(private)
dump_goroutines :: proc "contextless" (title: string) {
	when SCHED_DEBUG {
		// a SIGQUIT may arrive while the list is being changed; print it anyway
		locked := sync.mutex_try_lock(&all_lock)
		defer if locked do sync.mutex_unlock(&all_lock)
		runtime.print_strings("\nvidar:sched: ", title, "\n")
		for g := all_gs; g != nil; g = g.all_next {
			runtime.print_string("\ngoroutine ")
			runtime.print_int(g.id)
			runtime.print_string(" [")
			if g.wait != .None {
				runtime.print_string(WAIT_NAMES[g.wait])
				if g.wait_on != nil {
					runtime.print_byte(' ')
					print_hex(g.wait_on)
				}
			} else {
				running := false
				for p in procs do if p != nil && p.cur == g do running = true
				runtime.print_string("running" if running else "runnable")
			}
			runtime.print_byte(']')
			when MULTI do if g.owner != nil && g.started {
				runtime.print_string(" on thread ")
				runtime.print_int(g.owner.index)
			}
			if g.go_loc.file_path == "" do runtime.print_string(" (main)")
			runtime.print_string(":\n")
			if g.wait != .None {
				runtime.print_string("\tparked at ")
				runtime.print_caller_location(g.wait_loc)
				runtime.print_byte('\n')
			}
			if g.wait == .Select {
				for c, i in g.wait_cases {
					if c.ch == nil do continue
					runtime.print_string("\t\tcase ")
					runtime.print_int(i)
					runtime.print_string(": send on " if c.is_send else ": receive on ")
					print_hex(c.ch)
					runtime.print_byte('\n')
				}
			}
			if g.go_loc.file_path != "" {
				runtime.print_string("\tstarted at ")
				runtime.print_caller_location(g.go_loc)
				runtime.print_byte('\n')
			}
		}
		runtime.print_byte('\n')
	}
}

// SIGQUIT (Ctrl-\) prints the goroutines, then ends the program as it would have without the handler.
@(private)
install_sigquit :: proc() {
	when !SCHED_DEBUG && !TRACE do return
	when ODIN_OS == .Linux || ODIN_OS == .Darwin {
		libc.signal(SIGQUIT, on_sigquit)
	}
}

@(private)
SIGQUIT :: 3

@(private)
on_sigquit :: proc "c" (sig: libc.int) {
	dump_goroutines("SIGQUIT")
	write_trace()
	libc.signal(sig, auto_cast libc.SIG_DFL)
	libc.raise(sig)
}

// What a goroutine waiting on op waits on, for the dump.
@(private)
io_what :: proc(op: ^nbio.Operation) -> Wait {
	#partial switch op.type {
	case .Accept:    return .IO_Accept
	case .Close:     return .IO_Close
	case .Dial:      return .IO_Dial
	case .Read:      return .IO_Read
	case .Recv:      return .IO_Recv
	case .Send:      return .IO_Send
	case .Write:     return .IO_Write
	case .Timeout:   return .Sleep
	case .Poll:      return .IO_Poll
	case .Send_File: return .IO_Send_File
	case .Open:      return .IO_Open
	case .Stat:      return .IO_Stat
	}
	return .IO
}

// ---- debugging: the race check ----

@(private)
race_slot :: #force_inline proc "contextless" (id: int) -> int { return id & (RACE_SLOTS - 1) }

// A channel operation, Mutex or Wait_Group call on an object with clock vc: the current goroutine
// comes after everything that synchronized through it before, and everything after comes after
// this goroutine's past. Joining both ways orders more than the operation does, so the check
// misses some races but never reports two writes that are ordered.
@(private)
race_sync :: #force_inline proc(vc: ^Clock) {
	when RACE {
		me := self()
		if me == nil || me.cur == nil do return
		g := me.cur
		s := race_slot(g.id)
		g.vc[s] = max(g.vc[s], g.clock)
		for i in 0..<RACE_SLOTS {
			m := max(g.vc[i], vc[i])
			g.vc[i], vc[i] = m, m
		}
		g.clock += 1
	}
}

// race_sync, after a park: takes the guard again.
@(private)
race_sync_locked :: #force_inline proc(guard: ^sync.Mutex, vc: ^Clock) {
	when RACE {
		mlock(guard)
		race_sync(vc)
		munlock(guard)
	}
}

@(private)
Race_Entry :: struct {
	addr:     uintptr,
	gid:      i32,
	clock:    u32,
	reported: bool,
	loc:      runtime.Source_Code_Location,
}

@(private)
race_table: []Race_Entry
@(private)
race_used: int
@(private)
race_lock: sync.Mutex

// Generated for a watched write: __race_w(&x)^ = v.
__race_w :: #force_inline proc(p: ^$T, loc := #caller_location) -> ^T {
	when RACE do race_write(uintptr(p), loc, false)
	return p
}

// Generated after the declaration of a captured local: its address may have held another variable.
__race_decl :: #force_inline proc(p: ^$T, loc := #caller_location) {
	when RACE do race_write(uintptr(p), loc, true)
}

@(private)
race_write :: proc(addr: uintptr, loc: runtime.Source_Code_Location, decl: bool) {
	when RACE {
		// not a goroutine: a blocking closure on a worker, or code before the scheduler started
		me := self()
		if me == nil || !me.inited || me.cur == nil do return
		g := me.cur
		sync.mutex_lock(&race_lock)
		defer sync.mutex_unlock(&race_lock)
		if race_table == nil do race_table = make([]Race_Entry, RACE_TABLE, runtime.heap_allocator())
		i := int((addr >> 3) * 0x9E3779B97F4A7C15 >> 16) & (RACE_TABLE - 1)
		for race_table[i].addr != addr && race_table[i].addr != 0 do i = (i + 1) & (RACE_TABLE - 1)
		e := &race_table[i]
		if e.addr == 0 {
			if race_used >= RACE_TABLE * 3 / 4 {
				if race_used == RACE_TABLE * 3 / 4 do runtime.print_string("vidar:sched: the race check watches no more addresses (-define:VIDAR_RACE_TABLE=<power of two>)\n")
				race_used = RACE_TABLE * 3 / 4 + 1
				return
			}
			race_used += 1
			e.addr = addr
		} else if !decl && e.gid != i32(g.id) && !e.reported && e.clock > g.vc[race_slot(int(e.gid))] {
			e.reported = true
			runtime.print_string("\nvidar:sched: race: goroutine ")
			runtime.print_int(g.id)
			runtime.print_string(" writes ")
			print_hex(rawptr(addr))
			runtime.print_string(" at ")
			runtime.print_caller_location(loc)
			runtime.print_string("\n\tgoroutine ")
			runtime.print_int(int(e.gid))
			runtime.print_string(" wrote it at ")
			runtime.print_caller_location(e.loc)
			runtime.print_string("\n\tand no channel operation, sched.Mutex, sched.Wait_Group or sched.go orders the two\n\n")
		}
		e.gid, e.clock, e.loc = i32(g.id), g.clock, loc
	}
}

// ---- debugging: the trace ----

@(private)
Trace_Kind :: enum u8 { Go, Run, Park, Exit, Wake, Steal, IO_Submit, IO_Done, Idle, Idle_End }

// arg: for Go the new goroutine, for Wake the thread it is queued on, for Steal the thread it came from
@(private)
Trace_Event :: struct {
	ts:   i64,
	g:    i32,
	arg:  i32,
	kind: Trace_Kind,
	wait: Wait,
}

@(private)
trace_start: time.Tick
@(private)
trace_written: bool

@(private)
trace :: #force_inline proc(kind: Trace_Kind, g: ^G, arg := 0, wait := Wait.None) {
	when TRACE {
		me := self()
		if me == nil || me.trace == nil do return
		me.trace[me.trace_n & (TRACE_EVENTS - 1)] = {time.tick_now()._nsec, i32(g.id) if g != nil else 0, i32(arg), kind, wait}
		sync.atomic_store(&me.trace_n, me.trace_n + 1)
	}
}

when TRACE {
	@(private, fini)
	trace_at_exit :: proc "contextless" () { write_trace() }
}

// Writes every thread's events, oldest first, as Chrome trace JSON: a slice per goroutine run and per
// idle wait, an instant per other event. Other threads may still be adding events; at most the
// newest few are torn.
@(private)
write_trace :: proc "contextless" () {
	when TRACE {
		if _, first := sync.atomic_compare_exchange_strong(&trace_written, false, true); !first do return
		path := libc.getenv("VIDAR_TRACE_FILE")
		if path == nil || (^u8)(path)^ == 0 do path = "vidar-trace.json"
		f := libc.fopen(path, "w")
		if f == nil {
			runtime.print_strings("vidar:sched: could not write the trace to ", string(path), "\n")
			return
		}
		libc.fprintf(f, "%s", cstring("{\"displayTimeUnit\":\"ns\",\"traceEvents\":[" + "\n"))
		libc.fprintf(f, "%s", cstring("{\"name\":\"process_name\",\"ph\":\"M\",\"pid\":1,\"tid\":0,\"args\":{\"name\":\"vidar:sched\"}}"))
		ts :: proc "contextless" (f: ^libc.FILE, t: i64) {
			t := max(t - trace_start._nsec, 0)
			libc.fprintf(f, "\"ts\":%lld.%03lld", t / 1000, t % 1000)
		}
		head :: proc "contextless" (f: ^libc.FILE, name: string, ph: cstring, tid: int, t: i64) {
			libc.fprintf(f, ",\n{\"name\":\"%.*s\",\"ph\":\"%s\",\"pid\":1,\"tid\":%lld,", i32(len(name)), raw_data(name), ph, i64(tid))
			ts(f, t)
		}
		for p, tid in procs {
			if p == nil || p.trace == nil do continue
			libc.fprintf(f, ",\n{\"name\":\"thread_name\",\"ph\":\"M\",\"pid\":1,\"tid\":%lld,\"args\":{\"name\":\"sched thread %lld\"}}", i64(tid), i64(tid))
			n := sync.atomic_load(&p.trace_n)
			run_g, run_ts, idle_ts := i32(0), i64(-1), i64(-1)
			end_run :: proc "contextless" (f: ^libc.FILE, tid: int, g: i32, from, to: i64) {
				libc.fprintf(f, ",\n{\"name\":\"goroutine %d\",\"cat\":\"run\",\"ph\":\"X\",\"pid\":1,\"tid\":%lld,", g, i64(tid))
				ts(f, from)
				libc.fprintf(f, ",\"dur\":%lld.%03lld,\"args\":{\"g\":%d}}", (to - from) / 1000, (to - from) % 1000, g)
			}
			for i in max(0, n - TRACE_EVENTS)..<n {
				e := p.trace[i & (TRACE_EVENTS - 1)]
				wait := e.wait if e.wait <= max(Wait) else .None
				// a run ends at the next event that switches away
				if run_ts >= 0 && (e.kind == .Run || e.kind == .Park || e.kind == .Exit || e.kind == .Idle) {
					end_run(f, tid, run_g, run_ts, e.ts)
					run_ts = -1
				}
				switch e.kind {
				case .Run:
					run_g, run_ts = e.g, e.ts
				case .Idle:
					idle_ts = e.ts
				case .Idle_End:
					if idle_ts >= 0 {
						head(f, "idle", "X", tid, idle_ts)
						libc.fprintf(f, ",\"cat\":\"idle\",\"dur\":%lld.%03lld}", (e.ts - idle_ts) / 1000, (e.ts - idle_ts) % 1000)
					}
					idle_ts = -1
				case .Park:
					name := WAIT_NAMES[wait] if wait != .None else "yield"
					head(f, "park", "i", tid, e.ts)
					libc.fprintf(f, ",\"s\":\"t\",\"args\":{\"g\":%d,\"on\":\"%.*s\"}}", e.g, i32(len(name)), raw_data(name))
				case .Exit:
					head(f, "exit", "i", tid, e.ts)
					libc.fprintf(f, ",\"s\":\"t\",\"args\":{\"g\":%d}}", e.g)
				case .Go:
					head(f, "go", "i", tid, e.ts)
					libc.fprintf(f, ",\"s\":\"t\",\"args\":{\"g\":%d,\"by\":%d}}", e.arg, e.g)
				case .Wake:
					head(f, "wake", "i", tid, e.ts)
					libc.fprintf(f, ",\"s\":\"t\",\"args\":{\"g\":%d,\"thread\":%d}}", e.g, e.arg)
				case .Steal:
					head(f, "steal", "i", tid, e.ts)
					libc.fprintf(f, ",\"s\":\"t\",\"args\":{\"g\":%d,\"from\":%d}}", e.g, e.arg)
				case .IO_Submit:
					name := WAIT_NAMES[wait]
					head(f, "io submit", "i", tid, e.ts)
					libc.fprintf(f, ",\"s\":\"t\",\"args\":{\"g\":%d,\"op\":\"%.*s\"}}", e.g, i32(len(name)), raw_data(name))
				case .IO_Done:
					head(f, "io done", "i", tid, e.ts)
					libc.fprintf(f, ",\"s\":\"t\",\"args\":{\"g\":%d}}", e.g)
				}
			}
		}
		libc.fprintf(f, "%s", cstring("\n]}\n"))
		libc.fclose(f)
	}
}

// ---- I/O: start an nbio operation, park, resume from its callback ----

@(private)
Io_Wait :: struct {
	g:      ^G,
	result: nbio.Operation,
	task:   __vidar.Closure(proc(__vidar.Env)),
	ctx:    runtime.Context,
}

@(private)
io_done :: proc(op: ^nbio.Operation) {
	w := (^Io_Wait)(op.user_data[0])
	w.result = op^
	self().io_waiting -= 1
	trace(.IO_Done, w.g)
	ready(w.g)
}

// Starts op and parks until its callback (on this thread's loop, or a worker's) resumes us.
@(private)
await_op :: proc(op: ^nbio.Operation, loc: runtime.Source_Code_Location) -> nbio.Operation {
	w := Io_Wait{g = self().cur}
	op.user_data[0] = &w
	self().io_waiting += 1
	waiting(io_what(op), nil, loc)
	trace(.IO_Submit, self().cur, 0, io_what(op))
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
	return workers.loops[(sync.atomic_add(&workers.next, 1) + 1) % WORKERS]
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
	self().io_waiting -= 1
	trace(.IO_Done, w.g)
	ready(w.g)
}

@(private)
sched_loop_of :: proc(op: ^nbio.Operation) -> ^nbio.Event_Loop {
	return (^nbio.Event_Loop)(op.user_data[1])
}

// Like await_op, for an operation prepared on a worker's loop with worker_done as its callback.
@(private)
await_on_worker :: proc(op: ^nbio.Operation, loc: runtime.Source_Code_Location) -> nbio.Operation {
	w := Io_Wait{g = self().cur}
	op.user_data[0] = &w
	op.user_data[1] = self().loop
	self().io_waiting += 1
	waiting(io_what(op), nil, loc)
	trace(.IO_Submit, self().cur, 0, io_what(op))
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
	w.task.call(w.task.env)
	worker_done(op)
}

// Runs task on a worker thread and parks this goroutine until it returns; the other goroutines keep running.
// Use it for calls that block the thread: DNS, C libraries, anything without a sched version.
// The task runs on another thread, so it must not touch goroutine state without synchronizing.
blocking :: proc(task: __vidar.Closure(proc(__vidar.Env)), loc := #caller_location) { __task_call := task.call;
	sched_init()
	// nothing else could run meanwhile, so skip starting the workers
	if self().head == nil && self().io_waiting == 0 {
		__task_call(task.env)
		return
	}
	w := Io_Wait{g = self().cur, task = task, ctx = context}
	op := nbio.prep_timeout(0, run_blocking, worker_loop())
	op.user_data[0] = &w
	op.user_data[1] = self().loop
	self().io_waiting += 1
	waiting(.Blocking, nil, loc)
	trace(.IO_Submit, self().cur, 0, .Blocking)
	nbio.exec(op)
	park()
}

// File operations run on io_uring on Linux; elsewhere nbio does them synchronously, so they go to a worker.
// -define:VIDAR_FILES_ON_WORKERS=true sends them to workers on Linux too, to test that path there.
@(private)
FILES_ON_WORKERS :: #config(VIDAR_FILES_ON_WORKERS, ODIN_OS != .Linux)

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
await_file :: proc(op: ^nbio.Operation, loc: runtime.Source_Code_Location) -> nbio.Operation {
	when FILES_ON_WORKERS do return await_on_worker(op, loc)
	else do return await_op(op, loc)
}

// ---- timers ----

sleep :: proc(d: time.Duration, loc := #caller_location) {
	sched_init()
	await_op(nbio.prep_timeout(d, io_done), loc)
}

// A channel that receives true once d has passed, for select timeouts.
after :: proc(d: time.Duration, loc := #caller_location) -> Chan(bool) {
	c := make_chan(bool, 1)
	go(__closure_0(d, c, loc), loc)
	return c
}

// ---- TCP ----

listen_tcp :: proc(endpoint: nbio.Endpoint, backlog := 1000) -> (nbio.TCP_Socket, nbio.Network_Error) {
	sched_init()
	return nbio.listen_tcp(endpoint, backlog)
}

accept :: proc(socket: nbio.TCP_Socket, timeout := nbio.NO_TIMEOUT, loc := #caller_location) -> (nbio.TCP_Socket, nbio.Endpoint, nbio.Accept_Error) {
	sched_init()
	r := await_op(nbio.prep_accept(socket, io_done, timeout), loc)
	return r.accept.client, r.accept.client_endpoint, r.accept.err
}

dial :: proc(endpoint: nbio.Endpoint, timeout := nbio.NO_TIMEOUT, loc := #caller_location) -> (nbio.TCP_Socket, nbio.Network_Error) {
	sched_init()
	r := await_op(nbio.prep_dial(endpoint, io_done, timeout), loc)
	return r.dial.socket, r.dial.err
}

socket_recv :: proc(socket: nbio.TCP_Socket, buf: []byte, all := false, timeout := nbio.NO_TIMEOUT, loc := #caller_location) -> (int, nbio.Recv_Error) {
	sched_init()
	bufs := [1][]byte{buf}
	r := await_op(nbio.prep_recv(socket, bufs[:], io_done, all, timeout), loc)
	return r.recv.received, r.recv.err
}

socket_send :: proc(socket: nbio.TCP_Socket, buf: []byte, timeout := nbio.NO_TIMEOUT, loc := #caller_location) -> (int, nbio.Send_Error) {
	sched_init()
	bufs := [1][]byte{buf}
	r := await_op(nbio.prep_send(socket, bufs[:], io_done, timeout = timeout), loc)
	return r.send.sent, r.send.err
}

socket_close :: proc(socket: nbio.TCP_Socket, loc := #caller_location) {
	sched_init()
	await_op(nbio.prep_close(socket, io_done), loc)
}

// Sends nbytes of file (all of it by default) over the socket, without copying it through user space.
send_file :: proc(socket: nbio.TCP_Socket, file: File, offset := 0, nbytes := nbio.SEND_ENTIRE_FILE, timeout := nbio.NO_TIMEOUT, loc := #caller_location) -> (int, nbio.Send_File_Error) {
	sched_init()
	r := await_op(nbio.prep_sendfile(socket, file, io_done, offset, nbytes, timeout = timeout), loc)
	return r.sendfile.sent, r.sendfile.err
}

// Waits until the socket can be read from (.Receive) or written to (.Send) without blocking.
wait_ready :: proc(socket: nbio.Any_Socket, event: nbio.Poll_Event, timeout := nbio.NO_TIMEOUT, loc := #caller_location) -> nbio.Poll_Result {
	sched_init()
	r := await_op(nbio.prep_poll(socket, event, io_done, timeout), loc)
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

send_to :: proc(socket: nbio.UDP_Socket, buf: []byte, to: nbio.Endpoint, timeout := nbio.NO_TIMEOUT, loc := #caller_location) -> (int, nbio.Send_Error) {
	sched_init()
	bufs := [1][]byte{buf}
	r := await_op(nbio.prep_send(socket, bufs[:], io_done, to, timeout = timeout), loc)
	return r.send.sent, r.send.err
}

recv_from :: proc(socket: nbio.UDP_Socket, buf: []byte, timeout := nbio.NO_TIMEOUT, loc := #caller_location) -> (int, nbio.Endpoint, nbio.Recv_Error) {
	sched_init()
	bufs := [1][]byte{buf}
	r := await_op(nbio.prep_recv(socket, bufs[:], io_done, timeout = timeout), loc)
	return r.recv.received, r.recv.source, r.recv.err
}

udp_close :: proc(socket: nbio.UDP_Socket, loc := #caller_location) {
	sched_init()
	await_op(nbio.prep_close(socket, io_done), loc)
}

// ---- DNS (on a worker thread: the resolver blocks) ----

resolve :: proc(hostname_and_maybe_port: string, loc := #caller_location) -> (ep4, ep6: nbio.Endpoint, err: net.Network_Error) {
	Result :: struct { ep4, ep6: nbio.Endpoint, err: net.Network_Error }
	r := new(Result)
	defer free(r)
	blocking(__closure_1(hostname_and_maybe_port, r), loc)
	return r.ep4, r.ep6, r.err
}

// ---- files ----

File :: nbio.Handle

open :: proc(path: string, mode: nbio.File_Flags = {.Read}, perm := nbio.Permissions_Default_File, loc := #caller_location) -> (File, nbio.FS_Error) {
	sched_init()
	r := await_file(nbio.prep_open(path, file_cb(), mode, perm, l = file_loop()), loc)
	return r.open.handle, r.open.err
}

// Reads at offset (the file position is not used); with all, keeps reading until buf is full or the file ends.
read_at :: proc(file: File, offset: int, buf: []byte, all := false, loc := #caller_location) -> (int, nbio.FS_Error) {
	sched_init()
	r := await_file(nbio.prep_read(file, offset, buf, file_cb(), all, l = file_loop()), loc)
	return r.read.read, r.read.err
}

write_at :: proc(file: File, offset: int, buf: []byte, all := true, loc := #caller_location) -> (int, nbio.FS_Error) {
	sched_init()
	r := await_file(nbio.prep_write(file, offset, buf, file_cb(), all, l = file_loop()), loc)
	return r.write.written, r.write.err
}

stat :: proc(file: File, loc := #caller_location) -> (type: nbio.File_Type, size: i64, err: nbio.FS_Error) {
	sched_init()
	r := await_file(nbio.prep_stat(file, file_cb(), l = file_loop()), loc)
	return r.stat.type, r.stat.size, r.stat.err
}

file_close :: proc(file: File, loc := #caller_location) -> nbio.FS_Error {
	sched_init()
	r := await_file(nbio.prep_close(file, file_cb(), l = file_loop()), loc)
	return r.close.err
}

read_entire_file :: proc(path: string, allocator := context.allocator, loc := #caller_location) -> (data: []byte, err: nbio.FS_Error) {
	f := open(path, loc = loc) or_return
	defer file_close(f, loc)
	_, size := stat(f, loc) or_return
	data = make([]byte, int(size), allocator)
	n: int
	n, err = read_at(f, 0, data, all = true, loc = loc)
	if err == .EOF do err = nil
	return data[:n], err
}

write_entire_file :: proc(path: string, data: []byte, truncate := true, loc := #caller_location) -> nbio.FS_Error {
	mode: nbio.File_Flags = {.Write, .Create}
	if truncate do mode += {.Trunc}
	f := open(path, mode, loc = loc) or_return
	defer file_close(f, loc)
	_, err := write_at(f, 0, data, loc = loc)
	return err
}

send  :: proc{chan_send, socket_send}
recv  :: proc{chan_recv, socket_recv}
close :: proc{chan_close, socket_close, udp_close, file_close}

// ---- mutexes that park the goroutine, not the thread ----

Mutex :: struct {
	locked:  bool,
	waiters: Wait_Queue,
	guard:   sync.Mutex,
	vc:      Clock,
}

// Parking after the guard is released is safe: a wakeup that comes first queues the goroutine on
// its thread, where park picks it again, and no other thread takes it until it has switched away.
lock :: proc(m: ^Mutex, loc := #caller_location) {
	sched_init()
	mlock(&m.guard)
	if !m.locked {
		m.locked = true
		race_sync(&m.vc)
		munlock(&m.guard)
		return
	}
	w := Waiter{g = self().cur}
	enqueue(&m.waiters, &w)
	waiting(.Mutex, m, loc)
	munlock(&m.guard)
	park()
	race_sync_locked(&m.guard, &m.vc)
}

// Hands the lock straight to the longest waiter, if any.
unlock :: proc(m: ^Mutex) {
	mlock(&m.guard)
	defer munlock(&m.guard)
	assert(m.locked, "unlock of an unlocked sched.Mutex")
	race_sync(&m.vc)
	if w := dequeue(&m.waiters); w != nil {
		ready(w.g)
	} else {
		m.locked = false
	}
}

try_lock :: proc(m: ^Mutex) -> bool {
	mlock(&m.guard)
	defer munlock(&m.guard)
	if m.locked do return false
	m.locked = true
	race_sync(&m.vc)
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
		// a select waits on several channels, whose locks are taken one at a time
		when MULTI {
			if _, won := sync.atomic_compare_exchange_strong(&w.sel.fired, -1, w.case_index); won do return w
		} else {
			if w.sel.fired < 0 {
				w.sel.fired = w.case_index
				return w
			}
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
	guard:        sync.Mutex,
	vc:           Clock,
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
chan_send :: proc(c: Chan($T), v: T, loc := #caller_location) {
	sched_init()
	v := v
	if c.raw == nil do block_forever(.Chan_Send_Nil, loc)
	mlock(&c.raw.guard)
	race_sync(&c.raw.vc)
	if try_send_raw(c.raw, &v) {
		munlock(&c.raw.guard)
		return
	}
	w := Waiter{g = self().cur, elem = &v}
	enqueue(&c.raw.sendq, &w)
	waiting(.Chan_Send, c.raw, loc)
	munlock(&c.raw.guard)
	park()
	race_sync_locked(&c.raw.guard, &c.raw.vc)
	if !w.ok do panic("send on closed channel")
}

// Blocks until a value arrives; ok is false once the channel is closed and drained.
chan_recv :: proc(c: Chan($T), loc := #caller_location) -> (v: T, ok: bool) #optional_ok {
	sched_init()
	if c.raw == nil do block_forever(.Chan_Recv_Nil, loc)
	mlock(&c.raw.guard)
	race_sync(&c.raw.vc)
	if done, got := try_recv_raw(c.raw, &v); done {
		munlock(&c.raw.guard)
		return v, got
	}
	w := Waiter{g = self().cur, elem = &v}
	enqueue(&c.raw.recvq, &w)
	waiting(.Chan_Recv, c.raw, loc)
	munlock(&c.raw.guard)
	park()
	race_sync_locked(&c.raw.guard, &c.raw.vc)
	return v, w.ok
}

chan_close :: proc(c: Chan($T)) {
	sched_init()
	if c.raw == nil do panic("close of nil channel")
	mlock(&c.raw.guard)
	defer munlock(&c.raw.guard)
	if c.raw.closed do panic("close of closed channel")
	c.raw.closed = true
	race_sync(&c.raw.vc)
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

chan_len :: proc(c: Chan($T)) -> int { return sync.atomic_load(&c.raw.count) if c.raw != nil else 0 }
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
select :: proc(cases: ..Select_Case, loc := #caller_location) -> int {
	return select_cases(cases, false, loc)
}

// Like select, but returns -1 at once when no case is ready.
try_select :: proc(cases: ..Select_Case, loc := #caller_location) -> int {
	return select_cases(cases, true, loc)
}

@(private)
select_cases :: proc(cases: []Select_Case, nonblocking: bool, loc: runtime.Source_Code_Location) -> int {
	sched_init()
	scratch := make([][]byte, len(cases), runtime.heap_allocator())
	for &c, i in cases {
		if c.ch != nil && c.elem == nil {
			scratch[i] = make([]byte, max(c.ch.elem_size, 1), runtime.heap_allocator())
			c.elem = raw_data(scratch[i])
		}
	}
	index, ok := select_raw(cases, nonblocking, loc)
	if index >= 0 && cases[index].ok != nil do cases[index].ok^ = ok
	for c, i in cases {
		if c.is_send do free(c.elem, runtime.heap_allocator())
		delete(scratch[i], runtime.heap_allocator())
	}
	delete(scratch, runtime.heap_allocator())
	if index >= 0 && cases[index].is_send && !ok do panic("send on closed channel")
	return index
}

// With several threads, a select holds every channel's guard while it tries and enqueues, taking
// them in address order so two selects can't deadlock.
@(private)
select_lock :: proc(cases: []Select_Case, take: bool) {
	when MULTI {
		chans := make([]^Raw_Chan, len(cases), runtime.heap_allocator())
		defer delete(chans, runtime.heap_allocator())
		n := 0
		for c in cases do if c.ch != nil {
			chans[n] = c.ch
			n += 1
		}
		slice.sort(chans[:n])
		for ch, i in chans[:n] {
			if i > 0 && ch == chans[i - 1] do continue
			if take do sync.mutex_lock(&ch.guard)
			else do sync.mutex_unlock(&ch.guard)
		}
	}
}

@(private)
select_raw :: proc(cases: []Select_Case, nonblocking: bool, loc: runtime.Source_Code_Location) -> (index: int, ok: bool) {
	select_lock(cases, true)
	locked := true
	defer if locked do select_lock(cases, false)
	when RACE do for c in cases do if c.ch != nil do race_sync(&c.ch.vc)
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
		waiters[i] = Waiter{g = self().cur, elem = c.elem, sel = &sel, case_index = i}
		enqueue(&c.ch.sendq if c.is_send else &c.ch.recvq, &waiters[i])
	}
	waiting(.Select, nil, loc)
	when SCHED_DEBUG do self().cur.wait_cases = cases
	select_lock(cases, false)
	locked = false
	park()
	select_lock(cases, true)
	locked = true
	when RACE do for c in cases do if c.ch != nil do race_sync(&c.ch.vc)
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
	guard:   sync.Mutex,
	vc:      Clock,
}

add :: proc(wg: ^Wait_Group, n := 1) {
	mlock(&wg.guard)
	defer munlock(&wg.guard)
	race_sync(&wg.vc)
	wg.count += n
	if wg.count < 0 do panic("negative wait group counter")
	if wg.count == 0 {
		for w := dequeue(&wg.waiters); w != nil; w = dequeue(&wg.waiters) do ready(w.g)
	}
}

done :: proc(wg: ^Wait_Group) { add(wg, -1) }

wait :: proc(wg: ^Wait_Group, loc := #caller_location) {
	sched_init()
	mlock(&wg.guard)
	if wg.count == 0 {
		race_sync(&wg.vc)
		munlock(&wg.guard)
		return
	}
	w := Waiter{g = self().cur}
	enqueue(&wg.waiters, &w)
	waiting(.Wait_Group, wg, loc)
	munlock(&wg.guard)
	park()
	race_sync_locked(&wg.guard, &wg.vc)
}

// ---- generated by vidar ----

__closure_0 :: proc(__c0: $T0, __c1: $T1, __c2: $T2) -> __vidar.Closure(proc(__vidar.Env)) {
	__Caps :: struct {
		d: T0,
		c: T1,
		loc: T2,
	}
	#assert(size_of(__Caps) <= __vidar.CLOSURE_ENV, "closure at sched.vidar:1134: its captures don't fit in VIDAR_CLOSURE_ENV bytes; capture a pointer, or build with -define:VIDAR_CLOSURE_ENV=<bytes>")
	__Env :: struct { using __caps: __Caps, __pad: [__vidar.CLOSURE_ENV - size_of(__Caps)]byte }
	return __vidar.Closure(proc(__vidar.Env)){
		call = proc(__env_raw: __vidar.Env) { __env := transmute(__Env)__env_raw;
		sleep(__env.d, __env.loc)
		chan_send(__env.c, true, __env.loc)
	},
		env = transmute(__vidar.Env)__Env{__caps = {__c0, __c1, __c2}},
	}
}

__closure_1 :: proc(__c0: $T0, __c1: $T1) -> __vidar.Closure(proc(__vidar.Env)) {
	__Caps :: struct {
		hostname_and_maybe_port: T0,
		r: T1,
	}
	#assert(size_of(__Caps) <= __vidar.CLOSURE_ENV, "closure at sched.vidar:1229: its captures don't fit in VIDAR_CLOSURE_ENV bytes; capture a pointer, or build with -define:VIDAR_CLOSURE_ENV=<bytes>")
	__Env :: struct { using __caps: __Caps, __pad: [__vidar.CLOSURE_ENV - size_of(__Caps)]byte }
	return __vidar.Closure(proc(__vidar.Env)){
		call = proc(__env_raw: __vidar.Env) { __env := transmute(__Env)__env_raw;
		__env.r.ep4, __env.r.ep6, __env.r.err = net.resolve(__env.hostname_and_maybe_port)
	},
		env = transmute(__vidar.Env)__Env{__caps = {__c0, __c1}},
	}
}
