## abs

```vidar
fmt.println(abs(-5), abs(2.5), abs(i8(-128) + 1))
```

```output
5 2.5 127
```

## align_of

```vidar
Pair :: struct { a: u8, b: f64 }

main :: proc() {
	fmt.println(align_of(u8), align_of(f64), align_of(Pair))
}
```

```output
1 8 8
```

## append

`append` takes any number of values, and with `..` the elements of a slice. For an element type with [`impl Destroy`](ch07-04-containers.md), it moves new values in, and copying a variable in is an error.

```vidar
xs: [dynamic]int
defer delete(xs)
append(&xs, 1)
append(&xs, 2, 3)
append(&xs, ..[]int{4, 5})
fmt.println(xs[:], len(xs))
```

```output
[1, 2, 3, 4, 5] 5
```

## assert

```vidar,should_panic
n := 3
assert(n > 0)                       // passes
assert(n > 5, "n must be above 5")  // panics
```

```error
runtime assertion: n must be above 5
```

For a message that shows the values involved, use [`check!`](reference-04-macros.md#check).

## assign_at

```vidar
xs: [dynamic]int
defer delete(xs)
assign_at(&xs, 3, 7)     // grows xs to 4 elements
fmt.println(xs[:])
```

```output
[0, 0, 0, 7]
```

With destructible elements, `assign_at` is an error, since it would overwrite without destroying; assign to the element instead.

## cap

```vidar
xs := make([dynamic]int, 2, 10)
defer delete(xs)
fmt.println(len(xs), cap(xs))
```

```output
2 10
```

## card

```vidar
Color :: enum { Red, Green, Blue }

main :: proc() {
	warm := bit_set[Color]{.Red, .Green}
	fmt.println(card(warm))
}
```

```output
2
```

## clamp

```vidar
fmt.println(clamp(15, 0, 10), clamp(-3, 0, 10), clamp(0.5, 0, 1))
```

```output
10 0 0.5
```

## clear

```vidar
xs: [dynamic]int
defer delete(xs)
append(&xs, 1, 2, 3)
clear(&xs)
fmt.println(len(xs), cap(xs) >= 3)
```

```output
0 true
```

For an element type with `impl Destroy`, `clear` destroys the elements first.

## conj

```vidar
z := complex(3, 4)
fmt.println(conj(z))
```

```output
3-4i
```

## copy

```vidar
src := []int{1, 2, 3, 4}
dst: [3]int
n := copy(dst[:], src)
fmt.println(n, dst)
```

```output
3 [1, 2, 3]
```

## delete

```vidar
xs := make([dynamic]int)
append(&xs, 1, 2)
delete(xs)

m := make(map[string]int)
m["a"] = 1
delete(m)

s := fmt.aprintf("%d items", 2)
fmt.println(s)
delete(s)
```

```output
2 items
```

For a dynamic array or map whose elements have `impl Destroy`, `delete` destroys them too and leaves the container empty.

## delete_key

```vidar
ages := make(map[string]int)
defer delete(ages)
ages["ada"] = 36
ages["bob"] = 41
key, value := delete_key(&ages, "bob")
fmt.println(key, value, len(ages))
```

```output
bob 41 1
```

## expand_values

```vidar
Point :: struct { x, y: int }

add :: proc(x, y: int) -> int { return x + y }

main :: proc() {
	p := Point{3, 4}
	fmt.println(add(expand_values(p)))
}
```

```output
7
```

## free

```vidar
p := new(int)
p^ = 42
fmt.println(p^)
free(p)
```

```output
42
```

`free` doesn't run a destructor: for a pointer to a type with `impl Destroy`, destroy the value first.

## free_all

```vidar
for i in 0..<3 {
	s := fmt.tprintf("round %d", i)    // from context.temp_allocator
	fmt.println(s)
	free_all(context.temp_allocator)
}
```

```output
round 0
round 1
round 2
```

## imag

```vidar
z := complex(3, 4)
fmt.println(real(z), imag(z))
```

```output
3 4
```

## inject_at

```vidar
xs: [dynamic]int
defer delete(xs)
append(&xs, 1, 3)
inject_at(&xs, 1, 2)
fmt.println(xs[:])
```

```output
[1, 2, 3]
```

## len

```vidar
arr := [4]int{}
s := "héllo"
m := make(map[string]int)
defer delete(m)
m["a"] = 1
fmt.println(len(arr), len(s), len(m))
```

```output
4 6 1
```

`len` of a string counts bytes: `é` takes two.

## make

```vidar
s := make([]int, 3)                 // a slice of 3 zeros
defer delete(s)
d := make([dynamic]int, 0, 16)      // empty, with room for 16
defer delete(d)
m := make(map[string]int)
defer delete(m)
fmt.println(len(s), len(d), cap(d), len(m))
```

```output
3 0 16 0
```

## max

```vidar
fmt.println(max(3, 9, 4), max(1.5, -2))
```

```output
9 1.5
```

## min

```vidar
fmt.println(min(3, 9, 4), min(1.5, -2))
```

```output
3 -2
```

## new

```vidar
Point :: struct { x, y: int }

main :: proc() {
	p := new(Point)       // zeroed, on the heap
	defer free(p)
	p.x = 5
	fmt.println(p^)
}
```

```output
Point{x = 5, y = 0}
```

## new_clone

```vidar
Point :: struct { x, y: int }

main :: proc() {
	p := new_clone(Point{1, 2})
	defer free(p)
	fmt.println(p^)
}
```

```output
Point{x = 1, y = 2}
```

`new_clone` is the usual way to give a closure or an interface value something that outlives the current procedure. For a type with `impl Destroy`, it clones (with `impl Clone`) or is an error.

## offset_of

```vidar
Header :: struct { tag: u8, size: u32, name: string }

main :: proc() {
	fmt.println(offset_of(Header, tag), offset_of(Header, size), offset_of(Header, name))
}
```

```output
0 4 8
```

## ordered_remove

```vidar
xs: [dynamic]string
defer delete(xs)
append(&xs, "a", "b", "c", "d")
ordered_remove(&xs, 1)
fmt.println(xs[:])
```

```output
["a", "c", "d"]
```

## panic

```vidar,should_panic
divide :: proc(a, b: int) -> int {
	if b == 0 do panic("division by zero")
	return a / b
}

main :: proc() {
	fmt.println(divide(6, 3))
	fmt.println(divide(1, 0))
}
```

```output
2
```

```error
panic: division by zero
```

## pop

```vidar
xs: [dynamic]int
defer delete(xs)
append(&xs, 1, 2, 3)
last := pop(&xs)
fmt.println(last, xs[:])
```

```output
3 [1, 2]
```

## pop_front

```vidar
xs: [dynamic]int
defer delete(xs)
append(&xs, 1, 2, 3)
first := pop_front(&xs)
fmt.println(first, xs[:])
```

```output
1 [2, 3]
```

## raw_data

```vidar
xs := []i32{10, 20, 30}
p := raw_data(xs)        // [^]i32
fmt.println(p[0], p[2])
```

```output
10 30
```

## real

```vidar
z := complex(1.5, -2)
fmt.println(real(z))
```

```output
1.5
```

## remove_range

```vidar
xs: [dynamic]int
defer delete(xs)
append(&xs, 0, 1, 2, 3, 4, 5)
remove_range(&xs, 1, 4)
fmt.println(xs[:])
```

```output
[0, 4, 5]
```

## reserve

```vidar
xs: [dynamic]int
defer delete(xs)
reserve(&xs, 100)
for i in 0..<100 do append(&xs, i)   // no growth needed
fmt.println(len(xs), cap(xs))
```

```output
100 100
```

## resize

```vidar
xs: [dynamic]int
defer delete(xs)
append(&xs, 1, 2)
resize(&xs, 4)
fmt.println(xs[:])
resize(&xs, 1)
fmt.println(xs[:])
```

```output
[1, 2, 0, 0]
[1]
```

## shrink

```vidar
xs := make([dynamic]int, 0, 64)
defer delete(xs)
append(&xs, 1, 2, 3)
shrink(&xs)
fmt.println(len(xs), cap(xs))
```

```output
3 3
```

## size_of

```vidar
Pair :: struct { a: u8, b: f64 }

main :: proc() {
	fmt.println(size_of(u8), size_of(f64), size_of(Pair), size_of(string))
}
```

```output
1 8 16 16
```

## swizzle

```vidar
v := [4]f32{1, 2, 3, 4}
fmt.println(swizzle(v, 3, 2, 1, 0), swizzle(v, 0, 0))
```

```output
[4, 3, 2, 1] [1, 1]
```

## type_info_of

```vidar
info := type_info_of(f64)
fmt.println(info.size, info.align)
```

```output
8 8
```

## type_of

```vidar
x := 3.5
y: type_of(x) = 2        // y is an f64 too
fmt.println(x + y, typeid_of(type_of(y)))
```

```output
5.5 f64
```

## typeid_of

```vidar
show :: proc(x: any) {
	fmt.println(x.id == typeid_of(int))
}

main :: proc() {
	show(1)
	show("one")
}
```

```output
true
false
```

## unimplemented

In a Vidar file, the name belongs to the built-in macro [`unimplemented!`](reference-04-macros.md#unimplemented), which panics at the line of the call; calling Odin's procedure by its plain name is an error that says so:

```vidar,compile_fail
area :: proc(shape: string) -> f64 {
	if shape == "square" do return 1
	unimplemented("only squares")
}
```

```error
error: 'unimplemented' is a comptime proc: call it as 'unimplemented!(...)'
```

```vidar,should_panic
area :: proc(shape: string) -> f64 {
	if shape == "square" do return 1
	unimplemented!("only squares")
}

main :: proc() {
	fmt.println(area("square"))
	fmt.println(area("circle"))
}
```

```output
1
```

```error
panic: not implemented: only squares
```

## unordered_remove

```vidar
xs: [dynamic]string
defer delete(xs)
append(&xs, "a", "b", "c", "d")
unordered_remove(&xs, 0)     // "d" moves into slot 0
fmt.println(xs[:])
```

```output
["d", "b", "c"]
```
