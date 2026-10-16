# What It Buys

[`examples/negative_cost`](../../examples/negative_cost) measures each feature against the plain version. Every section prints a checksum, and with `--bench` the time too:

```console
$ vidar build examples/negative_cost -opt -o out/nc
$ odin build out/nc -o:speed -out:out/nc/prog
$ out/nc/prog --bench
```

Built with `-o:speed` on an M3 Pro:

| | plain | Vidar |
|---|---|---|
| `fmt.sbprintf` with a literal format | 210 ms | 68 ms |
| three scratch allocations freed together | 115 ms | 45 ms |
| 1000 appends in a loop, reserved first | 92 ms | 50 ms |
| loop with proven indexes | 24.2 ms | 24.2 ms |
| box blur, radius 1 and 3 (`@(specialize)`) | 33 ms | 11 ms |
| Collatz steps over bytes (`@(table)`) | 282 ms | 1.4 ms |
| sum of areas over shapes (`Pool` vs `[dynamic]Shape`) | 3.5 ms | 3.2 ms |
| 3 of 10 fields over 100k structs (`#soa`) | 75 ms | 29 ms |
| closure literal called per element (copy per closure) | 7.6 ms | 4.0 ms |

Newer sections, measured so far only on a 4-core linux/amd64 machine:

| | plain | Vidar |
|---|---|---|
| `json.unmarshal` of 100 structs (~10 KB), 500 times | 220 to 260 ms | 21 to 23 ms |
| 1,000,000 structs, fields reordered (40 bytes to 24) | 112 ms | 53 ms |

Some things to keep in mind when reading these:

- Bounds checks rarely matter on their own: LLVM already removes most of them in loops like these.
- A table wins only when the body costs more than a memory load. A bit count, which LLVM turns into one instruction, gains nothing.
- On the [slime_mud](../../examples/slime_mud) server simulation, a larger program, `-opt` took a run from 980 ms to 760 ms. The hand-written Odin version takes 905 ms.

## Summary

- `-opt` rewrites plain Odin where it can prove the result is the same program, and records every decision.
- `-opt-report` and the editor's hints show what it did and why; `@(no_...)` attributes opt out.
- `@(table)`, `@(memo)`, `@(specialize)` and `Pool(I)` ask for specific transformations.
- `@(no_alloc)` and `@(hot)` turn performance promises into compile-time checks.
