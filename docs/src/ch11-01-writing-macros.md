# Writing Macros

A macro is declared like a procedure, with a `!` after `proc`, and called with a `!` after its name:

```vidar
square :: proc!(x: Expr) -> Expr {
	return quote($x * $x)
}

main :: proc() {
	k := 7
	fmt.println(square!(k + 1))
}
```

<span class="caption">Listing 11-1: A macro that squares an expression</span>

```output
64
```

Three things make this different from a procedure:

- **The parameter is code.** `x: Expr` receives the *expression* `k + 1`, not its value. A macro runs while compiling, when `k` has no value yet.
- **`quote(...)` builds code.** `quote($x * $x)` is the code `$x * $x`, with the argument spliced in where it says `$x`.
- **The result replaces the call.** `square!(k + 1)` becomes `((k + 1) * (k + 1))` in the generated Odin. The argument is spliced as a unit, so its parentheses are kept.

## Statement Macros

A macro that returns `Stmt` produces statements. `quote { ... }` quotes a block of them:

```vidar
swap :: proc!(a, b: Expr) -> Stmt {
	return quote {
		tmp := $a
		$a = $b
		$b = tmp
	}
}

main :: proc() {
	tmp, other := 1, 2
	swap!(tmp, other)
	fmt.println(tmp, other)
}
```

<span class="caption">Listing 11-2: A statement macro, and hygiene</span>

```output
2 1
```

A `Stmt` macro can only be called where a statement can go.

## Hygiene

Look at Listing 11-2 again: the macro declares `tmp`, and the caller swaps a variable that's also called `tmp`. That works because names a quote *declares* are renamed in each expansion (to `tmp__1`, say), so they can't clash with the caller's names. This is called *hygiene*. Code you splice in, like `$a`, is never renamed: it means what it meant at the call.

To declare a name in the caller's scope on purpose, take it as an `Ident` parameter, which is spliced as written; see the [next section](ch11-02-macro-parameters.md#ident-names-the-caller-chooses).

## Splicing

Inside a quote:

| Syntax | Splices |
|---|---|
| `$name` | a compile-time value: code, a number, a string, an `Ident`, or a `[dynamic]Stmt` (every statement in it) |
| `$(expr)` | the result of a compile-time expression |
| `$$` | a literal `$`, for generating polymorphic procedures |

A macro's body is ordinary code that runs at compile time, so it can compute what to splice. This one builds a list of statements in a loop:

```vidar
repeat :: proc!(n: int, body: Stmt) -> Stmt {
	out: [dynamic]Stmt
	for _ in 0..<n do append(&out, body)
	return quote { $out }
}

main :: proc() {
	total := 0
	repeat!(4) { total += 10 }
	fmt.println(total)
}
```

<span class="caption">Listing 11-3: Building statements in a loop</span>

```output
40
```

## Trailing Blocks

`repeat!(4) { total += 10 }` passes the block after the call as the last argument. A macro whose last parameter is a `Stmt` can always take it that way, and with no other arguments the parentheses can go too: `repeat! { ... }`, if `n` had a default. That's what makes macros like `scoped! { ... }` read like built-in statements.

## Calling Macros from Other Packages

Macros are declarations like any other: `pkg.name!(...)` calls one from another package, and `@(private)` hides one.

## What Gets Generated

An expansion is written out as ordinary Odin, one statement per line, under a comment that names the call. The macro itself becomes a one-line comment. For Listing 11-2, `vidar emit` shows:

```odin
// swap :: proc!(a, b: Expr) -> Stmt — comptime, main.vidar:1
...
	tmp, other := 1, 2
	// swap!(tmp, other) — main.vidar:12
	tmp__1 := tmp
	tmp = other
	other = tmp__1
```

Errors that Odin reports in an expansion, and panics in it, are reported at the macro call, or at the line of the code that was passed into it. In the editor, hovering a macro call shows its expansion.
