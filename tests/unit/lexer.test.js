const { test } = require("node:test");
const assert = require("node:assert/strict");
const { lex } = require("../../dist/lexer.js");

const kinds = (src) => lex(src, "t").map((t) => (t.kind === "semi" ? (t.text ? ";" : "\\n") : t.text)).filter((x) => x !== "");

test("inserts semicolons after identifiers, literals and closing brackets at line ends", () => {
  assert.deepEqual(kinds("x := 1\ny := f(x)\n"), ["x", ":=", "1", "\\n", "y", ":=", "f", "(", "x", ")", "\\n"]);
});

test("no semicolon inside parentheses or brackets", () => {
  assert.deepEqual(kinds("f(a,\n  b)\n"), ["f", "(", "a", ",", "b", ")", "\\n"]);
  // inside braces newlines can end statements, but not after a comma; only the closing brace ends one here
  assert.deepEqual(kinds("x := [2]int{\n1,\n2,\n}\n").filter((t) => t === "\\n").length, 1);
});

test("semicolon after return, break, continue and diverging results", () => {
  assert.deepEqual(kinds("return\n"), ["return", "\\n"]);
  assert.deepEqual(kinds("f :: proc() -> !\n").slice(-2), ["!", "\\n"]);
});

test("block comment containing a newline ends the statement", () => {
  assert.deepEqual(kinds("x := 1 /* a\nb */ y := 2"), ["x", ":=", "1", "\\n", "y", ":=", "2", "\\n"]);
});

test("trailing backslash continues the line", () => {
  assert.deepEqual(kinds("x := 1 + \\\n 2\n"), ["x", ":=", "1", "+", "2", "\\n"]);
});

test("numbers: ranges are not floats, imaginary suffixes, separators", () => {
  const toks = lex("0..<10 1.5e3 2i 1_000 0xFF", "t").filter((t) => t.kind !== "semi" && t.kind !== "eof");
  assert.deepEqual(toks.map((t) => [t.kind, t.text]), [["int", "0"], ["op", "..<"], ["int", "10"], ["float", "1.5e3"], ["imag", "2i"], ["int", "1_000"], ["int", "0xFF"]]);
});

test("keeps whitespace and comments as token trivia", () => {
  const toks = lex("// head\nx := 1 // tail\n", "t");
  assert.equal(toks[0].pre, "// head\n");
  assert.equal(toks.at(-1).pre, " // tail\n");
});

test("directives, raw strings and runes", () => {
  const toks = lex("#partial switch `raw\\n` '\\''", "t").filter((t) => t.kind !== "semi" && t.kind !== "eof");
  assert.deepEqual(toks.map((t) => t.kind), ["directive", "kw", "string", "rune"]);
});

test("reports unterminated literals with a position", () => {
  assert.throws(() => lex('x := "abc\n', "t"), /unterminated literal/);
  assert.throws(() => lex("/* never closed", "t"), /unterminated block comment/);
});
