const { test } = require("node:test");
const assert = require("node:assert/strict");
const { patch } = require("../../dist/lsp/odin.js");

const src = "package m\na := 1\nf := proc[a]() {}\nb := 2";
const out = "package m\na := 1\nf := __closure_0(a)\nb := 2\n\n__closure_0 :: proc() {}";

test("patch keeps generated text around an edit", () => {
  const edited = src.replace("b := 2", "b := 2\nfmt.");
  assert.equal(patch(src, out, edited), "package m\na := 1\nf := __closure_0(a)\nb := 2\nfmt.\n\n__closure_0 :: proc() {}");
});

test("patch takes edited lines from the current source", () => {
  const edited = src.replace("f := proc[a]() {}", "f := proc[a]() { x }");
  assert.equal(patch(src, out, edited).split("\n")[2], "f := proc[a]() { x }");
});

test("patch of an unchanged source is the old output", () => {
  assert.equal(patch(src, out, src), out);
});
