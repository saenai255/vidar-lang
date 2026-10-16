## Rc

```vidar
import "vidar:rc"

main :: proc() {
	a := rc.new([]int{1, 2, 3})
	b := a                          // a second owner
	rc.get(b)[0] = 10
	fmt.println(rc.get(a)^, rc.count(a))
}
```

```output
[10, 2, 3] 2
```

See [Shared Values with `vidar:rc`](ch07-05-rc.md).

## Weak

```vidar
import "vidar:rc"

main :: proc() {
	w: rc.Weak(int)
	{
		r := rc.new(42)
		w = rc.downgrade(r)
		fmt.println(rc.alive(w))
	}                               // the last Rc is gone
	fmt.println(rc.alive(w))
}
```

```output
true
false
```

## new

```vidar
import "vidar:rc"

Name :: struct { text: string }

name_destroy :: proc(n: ^Name) {
	if n.text != "" do fmt.println("dropping", n.text)
}

impl Destroy for Name { destroy = name_destroy }

main :: proc() {
	n := Name{"shared"}
	r := rc.new(move!(n))           // rc.new takes the value over
	fmt.println(rc.get(r).text)
}
```

```output
shared
dropping shared
```

## get

```vidar
import "vidar:rc"

main :: proc() {
	r := rc.new(1)
	rc.get(r)^ += 1
	fmt.println(rc.get(r)^)
	empty: rc.Rc(int)
	fmt.println(rc.get(empty) == nil)
}
```

```output
2
true
```

## count

```vidar
import "vidar:rc"

main :: proc() {
	a := rc.new("x")
	fmt.println(rc.count(a))
	{
		b := a
		fmt.println(rc.count(a), rc.count(b))
	}
	fmt.println(rc.count(a))
}
```

```output
1
2 2
1
```

## downgrade

```vidar
import "vidar:rc"

main :: proc() {
	r := rc.new(5)
	w := rc.downgrade(r)
	fmt.println(rc.count(r), rc.alive(w))     // a Weak isn't an owner
}
```

```output
1 true
```

## upgrade

```vidar
import "vidar:rc"

main :: proc() {
	r := rc.new(5)
	w := rc.downgrade(r)
	s := rc.upgrade(w)              // the zero Rc if the value were gone
	if rc.get(s) != nil {
		fmt.println("still alive:", rc.get(s)^, rc.count(r))
	}
}
```

```output
still alive: 5 2
```

## alive

```vidar
import "vidar:rc"

main :: proc() {
	w: rc.Weak(string)
	fmt.println(rc.alive(w))         // the zero Weak refers to nothing
	r := rc.new("x")
	w = rc.downgrade(r)
	fmt.println(rc.alive(w))
}
```

```output
false
true
```

## share

What copying an `Rc` calls; programs don't call it themselves:

```vidar
import "vidar:rc"

main :: proc() {
	a := rc.new(1)
	b := a                 // b := rc.share(a)
	fmt.println(rc.count(a), rc.get(b)^)
}
```

```output
2 1
```

## release

What the end of an `Rc`'s scope calls; programs don't call it themselves:

```vidar
import "vidar:rc"

main :: proc() {
	a := rc.new(1)
	{
		b := a
		fmt.println(rc.count(a))
	}                      // rc.release(&b)
	fmt.println(rc.count(a))
}
```

```output
2
1
```

## weak_share

What copying a `Weak` calls; programs don't call it themselves:

```vidar
import "vidar:rc"

main :: proc() {
	r := rc.new(3)
	w1 := rc.downgrade(r)
	w2 := w1                // w2 := rc.weak_share(w1)
	fmt.println(rc.alive(w1), rc.alive(w2))
}
```

```output
true true
```

## weak_release

What the end of a `Weak`'s scope calls; programs don't call it themselves:

```vidar
import "vidar:rc"

main :: proc() {
	r := rc.new(3)
	{
		w := rc.downgrade(r)
		fmt.println(rc.alive(w))
	}                       // rc.weak_release(&w)
	fmt.println(rc.count(r))
}
```

```output
true
1
```
