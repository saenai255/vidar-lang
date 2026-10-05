const { test } = require("node:test");
const assert = require("node:assert/strict");
const { lex } = require("../../dist/lexer.js");
const { respace } = require("../../dist/comptime.js");
const { transpile } = require("../../dist/project.js");

const main = (src) => [...transpile([{ path: "/tmp/m.vidar", text: src }]).values()][0];

test("respace gives generated tokens conventional spacing", () => {
  const toks = lex("if!(a.b[0]+f(x,-y)){p^=&q}", "t").filter((t) => t.kind !== "eof").map((t) => ({ ...t, pre: " " }));
  const text = respace(toks).map((t) => t.pre + t.text).join("");
  assert.equal(text, "if !(a.b[0] + f(x, -y)) { p^ = &q }");
});

test("comptime folding: arithmetic, strings, loops, switch and recursion", () => {
  const out = main(`package m
fact :: comptime proc(n: int) -> int { return 1 if n <= 1 else n * fact(n - 1) }
label :: comptime proc(n: int) -> string {
	switch n {
	case 0: return "zero"
	case 1, 2: return "small"
	}
	return "big"
}
sum :: comptime proc(n: int) -> int {
	s := 0
	for i in 1..=n do s += i
	return s
}
hex :: comptime proc() -> int { return 0xff & 0x0f | 1 << 4 }
main :: proc() { _ = fact!(10); _ = label!(2); _ = sum!(100); _ = hex!() }
`);
  assert.match(out, /_ = 3628800; _ = "small"; _ = 5050; _ = 31/);
});

test("comptime procs can read file-level constants and call regular procs", () => {
  const out = main(`package m
N :: 6
double :: proc(x: int) -> int { return x * 2 }
calc :: comptime proc() -> int { return double(N) + 1 }
main :: proc() { _ = calc!() }
`);
  assert.match(out, /_ = 13/);
});

test("negative and float results are emitted as valid literals", () => {
  const out = main(`package m
neg :: comptime proc() -> int { return 3 - 10 }
half :: comptime proc() -> f64 { return 1.0 / 4.0 }
whole :: comptime proc() -> f64 { return f64(2) }
main :: proc() { _ = neg!(); _ = half!(); _ = whole!() }
`);
  assert.match(out, /_ = \(-7\); _ = 0\.25; _ = 2\.0/);
});

test("hygiene renames only names the quote declares", () => {
  const out = main(`package m
twice :: comptime proc(body: Stmt) -> Stmt {
	return quote { for i in 0..<2 { tmp := i; $body } }
}
main :: proc() { tmp, i := 0, 5; twice!({ tmp += i }) }
`);
  assert.match(out, /for i__1 in 0\.\.<2 \{ tmp__2 := i__1; \{ tmp \+= i \} \}/);
});

test("Ident parameters and $$ escape", () => {
  const out = main(`package m
make_id :: comptime proc(name: Ident) -> Stmt {
	return quote { $name :: proc(x: $$T) -> T { return x } }
}
main :: proc() { make_id!(ident_fn); _ = ident_fn(3) }
`);
  assert.match(out, /ident_fn :: proc\(x: \$T\) -> T \{ return x \}/);
});

test("the step limit stops runaway compile-time loops", () => {
  assert.throws(() => main(`package m
spin :: comptime proc() -> int { for {} ; return 0 }
main :: proc() { _ = spin!() }
`), /step limit/);
});

test("block macros: name! { ... } passes the block as a single Stmt argument", () => {
  const out = main(`package m
twice :: comptime proc(body: Stmt) -> Stmt { return quote { $body; $body } }
main :: proc() {
	n := 0
	twice! { n += 1 }
	_ = n
}
`);
  assert.match(out, /\{ n \+= 1 \}; \{ n \+= 1 \}/);
});

test("macro expansions keep the line count of the call, so later lines still match", () => {
  const src = `package m
wrap :: comptime proc(body: Stmt) -> Stmt { return quote { { x := 1; $body } } }
main :: proc() {
	wrap! {
		a := 1
		b := 2
		_ = a + b
	}
	marker := 0
}
`;
  const out = main(src);
  const line = (text, needle) => text.split("\n").findIndex((l) => l.includes(needle));
  assert.equal(line(out, "b := 2"), line(src, "b := 2"));
  assert.equal(line(out, "marker := 0"), line(src, "marker := 0"));
});

