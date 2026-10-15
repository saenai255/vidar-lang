package main; import __vidar "vidar_runtime"

import "core:fmt"
import "core:strings"
import rc "vidar_rc"

// ---- a resource: a connection that must be closed ----

Conn :: struct {
	id:   int,
	peer: string,
}

conn_destroy :: proc(c: ^Conn) {
	if c.id == 0 do return // the zero value: nothing to close
	fmt.printfln("  close conn %d (%s)", c.id, c.peer)
}



next_id := 0

Error :: enum { None, Refused }

connect :: proc(peer: string) -> (Conn, Error) {
	if peer == "" do return {}, .Refused
	next_id += 1
	return Conn{next_id, peer}, nil
}

// every early return closes what is open so far
handshake :: proc(a, b: string) -> Error {
	first := connect(a) or_return; defer conn_destroy(&first)
	second := connect(b) or_return; defer conn_destroy(&second) // on failure, first is closed here
	fmt.printfln("  handshake %s <-> %s", first.peer, second.peer)
	return nil
}

// ---- a guard: unlocks when its scope ends ----

Lock :: struct { held: bool }

Guard :: struct { lock: ^Lock }

guard_destroy :: proc(g: ^Guard) {
	if g.lock == nil do return
	g.lock.held = false
	fmt.println("  unlocked")
}



acquire :: proc(l: ^Lock) -> Guard {
	l.held = true
	fmt.println("  locked")
	return Guard{l}
}

// ---- composition: a struct of resources is destroyed field by field ----

Server :: struct {
	name:      string,
	listener:  Conn,
	clients:   [dynamic]Conn,
	by_peer:   map[string]Conn,
}

// #owned: the server takes the connection over
accept :: proc(s: ^Server, c: Conn) { c := c; defer conn_destroy(&c);
	// move!(c) — main.vidar:70
	append(&s.clients, __vidar.take(&c))
}

// ---- a cloneable value: copies are deep ----

Buffer :: struct { data: [dynamic]u8 }

buffer_destroy :: proc(b: ^Buffer) { delete(b.data) }

buffer_clone :: proc(b: Buffer) -> Buffer {
	out := Buffer{make([dynamic]u8, len(b.data))}; defer buffer_destroy(&out)
	copy(out.data[:], b.data[:])
	{ defer out = {}; return out }
}




buffer :: proc(text: string) -> Buffer {
	b: Buffer; defer buffer_destroy(&b)
	append(&b.data, text)
	{ defer b = {}; return b }
}

text :: proc(b: Buffer) -> string { return string(b.data[:]) }

// ---- shared ownership: a tree whose children point back with a Weak ----

Node :: struct {
	name:     string,
	conn:     Conn,
	parent:   rc.Weak(Node),
	children: [dynamic]rc.Rc(Node),
}

add_child :: proc(parent: rc.Rc(Node), name: string) -> rc.Rc(Node) {
	c := connect(name) or_else Conn{}; defer conn_destroy(&c)
	// move!(c) — main.vidar:107
	child := rc.new(Node{name = name, conn = __vidar.take(&c), parent = rc.downgrade(parent)}); defer rc.release(&child)
	append(&rc.get(parent).children, rc.share(child)) // a second owner: the Rc is cloned
	{ defer child = {}; return child }
}

