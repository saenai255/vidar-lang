## Destroy

The whole of [Chapter 7](ch07-00-destructors.md) is about it.

```vidar
Buffer :: struct { data: []byte }

buffer_destroy :: proc(b: ^Buffer) {
	fmt.println("freeing", len(b.data), "bytes")
	delete(b.data)
}

impl Destroy for Buffer { destroy = buffer_destroy }

main :: proc() {
	b := Buffer{make([]byte, 16)}
	fmt.println("using", len(b.data), "bytes")
}   // b is destroyed here
```

```output
using 16 bytes
freeing 16 bytes
```

## Clone

See [Copying with `impl Clone`](ch07-03-impl-clone.md).

```vidar
Handle :: struct { id: int, refs: ^int }

handle_destroy :: proc(h: ^Handle) {
	if h.refs == nil do return
	h.refs^ -= 1
	if h.refs^ == 0 {
		fmt.println("last handle to", h.id, "released")
		free(h.refs)
	}
}

handle_clone :: proc(h: Handle) -> Handle {
	h.refs^ += 1
	return h
}

impl Destroy for Handle { destroy = handle_destroy }
impl Clone for Handle { clone = handle_clone }

main :: proc() {
	a := Handle{7, new_clone(1)}
	b := a                 // a clone: a is used below
	fmt.println("refs:", a.refs^, "ids:", a.id, b.id)
}
```

```output
refs: 2 ids: 7 7
last handle to 7 released
```

## Pool

See [Closures, Interfaces and `Pool`](ch15-06-closures-and-interfaces.md#pooli).

```vidar
Shape :: interface { area }
area :: proc(s: Shape) -> f64 ---

Square :: struct { side: f64 }
Circle :: struct { r: f64 }

square_area :: proc(s: ^Square) -> f64 { return s.side * s.side }
circle_area :: proc(c: ^Circle) -> f64 { return 3 * c.r * c.r }

impl Shape for Square { area = square_area }
impl Shape for Circle { area = circle_area }

main :: proc() {
	shapes: Pool(Shape)
	defer delete(shapes)
	append(&shapes, Square{2}, Circle{1}, Square{1})
	total := 0.0
	for s in shapes do total += area(s)     // one loop per type, direct calls
	fmt.println(len(shapes), total)
}
```

```output
3 8
```

## any

```vidar
describe :: proc(x: any) {
	switch v in x {
	case int:    fmt.println("an int:", v)
	case string: fmt.println("a string:", v)
	case:        fmt.println("something else:", x.id)
	}
}

main :: proc() {
	describe(42)
	describe("hi")
	describe(1.5)
}
```

```output
an int: 42
a string: hi
something else: f64
```

## b8

```vidar
flags: [4]b8 = {true, false, true, true}
fmt.println(flags, size_of(b8))
```

```output
[true, false, true, true] 1
```

## b16

```vidar
x: b16 = true
fmt.println(x, size_of(b16))
```

```output
true 2
```

## b32

```vidar
x: b32 = 3 > 2
fmt.println(x, size_of(b32))
```

```output
true 4
```

The sized booleans exist for C interop, where a `BOOL` is often 4 bytes.

## b64

```vidar
x: b64 = false
fmt.println(x, size_of(b64))
```

```output
false 8
```

## bool

```vidar
ready := 2 + 2 == 4
fmt.println(ready, !ready, size_of(bool))
```

```output
true false 1
```

## byte

```vidar
data := []byte{72, 105}
fmt.println(string(data), typeid_of(byte) == typeid_of(u8))
```

```output
Hi true
```

## complex64

```vidar
z: complex64 = complex(1, 2)
fmt.println(z * z)
```

```output
-3+4i
```

## complex128

```vidar
z := complex(0.0, 1.0)     // complex128
fmt.println(z * z, abs(complex(3.0, 4.0)))
```

```output
-1+0i 5
```

## cstring

```vidar
name: cstring = "vidar"           // a constant string converts to cstring
fmt.println(len(name), string(name))
```

```output
5 vidar
```

Use it for C APIs; `strings.clone_to_cstring` makes one from a run-time `string`.

## f16

```vidar
h: f16 = 1.5
fmt.println(h * 2, size_of(f16))
```

```output
3 2
```

## f32

```vidar
x: f32 = 0.1
fmt.println(x * 3, size_of(f32))
```

```output
0.3 4
```

## f64

```vidar
x := 0.1                 // untyped floats default to f64
fmt.println(x * 3, typeid_of(type_of(x)))
```

```output
0.30000000000000004 f64
```

## i8

```vidar
x: i8 = 127
x += 1                   // wraps around
fmt.println(x, min(i8), max(i8))
```

```output
-128 -128 127
```

## i16

```vidar
x: i16 = -300
fmt.println(x, size_of(i16))
```

```output
-300 2
```

## i32

```vidar
x: i32 = 2_000_000_000
fmt.println(x, size_of(i32))
```

```output
2000000000 4
```

## i64

```vidar
x: i64 = 1 << 40
fmt.println(x, size_of(i64))
```

```output
1099511627776 8
```

## i128

```vidar
x: i128 = 1 << 100
fmt.println(x)
```

```output
1267650600228229401496703205376
```

## int

```vidar
n := 42                  // untyped integers default to int
fmt.println(n, size_of(int), typeid_of(type_of(n)))
```

```output
42 8 int
```

## quaternion256

```vidar
q: quaternion256 = 1
i := quaternion(w = 0, x = 1, y = 0, z = 0)
fmt.println(q, i * i)
```

```output
1+0i+0j+0k -1+0i+0j+0k
```

## rawptr

```vidar
x := 7
p: rawptr = &x
back := (^int)(p)
fmt.println(back^)
```

```output
7
```

## rune

```vidar
for r in "héllo" do fmt.print(r, "")
fmt.println()
fmt.println('é', u32('é'))
```

```output
h é l l o
é 233
```

Looping over a string gives its runes, decoded from UTF-8.

## string

```vidar
s := "héllo"
fmt.println(len(s), s[1:3], strings.to_upper(s, context.temp_allocator))
```

```output
6 é HÉLLO
```

## u8

```vidar
x: u8 = 255
x += 1                   // wraps around
fmt.println(x, max(u8))
```

```output
0 255
```

## u16

```vidar
x: u16 = 65535
fmt.println(x, size_of(u16))
```

```output
65535 2
```

## u32

```vidar
x: u32 = 0xdead_beef
fmt.printfln("%x %d", x, size_of(u32))
```

```output
deadbeef 4
```

## u64

```vidar
x: u64 = 1 << 63
fmt.println(x)
```

```output
9223372036854775808
```

## u128

```vidar
x: u128 = 1 << 127
fmt.println(x)
```

```output
170141183460469231731687303715884105728
```

## uint

```vidar
x: uint = 3
fmt.println(x, size_of(uint) == size_of(int))
```

```output
3 true
```

## uintptr

```vidar
x := 7
addr := uintptr(&x)
fmt.println(addr != 0, size_of(uintptr) == size_of(rawptr))
```

```output
true true
```
