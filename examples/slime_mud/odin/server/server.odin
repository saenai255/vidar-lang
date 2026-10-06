package server

import "core:fmt"
import "core:net"
import "core:os"
import "core:strings"
import "core:sync"
import "core:sync/chan"
import "core:thread"
import "core:time"
import "../game"

OUTBOX_CAP :: 256
AUTOSAVE_TICKS :: 600
HEARTBEAT_EVERY :: 5 * time.Second
MAX_NAME :: 16

Config :: struct {
	port:        int    `usage:"TCP port (0 picks one)"`,
	udp_port:    int    `args:"name=udp-port" usage:"UDP status port"`,
	tick_ms:     int    `args:"name=tick-ms" usage:"world tick period, 0 for none"`,
	idle_secs:   int    `args:"name=idle-secs" usage:"disconnect idle players, 0 for never"`,
	slimes:      int    `usage:"slimes to spawn"`,
	seed:        u64    `usage:"world seed"`,
	saves:       string `usage:"save directory"`,
	motd:        string `usage:"message of the day"`,
	master:      string `usage:"send heartbeats to a master server (host:port)"`,
	ready_exit:  bool   `args:"name=ready-exit" usage:"start up, print the ports and exit"`,
	sim:         int    `usage:"run an offline simulation of this many ticks instead of a server"`,
	sim_players: int    `args:"name=sim-players" usage:"bots in the simulation"`,
}

DEFAULT_CONFIG :: Config{
	port = 4000, udp_port = 4001, tick_ms = 100, idle_secs = 300,
	slimes = 300, seed = 1, saves = "saves", motd = "motd.txt",
	sim_players = 200,
}

Server :: struct {
	cfg:     Config,
	motd:    []byte,
	// guards world and everything reachable from it
	mu:      sync.Mutex,
	world:   ^game.World,
	save_mu: sync.Mutex,
	stats:   struct {
		saves, bytes: int,
	},
}

run :: proc(cfg: Config) -> bool {
	s := new(Server)
	s.cfg = cfg
	s.world = game.make_world(cfg.seed, cfg.slimes)
	s.motd, _ = os.read_entire_file(cfg.motd, context.allocator)
	os.make_directory_all(cfg.saves)

	listener, err := net.listen_tcp({net.IP4_Loopback, cfg.port})
	if err != nil {
		fmt.eprintfln("listen on port %d: %v", cfg.port, err)
		return false
	}
	udp, uerr := net.make_bound_udp_socket(net.IP4_Loopback, cfg.udp_port)
	if uerr != nil {
		fmt.eprintfln("bind udp port %d: %v", cfg.udp_port, uerr)
		return false
	}
	tcp_ep, _ := net.bound_endpoint(listener)
	udp_ep, _ := net.bound_endpoint(udp)
	fmt.printfln("ready tcp=%d udp=%d", tcp_ep.port, udp_ep.port)
	if cfg.ready_exit do return true

	if cfg.tick_ms > 0 do thread.create_and_start_with_poly_data(s, ticker, self_cleanup = true)
	thread.create_and_start_with_poly_data2(s, udp, status_loop, self_cleanup = true)
	if cfg.master != "" do thread.create_and_start_with_poly_data(s, heartbeat_loop, self_cleanup = true)

	for {
		sock, _, aerr := net.accept_tcp(listener)
		if aerr != nil {
			fmt.eprintfln("accept: %v", aerr)
			continue
		}
		thread.create_and_start_with_poly_data2(s, sock, session, self_cleanup = true)
	}
}

ticker :: proc(s: ^Server) {
	period := time.Duration(s.cfg.tick_ms) * time.Millisecond
	for {
		time.sleep(period)
		pending: [dynamic]Pending_Save
		sync.lock(&s.mu)
		game.tick(s.world)
		if s.world.tick % AUTOSAVE_TICKS == 0 {
			for p in s.world.players do append(&pending, snapshot(s, p))
		}
		sync.unlock(&s.mu)
		for &ps in pending do write_save(s, &ps)
		delete(pending)
		free_all(context.temp_allocator)
	}
}

