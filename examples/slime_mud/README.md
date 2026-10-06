# Slime MUD

A small multiplayer text adventure server, written twice: once in idiomatic Vidar ([vidar/](vidar)) and once in idiomatic Odin ([odin/](odin)). Players connect over TCP, walk a 32×32 grid of caves, fight slimes and the Slime King, and gamble their gold. The world ticks on its own, players are saved to disk, a UDP port answers status queries, and an offline mode simulates hundreds of bots.

The Vidar version uses almost every feature in [SYNTAX.md](../../SYNTAX.md). The Odin version is the program an Odin programmer would write without Vidar. Both behave identically: they share the world rules, the random number generator and every message. The [benchmark](#benchmarks) checks this before it measures anything.

## Running

```bash
npm run build                                   # from the repository root
node dist/cli.js run examples/slime_mud/vidar   # or:
odin run examples/slime_mud/odin
```

Run either one from this directory so it finds `motd.txt`. Then connect with `nc localhost 4000` (or `telnet`), type a name, and try `help`. Saves go to `./saves`. `--help` lists the flags. Both versions take the same ones, for example `--port 0` to pick a free port, `--tick-ms 0` to stop the clock, and `--sim 2000` for an offline simulation.

```
$ echo status | nc -u -w1 localhost 4001
SlimeMUD v1.0 players=1 tick=5310
$ echo shutdown | nc -u -w1 localhost 4001      # saves everyone and exits
```

## Layout

| | Vidar | Odin |
|---|---|---|
| world, rules, rooms | [world/world.vidar](vidar/world/world.vidar) | [game/world.odin](odin/game/world.odin) |
| commands | [world/commands.vidar](vidar/world/commands.vidar) | [game/commands.odin](odin/game/commands.odin) |
| slimes, the king, players | [entity/slime.vidar](vidar/entity/slime.vidar), [entity/player.vidar](vidar/entity/player.vidar) | in [game/world.odin](odin/game/world.odin) |
| save files | [save/save.vidar](vidar/save/save.vidar) | [game/save.odin](odin/game/save.odin) |
| networking | [server/server.vidar](vidar/server/server.vidar) | [server/server.odin](odin/server/server.odin) |
| flags, simulation | [main.vidar](vidar/main.vidar) | [main.odin](odin/main.odin) |

[bench/](bench) holds the benchmark: a load generator written in plain Odin, a scripted session and the harness.

## How each version is built

| | Vidar | Odin |
|---|---|---|
| concurrency | goroutines on one thread: a reader and a writer per connection, one goroutine that owns the world, a ticker, a UDP responder | OS threads: a reader and a writer per connection, a ticker, a UDP responder; one mutex guards the world |
| talking to the world | `sched.Chan(Request)` into the world goroutine, a `sched.select` over requests and ticks | lock the mutex, call into the world, unlock |
| messages to a player | a closure stored on the player, `proc[outbox](msg) { deliver(outbox, msg) }` | a `core:sync/chan` stored on the player |
| monsters | `Slime` and `Slime_King` behind interfaces (`Monster`, `Boss`), allocated one by one | one `Monster` struct with a kind enum, in a contiguous array; rooms hold indices |
| commands | a registry of closures, filled by a `command!` macro | a `switch` on the verb |
| save format | `save.derive!(Player_Record, "record")` generates the writer and reader | hand-written writer and `switch` reader |
| tables (room names, xp curve, CRC) | computed by the transpiler and folded into the binary | room names and xp curve computed at startup; CRC from `core:hash` |
| flags | hand-rolled parser with `or_return .Bad_Number` | `core:flags` |

### Where the Vidar features are

- **Closures**
  - Command handlers in a `[dynamic]Command` registry: `proc[d](c: ^Ctx)` captures the direction per loop iteration.
  - World hooks (`every(n, f)`), the save callback, and each player's output sink.
  - Every goroutine starts from a closure.
- **Interfaces with extension**
  - `Entity`, then `Actor` and `Lootable` (both `using Entity`), then `Monster :: interface { using Actor, using Lootable }` (a diamond), then `Boss :: interface { using Monster, roar }`.
  - `Persistent` and `Hero :: interface { using Actor, using Persistent }`.
  - `entity` implements `world`'s interfaces from the other side of an import cycle (`impl world.Monster for Slime`).
  - Calls are dynamic in the tick loop and static on `^Player`.
- **Cyclic imports**: `world` spawns and moves entities; entities act on the world.
- **Error handling**
  - `or_return .Bad_Number` and `or_return .Bad_Direction` in commands and flag parsing.
  - `catch err { ... }` for command errors, unusable saves and socket setup.
  - `catch unreachable` for the built-in new-player template and the UDP socket.
  - `errdefer delete(rec.name)` while parsing a save.
- **Anonymous struct literals**: `hit := { dmg = dmg, killed = hurt(...) }` in combat, and the simulation totals.
- **Comptime procs**
  - `command!`: an `Ident` from `ident("c")` and a trailing `Stmt` block, expanding to a closure literal.
  - `save.derive!`
    - A file-scope macro from another package.
    - Uses `type_fields`, `parse_expr` and `$(...)` splicing.
    - Uses `$$T` to emit a polymorphic writer.
    - Calls `compile_error` on an empty type.
  - `in_range!`: `split_range` and `once`.
  - `log!`: `call_site`.
  - `static_assert!`: a no-result macro at file scope.
- **Compile-time evaluation**
  - `room_names!(32, 32)` folds to 1024 strings.
  - Also folded: `xp_curve!`, `crc32_table!`, and `VERSION :: fmt.tprintf!("SlimeMUD v%d.%d", MAJOR, MINOR)`.
- **Goroutines and channels**
  - Networking: `listen_tcp`/`accept`/`socket_recv` with an idle timeout, `send`, and `send_file` for the MOTD.
  - Waiting: `select` over requests and ticks; `try_select` with `on_send` to drop messages for slow clients.
  - Shutdown: a `Wait_Group` of pending saves, raced against `sched.after(2s)`.
  - Locking: `sched.Mutex` held across a file write.
  - Worker threads: `blocking` for `os.rename` and `os.make_directory_all`.
  - Also used: UDP `recv_from`/`send_to`, and `resolve` and `dial` for the optional master-server heartbeat.
- **Built-in macros**
  - `scoped!` around each request, tick and UDP packet.
  - `with_allocator!` puts the simulation on an arena.
  - `track!("session")` reports leaked allocations per connection in `-debug` builds.
  - `timed!("sim")` times the simulation.
  - `locked!` guards save stats written from worker threads.
  - `do!(Monster)` with `take` and an early `return .No_Target`.
  - `check!`, `dbg!` (debug builds) and `todo!` (IPv6-only master servers).

## Both versions agree

The world uses its own xorshift64* generator, and both versions draw from it in the same order. So the same seed gives the same game:

- `--sim 2000 --slimes 20000 --sim-players 500` prints the same totals and the same final generator state from both binaries.
- [bench/script.txt](bench/script.txt), played against each server with ticks off, produces byte-identical transcripts.
- Save files are byte-identical too: a player saved by one server loads in the other.

## Benchmarks

```bash
npm run build
node examples/slime_mud/bench/bench.js           # about 2 minutes; --quick for a smoke run
```

The harness builds both versions and checks they agree. Then it measures:

- **Build**: the transpile step and `odin build` at the default level and at `-o:speed`.
- **Startup**: from process start until both ports are bound (`--ready-exit`).
- **Simulation**: 2000 ticks of 500 bots in a world of 20,000 slimes, on one thread with no I/O. This is the pure game logic: command parsing and dispatch, combat, string formatting, monsters acting.
- **Server under load**: 64 clients on loopback, each logging in and sending 2000 commands, waiting for the prompt after each. The world ticks every 50 ms.

The results go to [bench/results.md](bench/results.md). These are from one run:

Measured on Apple M3 Pro, 12 cores, 36 GB, darwin 25.5.0; Odin dev-2026-07-nightly:ab0131c, Node v20.15.0.
Each number is the median of the runs listed. Both versions agree: simulation identical, transcript identical.

**Build** (5 runs)

|  | Vidar | Odin | Vidar vs Odin | 95% interval | Real difference? |
| --- | ---: | ---: | ---: | ---: | --- |
| transpile (`vidar build`, Node) | 145 ms | – | – | – | – |
| `odin build` default (`-o:minimal`) | 307 ms | 259 ms | +18.5% | +14.0% to +29.5% | yes |
| `odin build -o:speed` | 2468 ms | 2370 ms | +4.1% | +3.4% to +5.7% | yes |
| total, default | 454 ms | 259 ms | +75.3% | +68.2% to +86.9% | yes |
| binary size (`-o:speed`) | 445 KB | 409 KB | +8.7% | – | exact |
| source lines (non-blank, non-comment) | 1157 | 860 | +34.5% | – | exact |
| generated Odin lines (without runtime and sched) | 1621 | – | – | – | – |

**Startup**: process start to ports bound, `--ready-exit` (100 runs)

|  | Vidar | Odin | Vidar vs Odin | 95% interval | Real difference? |
| --- | ---: | ---: | ---: | ---: | --- |
| median | 3.7 ms | 3.7 ms | −0.6% | −1.3% to +2.3% | no, within noise |
| p90 | 4.9 ms | 4.7 ms | +5.0% | −13.0% to +17.7% | no, within noise |

**Simulation**: `--sim 2000 --slimes 20000 --sim-players 500`, one thread, no I/O (5 runs)

|  | Vidar | Odin | Vidar vs Odin | 95% interval | Real difference? |
| --- | ---: | ---: | ---: | ---: | --- |
| time | 1050 ms | 915 ms | +14.8% | +13.0% to +16.7% | yes |
| bot commands per second | 952484 | 1093385 | −12.9% | −14.3% to −11.5% | yes |

**Server under load**: 64 clients × 2000 commands over loopback, 50 ms ticks (3 runs)

|  | Vidar | Odin | Vidar vs Odin | 95% interval | Real difference? |
| --- | ---: | ---: | ---: | ---: | --- |
| throughput | 114052 cmd/s | 104974 cmd/s | +8.6% | +7.1% to +11.1% | yes |
| latency p50 | 0.507 ms | 0.549 ms | −7.7% | −10.2% to −5.8% | yes |
| latency p99 | 1.458 ms | 1.214 ms | +20.1% | +8.2% to +45.7% | yes |
| latency max | 4.6 ms | 16.0 ms | −71.1% | −80.0% to −18.7% | yes |
| failed clients | 0 | 0 | – | – | – |
| RSS idle | 2.2 MB | 2.0 MB | +9.4% | +8.6% to +10.2% | yes |
| RSS after load | 5.8 MB | 5.9 MB | −1.8% | −3.1% to −1.3% | yes |

Vidar vs Odin is (Vidar − Odin) / Odin: negative means Vidar is smaller, which is better for times, sizes and latency and worse for throughput.
The 95% interval comes from resampling the runs (bootstrap). When it includes 0%, the difference is within run-to-run noise. With only 3 to 5 runs, an interval is roughly the spread between runs; size and line counts are exact.

### What the numbers say

I ran the full benchmark three times. Percentages are Vidar against Odin. Where the runs disagreed, the ranges cover all three. "Within noise" means the 95% interval of that run included 0%.

- **Build: Vidar adds one transpile step, about 145 ms.** Most of that is Node starting up.
  - Total at the default level: Vidar 56–75% slower (about 450 ms against 260–280 ms). The transpile step is most of the difference.
  - `odin build` at the default level: the generated code took 4–19% longer to compile in every run (289–307 ms against 258–279 ms). Earlier runs, before devirtualization, had the two the other way round. The bench builds one version five times and then the other, so drift between the batches can show up here.
  - `-o:speed`: 1–5% slower (2.42–2.48 s against 2.35–2.41 s), dominated by LLVM.
  - The generated Odin is longer than the hand-written version. It adds interface vtables and dispatchers, closure constructors, the `vidar_runtime` and `vidar_sched` packages, and the 1024 room names folded in as a literal.
- **Size: the Vidar binary is 8.7% bigger (445 KB against 409 KB).** It also carries the scheduler and runtime packages, and its interface dispatchers test for each implementation inline.
- **Source lines: the Vidar version is 34.5% longer, and that is mostly a design choice, not the language.**
  - Vidar's monsters are two types behind interfaces, each with its own bound procs. Odin's are one struct with a kind enum and a few `if king` branches.
  - Vidar also defines its own macros, and it parses flags by hand where Odin uses `core:flags`.
  - In return, the Vidar version can add a monster type without touching the tick loop or the commands, and its save format follows the struct.
- **Startup: within noise in every run, about 3.6 ms for both, and mostly process creation.** Before it binds its ports, the Vidar binary creates a kqueue event loop and, for `sched.blocking`, four worker threads with their own event loops.
- **Simulation: Vidar is 13–15% slower (1037–1050 ms against 908–928 ms).** This is outside the noise in every run.
  - Profiles of both have the same shape. The top costs are moving monsters between rooms (an ordered remove from the room's list) and `fmt` formatting.
  - The difference is data layout, not dispatch. Interface calls are devirtualized: `act` compares the vtable pointer against the three implementations and calls the proc directly, and the dispatch frames disappear from the profile. Turning that off changes the simulation time by less than the noise, because the M3's branch predictor already handled the indirect call well.
  - What remains: Vidar's room lists hold 16-byte interface values where Odin's hold `int` indices, so the searches and removes in `relocate` touch twice the bytes (about 35% more samples in moving monsters). Each slime is also allocated on its own, where Odin walks a contiguous array.
  - `scoped!` around each tick costs nothing measurable: replacing it with Odin's `free_all(context.temp_allocator)` left the time unchanged.
- **Server under load: Vidar is ahead on throughput, median and worst-case latency, and behind on p99.** Each of these differences was outside the noise.
  - Every command is a `recv` and a `send` on each side of a loopback socket, so syscalls dominate, not game logic.
  - Throughput: Vidar 7–9% higher (113–114k commands/s against 105–107k).
  - Median latency: Vidar 7–8% lower (about 0.50 ms against 0.54 ms).
  - p99: Vidar 20–33% higher (1.38–1.54 ms against 1.15–1.21 ms). One scheduler thread runs every session, so a command can wait behind the others that arrived in the same event-loop pass.
  - Worst command: Vidar 70–75% lower (4.5–4.9 ms against 16–20 ms). The single scheduler thread never contends for a lock. The Odin server runs about 130 threads (two per client, plus the ticker, the UDP responder and the accept loop), and they queue on one world mutex.
  - Memory: 2.2 MB idle against 2.0 MB (+9%, the scheduler's worker threads), and about 2% less after the run (5.8 MB against 5.9–6.0 MB).

In short: Vidar adds about 150 ms to each build and about 14% to tight single-threaded loops that keep interface values in their hot data. In return, the I/O-bound server is as fast as a threaded Odin one, with a much lower worst case but a slightly higher p99, written as straight-line blocking code.

### Bugs this sample found

Building the sample turned up four bugs in Vidar, now fixed. Each has a regression test.

- **Closure types in an import cycle:** a closure type's result type, as in `closure(c: ^Ctx) -> Command_Error`, didn't get its package prefix. The analyzer never visited result types unless a caller asked for them. Test: [tests/cases/import_cycles](../../tests/cases/import_cycles).
- **Macros under `do`:** a statement macro whose `Expr(T)` argument needed an Odin-side type check broke out of a `do` body. Under `if err != .Io do log!(...)`, the log ran unconditionally. Test: [tests/cases/macro_typecheck_fallback](../../tests/cases/macro_typecheck_fallback).
- **`vidar:sched` hang on synchronous completion:** a goroutine whose I/O finished without waiting on the kernel (`send_file`, a short `send`) stayed parked whenever another goroutine had I/O pending, such as a listener's `accept`. That stopped the server after it sent the message of the day.
- **`vidar:sched` hang on worker results:** results from worker threads (`blocking`, and files on macOS) could arrive just as the scheduler went to sleep, and then didn't wake it.

The last two share a test: [tests/cases/sched_pending_io](../../tests/cases/sched_pending_io).
