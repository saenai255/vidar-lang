## block_value

`do!` is written with it, and so can a macro of your own that gives a block's `take` value:

```vidar
first_even :: proc!(T: Type = _, body: Stmt) -> Expr {
	return block_value(T, body)
}

main :: proc() {
	xs := []int{3, 5, 8, 9}
	n := first_even! {
		for x in xs do if x % 2 == 0 do take x
		take -1
	}
	fmt.println(n)
}
```

```output
8
```

## call_site

```vidar
here :: proc!() -> Expr(string) {
	return quote($(call_site()))
}

main :: proc() {
	fmt.println(len(here!()) > 0)
}
```

```output
true
```

`here!()` gives a string like `main.vidar:6`, fixed at compile time.

## compile_error

```vidar,compile_fail
power_of_two :: proc!(n: int) -> int {
	if n & (n - 1) != 0 do compile_error("not a power of two: ", n)
	return n
}

main :: proc() {
	SIZE :: 24
	_ = power_of_two!(SIZE)
}
```

```error
not a power of two: 24
```

## comptime_value

`comptime!` is written with it:

```vidar
at_compile_time :: proc!(body: Stmt) -> Expr {
	return comptime_value(body)
}

main :: proc() {
	n := at_compile_time! { take 6 * 7 }
	fmt.println(n)
}
```

```output
42
```

## ident

```vidar
getter :: proc!(field: string) -> Stmt {
	name := ident("get_" + field)
	f := ident(field)
	return quote { $name :: proc(p: Point) -> int { return p.$f } }
}

Point :: struct { x, y: int }

getter!("x")
getter!("y")

main :: proc() {
	p := Point{3, 4}
	fmt.println(get_x(p), get_y(p))
}
```

```output
3 4
```

## is_literal

```vidar
describe :: proc!(e: Expr) -> Expr(string) {
	return quote($("a literal" if is_literal(e) else "an expression"))
}

main :: proc() {
	n := 2
	fmt.println(describe!(42), describe!(n + 1))
}
```

```output
a literal an expression
```

## once

```vidar
square :: proc!(x: Expr) -> Expr {
	v := once(x)
	return quote($v * $v)
}

next :: proc(n: ^int) -> int {
	n^ += 1
	return n^
}

main :: proc() {
	counter := 0
	fmt.println(square!(next(&counter)), counter)    // next runs once, not twice
}
```

```output
1 1
```

## parse_expr

```vidar
from_text :: proc!(text: string) -> Expr {
	return parse_expr(text)
}

main :: proc() {
	x := 5
	fmt.println(from_text!("x * 2 + 1"))
}
```

```output
11
```

## split_comparison

```vidar
explain :: proc!(cond: Expr) -> Stmt {
	parts := split_comparison(cond)
	op := parts[1]
	return quote { fmt.println($(stringify(cond)), "compares with", $op) }
}

main :: proc() {
	a, b := 1, 2
	explain!(a < b)
}
```

```output
a < b compares with <
```

## split_range

```vidar
range_len :: proc!(r: Expr) -> Expr {
	parts := split_range(r)
	lo := parts[0]
	hi := parts[2]
	if parts[1] == "..=" do return quote($hi - $lo + 1)
	return quote($hi - $lo)
}

main :: proc() {
	fmt.println(range_len!(2..<10), range_len!(1..=3))
}
```

```output
8 3
```

## stringify

```vidar
show :: proc!(e: Expr) -> Stmt {
	return quote { fmt.println($(stringify(e)), "=", $e) }
}

main :: proc() {
	w, h := 3, 4
	show!(w * h + 1)
}
```

```output
w * h + 1 = 13
```

## type_fields

```vidar
field_list :: proc!(T: Type) -> Expr(string) {
	out := ""
	for f, i in type_fields(T) do out += ("" if i == 0 else ", ") + f
	return quote($out)
}

User :: struct { id: int, name: string, admin: bool }

main :: proc() {
	fmt.println(field_list!(User))
}
```

```output
id, name, admin
```

## type_name

```vidar
name_of :: proc!(T: Type) -> Expr(string) {
	return quote($(type_name(T)))
}

main :: proc() {
	fmt.println(name_of!([]int), name_of!(map[string]f64))
}
```

```output
[]int map[string]f64
```

## type_of_expr

```vidar
default_like :: proc!(x: Expr) -> Expr {
	T := type_of_expr(x)
	return quote($T{})
}

Point :: struct { x, y: int }

main :: proc() {
	p := Point{1, 2}
	n := 7
	fmt.println(default_like!(p), default_like!(n))
}
```

```output
Point{x = 0, y = 0} 0
```

## Expr

```vidar
twice :: proc!(e: Expr) -> Expr {
	return quote(($e) * 2)
}

halve :: proc!(e: Expr(f64)) -> Expr(f64) {
	return quote($e / 2)
}

main :: proc() {
	fmt.println(twice!(3 + 4), halve!(5.0))
}
```

```output
14 2.5
```

## Ident

```vidar
counter :: proc!(name: Ident) -> Stmt {
	return quote { $name := 0 }
}

capture_all :: proc!(names: []Ident, body: Stmt) -> Expr {
	return quote(proc[$names]() { $body })
}

main :: proc() {
	counter!(hits)
	step := 2
	bump := capture_all!({&hits, step}) { hits += step }
	bump()
	bump()
	fmt.println(hits)
}
```

```output
4
```

## Stmt

```vidar
twice :: proc!(body: Stmt) -> Stmt {
	return quote { $body; $body }
}

main :: proc() {
	n := 0
	twice! { n += 5 }
	fmt.println(n)
}
```

```output
10
```

## Type

```vidar
zero :: proc!(T: Type) -> Expr {
	return quote($T{})
}

Vec :: struct { x, y: f32 }

main :: proc() {
	fmt.println(zero!(Vec), zero!([3]int))
}
```

```output
Vec{x = 0, y = 0} [0, 0, 0]
```
