Measured on Apple M3 Pro, 12 cores, 36 GB, darwin 25.5.0; Odin dev-2026-07-nightly:ab0131c, Node v20.15.0.
Each number is the median of the runs listed. Both versions agree: simulation identical, transcript identical.

**Vidar wins 7 of 15 measures, loses 6; 2 within noise or too few runs to tell.**

- better: startup median: 1.01× faster
- better: simulation time: 1.19× faster
- better: bot commands per second: 1.19× faster
- better: server throughput: 1.08× faster
- better: server latency p50: 1.02× lower
- better: server latency p99: 1.15× lower
- better: server latency max: 5.22× lower
- worse: build `odin build` default (`-o:minimal`): 1.15× slower
- worse: build `odin build -o:speed`: 1.04× slower
- worse: build total, default: 2.24× slower
- worse: binary size (`-o:speed`): 1.09× larger
- worse: source lines (non-blank, non-comment): 1.35× more
- worse: server RSS idle: 1.02× larger

**Build** (5 runs)

|  | Vidar | Odin | Vidar is | 95% interval | Real difference? |
| --- | ---: | ---: | ---: | ---: | --- |
| transpile (`vidar build -opt`, Node) | 348 ms | – | – | – | – |
| `odin build` default (`-o:minimal`) | 368 ms | 319 ms | 1.15× slower | 1.12× to 2.10× slower | yes, Odin better |
| `odin build -o:speed` | 3209 ms | 3076 ms | 1.04× slower | 1.04× to 1.06× slower | yes, Odin better |
| total, default | 717 ms | 319 ms | 2.24× slower | 2.19× to 3.20× slower | yes, Odin better |
| binary size (`-o:speed`) | 444 KB | 409 KB | 1.09× larger | – | exact |
| source lines (non-blank, non-comment) | 1161 | 860 | 1.35× more | – | exact |
| generated Odin lines (without runtime and sched) | 2259 | – | – | – | – |

**Startup**: process start to ports bound, `--ready-exit` (100 runs)

|  | Vidar | Odin | Vidar is | 95% interval | Real difference? |
| --- | ---: | ---: | ---: | ---: | --- |
| median | 3.8 ms | 3.9 ms | **1.01× faster** | 1.01× to 1.04× faster | yes, Vidar better |
| p90 | 5.0 ms | 5.0 ms | same | 0.92× to 1.16× slower | no, within noise |

**Simulation**: `--sim 2000 --slimes 20000 --sim-players 500`, one thread, no I/O (5 runs)

|  | Vidar | Odin | Vidar is | 95% interval | Real difference? |
| --- | ---: | ---: | ---: | ---: | --- |
| time | 1030 ms | 1224 ms | **1.19× faster** | 1.17× to 1.19× faster | yes, Vidar better |
| bot commands per second | 970800 | 816763 | **1.19× faster** | 1.17× to 1.19× faster | yes, Vidar better |

**Server under load**: 64 clients × 2000 commands over loopback, 50 ms ticks (3 runs)

|  | Vidar | Odin | Vidar is | 95% interval | Real difference? |
| --- | ---: | ---: | ---: | ---: | --- |
| throughput | 101233 cmd/s | 94161 cmd/s | **1.08× faster** | 1.05× to 1.09× faster | yes, Vidar better |
| latency p50 | 0.605 ms | 0.617 ms | **1.02× lower** | 1.00× to 1.03× lower | yes, Vidar better |
| latency p99 | 1.081 ms | 1.245 ms | **1.15× lower** | 1.05× to 1.17× lower | yes, Vidar better |
| latency max | 3.1 ms | 16.2 ms | **5.22× lower** | 3.03× to 6.99× lower | yes, Vidar better |
| failed clients | 0 | 0 | – | – | – |
| RSS idle | 2.0 MB | 2.0 MB | 1.02× larger | 1.02× to 1.02× larger | yes, Odin better |
| RSS after load | 6.0 MB | 6.0 MB | 1.01× larger | 0.98× to 1.01× larger | no, within noise |

"Vidar is" says how many times faster, lower, smaller or fewer Vidar is than Odin, or how many times slower, higher, larger or more; bold marks a real Vidar win. Only real differences count as wins or losses in the summary.
The 95% interval comes from resampling the runs (bootstrap). When it includes 1×, the difference is within run-to-run noise. With only 3 to 5 runs, an interval is roughly the spread between runs; size and line counts are exact.
