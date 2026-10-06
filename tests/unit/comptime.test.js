const { test } = require("node:test");
const assert = require("node:assert/strict");
const { lex } = require("../../dist/lexer.js");
const { respace } = require("../../dist/comptime.js");
const { emitProgram, loadProgram, transpile } = require("../../dist/project.js");

const main = (src) => [...transpile([{ path: "/tmp/m.vidar", text: src }]).values()][0];
/** The generated code without comments, on one line. */
const flat = (src) => main(src).split("\n").map((l) => l.replace(/\/\/.*$/, "").trim()).filter(Boolean).join(" ");

test("respace gives generated tokens conventional spacing", () => {
  const toks = lex("if!(a.b[0]+f(x,-y)){p^=&q}", "t").filter((t) => t.kind !== "eof").map((t) => ({ ...t, pre: " " }));
  const text = respace(toks).map((t) => t.pre + t.text).join("");
  assert.equal(text, "if !(a.b[0] + f(x, -y)) { p^ = &q }");
});

test("comptime folding: arithmetic, strings, loops, switch and recursion", () => {
  const out = flat(`package m
fact :: proc!(n: int) -> int { return 1 if n <= 1 else n * fact(n - 1) }
label :: proc!(n: int) -> string {
	switch n {
	case 0: return "zero"
	case 1, 2: return "small"
	}
	return "big"
}
sum :: proc!(n: int) -> int {
	s := 0
	for i in 1..=n do s += i
	return s
}
hex :: proc!() -> int { return 0xff & 0x0f | 1 << 4 }
main :: proc() { _ = fact!(10); _ = label!(2); _ = sum!(100); _ = hex!() }
`);
  assert.match(out, /_ = 3628800; _ = "small"; _ = 5050; _ = 31/);
});

test("comptime procs can read file-level constants and call regular procs", () => {
  const out = main(`package m
N :: 6
double :: proc(x: int) -> int { return x * 2 }
calc :: proc!() -> int { return double(N) + 1 }
main :: proc() { _ = calc!() }
`);
  assert.match(out, /_ = 13/);
});

test("negative and float results are emitted as valid literals", () => {
  const out = flat(`package m
neg :: proc!() -> int { return 3 - 10 }
half :: proc!() -> f64 { return 1.0 / 4.0 }
whole :: proc!() -> f64 { return f64(2) }
main :: proc() { _ = neg!(); _ = half!(); _ = whole!() }
`);
  assert.match(out, /_ = -7; _ = 0\.25; _ = 2\.0/);
});

test("hygiene renames only names the quote declares", () => {
  const out = flat(`package m
twice :: proc!(body: Stmt) -> Stmt {
	return quote { for i in 0..<2 { tmp := i; $body } }
}
main :: proc() { tmp, i := 0, 5; twice!({ tmp += i }) }
`);
  assert.match(out, /for i__1 in 0\.\.<2 \{ tmp__2 := i__1 \{ tmp \+= i \} \}/);
});

test("Ident parameters and $$ escape", () => {
  const out = flat(`package m
make_id :: proc!(name: Ident) -> Stmt {
	return quote { $name :: proc(x: $$T) -> T { return x } }
}
main :: proc() { make_id!(ident_fn); _ = ident_fn(3) }
`);
  assert.match(out, /ident_fn :: proc\(x: \$T\) -> T \{ return x \}/);
  assert.match(main(`package m
make_id :: proc!(name: Ident) -> Stmt {
	return quote { $name :: proc(x: $$T) -> T { return x } }
}
main :: proc() {
	make_id!(ident_fn)
}
`), /\t\/\/ make_id!\(ident_fn\) — m\.vidar:6\n\tident_fn :: proc\(x: \$T\) -> T \{\n\t\treturn x\n\t\}\n/);
});

test("the step limit stops runaway compile-time loops", () => {
  assert.throws(() => main(`package m
spin :: proc!() -> int { for {} ; return 0 }
main :: proc() { _ = spin!() }
`), /step limit/);
});

test("block macros: name! { ... } passes the block as a single Stmt argument", () => {
  const out = flat(`package m
twice :: proc!(body: Stmt) -> Stmt { return quote { $body; $body } }
main :: proc() {
	n := 0
	twice! { n += 1 }
	_ = n
}
`);
  assert.match(out, /twice! \{ n \+= 1 \} — m\.vidar:5|\{ n \+= 1 \} \{ n \+= 1 \}/);
  assert.match(out, /\{ n \+= 1 \} \{ n \+= 1 \}/);
});