Pending_Save :: struct {
	path, data: string,
}

// Serializes p; call with s.mu held, then write_save without it.
snapshot :: proc(s: ^Server, p: ^game.Player) -> Pending_Save {
	return {fmt.aprintf("%s/%s.sav", s.cfg.saves, p.name), game.seal_record(&p.rec)}
}

// Writes a temp file and renames it over the old save, so a crash never leaves half a file.
write_save :: proc(s: ^Server, ps: ^Pending_Save) {
	defer {
		delete(ps.path)
		delete(ps.data)
	}
	sync.guard(&s.save_mu)
	tmp := strings.concatenate({ps.path, ".tmp"}, context.temp_allocator)
	if err := os.write_entire_file(tmp, ps.data); err != nil {
		fmt.eprintfln("save %s: %v", ps.path, err)
		return
	}
	if err := os.rename(tmp, ps.path); err != nil {
		fmt.eprintfln("save %s: %v", ps.path, err)
		return
	}
	s.stats.saves += 1
	s.stats.bytes += len(ps.data)
}

save_now :: proc(data: rawptr, p: ^game.Player) -> bool {
	s := (^Server)(data)
	// s.mu is held by the caller, so write on another thread
	ps := new_clone(snapshot(s, p))
	thread.create_and_start_with_poly_data2(s, ps, proc(s: ^Server, ps: ^Pending_Save) {
		write_save(s, ps)
		free(ps)
	}, self_cleanup = true)
	return true
}

load_or_create :: proc(s: ^Server, name: string) -> (rec: game.Record, fresh: bool) {
	path := fmt.tprintf("%s/%s.sav", s.cfg.saves, name)
	data, rerr := os.read_entire_file(path, context.allocator)
	if rerr != nil do return game.fresh_record(name), true
	defer delete(data)
	err: game.Save_Error
	rec, err = game.parse_record(string(data))
	if err != .None {
		fmt.eprintfln("save for %s is unusable (%v), starting fresh", name, err)
		return game.fresh_record(name), true
	}
	return rec, false
}

valid_name :: proc(name: string) -> bool {
	if len(name) == 0 || len(name) > MAX_NAME do return false
	for c in name {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9') do return false
	}
	return true
}

deliver :: proc(outbox: chan.Chan(string), msg: string) {
	owned := strings.clone(msg)
	if !chan.try_send(outbox, owned) do delete(owned)
}

session :: proc(s: ^Server, sock: net.TCP_Socket) {
	defer net.close(sock)
	if s.cfg.idle_secs > 0 {
		net.set_option(sock, .Receive_Timeout, time.Duration(s.cfg.idle_secs) * time.Second)
	}
	if len(s.motd) > 0 do net.send_tcp(sock, s.motd)

	outbox, _ := chan.create(chan.Chan(string), OUTBOX_CAP, context.allocator)
	w := thread.create_and_start_with_poly_data2(sock, outbox, writer)
	defer {
		chan.close(outbox)
		thread.join(w)
		thread.destroy(w)
		chan.destroy(outbox)
	}

	r := Line_Reader{sock = sock}
	deliver(outbox, "Who goes there?\n> ")
	p: ^game.Player
	for p == nil {
		line, err := read_line(&r)
		if err != .None do return
		name := strings.trim_space(line)
		if !valid_name(name) {
			deliver(outbox, "Names are 1-16 letters or digits.\n> ")
			continue
		}
		rec, fresh := load_or_create(s, name)
		sync.lock(&s.mu)
		ok: bool
		p, ok = game.join(s.world, rec, outbox)
		if ok {
			b := strings.builder_make(context.temp_allocator)
			fmt.sbprintf(&b, "Welcome, %s.\n" if fresh else "Welcome back, %s.\n", p.name)
			game.look(s.world, p, &b)
			strings.write_string(&b, "> ")
			deliver(outbox, strings.to_string(b))
		}
		sync.unlock(&s.mu)
		if !ok {
			delete(rec.name)
			deliver(outbox, "That name is taken.\n> ")
		}
		free_all(context.temp_allocator)
	}

	for {
		line, err := read_line(&r)
		if err != .None {
			if err == .Timeout do deliver(outbox, "* You doze off and fade away.\n")
			break
		}
		sync.lock(&s.mu)
		c := game.Ctx{w = s.world, p = p, saver = save_now, saver_data = s}
		deliver(outbox, game.handle_line(&c, line))
		sync.unlock(&s.mu)
		free_all(context.temp_allocator)
		verb, _, _ := strings.partition(strings.trim_space(line), " ")
		if verb == "quit" do break
	}

	sync.lock(&s.mu)
	ps := snapshot(s, p)
	game.leave(s.world, p)
	sync.unlock(&s.mu)
	write_save(s, &ps)
	game.free_player(p)
}

