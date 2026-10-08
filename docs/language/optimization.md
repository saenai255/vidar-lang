# Faster code: `-opt`, pools, tables and specialization

Vidar sees the whole program, so it can write some code more specifically than you would by hand. There are two ways to get that:

- **The `-opt` flag.** Vidar rewrites plain Odin wherever the result is provably the same program, only faster. Nothing changes in behavior: the test suite builds every case with and without `-opt` and compares the output.
- **Opt-in syntax.** `Pool(I)`, `@(table)`, `@(memo)` and `@(specialize)` ask for a specific transformation, and `@(no_alloc)` and `@(hot)` make the compiler check a promise.

Without `-opt`, plain Odin still passes through byte for byte.

```bash
vidar run examples/negative_cost -opt          # same output, faster
vidar emit examples/negative_cost -opt-report  # -opt, plus what it decided per proc and why
```

## See what it did

The same program, before and after `-opt`. Run `vidar emit <dir> -opt` to print the generated Odin for your own code.

```odin
squares :: proc(n: int) -> [dynamic]int {
	xs: [dynamic]int
	for i in 0..<n { append(&xs, i * i) }
	return xs
}

dot :: proc(a, b: []int) -> (d: int) {
	for x, i in a { d += x * b[i] }
	return
}

sum :: proc(a: []int) -> (t: int) {
	for i in 0..<len(a) do t += a[i]
	return
}

scratch :: proc() -> int {
	buf := make([]int, 64)
	defer delete(buf)
	for i in 0..<len(buf) do buf[i] = i
	return buf[10]
}
```

With `-opt`, the generated Odin is:

```odin
squares :: proc(n: int) -> [dynamic]int {
	xs: [dynamic]int
	reserve(&xs, len(xs) + n)                       // one growth before the loop
	for i in 0..<n { append(&xs, i * i) }
	return xs
}

dot :: proc(a, b: []int) -> (d: int) {
	__vidar.bounds_upto(len(a), 0, len(b)); for x, i in a {   // one check for b
		#no_bounds_check d += x * b[i]
	}
	return
}

sum :: proc(a: []int) -> (t: int) {
	for i in 0..<len(a) do #no_bounds_check t += a[i]         // proven by the loop
	return
}

scratch :: proc() -> int {
	__buf_buf: [64]int; buf := __buf_buf[:]         // on the stack
	/* delete(buf): buf is on the stack */
	for i in 0..<len(buf) do #no_bounds_check buf[i] = i
	return buf[10]
}
```

## Contents

