## catch

```vidar
Error :: enum { None, Empty }

first :: proc(xs: []int) -> (int, Error) {
	if len(xs) == 0 do return 0, .Empty
	return xs[0], .None
}

main :: proc() {
	n := first({}) catch err {
		fmt.println("no first element:", err)
		return
	}
	fmt.println(n)
}
```

```output
no first element: Empty
```

See [Handling a Failure in Place with `catch`](ch06-03-catch.md).

## closure

```vidar
make_adder :: proc(n: int) -> closure(int) -> int {
	return proc[n](x: int) -> int { return x + n }
}

main :: proc() {
	add5 := make_adder(5)
	fmt.println(add5(1), make_adder(10)(1))
}
```

```output
6 11
```

See [Closure Types](ch04-03-closure-types.md).

## errdefer

```vidar
Error :: enum { None, Failed }

build :: proc(fail: bool) -> (out: [dynamic]int, err: Error) {
	errdefer {
		fmt.println("cleaning up")
		delete(out)
	}
	append(&out, 1, 2)
	if fail do return out, .Failed
	return out, .None
}

main :: proc() {
	xs := build(false) catch unreachable
	defer delete(xs)
	fmt.println(xs[:])
	_, err := build(true)
	fmt.println(err)
}
```

```output
[1, 2]
cleaning up
Failed
```

## impl

```vidar
Greeter :: interface { greet }
greet :: proc(g: Greeter) -> string ---

English :: struct {}
english_greet :: proc(_: ^English) -> string { return "hello" }

impl Greeter for English { greet = english_greet }

main :: proc() {
	e: English
	fmt.println(greet(&e))
}
```

```output
hello
```

## interface

```vidar
Animal :: interface { speak }
speak :: proc(a: Animal) -> string ---

Dog :: struct {}
Cat :: struct {}
dog_speak :: proc(_: ^Dog) -> string { return "woof" }
cat_speak :: proc(_: ^Cat) -> string { return "meow" }
impl Animal for Dog { speak = dog_speak }
impl Animal for Cat { speak = cat_speak }

main :: proc() {
	d: Dog
	c: Cat
	animals := []Animal{Animal(&d), Animal(&c)}
	for a in animals do fmt.println(speak(a))
}
```

```output
woof
meow
```

See [Interfaces](ch05-00-interfaces.md).

## quote

```vidar
negate :: proc!(e: Expr) -> Expr {
	return quote(-($e))
}

main :: proc() {
	x := 4
	fmt.println(negate!(x + 1))
}
```

```output
-5
```

## take

```vidar
main :: proc() {
	n := 7
	parity := do! {
		if n % 2 == 0 do take "even"
		take "odd"
	}
	fmt.println(parity)
}
```

```output
odd
```

## unreachable

```vidar
main :: proc() {
	port := strconv.parse_int("8080") catch unreachable
	fmt.println(port)
}
```

```output
8080
```

## asm

`asm` is target-specific, so this one is shown and not compiled:

```vidar,ignore
nop :: asm() {
	"nop",
	"",
}
```

## auto_cast

```vidar
half :: proc(x: f64) -> f64 { return x / 2 }

main :: proc() {
	n: int = 9
	fmt.println(half(auto_cast n))
}
```

```output
4.5
```

## bit_field

```vidar
Flags :: bit_field u8 {
	ready: bool | 1,
	level: u8   | 3,
}

main :: proc() {
	f: Flags
	f.ready = true
	f.level = 5
	fmt.println(f.ready, f.level, size_of(Flags))
}
```

```output
true 5 1
```

## bit_set

```vidar
Day :: enum { Mon, Tue, Wed, Thu, Fri, Sat, Sun }

main :: proc() {
	weekend := bit_set[Day]{.Sat, .Sun}
	fmt.println(.Sat in weekend, .Mon in weekend, card(weekend))
}
```

```output
true false 2
```

## break

```vidar
for i in 0..<10 {
	if i == 3 do break
	fmt.print(i, "")
}
fmt.println()
```

```output
0 1 2
```

## case

```vidar
for n in 0..<4 {
	switch n {
	case 0:    fmt.println("zero")
	case 1, 2: fmt.println("small")
	case:      fmt.println("other")
	}
}
```

