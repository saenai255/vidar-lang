Measured on Apple M3 Pro, 12 cores, 36 GB, darwin 25.5.0; Odin dev-2026-07-nightly:ab0131c, Node v20.15.0.
Each number is the median of the runs listed. Both versions agree: simulation identical, transcript identical.

**Vidar wins 4 of 15 measures, loses 6; 5 within noise or too few runs to tell.**

- better: simulation time: 1.16× faster
- better: bot commands per second: 1.16× faster
- better: server latency max: 6.38× lower
- better: server RSS after load: 1.04× smaller
- worse: build `odin build -o:speed`: 1.16× slower
- worse: build total, default: 1.83× slower
- worse: binary size (`-o:speed`): 1.08× larger
- worse: source lines (non-blank, non-comment): 1.35× more
- worse: server latency p50: 1.03× higher
- worse: server RSS idle: 1.02× larger

**Build** (5 runs)

|  | Vidar | Odin | Vidar is | 95% interval | Real difference? |
| --- | ---: | ---: | ---: | ---: | --- |
| transpile (`vidar build -opt`, Node) | 185 ms | – | – | – | – |
| `odin build` default (`-o:minimal`) | 310 ms | 274 ms | 1.13× slower | 0.99× to 1.55× slower | no, within noise |
| `odin build -o:speed` | 2747 ms | 2362 ms | 1.16× slower | 1.01× to 1.20× slower | yes, Odin better |
| total, default | 502 ms | 274 ms | 1.83× slower | 1.60× to 2.25× slower | yes, Odin better |
| binary size (`-o:speed`) | 444 KB | 409 KB | 1.08× larger | – | exact |
| source lines (non-blank, non-comment) | 1161 | 860 | 1.35× more | – | exact |
| generated Odin lines (without runtime and sched) | 2223 | – | – | – | – |

**Startup**: process start to ports bound, `--ready-exit` (100 runs)

|  | Vidar | Odin | Vidar is | 95% interval | Real difference? |
| --- | ---: | ---: | ---: | ---: | --- |
| median | 3.5 ms | 3.5 ms | same | 0.91× to 1.04× slower | no, within noise |
| p90 | 4.3 ms | 4.5 ms | 1.04× faster | 0.92× to 1.10× faster | no, within noise |

**Simulation**: `--sim 2000 --slimes 20000 --sim-players 500`, one thread, no I/O (5 runs)

|  | Vidar | Odin | Vidar is | 95% interval | Real difference? |
| --- | ---: | ---: | ---: | ---: | --- |
| time | 778 ms | 903 ms | **1.16× faster** | 1.13× to 1.18× faster | yes, Vidar better |
| bot commands per second | 1284867 | 1106871 | **1.16× faster** | 1.13× to 1.18× faster | yes, Vidar better |

**Server under load**: 64 clients × 2000 commands over loopback, 50 ms ticks (3 runs)

|  | Vidar | Odin | Vidar is | 95% interval | Real difference? |
| --- | ---: | ---: | ---: | ---: | --- |
| throughput | 113366 cmd/s | 112591 cmd/s | 1.01× faster | 0.98× to 1.04× faster | no, within noise |
| latency p50 | 0.527 ms | 0.511 ms | 1.03× higher | 1.02× to 1.05× higher | yes, Odin better |
| latency p99 | 1.107 ms | 1.221 ms | 1.10× lower | 0.81× to 1.26× lower | no, within noise |
| latency max | 3.1 ms | 20.1 ms | **6.38× lower** | 3.74× to 8.86× lower | yes, Vidar better |
| failed clients | 0 | 0 | – | – | – |
| RSS idle | 2.0 MB | 2.0 MB | 1.02× larger | 1.02× to 1.02× larger | yes, Odin better |
| RSS after load | 5.8 MB | 6.0 MB | **1.04× smaller** | 1.02× to 1.04× smaller | yes, Vidar better |

"Vidar is" says how many times faster, lower, smaller or fewer Vidar is than Odin, or how many times slower, higher, larger or more; bold marks a real Vidar win. Only real differences count as wins or losses in the summary.
The 95% interval comes from resampling the runs (bootstrap). When it includes 1×, the difference is within run-to-run noise. With only 3 to 5 runs, an interval is roughly the spread between runs; size and line counts are exact.