test("macro expansions get their own lines; the line map points them at the call", () => {
  const src = `package m
wrap :: proc!(body: Stmt) -> Stmt { return quote { { x := 1; $body } } }
main :: proc() {
	wrap! {
		a := 1
		b := 2
		_ = a + b
	}
	marker := 0
}
`;
  const out = emitProgram(loadProgram([{ path: "/tmp/m.vidar", text: src }], { followImports: false }));
  const text = out.files.get("m.odin");
  const lines = out.lineMap.get("m.odin");
  const at = (t, needle) => t.split("\n").findIndex((l) => l.includes(needle));
  assert.match(text, /\t\/\/ wrap! \{ \.\.\. \} — m\.vidar:4\n\t\{\n\t\tx__1 := 1\n\t\t\{\n\t\t\ta := 1\n/);
  assert.equal(lines[at(text, "b := 2")], at(src, "b := 2") + 1);
  assert.equal(lines[at(text, "x__1 := 1")], -(at(src, "wrap!") + 1));
  assert.equal(lines[at(text, "marker := 0")], at(src, "marker := 0") + 1);
});

test("built-in scoped! needs no definition or import, and takes an optional allocator", () => {
  const out = main(`package m
main :: proc() {
	scoped! { _ = 1 }
	scoped!(context.allocator) { _ = 2 }
}
`);
  assert.match(out, /^package m; import __vidar "vidar_runtime"/);
  assert.match(out, /temp_arena_begin\(&arena__1, context\.allocator\)\n\t\tdefer __vidar\.temp_arena_end\(&arena__1\)\n\t\t\{\n\t\t\t_ = 1\n/);
  assert.match(out, /temp_arena_begin\(&arena__2, context\.allocator\)\n[^]*_ = 2/);
});

test("a user declaration shadows a built-in macro", () => {
  const out = flat(`package m
scoped :: proc!(body: Stmt) -> Stmt { return quote { $body; $body } }
main :: proc() { n := 0; scoped! { n += 1 } }
`);
  assert.match(out, /\{ n \+= 1 \} \{ n \+= 1 \}/);
  assert.doesNotMatch(out, /temp_arena/);
});

test("macro parameters can have defaults; a trailing block binds to the last parameter", () => {
  const out = flat(`package m
repeat :: proc!(times: int = 2, sep: Expr = "-", body: Stmt) -> Stmt {
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
  assert.match(out, /n := 0 \{ n \+= 1 \} \{ n \+= 1 \} \{ n \+= 10 \} \{ n \+= 10 \} \{ n \+= 10 \} \}/);
});

test("macro argument count errors mention defaults", () => {
  const src = (call) => `package m
m :: proc!(a: int, b: int = 1) -> int { return a + b }
main :: proc() { _ = ${call} }
`;
  assert.equal(main(src("m!(1)")).includes("_ = 2"), true);
  assert.throws(() => main(src("m!()")), /expects at least 1 argument\(s\) but got 0 \(missing 'a'\)/);
  assert.throws(() => main(src("m!(1, 2, 3)")), /expects at most 2 argument\(s\) but got 3/);
});

test("compile-time integers have run-time width and wrap-around", () => {
  const out = main(`package m
sq32 :: proc(x: i32) -> i32 { return x * x }
fib :: proc(n: int) -> int {
	a, b := 0, 1
	for _ in 0..<n do a, b = b, a + b
	return a
}
main :: proc() {
	a := comptime! { 1 << 40 }
	b := fib!(90)
	c := sq32!(100000)
	d := comptime! { u8(255) + 1 }
	e := comptime! { -7 / 2 }
	f := comptime! { -7 %% 3 }
}
`);
  assert.match(out, /a := 1099511627776/);
  assert.match(out, /b := 2880067194370816120/);
  assert.match(out, /c := i32\(1410065408\)/);
  assert.match(out, /d := u8\(0\)/);
  assert.match(out, /e := -3/);
  assert.match(out, /f := 2/);
});

test("name!(...) runs any proc at compile time; comptime! { } folds a block", () => {
  const out = main(`package m
import "core:fmt"
N :: 4
double :: proc(x: int) -> int { return x * 2 }
main :: proc() {
	a := double!(N)
	b := fmt.tprintf!("n=%d", N)
	c := comptime! { double(N) + double!(1) }
	d := comptime! {
		s := 0
		for i in 0..<N do s += do! { take i * i }
		take s
	}
}
`);
  assert.match(out, /a := 8\n\t\/\/ fmt\.tprintf!\("n=%d", N\) — m\.vidar:7\n\tb := "n=4"/);
  assert.match(out, /c := 10/);
  assert.match(out, /d := 14/);
});

test("check! evaluates operands once and types literals after the other side", () => {
  const out = flat(`package m
next :: proc() -> int { return 1 }
main :: proc() {
	x: f32 = 2
	check!(next() == 1)
	check!(1.5 < x, "x too small")
	check!(x > 0 && x < 10)
}
`);
  assert.match(out, /__check_lhs := next\(\) __check_rhs: type_of\(__check_lhs\) = 1/);
  assert.match(out, /__check_rhs := x __check_lhs: type_of\(__check_rhs\) = 1\.5/);
  assert.match(out, /if !\(x > 0 && x < 10\) \{ __vidar\.check_failed\("x > 0 && x < 10", ""\) \}/);
});

test("dbg! keeps the value and reports the source line", () => {
  const out = main(`package m
main :: proc() {
	y := dbg!(1 + 2) * 2
}
`);
  assert.match(out, /y := __vidar\.dbg\(1 \+ 2, "1 \+ 2", "m\.vidar:3"\) \* 2/);
});

test("block built-ins expand to plain blocks", () => {
  const out = flat(`package m
import "core:sync"
main :: proc() {
	m: sync.Mutex
	locked!(&m) { _ = 1 }
	with_allocator!(context.allocator) { _ = 2 }
	timed! { _ = 3 }
}
`);
  assert.match(out, /m__\d+ := &m __vidar\.lock\(m__\d+\) defer __vidar\.unlock\(m__\d+\) \{ _ = 1 \}/);
  assert.match(out, /\{ context\.allocator = context\.allocator \{ _ = 2 \} \}/);
  assert.match(out, /__vidar\.timer_report\("", "m\.vidar:7", start__\d+\)/);
});