path :: proc(n: rc.Rc(Node)) -> string {
	up := rc.upgrade(rc.get(n).parent); defer rc.release(&up)
	if rc.get(up) == nil { #assert(type_of(rc.get(n).name) != Conn && type_of(rc.get(n).name) != Guard && type_of(rc.get(n).name) != Server && type_of(rc.get(n).name) != Node, "main.vidar:114: this copies a value whose type has impl Destroy, and both copies would be destroyed"); return __vidar.clone(rc.get(n).name) }
	#assert(type_of(rc.get(n).name) != Conn && type_of(rc.get(n).name) != Guard && type_of(rc.get(n).name) != Server && type_of(rc.get(n).name) != Node, "main.vidar:115: this copies a value whose type has impl Destroy, and both copies would be destroyed"); return strings.concatenate({path(up), "/", __vidar.clone(rc.get(n).name)}, context.temp_allocator)
}

// ---- generic code: destroys whatever its T needs ----

Stack :: struct($T: typeid) { items: [dynamic]T }

push :: proc(s: ^Stack($T), x: T) { x := x; defer __vidar.destroy(&x); // move!(x) — main.vidar:122
	append(&s.items, __vidar.take(&x)) }

drop_top :: proc(s: ^Stack($T)) { __vidar.destroy_pop(&s.items) }

main :: proc() {
	fmt.println("errors:")
	fmt.println("  result:", handshake("db", "cache"))
	fmt.println("  result:", handshake("db", ""))

	fmt.println("guard:")
	lock: Lock
	{
		g := acquire(&lock); defer guard_destroy(&g)
		fmt.println("  held:", lock.held)
	}
	fmt.println("  held:", lock.held)

	fmt.println("server:")
	{
		s := Server{name = "main"}; defer __Server_destroy(&s)
		{ __vidar_new: type_of(s.listener) = connect("0.0.0.0") or_else Conn{}; __vidar_old := s.listener; s.listener = __vidar_new; conn_destroy(&__vidar_old) }
		for peer in ([]string{"alice", "bob", "carol"}) {
			c := connect(peer) or_else Conn{}; defer conn_destroy(&c)
			// move!(c) — main.vidar:145
			accept(&s, __vidar.take(&c))
		}
		__vidar.destroy_ordered_remove(&s.clients, 1) // bob's connection is closed here
		{ __vidar_new: type_of(s.by_peer["dave"]) = connect("dave") or_else Conn{}; __vidar_old := s.by_peer["dave"]; s.by_peer["dave"] = __vidar_new; conn_destroy(&__vidar_old) }
		{ __vidar_new: type_of(s.by_peer["dave"]) = connect("dave again") or_else Conn{}; __vidar_old := s.by_peer["dave"]; s.by_peer["dave"] = __vidar_new; conn_destroy(&__vidar_old) } // the old one is closed
		// a closure that borrows the server: it can't outlive this proc
		each := __closure_0(&s)
		each.call(each.env, __vidar.Closure(proc(__vidar.Env, ^Conn)){call = proc(__env_raw: __vidar.Env, c: ^Conn) { fmt.printfln("  client %s", c.peer) }})
		fmt.println("  shutting down")
	}

	fmt.println("buffers:")
	{
		a := buffer("hello"); defer buffer_destroy(&a)
		b := buffer_clone(a); defer buffer_destroy(&b)                 // a clone: a is read below
		append(&b.data, '!')
		c := buffer_clone(b); defer buffer_destroy(&c)                 // b's last use: moved, no clone
		fmt.println(" ", text(a), text(c))
	}

	fmt.println("tree:")
	{
		c := connect("root") or_else Conn{}; defer conn_destroy(&c)
		// move!(c) — main.vidar:168
		root := rc.new(Node{name = "root", conn = __vidar.take(&c)}); defer rc.release(&root)
		usr := add_child(root, "usr"); defer rc.release(&usr)
		bin := add_child(usr, "bin"); defer rc.release(&bin)
		fmt.println(" ", path(bin), "owners of usr:", rc.count(usr))
	}

	fmt.println("stack:")
	{
		s: Stack(Conn); defer __vidar.destroy(&s)
		for peer in ([]string{"x", "y", "z"}) {
			c := connect(peer) or_else Conn{}; defer conn_destroy(&c)
			// move!(c) — main.vidar:179
			push(&s, __vidar.take(&c))
		}
		drop_top(&s)
		fmt.println("  left:", len(s.items))
	}
	fmt.println("done")
}

// ---- generated by vidar ----

__closure_0 :: proc(__c0: $T0) -> __vidar.Closure(proc(__vidar.Env, __vidar.Closure(proc(__vidar.Env, ^Conn)))) {
	__Caps :: struct {
		s: T0,
	}
	#assert(size_of(__Caps) <= __vidar.CLOSURE_ENV, "closure at main.vidar:151: its captures don't fit in VIDAR_CLOSURE_ENV bytes; capture a pointer, or build with -define:VIDAR_CLOSURE_ENV=<bytes>")
	__Env :: struct { using __caps: __Caps, __pad: [__vidar.CLOSURE_ENV - size_of(__Caps)]byte }
	return __vidar.Closure(proc(__vidar.Env, __vidar.Closure(proc(__vidar.Env, ^Conn)))){
		call = proc(__env_raw: __vidar.Env, visit: __vidar.Closure(proc(__vidar.Env, ^Conn))) { __env := transmute(__Env)__env_raw; __visit_call := visit.call; for &c in __env.s^.clients do __visit_call(visit.env, &c) },
		env = transmute(__vidar.Env)__Env{__caps = {__c0}},
	}
}

// destroys a Server: its fields that need it, last first
__Server_destroy :: proc(x: ^Server) {
	__vidar.destroy(&x.by_peer)
	__vidar.destroy(&x.clients)
	conn_destroy(&x.listener)
}

// destroys a Node: its fields that need it, last first
__Node_destroy :: proc(x: ^Node) {
	__vidar.destroy(&x.children)
	rc.weak_release(&x.parent)
	conn_destroy(&x.conn)
}

// impl Destroy for generic code and run-time checks
@(init, private="file")
__vidar_destroy_init :: proc "contextless" () {
	__vidar.register_destroy(Conn, conn_destroy)
	__vidar.register_destroy(Guard, guard_destroy)
	__vidar.register_clone(Buffer, buffer_destroy, buffer_clone)
	__vidar.register_destroy(Server, __Server_destroy)
	__vidar.register_destroy(Node, __Node_destroy)
}