test("built-in scoped! needs no definition or import, and takes an optional allocator", () => {
  const out = main(`package m
main :: proc() {
	scoped! { _ = 1 }
	scoped!(context.allocator) { _ = 2 }
}
`);
  assert.match(out, /^package m; import __vidar "vidar_runtime"/);
  assert.match(out, /temp_arena_begin\(&arena__1, context\.allocator\)[^\n]*\{ _ = 1 \}/);
  assert.match(out, /temp_arena_begin\(&arena__2, context\.allocator\)[^\n]*\{ _ = 2 \}/);
});

test("a user declaration shadows a built-in macro", () => {
  const out = main(`package m
scoped :: comptime proc(body: Stmt) -> Stmt { return quote { $body; $body } }
main :: proc() { n := 0; scoped! { n += 1 } }
`);
  assert.match(out, /\{ n \+= 1 \}; \{ n \+= 1 \}/);
  assert.doesNotMatch(out, /temp_arena/);
});

test("macro parameters can have defaults; a trailing block binds to the last parameter", () => {
  const out = main(`package m
repeat :: comptime proc(times: int = 2, sep: Expr = "-", body: Stmt) -> Stmt {
	out: [dynamic]Stmt
	for _ in 0..<times do append(&out, body)
	return quote { $out }
}
main :: proc() {
	n := 0
	repeat! { n += 1 }
	repeat!(3) { n += 10 }
}
`);
  assert.match(out, /\{ n \+= 1 \}; \{ n \+= 1 \}\n/);
  assert.match(out, /\{ n \+= 10 \}; \{ n \+= 10 \}; \{ n \+= 10 \}/);
});

test("macro argument count errors mention defaults", () => {
  const src = (call) => `package m
m :: comptime proc(a: int, b: int = 1) -> int { return a + b }
main :: proc() { _ = ${call} }
`;
  assert.equal(main(src("m!(1)")).includes("_ = 2"), true);
  assert.throws(() => main(src("m!()")), /expects at least 1 argument\(s\) but got 0 \(missing 'a'\)/);
  assert.throws(() => main(src("m!(1, 2, 3)")), /expects at most 2 argument\(s\) but got 3/);
});

test("format! builds a tprintf format and arguments", () => {
  const out = main(`package m
main :: proc() {
	name := "x"
	n := 3.14159
	_ = format!("hi {name}, {n:.2f}, {{lit}} 100% {name + \\"!\\"}")
}
`);
  assert.match(out, /__vidar\.tprintf\("hi %v, %\.2f, \{\{lit\}\} 100%% %v", name, n, \(name \+ "!"\)\)/);
});

test("format! rejects malformed templates at compile time", () => {
  const src = (t) => `package m\nmain :: proc() { _ = format!(${JSON.stringify(t)}) }\n`;
  assert.throws(() => main(src("open {brace")), /unclosed '\{'/);
  assert.throws(() => main(src("close } brace")), /unmatched '\}'/);
  assert.throws(() => main(src("empty {}")), /empty '\{\}'/);
  assert.throws(() => main(src("bad {1 +}")), /'1 \+' is not a valid expression/);
});

test("check! evaluates operands once and types literals after the other side", () => {
  const out = main(`package m
next :: proc() -> int { return 1 }
main :: proc() {
	x: f32 = 2
	check!(next() == 1)
	check!(1.5 < x, "x too small")
	check!(x > 0 && x < 10)
}
`);
  assert.match(out, /__check_lhs := next\(\); __check_rhs: type_of\(__check_lhs\) = 1/);
  assert.match(out, /__check_rhs := x; __check_lhs: type_of\(__check_rhs\) = 1\.5/);
  assert.match(out, /if !\(\(x > 0 && x < 10\)\) \{ __vidar\.check_failed\("x > 0 && x < 10", ""\) \}/);
});

test("dbg! keeps the value and reports the source line", () => {
  const out = main(`package m
main :: proc() {
	y := dbg!(1 + 2) * 2
}
`);
  assert.match(out, /y := __vidar\.dbg\(\(1 \+ 2\), "1 \+ 2", "m\.vidar:3"\) \* 2/);
});

test("block built-ins expand to plain blocks", () => {
  const out = main(`package m
import "core:sync"
main :: proc() {
	m: sync.Mutex
	locked!(&m) { _ = 1 }
	with_allocator!(context.allocator) { _ = 2 }
	timed! { _ = 3 }
}
`);
  assert.match(out, /m__\d+ := \(&m\); __vidar\.lock\(m__\d+\); defer __vidar\.unlock\(m__\d+\); \{ _ = 1 \}/);
  assert.match(out, /\{ context\.allocator = context\.allocator; \{ _ = 2 \}; \}/);
  assert.match(out, /__vidar\.timer_report\("", "m\.vidar:7", start__\d+\)/);
});
