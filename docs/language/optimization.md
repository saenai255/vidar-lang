# Faster code: `-opt`, pools, tables and specialization

Vidar can write some code more specifically than you would by hand, because it sees the whole program. Some of this is opt-in syntax (`Pool`, `@(table)`, `@(specialize)`); the rest happens under the `-opt` flag, which also rewrites plain Odin where the result is provably the same program, only faster. Without `-opt`, plain Odin still passes through byte-for-byte.

```bash
node dist/cli.js run examples/negative_cost -opt          # same output, faster
node dist/cli.js emit examples/negative_cost -opt-report  # -opt, plus what it decided per proc and why
```

## `-opt` on plain Odin

- **fmt calls with a literal format** (`fmt.printf`, `fmt.println`, `fmt.sbprintf`, `fmt.tprintf`, `fmt.wprintf`, the `e`/`a` variants, ...) compile to a proc that writes each piece directly: no format parsing at run time, no `any` boxing, no type switch. `%v %d %s %x %t %c` on basic types are written directly; other verbs and flags still go through `fmt`, one argument at a time. A format vidar can't read (`{}` arguments, `*` widths, explicit argument indexes) is left alone.
- **Bounds checks a loop already guarantees** are dropped (`#no_bounds_check` on the statement) when the index comes from `for i in 0..<len(a)`, `for x, i in a` or `for i := 0; i < len(a); i += 1`, and nothing in the loop can change `a`'s length: `a` is a local or parameter that isn't reassigned, appended to, or reachable through a pointer. Constant offsets count too: `a[i + 1]` in `for i in 0..<len(a) - 1`, `a[i - 2]` in `for i in 2..<len(a)`.
- **Bounds checks moved before the loop:** in a loop over `lo..<n` (or `for x, i in a`) with no `break`, `return` or `or_*` in it, an array indexed by plain `i` on every pass, outside any `if`, gets one check before the loop: `__vidar.bounds_upto(n, lo, len(b))` fails with the same index the loop would have failed on, and the indexes inside go unchecked. That covers a bound that isn't `len(b)` (`for i in 0..<n { b[i] }`) and arrays indexed in lockstep (`for x, i in a { b[i] }`). The check is a statement of its own, so LLVM still vectorizes the loop. A failing check panics before the loop's first iteration, not at the iteration that would have failed.
- **`reserve` before append loops:** a loop whose trip count is known before it starts (`for i in a..<b`, `a..=b`, `for x in xs` over a slice, array, dynamic array or string, `for i := a; i < n; i += 1`) and that runs `append(&xs, v)` (or `append(p, v)` for a pointer `p`) as a statement of its body gets `reserve(&xs, len(xs) + count)` before it, counting every value an append takes. Appends under an `if` (or its `else if` / `else` branches) count as the branch that appends the most, so the reserve is an upper bound; since a reserve can't be undone, that is only done for elements of at most 16 bytes. Skipped when the body can `break`, `continue` or `return`, the loop can change the bounds, or it reassigns, clears, resizes or takes the address of the array.
- **Allocations freed together:** adjacent `x := make([]E, n)` / `p := new(T)` that are only freed by a `defer delete(x)` / `defer free(p)` in the same block become one allocation, sliced up, and freed by the defer that runs last.
- **Struct fields reordered:** a plain struct (no directives, `using`, tags or blank fields) whose fields would pack tighter sorted by alignment, largest first, is written that way, when nothing can see its layout: it is never measured (`size_of`, `offset_of`, `type_info_of`, ...), cast, transmuted, converted, used as a map key or converted to `any`, and no value of a type holding it reaches code vidar can't see (core and foreign procs, proc values; so fmt and encoding/json, whose output follows the field order, keep it as written). Positional literals of it are rewritten with field names. Hints: `reordered` / `not reordered`.
- **Interface arrays held inline:** a local `[dynamic]I` (I closed, with no bases) whose elements all come from `new_clone(value)`, used only to append such clones, loop over and call I's methods on the elements, index for a method call, `len`, `clear` and `delete`, holds `union { T1, T2, ... }` instead: `append(&xs, new_clone(Circle{1}))` becomes `append(&xs, Circle{1})`, `for s in xs` becomes `for &s in xs`, and `grow(s, k)` calls `__I_v_grow(&s, k)`, a switch calling the impl directly. Each element was reachable only through the array, so nobody can tell. Not when an implementation is over 64 bytes, or an impl method uses its receiver other than through its fields (it could keep a pointer, which would dangle once the array grows). Hints: `value interface` / `no value interface`.
- **Generated printers:** `%v` and `%#v` (and `print`/`println`) of a struct, enum, fixed array, slice or dynamic array whose type vidar can see all the way down (plain structs without tags, `using`, `any` or directives; enums without explicit values; strings, bools, runes, integers and floats at the leaves) are written by generated `__print_T` procs instead of fmt's walk over type info. The output is fmt's byte for byte, and so is the count fmt returns. A `when` on the argument's type keeps fmt for anything vidar guessed wrong, and a program that registers its own fmt formatters keeps fmt everywhere. `%v` of a float goes straight to fmt's float formatter.
- **Generated JSON encoding:** `json.marshal(x)` with the default options, for such a type, calls a generated writer: encoding/json's exact bytes (its key quoting and JSON string escaping, `io.write_f*` floats, enums as integers, `json:"name"`, `json:"-"` and `omitempty` tags), without the walk over type info. Again under a `when` on the type, and not in a program that registers its own marshalers.
- **Generated JSON decoding:** `json.unmarshal(data, &x)` and `json.unmarshal_string` with the default specification (an `allocator =` may be given), into such a type (here structs may also have tags, and fields of any type), call a generated reader with encoding/json's result and error for every input:
  - The input is first checked to be strict JSON: RFC 8259 syntax, valid UTF-8 in strings, only whitespace after the value, at most 256 levels deep. Anything else goes to `json.unmarshal` untouched, so its errors (`Invalid_Data`) and its JSON5 (comments, unquoted keys, trailing commas, hex, `Infinity`, a value followed by more text) stay encoding/json's.
  - Strict JSON is then read with encoding/json's rules: a key names the first field with that `json:` name (`json:"-"` included), else the first field without one named so; unknown keys are skipped; `null` zeroes; integers go through `i64` (`strconv.parse_i128` past 18 digits) and are truncated as encoding/json truncates; floats are one division for up to 15 digits over a power of ten up to 22 (the fast path `strconv.parse_f64` takes too), `strconv.parse_f64` otherwise; enums take their integer or their name; strings are unquoted (escapes, surrogate pairs) and allocated as `unquote_string` allocates them; arrays are counted first (from a table the check filled), a fixed array with too many elements is the error before anything is written, and slices and dynamic arrays get exactly that length.
  - A value the reader doesn't read itself (the wrong kind of value for its field, a float or a string into an integer, a rune, a field of a type it can't see, such as a map) goes to `json.unmarshal` on its own bytes, and an `Unsupported_Type_Error`'s token is moved back to its offset, line and column in the whole input.
  - The one difference: object keys aren't allocated (encoding/json clones each one and frees it), so an allocator that is nearly out of memory can fail later than it would. Not in a program that registers its own unmarshalers. Hints: `json unmarshal` / `no json unmarshal`.
