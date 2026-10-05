const { test } = require("node:test");
const assert = require("node:assert/strict");
const { lex } = require("../../dist/lexer.js");
const { Parser } = require("../../dist/parser.js");
const { transpile } = require("../../dist/project.js");

const parse = (src) => new Parser(lex(src, "t.vidar")).parseFile("t.vidar");
const roundTrip = (src) => [...transpile([{ path: "/tmp/t.vidar", text: src }]).values()][0];

test("plain Odin snippets round-trip byte-for-byte", () => {
  const snippets = [
    "package p\n\nx :: 1 // c\n",
    "package p\nV :: struct #packed { a, b: f32 `tag`, using base: Base }\nBase :: struct {}\n",
    "package p\nE :: enum u8 { A, B = 4, C }\nS :: bit_set[E; u16]\n",
    "package p\nf :: proc(x: $T, args: ..int) -> (r: T, ok: bool) where size_of(T) > 1 {\n\treturn x, true\n}\n",
    "package p\nm :: proc() {\n\tlabel: for i in 0..<3 {\n\t\tswitch i {\n\t\tcase 0: continue label\n\t\tcase: break label\n\t\t}\n\t}\n}\n",
    "package p\nm :: proc() -> int {\n\tx := 3 if true else 4\n\ty := x when ODIN_DEBUG else 0\n\tdefer x += 1\n\treturn x\n}\n",
    "package p\ng :: proc{a, b}\na :: proc(x: int) {}\nb :: proc(x: f32) {}\n",
    "package p\nm :: proc(p: ^[4]int) {\n\t#no_bounds_check p[0] = p^[1]\n\tfor &v in p do v += 1\n}\n",
    "package p\nU :: union #no_nil { int, string }\nm :: proc(u: U) { if s, ok := u.(string); ok {} ; _ = u.? }\n",
    "package p\nimport \"core:fmt\"\n@(private=\"file\") m :: proc() { fmt.println(#procedure, #location()) }\n",
  ];
  for (const s of snippets) assert.equal(roundTrip(s), s, s);
});

test("parses the extension syntax into dedicated nodes", () => {
  const f = parse(`package p
I :: interface { m }
impl I for T { m = t_m }
T :: struct {}
c :: comptime proc(x: Expr) -> Expr { return quote($x) }
main :: proc() {
	n := 1
	f := proc[n, &n](y: int) -> int { return y }
	g: closure(int) -> int
	_ = c!(n)
}`);
  const kinds = f.stmts.map((s) => s.k);
  assert.deepEqual(kinds, ["Package", "ValueDecl", "ImplBlock", "ValueDecl", "ValueDecl", "ValueDecl"]);
  assert.equal(f.stmts[1].values[0].k, "InterfaceType");
  assert.deepEqual(f.stmts[1].values[0].methods.map((m) => m.name), ["m"]);
  assert.deepEqual(f.stmts[2].bindings.map((b) => [b.name, b.value.name]), [["m", "t_m"]]);
  assert.equal(f.stmts[4].values[0].comptime, true);
  const body = f.stmts[5].values[0].body.stmts;
  assert.deepEqual(body[1].values[0].captures.map((c) => [c.name, c.byRef]), [["n", false], ["n", true]]);
  assert.equal(body[2].type.k, "ClosureType");
  assert.equal(body[3].rhs[0].k, "MacroCall");
});

test("extension keywords stay usable as identifiers", () => {
  const src = "package p\nm :: proc() {\n\tclosure := 1\n\tinterface := closure + 1\n\timpl, comptime, quote := 1, 2, 3\n\t_ = interface + impl + comptime + quote\n}\n";
  assert.equal(roundTrip(src), src);
});

test("tolerant parsing skips a broken declaration and keeps the rest", () => {
  const errors = [];
  const f = new Parser(lex("package p\nbroken :: proc( {\n}\ngood :: proc() {}\n", "t")).parseFile("t", errors);
  assert.equal(errors.length, 1);
  assert.ok(f.stmts.some((s) => s.k === "ValueDecl" && s.names[0].name === "good"));
});

test("macro arguments are kept as raw token lists split at top-level commas", () => {
  const f = parse("package p\nm :: proc() { x!(a, f(b, c), { d; e }) }\n");
  const call = f.stmts[1].values[0].body.stmts[0].x;
  assert.equal(call.args.length, 3);
  assert.equal(call.args[1].filter((t) => t.kind !== "eof").map((t) => t.text).join(""), "f(b,c)");
});

test("catch, errdefer and unreachable stay usable as plain identifiers", () => {
  const src = "package p\nm :: proc() {\n\tcatch := 1\n\terrdefer := catch + 1\n\tunreachable_count := errdefer\n\t_ = unreachable_count\n\tcatch = 3\n}\n";
  assert.equal(roundTrip(src), src);
});
