const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { emitProgram, loadProgram } = require("../../dist/project.js");
const { LineFilter, generatedLine, locationMapper, readRunMap, runMapOf, MAP_FILE } = require("../../dist/runmap.js");
const { mapLocations } = require("../../dist/cli.js");

const root = "/work/out";
const map = {
  version: 1,
  files: {
    "main.odin": { source: "/src/app/main.vidar", lines: [1, 2, -2, -2, 3, 4, 0] },
    "util/util.odin": { source: "/src/app/util/util.vidar", lines: [1, 2, 3] },
    "a/same.odin": { source: "/src/app/a/same.vidar", lines: [1, 2] },
    "b/same.odin": { source: "/src/app/b/same.vidar", lines: [1, 2] },
  },
};
const mapLine = locationMapper(map, [root], { cwd: "/src" });

test("panics and compile errors: path(line:col) points at the .vidar line", () => {
  assert.equal(mapLine("/work/out/main.odin(6:9) Index 3 is out of range 0..<3"), "/src/app/main.vidar(4:9) Index 3 is out of range 0..<3");
  assert.equal(mapLine("/work/out/util/util.odin(3:1) Error: x"), "/src/app/util/util.vidar(3:1) Error: x");
  // a generated line is attributed to the source line it was written for
  assert.equal(mapLine("/work/out/main.odin(4:2) runtime assertion"), "/src/app/main.vidar(2:2) runtime assertion");
});

test("testing and log messages: [file.odin:line:proc()] names the .vidar file", () => {
  assert.equal(mapLine("[ERROR] --- [main.odin:5:test_x()] expected 1 to be 2"), "[ERROR] --- [app/main.vidar:3:test_x()] expected 1 to be 2");
  assert.equal(mapLine("+++ leak 16B @ 0x1 [util.odin:2:f()]"), "+++ leak 16B @ 0x1 [app/util/util.vidar:2:f()]");
  assert.equal(mapLine("[/work/out/main.odin:6:p()] long path"), "[/src/app/main.vidar:4:p()] long path");
});

test("everything else passes through unchanged", () => {
  for (const line of [
    "plain output main.odin(6:9)",
    "/elsewhere/main.odin(6:9) not ours",
    "/work/out/main.odin(7:1) helper code has no .vidar line",
    "/work/out/main.odin(99:1) past the end",
    "[same.odin:1:f()] two packages have a same.odin",
    "/work/out/main.odinx(1:1) not the same file",
    "",
  ]) assert.equal(mapLine(line), line);
});

test("mapLocations (compile errors) uses the same mapping", () => {
  const out = { files: new Map(), sourceOf: new Map([["main.odin", "/src/m.vidar"]]), lineMap: new Map([["main.odin", [1, -1, 2]]]) };
  assert.equal(mapLocations("/r/main.odin(3:4) Error: bad\n/r/main.odin(2:1) Error: worse\n", out, "/r"), "/src/m.vidar(2:4) Error: bad\n/src/m.vidar(1:1) Error: worse\n");
});

test("LineFilter rewrites whole lines as they complete, across chunks", () => {
  const got = [];
  const f = new LineFilter(mapLine, (t) => got.push(t), -1);
  f.push("first\n/work/out/ma");
  assert.deepEqual(got, ["first\n"]);
  f.push("in.odin(5:1) boom\nlast, no newline");
  assert.deepEqual(got, ["first\n", "/src/app/main.vidar(3:1) boom\n"]);
  f.end();
  assert.equal(got.join(""), "first\n/src/app/main.vidar(3:1) boom\nlast, no newline");
});

test("LineFilter writes out a partial line once output goes quiet", async () => {
  const got = [];
  const f = new LineFilter(mapLine, (t) => got.push(t), 10);
  f.push("Name? ");
  assert.deepEqual(got, []);
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(got, ["Name? "]);
  f.end();
  assert.deepEqual(got, ["Name? "]);
});

test("generatedLine finds the Odin line written for a .vidar line", () => {
  const lines = [1, 2, -2, -2, 3, 4, 0, 6];
  assert.equal(generatedLine(lines, 1), 1);
  assert.equal(generatedLine(lines, 3), 5);
  assert.equal(generatedLine(lines, 5), 8); // no code for line 5: the next line that has some
  assert.equal(generatedLine(lines, 9), 0);
  assert.equal(generatedLine([-4, -4, 4], 4), 3);
  assert.equal(generatedLine([-4, -4, 5], 4), 1);
  // given the text, a comment-only line (an expanded macro's header) gives way to the code
  assert.equal(generatedLine([1, 2, 2], 2, ["a", "\t// m!(x) — main.vidar:2", "f(x)"]), 3);
  assert.equal(generatedLine([1, 2], 2, ["a", "// only a comment"]), 2);
});

test("vidar.map.json round-trips, and maps a real program's shifted lines", () => {
  const src = `package m

Error :: enum { None, Bad }

setup :: proc(n: int) -> Error { return .None if n > 0 else .Bad }

main :: proc() {
	setup(1) catch unreachable
	assert(setup(0) == .None)
}
`;
  const out = emitProgram(loadProgram([{ path: "/src/m.vidar", text: src }], { followImports: false }));
  const dir = mkdtempSync(join(tmpdir(), "vidar-unit-"));
  writeFileSync(join(dir, MAP_FILE), JSON.stringify(runMapOf(out)));
  const saved = readRunMap(dir);
  const name = [...out.sourceOf.keys()][0];
  const gen = out.files.get(name).split("\n");
  const at = gen.findIndex((l) => l.includes("assert(")) + 1;
  assert.notEqual(at, 9, "the lowered catch should shift the generated lines");
  const mapped = locationMapper(saved, [dir])(`${join(dir, name)}(${at}:2) runtime assertion: failed`);
  assert.equal(mapped, "/src/m.vidar(9:2) runtime assertion: failed");
  assert.equal(generatedLine(saved.files[name].lines, 9), at);
});

test("a closure body lifted into a helper maps back to its .vidar lines", () => {
  const src = `package main

main :: proc() {
	n := 3
	f := proc[n](x: int) -> int {
		y := x + n
		return y * 2
	}
	_ = f(1)
}
`;
  const out = emitProgram(loadProgram([{ path: "/src/m.vidar", text: src }], { followImports: false }));
  const name = [...out.sourceOf.keys()][0];
  const gen = out.files.get(name).split("\n");
  const lines = out.lineMap.get(name);
  const at = (text) => gen.findIndex((l) => l.includes(text));
  assert.equal(lines[at("y := x + __env.n")], 6);
  assert.equal(lines[at("return y * 2")], 7);
  assert.equal(lines[at("call = proc(")], 5);
});