- **String switches through a perfect hash:** a `switch s` whose cases are 8 or more string literals switches on `__strswitch_N(s)` instead: a perfect hash of the string (its length and first, middle and last bytes with a multiplier found at compile time, or seeded FNV-1a when those collide) picks the one candidate, one compare confirms it, and each case's strings become their indexes. Case bodies, `fallthrough` and the default case stay as written. `@(no_perfect_hash)` opts a proc out; hints: `perfect hash` / `no perfect hash`.
- **Constant-size buffers on the stack:** `x := make([]T, N)` with a constant `N` and a matching `defer delete(x)` in the same block becomes `__x_buf: [N]T; x := __x_buf[:]`, when `x` can't outlive the proc: it is only indexed, measured with `len`/`cap`, looped over, or passed to procs that don't keep it (followed into procs with bodies, 4 calls deep; known `core:fmt`, `core:slice`, `core:mem` and `core:math` procs). Up to 4 KB in a proc a goroutine can reach, 64 KB elsewhere. `@(no_stack_buffer)` opts a proc out; hints: `stack buffer` / `no stack buffer`.
- **`#soa` layout:** a local `a: [dynamic]T`, `a: [N]T`, `a := make([dynamic]T, ...)` or `a := make([]T, n)` (with or without a declared type, `a: [dynamic]T = make([dynamic]T, ...)`) of a plain struct `T` (no `using`, tags, directives or parameters) becomes `#soa`, each field in an array of its own, when `T` has at least 3 fields or about 32 bytes and some loop touches only some of its fields. Every use of `a` must mean the same on an `#soa` container: `a[i].f` (read, write, `+=`, `a[i].f[j]`), `a[i]` as a whole value (copied, assigned, compared, passed), `len`, `cap`, `for x in a`, `for &x in a` using only `x.f`, `append(&a, ...)`, `clear`, `reserve`, `resize` and `delete`. Anything else keeps the layout: `&a[i]` or `&a[i].f`, slicing, passing `a` to a proc, returning, reassigning or capturing it.
- **Lookup tables, chosen automatically:** a proc taking one `bool`, `u8` or `i8` and returning an integer or `bool` becomes a table when its body is pure integer code (locals, constants, arithmetic, `if`/`for`/`switch`, calls to procs that pass the same check), has a loop or at least 24 operations, and finishes at compile time for every input. Floats, strings, globals, pointers and macros rule a proc out, because the compile-time interpreter can't promise to compute them exactly as the compiled program does.
- **Specialization, chosen automatically:** a proc gets a copy per constant argument when that parameter bounds a loop, or divides, shifts or branches inside one, and the calls pass constants to it. It is skipped when every call passes the same constant (LLVM already folds that) and when it would take more than 4 copies.
- **Closures passed as literals**, like Rust monomorphizing closures: `for_each(xs, proc[&total, k](x: int) { total += x * k })` calls `for_each__closure0(xs, &total, k)`, a copy of `for_each` in which `f(x)` is a direct call to the closure's body, lifted to a proc of its own, with the captures in an environment on the copy's stack. LLVM can then inline it, and nothing is allocated. This applies when the callee is a plain proc with a body, and its body only calls the parameter. The copy is written in the caller's file, so a callee in another file or package qualifies when its body uses nothing private the caller can't see (`@(private)` across packages, `@(private="file")` across files); imports it needs that the caller's file lacks are added under a `__` name. Storing the parameter, passing it on, returning it, comparing it, or capturing it in another closure keeps the call as it was. Each call passing a literal gets its own copy, at most 4 per proc; the calls past that call the original. Closure values held in variables (`g := proc[k]...; for_each(xs, g)`) aren't specialized.

