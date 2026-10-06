const { test } = require("node:test");
const assert = require("node:assert/strict");
const { patch } = require("../../dist/lsp/odin.js");

const src = "package m\na := 1\nf := proc[a]() {}\nb := 2";
const out = "package m\na := 1\nf := __closure_0(a)\nb := 2\n\n__closure_0 :: proc() {}";

test("patch keeps generated text around an edit", () => {
  const edited = src.replace("b := 2", "b := 2\nfmt.");
  assert.equal(patch(src, out, edited).text, "package m\na := 1\nf := __closure_0(a)\nb := 2\nfmt.\n\n__closure_0 :: proc() {}");
});

test("patch takes edited lines from the current source", () => {
  const edited = src.replace("f := proc[a]() {}", "f := proc[a]() { x }");
  assert.equal(patch(src, out, edited).text.split("\n")[2], "f := proc[a]() { x }");
});

test("patch of an unchanged source is the old output", () => {
  assert.equal(patch(src, out, src).text, out);
});

test("patch follows the line map of output with generated lines", () => {
  const source = "package m\nmain :: proc() {\n\tswap!(a, b)\n\tx := 1\n}";
  const output = "package m\nmain :: proc() {\n\t// swap!(a, b)\n\ttmp := a\n\ta = b\n\tb = tmp\n\tx := 1\n}";
  const lines = [1, 2, 3, -3, -3, -3, 4, 5];
  const edited = source.replace("x := 1", "x := 2\n\ty := 3");
  const r = patch(source, output, edited, lines);
  assert.equal(r.text, "package m\nmain :: proc() {\n\t// swap!(a, b)\n\ttmp := a\n\ta = b\n\tb = tmp\n\tx := 2\n\ty := 3\n}");
  assert.deepEqual(r.lines, [1, 2, 3, -3, -3, -3, 4, 5, 6]);
});
