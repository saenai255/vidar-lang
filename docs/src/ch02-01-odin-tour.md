# A Quick Tour of Odin

This section shows the parts of Odin that come up again and again in this book, one short program at a time. It isn't a complete description of Odin; the [Odin overview](https://odin-lang.org/docs/overview/) is.

## Variables and Constants

`name := value` declares a variable, and its type is inferred from the value. `name: Type = value` gives the type, and `name: Type` declares a variable set to its type's *zero value*: `0`, `false`, `""`, `nil` or an all-zero struct. `name :: value` declares a constant.

```vidar
main :: proc() {
	count := 3            // int
	ratio: f32 = 0.5
	label: string         // "", the zero value
	LIMIT :: 10           // a constant
	count += LIMIT
	fmt.println(count, ratio, len(label))
}
```

```output
13 0.5 0
```

Every variable starts as its zero value unless you give it another. Writing `x: int = ---` leaves it uninitialized instead, which you'll rarely need.

## Procedures

A procedure is declared as a constant whose value is a `proc`. Parameters are listed with their types, and results after `->`. A procedure can return several results, and the results can be named:

```vidar
add :: proc(a, b: int) -> int {
	return a + b
}

divide :: proc(a, b: int) -> (quotient: int, ok: bool) {
	if b == 0 do return 0, false
	return a / b, true
}

main :: proc() {
	fmt.println(add(2, 3))
	q, ok := divide(7, 2)
	fmt.println(q, ok)
	_, ok = divide(1, 0)
	fmt.println(ok)
}
```

```output
5
3 true
false
```

`if cond do stmt` is a one-statement `if`; `do` works the same after `for` and `when`. Parameters are read-only: to change a caller's value, pass a pointer.

## Structs, Enums and Unions

```vidar
Point :: struct {
	x, y: int,
}

Color :: enum { Red, Green, Blue }

Shape :: union { Circle, Square }
Circle :: struct { r: f64 }
Square :: struct { side: f64 }

area :: proc(s: Shape) -> f64 {
	switch v in s {
	case Circle: return 3.14159 * v.r * v.r
	case Square: return v.side * v.side
	}
	return 0
}

main :: proc() {
	p := Point{1, 2}
	q := Point{y = 5}          // fields by name; x is 0
	p.x += 10
	c := Color.Green
	fmt.println(p, q, c)
	fmt.println(area(Square{3}))
}
```

```output
Point{x = 11, y = 2} Point{x = 0, y = 5} Green
9
```

A `union` holds one of its variants, or `nil`. `switch v in s` is a *type switch*: in each `case`, `v` has that variant's type. Where the type is known, an enum member can be written without its type name, as `.Green`.

## Pointers

`^T` is a pointer to a `T`, `&x` takes the address of `x`, and `p^` is the value `p` points to. Fields are reached through a pointer without `^`:

```vidar
Counter :: struct { n: int }

bump :: proc(c: ^Counter) {
	c.n += 1        // same as c^.n += 1
}

main :: proc() {
	c := Counter{}
	bump(&c)
	bump(&c)
	p := &c
	fmt.println(c.n, p^)
}
```

```output
2 Counter{n = 2}
```

## Arrays, Slices, Dynamic Arrays and Maps

- `[N]T` is a fixed-size array, stored in place.
- `[]T` is a *slice*: a pointer and a length that view part of an array.
- `[dynamic]T` is a growable array; `append` adds to it and `delete` frees it.
- `map[K]V` is a hash map; `delete` frees it too.

```vidar
main :: proc() {
	arr := [3]int{1, 2, 3}
	s := arr[1:]                 // a slice of the last two

	xs: [dynamic]int
	defer delete(xs)
	append(&xs, 10, 20)
	append(&xs, 30)

	ages := make(map[string]int)
	defer delete(ages)
	ages["ada"] = 36
	age, found := ages["bob"]   // 0, false

	fmt.println(s, xs[:], len(xs), ages["ada"], age, found)
}
```

