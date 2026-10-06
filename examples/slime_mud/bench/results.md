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
