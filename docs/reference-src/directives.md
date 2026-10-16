## owned

```vidar
Token :: struct { id: int }

token_destroy :: proc(t: ^Token) {
	if t.id != 0 do fmt.println("released", t.id)
}

impl Destroy for Token { destroy = token_destroy }

consume :: proc(#owned t: Token) {
	fmt.println("consuming", t.id)
}                              // t is destroyed here

main :: proc() {
	t := Token{7}
	consume(move!(t))
	consume(Token{8})
	fmt.println("done")
}
```

```output
consuming 7
released 7
consuming 8
released 8
done
```

See [Taking Ownership with `#owned`](ch07-02-ownership.md#taking-ownership-with-owned).

## align

```vidar
Aligned :: struct #align(64) { x: int }

main :: proc() {
	fmt.println(align_of(Aligned), size_of(Aligned))
}
```

```output
64 64
```

## any_int

```vidar
repeat :: proc(s: string, #any_int n: int) {
	for _ in 0..<n do fmt.print(s)
	fmt.println()
}

main :: proc() {
	k: u8 = 3
	repeat("ab", k)          // a u8 passes as an int
}
```

```output
ababab
```

## assert

```vidar
Header :: struct { tag: u32, size: u32 }
#assert(size_of(Header) == 8)

main :: proc() {
	fmt.println(size_of(Header))
}
```

```output
8
```

## bounds_check

```vidar
xs := []int{1, 2, 3}
#no_bounds_check {
	#bounds_check {
		fmt.println(xs[2])        // checked again in here
	}
}
```

```output
3
```

## by_ptr

```vidar,no_run
Big :: struct { data: [64]u8 }

foreign import libc "system:c"

foreign libc {
	@(link_name = "puts")
	show :: proc "c" (#by_ptr b: Big) -> i32 ---   // passed as a pointer in C
}

main :: proc() {}
```

## c_vararg

```vidar
foreign import libc "system:c"

foreign libc {
	printf :: proc "c" (format: cstring, #c_vararg args: ..any) -> i32 ---
}

main :: proc() {
	printf("%d-%d\n", i32(1), i32(2))
}
```

```output
1-2
```

## caller_location

```vidar
where_from :: proc(loc := #caller_location) -> i32 {
	return loc.line
}

main :: proc() {
	fmt.println(where_from() > 0)
}
```

```output
true
```

## config

```vidar
WORKERS :: #config(WORKERS, 4)

main :: proc() {
	fmt.println(WORKERS)        // -define:WORKERS=8 changes it
}
```

```output
4
```

## defined

```vidar
FAST_MATH :: true

main :: proc() {
	when #defined(FAST_MATH) do fmt.println("FAST_MATH is declared")
	when !#defined(SLOW_MATH) do fmt.println("SLOW_MATH isn't")
}
```

```output
FAST_MATH is declared
SLOW_MATH isn't
```

## directory

```vidar
fmt.println(len(#directory) > 0)
```

```output
true
```

## exists

```vidar
when #exists("config.json") {
	HAS_CONFIG :: true
} else {
	HAS_CONFIG :: false
}

main :: proc() {
	fmt.println(HAS_CONFIG)
}
```

```output
false
```

## file

```vidar
fmt.println(strings.has_suffix(#file, ".vidar") || strings.has_suffix(#file, ".odin"))
```

```output
true
```

## force_inline

```vidar
square :: #force_inline proc(x: int) -> int { return x * x }

main :: proc() {
	fmt.println(square(9))
}
```

```output
81
```

## force_no_inline

```vidar
slow_path :: #force_no_inline proc(x: int) -> int { return x + 1 }

main :: proc() {
	fmt.println(slow_path(1))
}
```

```output
2
```

## hash

```vidar
KEY :: #hash("vidar", "fnv32a")

main :: proc() {
	fmt.println(KEY != 0)
}
```

```output
true
```

## line

```vidar
fmt.println(#line > 0)
```

```output
true
```

## load

```vidar,ignore
GREETING :: #load("greeting.txt", string)

main :: proc() {
	fmt.print(GREETING)
}
```

**In Vidar, the path is resolved from the generated Odin's directory**, not from the `.vidar` file's, so a relative path to a file next to your source isn't found; see [Appendix H](appendix-08-limits.md#directives). Use an absolute path, or one relative to where `vidar build -o` writes the output.

## load_directory

```vidar,ignore
FILES :: #load_directory("assets")

main :: proc() {
	for f in FILES do fmt.println(f.name, len(f.data))
}
```

**In Vidar, the path is resolved from the generated Odin's directory**, not from the `.vidar` file's, so a relative path to a file next to your source isn't found; see [Appendix H](appendix-08-limits.md#directives). Use an absolute path, or one relative to where `vidar build -o` writes the output.

## load_hash

```vidar,ignore
DATA_HASH :: #load_hash("data.txt", "crc32")
```

**In Vidar, the path is resolved from the generated Odin's directory**, not from the `.vidar` file's, so a relative path to a file next to your source isn't found; see [Appendix H](appendix-08-limits.md#directives). Use an absolute path, or one relative to where `vidar build -o` writes the output.

## location

```vidar
loc := #location()
fmt.println(loc.line > 0, loc.procedure)
```

```output
true main
```

## no_alias

```vidar
add_into :: proc(#no_alias dst, src: ^[4]int) {
	for i in 0..<4 do dst[i] += src[i]
}

main :: proc() {
	a := [4]int{1, 2, 3, 4}
	b := [4]int{10, 20, 30, 40}
	add_into(&a, &b)
	fmt.println(a)
}
```

```output
[11, 22, 33, 44]
```

## no_bounds_check

```vidar
xs := []int{1, 2, 3}
sum := 0
#no_bounds_check for i in 0..<len(xs) do sum += xs[i]
fmt.println(sum)
```

```output
6
```

## no_nil

```vidar
Value :: union #no_nil { int, string }

main :: proc() {
	v: Value                  // the first variant's zero value, not nil
	fmt.println(v)
}
```

```output
0
```

## optional_ok

```vidar
lookup :: proc(key: string) -> (int, bool) #optional_ok {
	return len(key), key != ""
}

main :: proc() {
	n := lookup("abc")         // the bool may be left off
	m, ok := lookup("")
	fmt.println(n, m, ok)
}
```

```output
3 0 false
```

## packed

```vidar
Loose :: struct { a: u8, b: u32 }
Tight :: struct #packed { a: u8, b: u32 }

main :: proc() {
	fmt.println(size_of(Loose), size_of(Tight))
}
```

```output
8 5
```

## panic

```vidar,compile_fail
when size_of(rawptr) < 4 {
	#panic("needs at least a 32-bit target")
}

#panic("this build is not supported yet")
```

```error
this build is not supported yet
```

## partial

```vidar
Color :: enum { Red, Green, Blue }

main :: proc() {
	c := Color.Green
	#partial switch c {
	case .Red: fmt.println("red")
	case:      fmt.println("not red")
	}
}
```

```output
not red
```

## procedure

```vidar
greet :: proc() {
	fmt.println("in", #procedure)
}

main :: proc() {
	greet()
}
```

```output
in greet
```

## raw_union

```vidar
Bits :: struct #raw_union {
	f: f32,
	u: u32,
}

main :: proc() {
	b: Bits
	b.f = 1
	fmt.printfln("%x", b.u)
}
```

```output
3f800000
```

## reverse

```vidar
#reverse for x in ([]int{1, 2, 3}) do fmt.print(x, "")
fmt.println()
```

```output
3 2 1
```

## row_major

```vidar
m := #row_major matrix[2, 2]int{
	1, 2,
	3, 4,
}
fmt.println(m[0, 1], m[1, 0])
```

```output
2 3
```

## shared_nil

```vidar
Error_A :: enum { None, A }
Error_B :: enum { None, B }
Error :: union #shared_nil { Error_A, Error_B }

main :: proc() {
	err: Error = Error_A.None       // a variant's nil value is the union's nil
	fmt.println(err == nil)
}
```

```output
true
```

## simd

```vidar
a := #simd[4]f32{1, 2, 3, 4}
b := #simd[4]f32{10, 20, 30, 40}
fmt.println(simd.to_array(a + b))
```

```output
[11, 22, 33, 44]
```

## soa

```vidar
Particle :: struct { x, y: f32, alive: bool }

main :: proc() {
	ps: #soa[4]Particle
	ps[1].x = 5
	fmt.println(ps[1].x, len(ps.x))    // each field is its own array
}
```

```output
5 4
```

## sparse

```vidar
Code :: enum { Ok = 200, Not_Found = 404 }

main :: proc() {
	names := #sparse[Code]string{ .Ok = "ok", .Not_Found = "not found" }
	fmt.println(names[.Not_Found])
}
```

```output
not found
```

## subtype

```vidar
Base :: struct { id: int }

Derived :: struct {
	#subtype base: Base,
	name:          string,
}

show :: proc(b: ^Base) { fmt.println(b.id) }

main :: proc() {
	d := Derived{base = {id = 9}, name = "d"}
	show(&d)                  // converts, though d.id isn't in scope
}
```

```output
9
```

## type

```vidar
Callback :: #type proc(n: int) -> int

apply :: proc(f: Callback, n: int) -> int { return f(n) }

main :: proc() {
	fmt.println(apply(proc(n: int) -> int { return n + 1 }, 1))
}
```

```output
2
```

## unroll

```vidar
total := 0
#unroll for i in 0..<4 do total += i
fmt.println(total)
```

```output
6
```
