Measured on Apple M3 Pro, 12 cores, 36 GB, darwin 25.5.0; Odin dev-2026-07-nightly:ab0131c, Node v20.15.0.
Each number is the median of the runs listed. Both versions agree: simulation identical, transcript identical.

**Build** (5 runs)

|  | Vidar | Odin |
| --- | ---: | ---: |
| transpile (`vidar build`, Node) | 147 ms | – |
| `odin build` default (`-o:minimal`) | 337 ms | 385 ms |
| `odin build -o:speed` | 2760 ms | 2507 ms |
| total, default | 485 ms | 385 ms |
| binary size (`-o:speed`) | 427 KB | 409 KB |
| source lines (non-blank, non-comment) | 1157 | 860 |
| generated Odin lines (without runtime and sched) | 1588 | – |

**Startup**: process start to ports bound, `--ready-exit` (100 runs)

|  | Vidar | Odin |
| --- | ---: | ---: |
| median | 4.2 ms | 4.2 ms |
| p90 | 10.2 ms | 8.7 ms |

**Simulation**: `--sim 2000 --slimes 20000 --sim-players 500`, one thread, no I/O (5 runs)

|  | Vidar | Odin |
| --- | ---: | ---: |
| time | 1059 ms | 924 ms |
| bot commands per second | 944647 | 1082804 |

**Server under load**: 64 clients × 2000 commands over loopback, 50 ms ticks (3 runs)

|  | Vidar | Odin |
| --- | ---: | ---: |
| throughput | 113207 cmd/s | 102388 cmd/s |
| latency p50 | 0.505 ms | 0.552 ms |
| latency p99 | 1.426 ms | 1.196 ms |
| latency max | 4.5 ms | 21.5 ms |
| failed clients | 0 | 0 |
| RSS idle → after load | 2.2 → 5.9 MB | 2.0 → 6.0 MB |