writer :: proc(sock: net.TCP_Socket, outbox: chan.Chan(string)) {
	connected := true
	for {
		msg, ok := chan.recv(outbox)
		if !ok do return
		if connected {
			_, err := net.send_tcp(sock, transmute([]byte)msg)
			connected = err == nil
		}
		delete(msg)
	}
}

Read_Error :: enum { None, Closed, Timeout, Too_Long }

Line_Reader :: struct {
	sock:   net.TCP_Socket,
	buf:    [1024]byte,
	lo, hi: int,
}

// The next line, without its line ending; valid until the next call.
read_line :: proc(r: ^Line_Reader) -> (string, Read_Error) {
	for {
		for i in r.lo..<r.hi {
			if r.buf[i] == '\n' {
				line := string(r.buf[r.lo:i])
				r.lo = i + 1
				return strings.trim_right(line, "\r"), .None
			}
		}
		if r.lo > 0 {
			copy(r.buf[:], r.buf[r.lo:r.hi])
			r.hi -= r.lo
			r.lo = 0
		}
		if r.hi == len(r.buf) do return "", .Too_Long
		n, err := net.recv_tcp(r.sock, r.buf[r.hi:])
		if err == .Timeout do return "", .Timeout
		if err != nil || n == 0 do return "", .Closed
		r.hi += n
	}
}

status_loop :: proc(s: ^Server, sock: net.UDP_Socket) {
	buf: [256]byte
	for {
		n, from, err := net.recv_udp(sock, buf[:])
		if err != nil do continue
		switch strings.trim_space(string(buf[:n])) {
		case "status":
			sync.lock(&s.mu)
			msg := fmt.tprintf("%s players=%d tick=%d\n", game.VERSION, len(s.world.players), s.world.tick)
			sync.unlock(&s.mu)
			net.send_udp(sock, transmute([]byte)msg, from)
		case "shutdown":
			shutdown(s)
		}
		free_all(context.temp_allocator)
	}
}

heartbeat_loop :: proc(s: ^Server) {
	ep4, _, err := net.resolve(s.cfg.master)
	if err != nil {
		fmt.eprintfln("master %s: %v", s.cfg.master, err)
		return
	}
	for {
		if conn, derr := net.dial_tcp(ep4); derr == nil {
			sync.lock(&s.mu)
			msg := fmt.tprintf("heartbeat %s players=%d\n", game.VERSION, len(s.world.players))
			sync.unlock(&s.mu)
			net.send_tcp(conn, transmute([]byte)msg)
			net.close(conn)
		}
		free_all(context.temp_allocator)
		time.sleep(HEARTBEAT_EVERY)
	}
}

shutdown :: proc(s: ^Server) {
	pending: [dynamic]Pending_Save
	sync.lock(&s.mu)
	fmt.eprintfln("shutting down, saving %d players", len(s.world.players))
	for p in s.world.players {
		game.tell(p, "* The server is shutting down.\n")
		append(&pending, snapshot(s, p))
	}
	sync.unlock(&s.mu)
	for &ps in pending do write_save(s, &ps)
	sync.lock(&s.save_mu)
	fmt.eprintfln("saves written: %d (%d bytes)", s.stats.saves, s.stats.bytes)
	os.exit(0)
}
