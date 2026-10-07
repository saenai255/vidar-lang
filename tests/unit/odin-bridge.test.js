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

// ---- the column map: requests on lines vidar rewrites ----

const { columnAt, columnTarget } = require("../../dist/lsp/odin.js");
const { emitProgram, loadProgram } = require("../../dist/project.js");

const closureSrc = 'package m\n\nimport "core:fmt"\n\nmain :: proc() {\n\tcount := 0\n\tinc := proc[&count]() { count += 1; fmt.println(count) }\n\tinc()\n}\n';
const emitWithColumns = (text, columns = true) => {
  const out = emitProgram(loadProgram([{ path: "/src/m.vidar", text }], { followImports: false }), undefined, { columns });
  return { text: out.files.get("m.odin"), lines: out.lineMap.get("m.odin"), columns: out.columns?.get("m.odin") };
};
const at = (text, lineHas, needle) => {
  const lines = text.split("\n");
  const line = lines.findIndex((l) => l.includes(lineHas));
  return { line, character: lines[line].indexOf(needle) };
};

test("the column map doesn't change the output", () => {
  const plain = emitWithColumns(closureSrc, false);
  const mapped = emitWithColumns(closureSrc);
  assert.equal(mapped.text, plain.text);
  assert.deepEqual(mapped.lines, plain.lines);
  assert.equal(plain.columns, undefined);
});

test("the column map points each name at its text in the output", () => {
  const { text, columns } = emitWithColumns(closureSrc);
  const out = text.split("\n");
  const src = closureSrc.split("\n");
  // the closure's body (source line 7) is written in the helper at the end of the file
  assert.ok(columns.length >= 8 && columns.some((e) => e.line === 7 && e.outLine > 10), JSON.stringify(columns));
  for (const e of columns) assert.equal(out[e.outLine].substr(e.outCol, e.len), src[e.line - 1].substr(e.col - 1, e.len));
});

test("columnAt finds the name under a position, also just after it", () => {
  const cols = [{ line: 3, col: 2, len: 3, outLine: 9, outCol: 5 }, { line: 3, col: 6, len: 7, outLine: 9, outCol: 9 }, { line: 4, col: 1, len: 1, outLine: 10, outCol: 0 }];
  assert.equal(columnAt(cols, 3, 1), cols[0]);
  assert.equal(columnAt(cols, 3, 4), cols[0]);
  assert.equal(columnAt(cols, 3, 5), cols[1]);
  assert.equal(columnAt(cols, 3, 12), cols[1]);
  assert.equal(columnAt(cols, 3, 0), undefined);
  assert.equal(columnAt(cols, 5, 0), undefined);
});

test("a request on a rewritten line goes where the name went (a closure body, lifted out)", () => {
  const good = { sourceText: closureSrc, ...emitWithColumns(closureSrc) };
  const p = at(closureSrc, "inc := proc", "println");
  p.character += 3;
  const shadow = patch(closureSrc, good.text, closureSrc, good.lines);
  const t = columnTarget(good, shadow, p, closureSrc.split("\n")[p.line], shadow.text.split("\n"));
  assert.ok(t, "mapped");
  const line = shadow.text.split("\n")[t.position.line];
  assert.equal(line.slice(t.position.character - 3, t.position.character + 4), "println");
  assert.notEqual(line, closureSrc.split("\n")[p.line]);
  assert.deepEqual(t.span, [t.position.character - 3, t.position.character + 4]);
});

test("the column map follows edits elsewhere, and gives up on the edited line", () => {
  const good = { sourceText: closureSrc, ...emitWithColumns(closureSrc) };
  const edited = closureSrc.replace("\tcount := 0\n", "\tcount := 0\n\textra := 1\n");
  const shadow = patch(closureSrc, good.text, edited, good.lines);
  const p = at(edited, "inc := proc", "fmt");
  const t = columnTarget(good, shadow, p, edited.split("\n")[p.line], shadow.text.split("\n"));
  assert.ok(t, "mapped after an edit above");
  assert.equal(shadow.text.split("\n")[t.position.line].substr(t.position.character, 3), "fmt");
  const changed = closureSrc.replace("count += 1;", "count += 2;");
  const shadow2 = patch(closureSrc, good.text, changed, good.lines);
  const p2 = at(changed, "inc := proc", "fmt");
  assert.equal(columnTarget(good, shadow2, p2, changed.split("\n")[p2.line], shadow2.text.split("\n")), undefined);
});