On Vidar's error handling, `-opt` hints every failure path cold: the checks behind `catch`, `or_return X` and `errdefer` are wrapped in `intrinsics.expect(..., false)`, which LLVM turns into branch weights, and the panic behind `catch unreachable` is `@(cold)` (with or without `-opt`). Plain Odin `or_return` that is a whole statement (`x := f() or_return`, `x = f() or_return`, `f() or_return`) is written out the same way under `-opt`, returning the error itself, so its failure path is cold too.

`@(no_table)` and `@(no_specialize)` keep a proc out of the automatic choices, e.g. a baseline you benchmark against. `-opt-report` lists each proc that was tabulated or specialized, and each one that nearly was, with the reason, plus every statement and call it rewrote (the language server shows the same as inlay hints). A decision inside a macro's expansion is shown at the macro call, prefixed with the macro's name:

```
main.vidar:9: collatz: table: 256 results, has a loop, pure integer code
main.vidar:45: noisy: no table: it reads 'counter', which isn't a local or a constant (line 47)
main.vidar:66: blur: specialized ×2: radius bounds a loop; one copy for each of radius = 1 | radius = 2
main.vidar:73: sum_to: not specialized: every call passes n = 10, which LLVM folds without a copy
main.vidar:81: unchecked: every index here is proven in bounds by its loop, so it gets #no_bounds_check
main.vidar:80: bs: #soa: a loop touches 3 of 10 fields of Body (x, y, z); 10 fields, ~72 bytes
main.vidar:95: ps: not #soa: ps is passed to 'sum_x' (line 98)
```

## `@(table)`

`@(table)` on a proc with one parameter of type `bool`, `u8`, `i8` or an enum turns it into a lookup: the result for every value is stored, and the proc becomes `return table[x]`. For `bool`, `u8` and `i8`, vidar runs the body at compile time and writes the table as a `@(rodata)` literal. For an enum (whose members must not have explicit values), or a body that can't run at compile time, the table is filled once at startup from the original body. The body must not depend on anything but its argument; vidar can't check that for a table you ask for, which is why only the automatic tables are restricted to code it can check. Two parameters of type `bool`, `u8` or `i8` give a two-dimensional table, `table[x][y]`; `-opt` makes those on its own when there are at most 4096 results.

```odin
@(table)
collatz :: proc(b: u8) -> int {         // collatz :: #force_inline proc(b: u8) -> int { return __collatz_table[b] }
	n := int(b) + 1
	steps := 0
	for n != 1 {
		n = n / 2 if n % 2 == 0 else 3 * n + 1
		steps += 1
	}
	return steps
}
```

## `@(memo)`

`@(memo)` gives each outer call a memo table that the proc's calls to itself share; it is freed when the outer call returns, so nothing is kept between calls and nothing is shared between goroutines. The table is an array when every parameter is `bool`, `u8` or `i8` (4096 results at most), else a map keyed by the parameters. The proc keeps its name and signature; its body becomes `__f_memo_body`, in place. `-opt` adds it on its own to a pure integer proc that calls itself more than once per call (exponential recursion, like `fib`), unless the program has `@(no_alloc)` procs, since the table allocates. `@(no_memo)` opts a proc out.