- [What `-opt` rewrites](#what-opt-rewrites): the full list at a glance.
- [Details of each rewrite](#details-of-each-rewrite), grouped by what they speed up.
- [Reading `-opt-report`](#reading-opt-report) and [opting out](#opting-out).
- [Opt-in syntax](#opt-in-syntax): `@(table)`, `@(memo)`, `@(specialize)`, `@(no_alloc)`, `@(hot)`, `Pool(I)`.
- [What it buys](#what-it-buys): measurements.

## What `-opt` rewrites

| Rewrite | In one sentence | Opt out |
|---|---|---|
| [`fmt` with a literal format](#fmt-calls-with-a-literal-format) | writes each piece directly, with no format parsing | none |
| [Generated printers](#generated-printers) | `%v` of a plain type skips fmt's walk over type info | none |
| [Generated JSON encoding](#generated-json-encoding) | `json.marshal` of a plain type calls a generated writer | none |
| [Generated JSON decoding](#generated-json-decoding) | `json.unmarshal` of strict JSON calls a generated reader | none |
| [Proven bounds checks](#bounds-checks-a-loop-already-guarantees) | drops checks the loop already guarantees | none |
| [Hoisted bounds checks](#bounds-checks-moved-before-the-loop) | one check before the loop instead of one per pass | none |
| [`reserve` before append loops](#reserve-before-append-loops) | grows the array once before the loop | none |
| [Allocations freed together](#allocations-freed-together) | adjacent `make`/`new` become one allocation | none |
| [Stack buffers](#constant-size-buffers-on-the-stack) | constant-size `make` goes on the stack | `@(no_stack_buffer)` |
| [`#soa` layout](#soa-layout) | splits an array of structs into one array per field | none |
| [Struct field reordering](#struct-fields-reordered) | packs fields by alignment | none |
| [Inline interface arrays](#interface-arrays-held-inline) | stores values instead of pointers to clones | none |
| [String switches](#string-switches-through-a-perfect-hash) | perfect hash for switches with 8 or more cases | `@(no_perfect_hash)` |
| [Lookup tables](#lookup-tables-chosen-automatically) | a pure small-input proc becomes a table | `@(no_table)` |
| [Specialization](#specialization-chosen-automatically) | a copy of a proc per constant argument | `@(no_specialize)` |
| [Closure literals as arguments](#closures-passed-as-literals) | a copy of the callee calling the closure body directly | none |
| [Memoization](#memo) | caches a self-recursive pure proc | `@(no_memo)` |
| [Cold failure paths](#error-paths-are-cold) | tells LLVM that error branches are unlikely | none |

Every rewrite records a *hint* (a label with a reason) that feeds `-opt-report` and the editor's inlay hints. Labels that start with "no" or "not" are decisions *against* a rewrite.

## Details of each rewrite

### Formatting and serialization

#### `fmt` calls with a literal format

`fmt.printf`, `fmt.println`, `fmt.sbprintf`, `fmt.tprintf`, `fmt.wprintf`, the `e`/`a` variants and the rest compile to a proc that writes each piece directly. That removes three costs: format parsing at run time, `any` boxing, and the type switch.

- `%v %d %s %x %t %c` on basic types are written directly.
- Other verbs and flags still go through `fmt`, one argument at a time.
- A format vidar can't read is left alone: `{}` arguments, `*` widths, explicit argument indexes.

#### Generated printers

`%v` and `%#v` (and `print` / `println`) of a type that vidar can see all the way down are written by generated `__print_T` procs instead of fmt's walk over type info.

**Applies to** a struct, enum, fixed array, slice or dynamic array made of:

- plain structs (no tags, `using`, `any` or directives);
- enums without explicit values;
- strings, bools, runes, integers and floats at the leaves.

**Guarantees:**

- The output is fmt's, byte for byte, and so is the count fmt returns.
- A `when` on the argument's type keeps fmt for anything vidar guessed wrong.
- A program that registers its own fmt formatters keeps fmt everywhere.
- `%v` of a float goes straight to fmt's float formatter.

#### Generated JSON encoding

`json.marshal(x)` with the default options, for a type that the printers above accept, calls a generated writer. It produces encoding/json's exact bytes, without the walk over type info:

- key quoting and JSON string escaping;
- floats through `io.write_f*`;
- enums as integers;
- the `json:"name"`, `json:"-"` and `omitempty` tags.

It sits under a `when` on the type, and it is not used in a program that registers its own marshalers.

#### Generated JSON decoding

`json.unmarshal(data, &x)` and `json.unmarshal_string`, with the default specification (an `allocator =` may be given), call a generated reader. The target type may be a struct with tags and fields of any type.

The reader returns encoding/json's result and error for every input. It works in three steps.

**1. Check that the input is strict JSON.** RFC 8259 syntax, valid UTF-8 in strings, only whitespace after the value, at most 256 levels deep. Anything else goes to `json.unmarshal` untouched, so its errors (`Invalid_Data`) and its JSON5 support (comments, unquoted keys, trailing commas, hex, `Infinity`, a value followed by more text) stay encoding/json's.

**2. Read strict JSON with encoding/json's rules:**

| Input | What the reader does |
|---|---|
| a key | names the first field with that `json:` name (`json:"-"` included), else the first field without one named so |
| an unknown key | skipped |
| `null` | zeroes the field |
| an integer | goes through `i64` (`strconv.parse_i128` past 18 digits) and is truncated as encoding/json truncates |
| a float | one division for up to 15 digits over a power of ten up to 22 (the fast path `strconv.parse_f64` takes too), `strconv.parse_f64` otherwise |
| an enum | takes its integer or its name |
| a string | unquoted (escapes, surrogate pairs) and allocated as `unquote_string` allocates it |
| an array | counted first, from a table the check filled; a fixed array with too many elements is the error before anything is written; slices and dynamic arrays get exactly that length |

**3. Hand back what it can't read.** A value the reader doesn't read itself goes to `json.unmarshal` on its own bytes. That covers the wrong kind of value for its field, a float or a string into an integer, a rune, and a field of a type it can't see, such as a map. An `Unsupported_Type_Error`'s token is moved back to its offset, line and column in the whole input.

**The one difference:** object keys aren't allocated (encoding/json clones each one and frees it), so an allocator that is nearly out of memory can fail later than it would.

Not used in a program that registers its own unmarshalers. Hints: `json unmarshal` / `no json unmarshal`.

### Bounds checks and loops

#### Bounds checks a loop already guarantees

The check is dropped (`#no_bounds_check` on the statement) when both of these hold:

1. The index comes from one of these loops:
   - `for i in 0..<len(a)`
   - `for x, i in a`
   - `for i := 0; i < len(a); i += 1`
2. Nothing in the loop can change `a`'s length: `a` is a local or parameter that isn't reassigned, appended to, or reachable through a pointer.

Constant offsets count too: `a[i + 1]` in `for i in 0..<len(a) - 1`, and `a[i - 2]` in `for i in 2..<len(a)`.

#### Bounds checks moved before the loop

Some loops don't index by `len(a)` but still index by the loop variable on every pass. These get **one** check before the loop, and the indexes inside go unchecked:

```odin
for i in 0..<n { b[i] }          // __vidar.bounds_upto(n, lo, len(b)) before the loop
for x, i in a { b[i] }           // arrays indexed in lockstep
```

**Applies when** the loop runs over `lo..<n` (or `for x, i in a`), has no `break`, `return` or `or_*` in it, and indexes an array by plain `i` on every pass, outside any `if`.

Generated:

```odin
__vidar.bounds_upto(len(a), 0, len(b)); for x, i in a {
	#no_bounds_check d += x * b[i]
}
```

**Details:**

- The check fails with the same index the loop would have failed on.
- It is a statement of its own, so LLVM can still vectorize the loop.
- A failing check panics before the loop's first iteration, not at the iteration that would have failed.

#### `reserve` before append loops

A loop whose trip count is known before it starts, and that appends to an array, gets a `reserve` before it so the array grows once.

**Loops with a known trip count:**

- `for i in a..<b`, `a..=b`
- `for x in xs` over a slice, array, dynamic array or string
- `for i := a; i < n; i += 1`

**What it adds:** `reserve(&xs, len(xs) + count)`, where `count` adds up every value an `append(&xs, v)` (or `append(p, v)` for a pointer `p`) takes as a statement of the loop body.

**Appends under an `if`** (or its `else if` / `else` branches) count as the branch that appends the most, so the reserve is an upper bound. A reserve can't be undone, so that is only done for elements of at most 16 bytes.

**Skipped when** the body can `break`, `continue` or `return`; the loop can change the bounds; or it reassigns, clears, resizes or takes the address of the array.

```odin
xs: [dynamic]int
reserve(&xs, len(xs) + n)           // added by -opt
for i in 0..<n {
	append(&xs, i * i)
}
```

### Memory

#### Allocations freed together

Adjacent `x := make([]E, n)` and `p := new(T)` that are only freed by a `defer delete(x)` / `defer free(p)` in the same block become **one** allocation, sliced up, and freed by the defer that runs last.

#### Constant-size buffers on the stack

`x := make([]T, N)` with a constant `N` and a matching `defer delete(x)` in the same block becomes:

```odin
__x_buf: [N]T
x := __x_buf[:]
```

**Applies when** `x` can't outlive the proc. It may only be:

- indexed;
- measured with `len` / `cap`;
- looped over;
- passed to procs that don't keep it. Vidar follows calls into procs with bodies, 4 calls deep, and knows certain `core:fmt`, `core:slice`, `core:mem` and `core:math` procs.

**Size limit:** up to 4 KB in a proc a goroutine can reach, 64 KB elsewhere.

```odin
buf := make([]int, 64)              // before
defer delete(buf)

__buf_buf: [64]int; buf := __buf_buf[:]   // after: no allocation, no free
```

Opt out with `@(no_stack_buffer)`. Hints: `stack buffer` / `no stack buffer`.

#### `#soa` layout

A local array of a plain struct becomes `#soa`: each field gets an array of its own, so a loop that touches only some fields reads less memory.

**Which declarations:** a local `a: [dynamic]T`, `a: [N]T`, `a := make([dynamic]T, ...)` or `a := make([]T, n)`, with or without a declared type (`a: [dynamic]T = make([dynamic]T, ...)`).

**Which structs:** a plain struct `T` (no `using`, tags, directives or parameters) with at least 3 fields or about 32 bytes, where some loop touches only some of its fields.

**Every use of `a` must mean the same on an `#soa` container.** These are fine:

- `a[i].f`: read, write, `+=`, `a[i].f[j]`
- `a[i]` as a whole value: copied, assigned, compared, passed
- `len`, `cap`, `for x in a`
- `for &x in a`, using only `x.f`
- `append(&a, ...)`, `clear`, `reserve`, `resize`, `delete`

**These keep the layout as it was:** `&a[i]` or `&a[i].f`, slicing, passing `a` to a proc, returning it, reassigning it, capturing it.

#### Struct fields reordered

A plain struct whose fields would pack tighter sorted by alignment, largest first, is written that way, as long as nothing can see its layout. Positional literals of it are rewritten with field names.

**Which structs:** no directives, `using`, tags or blank fields.

**Nothing may see the layout.** The type must never be:

- measured (`size_of`, `offset_of`, `type_info_of`, ...);
- cast, transmuted or converted;
- used as a map key;
- converted to `any`.

No value of a type holding it may reach code vidar can't see: core and foreign procs, and proc values. That keeps fmt and encoding/json, whose output follows the field order, on the order as written.

Hints: `reordered` / `not reordered`.

#### Interface arrays held inline

A local `[dynamic]I` whose elements all come from `new_clone(value)` holds the values themselves, as `union { T1, T2, ... }`:

| Before | After |
|---|---|
| `append(&xs, new_clone(Circle{1}))` | `append(&xs, Circle{1})` |
| `for s in xs` | `for &s in xs` |
| `grow(s, k)` | `__I_v_grow(&s, k)`, a switch that calls the impl directly |

**Applies when** `I` is closed (it has no bases) and the array is used only to append such clones, loop over, call `I`'s methods on the elements, index for a method call, `len`, `clear` and `delete`. Each element was reachable only through the array, so nobody can tell the difference.

**Not when** an implementation is over 64 bytes, or an impl method uses its receiver other than through its fields (it could keep a pointer, which would dangle once the array grows).

Hints: `value interface` / `no value interface`.

### Control flow

#### String switches through a perfect hash

```odin
keyword :: proc(word: string) -> Token {
	switch word {                    // 8 or more string-literal cases: -opt switches on a hash
	case "if":           return .If
	case "else":         return .Else
	case "for", "in":    return .For if word == "for" else .In
	case "return":       return .Return
	// ...
	}
	return .Ident
}
```

A `switch s` with **8 or more** string-literal cases switches on `__strswitch_N(s)` instead:

1. A perfect hash of the string picks the one candidate. It uses the length and the first, middle and last bytes with a multiplier found at compile time, or seeded FNV-1a when those collide.
2. One compare confirms it.
3. Each case's strings become their indexes.

Case bodies, `fallthrough` and the default case stay as written. Opt out with `@(no_perfect_hash)`. Hints: `perfect hash` / `no perfect hash`.

#### Lookup tables, chosen automatically

A proc becomes a table when **all** of these hold:

- It takes one `bool`, `u8` or `i8` and returns an integer or `bool`.
- Its body is pure integer code: locals, constants, arithmetic, `if` / `for` / `switch`, and calls to procs that pass the same check.
- It has a loop or at least 24 operations.
- It finishes at compile time for every input.

Floats, strings, globals, pointers and macros rule a proc out, because the compile-time interpreter can't promise to compute them exactly as the compiled program does. To ask for a table yourself, see [`@(table)`](#table). Opt out with `@(no_table)`.

#### Specialization, chosen automatically

A proc gets a copy per constant argument when the calls pass constants to it **and** that parameter bounds a loop, or divides, shifts or branches inside one. It is skipped when:

- every call passes the same constant (LLVM already folds that);
- it would take more than 4 copies.

To ask for it yourself, see [`@(specialize)`](#specialize). Opt out with `@(no_specialize)`.

#### Closures passed as literals

This is like Rust monomorphizing closures. Take:

```odin
for_each(xs, proc[&total, k](x: int) { total += x * k })
```

It becomes a call to `for_each__closure0(xs, &total, k)`: a copy of `for_each` in which `f(x)` is a direct call to the closure's body, lifted to a proc of its own, with the captures in an environment on the copy's stack. LLVM can then inline it, and nothing is allocated.

**Applies when** the callee is a plain proc with a body, and its body only calls the parameter.

Real output for the call above:

```odin
for_each :: proc(xs: []int, f: closure(int)) {          // the original, unchanged
	for x in xs do f(x)
}

for_each__closure0([]int{1, 2, 3}, &total, k)           // the call site

// for_each with the closure from line 38 called directly
for_each__closure0 :: proc(xs: []int, __f_c0: $__f_T0, __f_c1: $__f_T1) { __f_env := ...
	for x in xs do __for_each__closure0_f(&__f_env, x)  // a direct call LLVM can inline
}
```

**Across files and packages:** the copy is written in the caller's file, so a callee in another file or package qualifies when its body uses nothing private the caller can't see (`@(private)` across packages, `@(private="file")` across files). Imports it needs that the caller's file lacks are added under a `__` name.

**Keeps the call as it was** if the callee stores the parameter, passes it on, returns it, compares it, or captures it in another closure.

**Limits:** each call passing a literal gets its own copy, at most 4 per proc; the calls past that call the original. Closure values held in variables (`g := proc[k]...; for_each(xs, g)`) aren't specialized.

#### Error paths are cold

With `-opt`, every failure path of Vidar's [error handling](error-handling.md) is hinted cold:

- The checks behind `catch`, `or_return X` and `errdefer` are wrapped in `intrinsics.expect(..., false)`, which LLVM turns into branch weights.
- The panic behind `catch unreachable` is `@(cold)`, with or without `-opt`.
- Plain Odin `or_return` that is a whole statement (`x := f() or_return`, `x = f() or_return`, `f() or_return`) is written out the same way under `-opt`, returning the error itself, so its failure path is cold too.

## Reading `-opt-report`

`-opt-report` stands in for `-opt` and also prints each decision as `file:line: name: label: reason`. It lists:

- each proc that was tabulated or specialized, and each one that nearly was, with the reason;
- every statement and call it rewrote.

The language server shows the same as inlay hints. A decision inside a macro's expansion is shown at the macro call, prefixed with the macro's name.

```
main.vidar:9: collatz: table: 256 results, has a loop, pure integer code
main.vidar:45: noisy: no table: it reads 'counter', which isn't a local or a constant (line 47)
main.vidar:66: blur: specialized ×2: radius bounds a loop; one copy for each of radius = 1 | radius = 2
main.vidar:73: sum_to: not specialized: every call passes n = 10, which LLVM folds without a copy
main.vidar:81: unchecked: every index here is proven in bounds by its loop, so it gets #no_bounds_check
main.vidar:80: bs: #soa: a loop touches 3 of 10 fields of Body (x, y, z); 10 fields, ~72 bytes
main.vidar:95: ps: not #soa: ps is passed to 'sum_x' (line 98)
```

## Opting out

Each automatic choice has an attribute that keeps a proc out of it, for example when you want a baseline to benchmark against.

| Attribute | Keeps the proc out of |
|---|---|
| `@(no_table)` | automatic lookup tables |
| `@(no_specialize)` | automatic specialized copies |
| `@(no_memo)` | automatic memoization |
| `@(no_stack_buffer)` | stack buffers for constant-size `make` |
| `@(no_perfect_hash)` | perfect-hash string switches |

## Opt-in syntax

### `@(table)`

`@(table)` on a proc with one parameter of type `bool`, `u8`, `i8` or an enum turns it into a lookup. The result for every value is stored, and the proc becomes `return table[x]`.

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

**How the table is built:**

| Parameter | Table |
|---|---|
| `bool`, `u8`, `i8` | vidar runs the body at compile time and writes a `@(rodata)` literal |
| an enum (members must not have explicit values), or a body that can't run at compile time | filled once at startup from the original body |
| two parameters of type `bool`, `u8` or `i8` | a two-dimensional table, `table[x][y]`; `-opt` makes those on its own when there are at most 4096 results |

> [!WARNING]
> The body must not depend on anything but its argument. Vidar can't check that for a table you ask for. That is why only the *automatic* tables are restricted to code vidar can check.

### `@(memo)`

`@(memo)` gives each outer call a memo table that the proc's calls to itself share.

```odin
fib :: proc(n: int) -> int {           // -opt: fib(n) makes the table, __fib_memo(n, &table) looks up or computes
	if n < 2 do return n
	return fib(n - 1) + fib(n - 2)      // __fib_memo(n - 1, __memo) + __fib_memo(n - 2, __memo)
}
```

- The table is freed when the outer call returns, so nothing is kept between calls and nothing is shared between goroutines.
- The table is an array when every parameter is `bool`, `u8` or `i8` (4096 results at most), else a map keyed by the parameters.
- The proc keeps its name and signature; its body becomes `__f_memo_body`, in place.
- `-opt` adds it on its own to a pure integer proc that calls itself more than once per call (exponential recursion, like `fib`), unless the program has `@(no_alloc)` procs, since the table allocates.
- `@(no_memo)` opts a proc out.

### `@(specialize)`

`@(specialize)` on a proc gives each call that passes constants a copy where those parameters are compile-time (`$radius`). Odin then builds one version per value, and LLVM can unroll loops, turn divisions into shifts and drop branches.

```odin
@(specialize)
box_blur :: proc(dst, src: []int, radius: int) { ... }

box_blur(dst, src, 1)       // box_blur__radius(dst, src, 1), with `$radius: int`
box_blur(dst, src, r)       // the original
```

- Parameters of basic types and enums qualify.
- Calls with run-time values call the original.
- On a `@(specialize)` proc, a call passing a closure literal also gets a copy calling the closure's body directly, as `-opt` does on its own (see [closures passed as literals](#closures-passed-as-literals)), together with any constants it passes. This happens without `-opt` too, and isn't capped.

### `@(no_alloc)` and `@(hot)`

Two promises the compiler checks:

```odin
@(no_alloc)
step :: proc(w: ^World) { ... }    // error: @(no_alloc) 'step' can allocate: append, reached through step -> spawn -> push at world.vidar:12

@(hot)
blur :: proc(dst, src: []int) { ... }   // with -opt, warning: @(hot) 'blur': no bounds proof: an index here isn't proven in bounds by its loop
```

#### `@(no_alloc)`

A compile error when the proc, or anything it calls, can allocate. The message names the allocation and the chain of calls that reached it.

**What it follows:**

- calls into procs with bodies, in any package;
- proc groups;
- interface methods, when every impl is known.

**What it stops at (an error):**

- `make`, `new`, `new_clone`, `append`, `reserve`, `resize` and the other allocating built-ins;
- map inserts, and `[dynamic]` and `map` literals;
- allocating `core:` procs: `fmt.aprintf`, `fmt.tprintf`, `fmt.sbprintf`, `strings.clone`, `strings.builder_make`, ...

**A call it can't follow is an error too:**

- a call through a closure or proc value;
- an interface whose impls aren't all known;
- a `core:` proc that isn't on the list of procs known not to allocate: `fmt.println` / `printf` / `bprintf`, `core:math`, `core:time`'s ticks and durations, `strings.has_prefix`, ...

**Run-time backstop:** in builds below `-o:size`, the proc's `context.allocator` and `context.temp_allocator` panic, so an allocation the analysis missed fails loudly in tests.

#### `@(hot)`

With `-opt`, turns every `-opt` decision against something inside the proc into a warning, on the command line and in the editor:

- an index that keeps its bounds check inside a loop (`no bounds proof`);
- a call through a closure value (`no direct call`);
- a closure literal that was not inlined;
- a `vtable` call;
- an allocation inside a loop.

Without `-opt` it does nothing.

### `Pool(I)`

`Pool(I)` holds values of every type implementing the interface `I`, stored by type: one `[dynamic]T` per implementation instead of one array of interface values. `for s in pool` becomes one loop per type, in which `s` is a `^T`, so method calls are direct calls Odin can inline. `s` converts to `I` like any pointer to an implementation.

```odin
shapes: Pool(Shape)
append(&shapes, Rect{2, 3}, Circle{2})   // copies each value into its type's array
for s in shapes do total += area(s)      // a Circle loop, then a Rect loop, ...
len(shapes); clear(&shapes); delete(shapes)
```

**Behavior:**

- Values of one type keep their order; types are visited in the order of their `impl` blocks.
- `break`, `continue` and labels act on the whole loop, as written.

**Restrictions:**

- Every implementation of `I` must be known: `I` must not be extended by an interface in another package.
- No impl of `I` can be for a parametric type (`Box($T)`, `Box(int)`): there is no one array type for it.
- `append` takes values, not pointers, and is a statement of its own.
- `for s, i in pool` (an index) is an error.

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

**Reading the numbers:**

- Bounds checks rarely matter: LLVM already removes most of them in loops like these.
- The table wins only when the body costs more than a memory load. A bit count, which LLVM turns into one instruction, gains nothing.
- On the slime_mud server simulation, `-opt` took a run from 980 ms to 760 ms. The hand-written Odin version takes 905 ms.
