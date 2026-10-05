/**
 * The built-in library: macros available in every file without an import. It is written in
 * Vidar itself; user declarations with the same names shadow these. Expansions call helpers in
 * the generated `vidar_runtime` package (spelled `__vidar` in generated code), so using them
 * needs no imports.
 */
export const PRELUDE_PATH = "<vidar prelude>";

export const PRELUDE_SOURCE = String.raw`package vidar_prelude

// scoped! { ... } gives the block its own temp allocator and frees it when the block ends.
// scoped!(allocator) { ... } takes the arena's memory from ${"`"}allocator${"`"} instead of context.allocator.
scoped :: comptime proc(allocator: Expr = context.allocator, body: Stmt) -> Stmt {
	return quote {
		{
			arena: __vidar.Temp_Arena
			context.temp_allocator = __vidar.temp_arena_begin(&arena, $allocator)
			defer __vidar.temp_arena_end(&arena)
			$body
		}
	}
}

// with_allocator!(a) { ... } makes ${"`"}a${"`"} the block's context.allocator.
with_allocator :: comptime proc(allocator: Expr, body: Stmt) -> Stmt {
	return quote {
		{
			context.allocator = $allocator
			$body
		}
	}
}

// locked!(&mutex) { ... } holds the lock for the block and releases it on every exit.
locked :: comptime proc(mutex: Expr, body: Stmt) -> Stmt {
	return quote {
		{
			m := $mutex
			__vidar.lock(m)
			defer __vidar.unlock(m)
			$body
		}
	}
}

// timed!("label") { ... } prints how long the block took (to stderr). The label defaults to the call site.
timed :: comptime proc(label: Expr = "", body: Stmt) -> Stmt {
	site := call_site()
	return quote {
		{
			start := __vidar.timer_start()
			defer __vidar.timer_report($label, $site, start)
			$body
		}
	}
}

// dbg!(expr) prints "file:line: expr = value" (to stderr) and evaluates to the value.
dbg :: comptime proc(value: Expr) -> Expr {
	return quote(__vidar.dbg($value, $(stringify(value)), $(call_site())))
}

// check!(cond) panics when cond is false, showing the expression; for comparisons it also
// shows both operands. check!(cond, "message") adds a message.
check :: comptime proc(cond: Expr, message: Expr = "") -> Stmt {
	text := stringify(cond)
	parts := split_comparison(cond)
	if len(parts) == 0 {
		return quote {
			if !($cond) { __vidar.check_failed($text, $message) }
		}
	}
	lhs := parts[0]
	rhs := parts[2]
	l := ident("__check_lhs")
	r := ident("__check_rhs")
	// each operand is evaluated once; a literal takes the other side's type
	decl := quote { $l := $lhs; $r: type_of($l) = $rhs }
	if is_literal(lhs) {
		decl = quote { $r := $rhs; $l: type_of($r) = $lhs }
	}
	cmp: Expr
	switch parts[1] {
	case "==": cmp = quote($l == $r)
	case "!=": cmp = quote($l != $r)
	case "<":  cmp = quote($l < $r)
	case ">":  cmp = quote($l > $r)
	case "<=": cmp = quote($l <= $r)
	case ">=": cmp = quote($l >= $r)
	}
	// literal operands are already visible in the expression, so they aren't repeated
	lhs_text := "" if is_literal(lhs) else stringify(lhs)
	rhs_text := "" if is_literal(rhs) else stringify(rhs)
	return quote {
		{
			$decl
			if !$cmp { __vidar.check_failed_cmp($text, $message, $lhs_text, $l, $rhs_text, $r) }
		}
	}
}

// todo!() / todo!("message"): panic in code that isn't written yet.
todo :: comptime proc(message: Expr = "") -> Expr {
	return quote(__vidar.not_done("not yet implemented", $message))
}

// unimplemented!() / unimplemented!("message"): panic in code that is deliberately not supported.
unimplemented :: comptime proc(message: Expr = "") -> Expr {
	return quote(__vidar.not_done("not implemented", $message))
}

// format!("hi {name}, pi is {x:.2f}") -> a temp-allocated string, like fmt.tprintf.
// {expr} prints with %v; {expr:spec} uses %spec (e.g. .2f, 5d, x, q); {{ and }} are literal braces.
format :: comptime proc(template: string) -> Expr {
	out := ""
	args: [dynamic]Expr
	i := 0
	n := len(template)
	for i < n {
		c := template[i]
		if c == '{' && i + 1 < n && template[i + 1] == '{' {
			out += "{{"
			i += 2
			continue
		}
		if c == '}' && i + 1 < n && template[i + 1] == '}' {
			out += "}}"
			i += 2
			continue
		}
		if c == '}' {
			compile_error("format!: unmatched '}' (write '}}' for a literal brace)")
		}
		if c == '%' {
			out += "%%"
			i += 1
			continue
		}
		if c != '{' {
			out += template[i:i + 1]
			i += 1
			continue
		}
		// a hole: {expr} or {expr:spec}, where the spec starts at the first ':' outside brackets
		j := i + 1
		depth := 0
		colon := -1
		for j < n {
			d := template[j]
			if d == '(' || d == '[' || d == '{' do depth += 1
			if d == ')' || d == ']' do depth -= 1
			if d == '}' {
				if depth == 0 do break
				depth -= 1
			}
			if d == ':' && depth == 0 && colon < 0 do colon = j
			j += 1
		}
		if j >= n do compile_error("format!: unclosed '{' (write '{{' for a literal brace)")
		expr_end := colon if colon >= 0 else j
		expr := template[i + 1:expr_end]
		spec := "v"
		if colon >= 0 do spec = template[colon + 1:j]
		if len(expr) == 0 do compile_error("format!: empty '{}'")
		append(&args, parse_expr(expr))
		out += "%" + spec
		i = j + 1
	}
	if len(args) == 0 do return quote(__vidar.tprintf($out))
	return quote(__vidar.tprintf($out, $args))
}
`;