```odin
fib :: proc(n: int) -> int {           // -opt: fib(n) makes the table, __fib_memo(n, &table) looks up or computes
	if n < 2 do return n
	return fib(n - 1) + fib(n - 2)      // __fib_memo(n - 1, __memo) + __fib_memo(n - 2, __memo)
}
```

## `@(specialize)`

`@(specialize)` on a proc gives each call that passes constants a copy where those parameters are compile-time (`$radius`), so Odin builds one version per value and LLVM can unroll loops, turn divisions into shifts and drop branches. Parameters of basic types and enums qualify; calls with run-time values call the original.

```odin
@(specialize)
box_blur :: proc(dst, src: []int, radius: int) { ... }

box_blur(dst, src, 1)       // box_blur__radius(dst, src, 1), with `$radius: int`
box_blur(dst, src, r)       // the original
```

On a `@(specialize)` proc, a call passing a closure literal also gets a copy calling the closure's body directly, as `-opt` does on its own (see above), together with any constants it passes. This happens without `-opt` too, and isn't capped.

## `@(no_alloc)` and `@(hot)`

Two promises the compiler checks:

```odin
@(no_alloc)
step :: proc(w: ^World) { ... }    // error: @(no_alloc) 'step' can allocate: append, reached through step -> spawn -> push at world.vidar:12

@(hot)
blur :: proc(dst, src: []int) { ... }   // with -opt, warning: @(hot) 'blur': no bounds proof: an index here isn't proven in bounds by its loop
```

- **`@(no_alloc)`** is a compile error when the proc, or anything it calls, can allocate. It follows calls into procs with bodies (in any package), proc groups, and interface methods when every impl is known. It stops at `make`, `new`, `new_clone`, `append`, `reserve`, `resize` and the other allocating built-ins, map inserts, `[dynamic]` and `map` literals, and allocating `core:` procs (`fmt.aprintf`, `fmt.tprintf`, `fmt.sbprintf`, `strings.clone`, `strings.builder_make`, ...). A call it can't follow is an error too: a call through a closure or proc value, an interface whose impls aren't all known, or a `core:` proc that isn't on the list of procs known not to allocate (`fmt.println`/`printf`/`bprintf`, `core:math`, `core:time`'s ticks and durations, `strings.has_prefix`, ...). The message names the allocation and the chain of calls that reached it. As a backstop, in builds below `-o:size` the proc's `context.allocator` and `context.temp_allocator` panic, so an allocation the analysis missed fails loudly in tests.
- **`@(hot)`**, with `-opt`, turns every `-opt` decision against something inside the proc into a warning, on the command line and in the editor: an index that keeps its bounds check inside a loop (`no bounds proof`), a call through a closure value (`no direct call`), a closure literal not inlined, a `vtable` call, and an allocation inside a loop. Without `-opt` it does nothing.

## `Pool(I)`

`Pool(I)` holds values of every type implementing the interface `I`, stored by type: one `[dynamic]T` per implementation instead of one array of interface values. `for s in pool` becomes one loop per type, in which `s` is a `^T`, so method calls are direct calls Odin can inline. `s` converts to `I` like any pointer to an implementation.

```odin
shapes: Pool(Shape)
append(&shapes, Rect{2, 3}, Circle{2})   // copies each value into its type's array
for s in shapes do total += area(s)      // a Circle loop, then a Rect loop, ...
len(shapes); clear(&shapes); delete(shapes)
```

- Values of one type keep their order; types are visited in the order of their `impl` blocks.
- `break`, `continue` and labels act on the whole loop, as written.
- Every implementation of `I` must be known: `I` must not be extended by an interface in another package. No impl of `I` can be for a parametric type (`Box($T)`, `Box(int)`): there is no one array type for it.
- `append` takes values, not pointers, and is a statement of its own. `for s, i in pool` (an index) is an error.

## What it buys

`examples/negative_cost` measures each feature against the plain version (`--bench`, built with `-o:speed` on an M3 Pro):

| | plain | vidar |
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

Newer sections, measured so far only on a 4-core linux/amd64 VM (`-o:speed`; re-measure on the M3):

| | plain | vidar |
|---|---|---|
| `json.unmarshal` of 100 structs (~10 KB), 500 times | 220 to 260 ms | 21 to 23 ms |
| 1,000,000 structs, fields reordered (40 bytes to 24) | 112 ms | 53 ms |
| `examples/fanout --uneven` at 4 threads, before and after work stealing | 101 ms | 40 ms |

Bounds checks rarely matter: LLVM already removes most of them in loops like these. The table wins only when the body costs more than a memory load; a bit count, which LLVM turns into one instruction, gains nothing. On the slime_mud server simulation, `-opt` took a run from 980 ms to 760 ms; the hand-written Odin version takes 905 ms.
