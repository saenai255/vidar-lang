// Load generator for both slime_mud servers: N clients on threads, each logging in and sending
// M commands, waiting for the prompt after each. Prints throughput and latency percentiles.
// With -script, runs one client through a file of commands and prints everything it receives.
package loadgen

import "core:flags"
import "core:fmt"
import "core:net"
import "core:os"
import "core:slice"
import "core:strings"
import "core:sync"
import "core:thread"
import "core:time"

Options :: struct {
	port:     int    `usage:"server TCP port"`,
	clients:  int    `usage:"concurrent clients"`,
	commands: int    `usage:"commands per client"`,
	script:   string `usage:"run one client through this file of commands, printing the transcript"`,
	prefix:   string `usage:"player name prefix"`,
}

COMMANDS := [?]string{"look", "n", "s", "e", "w", "attack slime", "attack slime", "say hi", "stats", "who"}

Client :: struct {
	sock:      net.TCP_Socket,
	buf:       [8192]byte,
	at_line:   bool,
	saw_angle: bool,
	transcript: ^strings.Builder,
}

// Reads until the server has sent one more "> " prompt at the start of a line.
wait_prompt :: proc(c: ^Client) -> bool {
	for {
		n, err := net.recv_tcp(c.sock, c.buf[:])
		if err != nil || n == 0 do return false
		if c.transcript != nil do strings.write_bytes(c.transcript, c.buf[:n])
		found := false
		for b in c.buf[:n] {
			if c.saw_angle && b == ' ' do found = true
			c.saw_angle = c.at_line && b == '>'
			c.at_line = b == '\n'
		}
		if found do return true
	}
}

send_line :: proc(c: ^Client, line: string) -> bool {
	msg := strings.concatenate({line, "\n"}, context.temp_allocator)
	_, err := net.send_tcp(c.sock, transmute([]byte)msg)
	return err == nil
}

connect :: proc(port: int, name: string, transcript: ^strings.Builder = nil) -> (c: ^Client, ok: bool) {
	sock, err := net.dial_tcp(net.Endpoint{net.IP4_Loopback, port})
	if err != nil do return nil, false
	net.set_option(sock, .Receive_Timeout, 30 * time.Second)
	c = new(Client)
	c^ = {sock = sock, at_line = true, transcript = transcript}
	if !wait_prompt(c) || !send_line(c, name) || !wait_prompt(c) {
		net.close(sock)
		free(c)
		return nil, false
	}
	return c, true
}

Result :: struct {
	latencies: [dynamic]time.Duration,
	failed:    bool,
}

run_client :: proc(opts: ^Options, id: int, start: ^sync.Barrier, out: ^Result) {
	c, ok := connect(opts.port, fmt.tprintf("%s%d", opts.prefix, id))
	sync.barrier_wait(start)
	if !ok {
		out.failed = true
		return
	}
	defer net.close(c.sock)
	rng := u64(id) * 0x9E3779B97F4A7C15 + 1
	reserve(&out.latencies, opts.commands)
	for _ in 0..<opts.commands {
		rng ~= rng << 13
		rng ~= rng >> 7
		rng ~= rng << 17
		cmd := COMMANDS[rng % len(COMMANDS)]
		t := time.tick_now()
		if !send_line(c, cmd) || !wait_prompt(c) {
			out.failed = true
			return
		}
		append(&out.latencies, time.tick_since(t))
		free_all(context.temp_allocator)
	}
	send_line(c, "quit")
}

run_script :: proc(opts: ^Options) {
	data, err := os.read_entire_file(opts.script, context.allocator)
	if err != nil {
		fmt.eprintfln("read %s: %v", opts.script, err)
		os.exit(1)
	}
	transcript := strings.builder_make()
	c, ok := connect(opts.port, opts.prefix, &transcript)
	if !ok {
		fmt.eprintln("could not log in")
		os.exit(1)
	}
	text := string(data)
	for line in strings.split_lines_iterator(&text) {
		if line == "" do continue
		if !send_line(c, line) do break
		if !wait_prompt(c) do break
	}
	fmt.print(strings.to_string(transcript))
}

main :: proc() {
	opts := Options{port = 4000, clients = 32, commands = 1000, prefix = "bot"}
	flags.parse_or_exit(&opts, os.args, .Unix)
	if opts.script != "" {
		run_script(&opts)
		return
	}

	results := make([]Result, opts.clients)
	threads := make([]^thread.Thread, opts.clients)
	start: sync.Barrier
	sync.barrier_init(&start, opts.clients + 1)
	for i in 0..<opts.clients {
		threads[i] = thread.create_and_start_with_poly_data4(&opts, i, &start, &results[i], run_client)
	}
	sync.barrier_wait(&start)
	t0 := time.tick_now()
	for t in threads do thread.join(t)
	elapsed := time.tick_since(t0)

	all: [dynamic]time.Duration
	failed := 0
	for r in results {
		append(&all, ..r.latencies[:])
		if r.failed do failed += 1
	}
	slice.sort(all[:])
	pct :: proc(xs: []time.Duration, p: f64) -> f64 {
		if len(xs) == 0 do return 0
		return time.duration_milliseconds(xs[min(len(xs) - 1, int(f64(len(xs)) * p))])
	}
	secs := time.duration_seconds(elapsed)
	fmt.printfln("clients=%d commands=%d failed=%d", opts.clients, len(all), failed)
	fmt.printfln("elapsed_s=%.3f throughput=%.0f p50_ms=%.3f p99_ms=%.3f max_ms=%.3f",
		secs, f64(len(all)) / secs, pct(all[:], 0.50), pct(all[:], 0.99), pct(all[:], 1))
}