```output
zero
small
small
other
```

## cast

```vidar
x := 3.9
fmt.println(cast(int)x, int(x), u8(300 % 256))
```

```output
3 3 44
```

## context

```vidar
show_allocator :: proc() {
	fmt.println(context.allocator.procedure != nil)
}

main :: proc() {
	show_allocator()
}
```

```output
true
```

See [Constants and Context Fields](reference-03-constants.md#context-fields).

## continue

```vidar
for i in 0..<6 {
	if i % 2 == 1 do continue
	fmt.print(i, "")
}
fmt.println()
```

```output
0 2 4
```

## defer

```vidar
main :: proc() {
	defer fmt.println("third")
	defer fmt.println("second")
	fmt.println("first")
}
```

```output
first
second
third
```

## distinct

```vidar
Meters :: distinct f64
Feet :: distinct f64

main :: proc() {
	m := Meters(3)
	f := Feet(m * 3.28084)     // converting is explicit
	fmt.printfln("%.2f", f)
}
```

```output
9.84
```

## do

```vidar
for i in 0..<3 do fmt.print(i, "")
fmt.println()
if true do fmt.println("one line")
```

```output
0 1 2
one line
```

## dynamic

```vidar
names: [dynamic]string
defer delete(names)
append(&names, "ada", "bob")
fmt.println(names[:], len(names))
```

```output
["ada", "bob"] 2
```

## else

```vidar
n := 7
if n > 10 {
	fmt.println("big")
} else if n > 5 {
	fmt.println("medium")
} else {
	fmt.println("small")
}
fmt.println("even" if n % 2 == 0 else "odd")
```

```output
medium
odd
```

## enum

```vidar
Direction :: enum { North, East, South, West }

main :: proc() {
	d := Direction.East
	fmt.println(d, int(d), Direction(2))
	for dir in Direction do fmt.print(dir, "")
	fmt.println()
}
```

```output
East 1 South
North East South West
```

## fallthrough

```vidar
switch 1 {
case 1:
	fmt.println("one")
	fallthrough
case 2:
	fmt.println("one or two")
}
```

```output
one
one or two
```

## false

```vidar
done := false
fmt.println(done, !done)
```

```output
false true
```

## for

```vidar
for i := 0; i < 2; i += 1 do fmt.print(i, "")
for i in 2..<4 do fmt.print(i, "")
for c in "ab" do fmt.print(c, "")
fmt.println()
```

```output
0 1 2 3 a b
```

## foreign

```vidar
foreign import libc "system:c"

foreign libc {
	@(link_name = "abs")
	c_abs :: proc "c" (x: i32) -> i32 ---
}

main :: proc() {
	fmt.println(c_abs(-7))
}
```

```output
7
```

`@(link_name)` binds C's `abs` under another name, since `abs` is already one of Odin's built-ins.

## if

```vidar
if n := len("vidar"); n > 3 {
	fmt.println("long name:", n)
}
```

```output
long name: 5
```

## import

```vidar
import "core:fmt"
import str "core:strings"

main :: proc() {
	fmt.println(str.to_upper("vidar", context.temp_allocator))
}
```

```output
VIDAR
```

## in

```vidar
primes := bit_set[0..<16]{2, 3, 5, 7, 11, 13}
fmt.println(7 in primes, 9 in primes)
for x in ([]int{1, 2}) do fmt.print(x, "")
fmt.println()
```

```output
true false
1 2
```

## map

```vidar
ages := make(map[string]int)
defer delete(ages)
ages["ada"] = 36
if age, ok := ages["ada"]; ok do fmt.println(age)
fmt.println("bob" in ages)
```

```output
36
false
```

## matrix

```vidar
m := matrix[2, 2]f32{
	1, 2,
	3, 4,
}
v := [2]f32{1, 1}
fmt.println(m * v)
```

```output
[3, 7]
```

## nil

```vidar
p: ^int
m: map[string]int
f: closure()
fmt.println(p == nil, m == nil, f == {})
```

```output
true true true
```

## not_in

```vidar
seen := bit_set[0..<8]{1, 3}
fmt.println(2 not_in seen, 3 not_in seen)
```

```output
true false
```

## or_break

```vidar
lookup :: proc(i: int) -> (int, bool) { return i * 10, i < 3 }

main :: proc() {
	for i in 0..<10 {
		v := lookup(i) or_break
		fmt.print(v, "")
	}
	fmt.println()
}
```

```output
0 10 20
```

## or_continue

```vidar
parse :: proc(s: string) -> (int, bool) { return strconv.parse_int(s) }

main :: proc() {
	total := 0
	for s in ([]string{"1", "x", "3"}) {
		n := parse(s) or_continue
		total += n
	}
	fmt.println(total)
}
```

```output
4
```

## or_else

```vidar
port := strconv.parse_int("not a number") or_else 8080
fmt.println(port)
```

```output
8080
```

## or_return

```vidar
Error :: enum { None, Bad }

parse :: proc(s: string) -> (int, Error) {
	n := strconv.parse_int(s) or_return .Bad      // Vidar: return a different error
	return n, .None
}

sum :: proc(a, b: string) -> (total: int, err: Error) {
	x := parse(a) or_return                       // Odin: pass the error on
	y := parse(b) or_return
	return x + y, .None
}

main :: proc() {
	fmt.println(sum("2", "3"))
	fmt.println(sum("2", "x"))
}
```

```output
5 None
0 Bad
```

## package

```vidar
package main

import "core:fmt"

main :: proc() {
	fmt.println("every file starts with its package")
}
```

```output
every file starts with its package
```

## proc

```vidar
add :: proc(a, b: int) -> int { return a + b }

main :: proc() {
	sub := proc(a, b: int) -> int { return a - b }   // a procedure value
	fmt.println(add(2, 3), sub(5, 1))
}
```

```output
5 4
```

## return

```vidar
min_max :: proc(xs: []int) -> (lo, hi: int) {
	lo, hi = xs[0], xs[0]
	for x in xs {
		lo = min(lo, x)
		hi = max(hi, x)
	}
	return                        // returns the named results
}

main :: proc() {
	fmt.println(min_max({4, 1, 9}))
}
```

```output
1 9
```

## struct

```vidar
Player :: struct {
	name:  string,
	score: int,
}

main :: proc() {
	p := Player{name = "ada", score = 10}
	p.score += 5
	fmt.println(p)
}
```

```output
Player{name = "ada", score = 15}
```

## switch

```vidar
Value :: union { int, string }

main :: proc() {
	values := []Value{1, "two"}
	for v in values {
		switch x in v {
		case int:    fmt.println("int", x)
		case string: fmt.println("string", x)
		}
	}
}
```

```output
int 1
string two
```

## transmute

```vidar
f: f32 = 1.0
bits := transmute(u32)f
fmt.printfln("%x", bits)
```

```output
3f800000
```

## true

```vidar
ok := true
fmt.println(ok && !false)
```

```output
true
```

## typeid

```vidar
kind :: proc(T: typeid) -> string {
	return "number" if T == int || T == f64 else "other"
}

main :: proc() {
	fmt.println(kind(int), kind(string))
}
```

```output
number other
```

## union

```vidar
Shape :: union { Circle, Square }
Circle :: struct { r: f64 }
Square :: struct { side: f64 }

main :: proc() {
	s: Shape = Square{2}
	if sq, ok := s.(Square); ok do fmt.println(sq.side)
	s = nil
	fmt.println(s == nil)
}
```

```output
2
true
```

## using

```vidar
Entity :: struct { x, y: f32 }

Player :: struct {
	using entity: Entity,
	name:         string,
}

main :: proc() {
	p := Player{name = "ada"}
	p.x = 3                  // a field of entity, through using
	fmt.println(p.x, p.entity.x)
}
```

```output
3 3
```

## when

```vidar
DEBUG :: false

main :: proc() {
	when DEBUG {
		fmt.println("debugging")
	} else {
		fmt.println("not debugging")
	}
}
```

```output
not debugging
```

## where

```vidar
sum :: proc(xs: []$T) -> T where intrinsics.type_is_numeric(T) {
	total: T
	for x in xs do total += x
	return total
}

main :: proc() {
	fmt.println(sum([]int{1, 2, 3}), sum([]f64{0.5, 0.25}))
}
```

```output
6 0.75
```