```output
[2, 3] [10, 20, 30] 3 36 0 false
```

Odin doesn't free memory for you. Whatever you `make`, `new` or `append` to stays allocated until you `delete` or `free` it. `defer` runs a statement when the enclosing scope ends, on every path out of it, which makes it the usual way to pair an allocation with its release. [Chapter 7](ch07-00-destructors.md) shows how Vidar can do that pairing for you.

## Control Flow

There is one loop keyword, `for`:

```vidar
main :: proc() {
	for i := 0; i < 3; i += 1 do fmt.print(i, "")
	fmt.println()

	for i in 0..<3 do fmt.print(i, "")      // a half-open range
	fmt.println()

	names := []string{"ada", "bob"}
	for name, i in names do fmt.print(i, name, "")
	fmt.println()

	n := 10
	for n > 1 do n /= 2                      // a while loop
	fmt.println(n)

	switch n {
	case 0:    fmt.println("zero")
	case 1, 2: fmt.println("small")
	case:      fmt.println("other")         // the default case
	}
}
```

```output
0 1 2
0 1 2
0 ada 1 bob
1
small
```

A `switch` case doesn't fall through to the next one unless it says `fallthrough`.

## Errors Are Values

Odin has no exceptions. A procedure that can fail returns its error, or a `bool`, as its last result. `or_return` returns early when that last result is a failure:

```vidar
Error :: enum { None, Negative }

check :: proc(n: int) -> (int, Error) {
	if n < 0 do return 0, .Negative
	return n, .None
}

double_checked :: proc(n: int) -> (result: int, err: Error) {
	v := check(n) or_return       // on .Negative, return it
	return v * 2, .None
}

main :: proc() {
	fmt.println(double_checked(4))
	fmt.println(double_checked(-1))
}
```

```output
8 None
0 Negative
```

With more than one result, `or_return` needs the results to be named, so it knows what to return alongside the error. `or_else` gives a default instead, and `or_break` and `or_continue` leave a loop. [Chapter 6](ch06-00-error-handling.md) builds on these.

## Polymorphic Procedures

A parameter whose type is written `$T` makes the procedure *polymorphic*: Odin makes a copy for each type it is called with.

```vidar
largest :: proc(xs: []$T) -> T {
	best := xs[0]
	for x in xs do if x > best do best = x
	return best
}

main :: proc() {
	fmt.println(largest([]int{3, 9, 2}))
	fmt.println(largest([]f64{1.5, 0.5}))
}
```

```output
9
1.5
```

Structs can take parameters too: `Box :: struct($T: typeid) { value: T }` declares a type you use as `Box(int)`.

A *proc group* is a set of procedures under one name; a call picks the one whose parameters fit:

```vidar
show_int :: proc(x: int) { fmt.println("int", x) }
show_str :: proc(s: string) { fmt.println("string", s) }
show :: proc{show_int, show_str}

main :: proc() {
	show(1)
	show("one")
}
```

```output
int 1
string one
```

## The Context and Allocators

Every Odin procedure receives an implicit `context`, which holds, among other things, the allocator that `make`, `new` and `append` use. Assigning to a field of `context` changes it for the rest of the scope and for everything called from there. `context.temp_allocator` is an arena for short-lived memory that you free all at once:

```vidar
main :: proc() {
	s := fmt.tprintf("%d-%d", 1, 2)             // allocated from context.temp_allocator
	fmt.println(s)
	free_all(context.temp_allocator)
}
```

```output
1-2
```

## Packages

A directory is a package, and `import` brings in another one. `core:` packages come with Odin; a relative path such as `import "../util"` imports one of yours. Names declared in a package are visible to other packages unless they're marked `@(private)`. A file can import a package under another name: `import str "core:strings"`.

## What's Next

That's enough Odin to read the rest of this book. The next section lists what Vidar adds to it and changes about it.
