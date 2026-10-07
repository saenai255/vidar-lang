Measured on Apple M3 Pro, 12 cores, 36 GB, darwin 25.5.0; Odin dev-2026-07-nightly:ab0131c, Node v20.15.0.
Each number is the median of the runs listed. Both versions agree: simulation identical, transcript identical.

**Vidar wins 4 of 15 measures, loses 7; 4 within noise or too few runs to tell.**

- better: simulation time: 1.14× faster
- better: bot commands per second: 1.14× faster
- better: server latency max: 5.32× lower
- better: server RSS after load: 1.03× smaller
- worse: build `odin build` default (`-o:minimal`): 1.12× slower
- worse: build total, default: 1.74× slower
- worse: binary size (`-o:speed`): 1.08× larger
- worse: source lines (non-blank, non-comment): 1.35× more
- worse: startup median: 1.09× slower
- worse: server latency p50: 1.05× higher
- worse: server RSS idle: 1.10× larger

**Build** (5 runs)

|  | Vidar | Odin | Vidar is | 95% interval | Real difference? |
| --- | ---: | ---: | ---: | ---: | --- |
| transpile (`vidar build -opt`, Node) | 189 ms | – | – | – | – |
| `odin build` default (`-o:minimal`) | 353 ms | 317 ms | 1.12× slower | 1.02× to 1.36× slower | yes, Odin better |
| `odin build -o:speed` | 2628 ms | 2641 ms | same | 0.92× to 1.16× faster | no, within noise |
| total, default | 551 ms | 317 ms | 1.74× slower | 1.61× to 2.20× slower | yes, Odin better |
| binary size (`-o:speed`) | 444 KB | 409 KB | 1.08× larger | – | exact |
| source lines (non-blank, non-comment) | 1161 | 860 | 1.35× more | – | exact |
| generated Odin lines (without runtime and sched) | 2223 | – | – | – | – |

**Startup**: process start to ports bound, `--ready-exit` (100 runs)

|  | Vidar | Odin | Vidar is | 95% interval | Real difference? |
| --- | ---: | ---: | ---: | ---: | --- |
| median | 4.1 ms | 3.7 ms | 1.09× slower | 1.04× to 1.16× slower | yes, Odin better |
| p90 | 4.9 ms | 4.8 ms | 1.03× slower | 0.94× to 1.12× slower | no, within noise |

**Simulation**: `--sim 2000 --slimes 20000 --sim-players 500`, one thread, no I/O (5 runs)

|  | Vidar | Odin | Vidar is | 95% interval | Real difference? |
| --- | ---: | ---: | ---: | ---: | --- |
| time | 784 ms | 895 ms | **1.14× faster** | 1.11× to 1.21× faster | yes, Vidar better |
| bot commands per second | 1274904 | 1117750 | **1.14× faster** | 1.11× to 1.21× faster | yes, Vidar better |

**Server under load**: 64 clients × 2000 commands over loopback, 50 ms ticks (3 runs)

|  | Vidar | Odin | Vidar is | 95% interval | Real difference? |
| --- | ---: | ---: | ---: | ---: | --- |
| throughput | 110628 cmd/s | 110226 cmd/s | same | 0.95× to 1.02× faster | no, within noise |
| latency p50 | 0.528 ms | 0.505 ms | 1.05× higher | 1.01× to 1.06× higher | yes, Odin better |
| latency p99 | 1.221 ms | 1.907 ms | 1.56× lower | 0.74× to 2.32× lower | no, within noise |
| latency max | 3.4 ms | 18.0 ms | **5.32× lower** | 2.07× to 5.90× lower | yes, Vidar better |
| failed clients | 0 | 0 | – | – | – |
| RSS idle | 2.2 MB | 2.0 MB | 1.10× larger | 1.09× to 1.10× larger | yes, Odin better |
| RSS after load | 5.8 MB | 6.0 MB | **1.03× smaller** | 1.03× to 1.05× smaller | yes, Vidar better |

"Vidar is" says how many times faster, lower, smaller or fewer Vidar is than Odin, or how many times slower, higher, larger or more; bold marks a real Vidar win. Only real differences count as wins or losses in the summary.
The 95% interval comes from resampling the runs (bootstrap). When it includes 1×, the difference is within run-to-run noise. With only 3 to 5 runs, an interval is roughly the spread between runs; size and line counts are exact.
