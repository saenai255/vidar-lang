const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { loadProgram, emitProgram } = require("../../dist/project.js");

/** Writes { "dir/file.vidar": text } under a fresh temp dir and returns its path. */
function tree(files) {
  const root = mkdtempSync(join(tmpdir(), "vidar-unit-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

const units = (p) => p.units.map((u) => [u.outDir, u.packages.map((x) => x.name).sort().join("+"), u.merged]);

test("packages without cycles stay separate units", () => {
  const root = tree({
    "main.vidar": 'package main\nimport "a"\nimport "b"\nmain :: proc() {}\n',
    "a/a.vidar": 'package a\nimport "../d"\nx :: 1\n',
    "b/b.vidar": 'package b\nimport "../d"\ny :: 1\n',
    "d/d.vidar": "package d\nz :: 1\n",
  });
  assert.deepEqual(units(loadProgram(root)), [["", "main", false], ["a", "a", false], ["b", "b", false], ["d", "d", false]]);
});

test("a cycle becomes one merged unit with prefixed names", () => {
  const root = tree({
    "main.vidar": 'package main\nimport "a"\nmain :: proc() { _ = a.f() }\n',
    "a/a.vidar": 'package a\nimport "../b"\nf :: proc() -> int { return b.g() }\n',
    "b/b.vidar": 'package b\nimport "../a"\ng :: proc() -> int { return 1 }\nh :: proc() -> int { return a.f() }\n',
  });
  const p = loadProgram(root);
  assert.deepEqual(units(p), [["", "main", false], ["a_b", "a+b", true]]);
  const out = emitProgram(p).files;
  assert.deepEqual([...out.keys()].sort(), ["a_b/a__a.odin", "a_b/b__b.odin", "main.odin"]);
  assert.match(out.get("main.odin"), /import a "a_b"[\s\S]*a\.a__f\(\)/);
  assert.match(out.get("a_b/a__a.odin"), /^package a_b\n\na__f :: proc\(\) -> int \{ return b__g\(\) \}/);
});

test("two cycles and a shared dependency", () => {
  const root = tree({
    "main.vidar": 'package main\nimport "a"\nimport "c"\nmain :: proc() {}\n',
    "a/a.vidar": 'package a\nimport "../b"\nimport "../shared"\nx :: 1\n',
    "b/b.vidar": 'package b\nimport "../a"\nimport "../shared"\ny :: 1\n',
    "c/c.vidar": 'package c\nimport "../d"\nz :: 1\n',
    "d/d.vidar": 'package d\nimport "../c"\nw :: 1\n',
    "shared/s.vidar": "package shared\nv :: 1\n",
  });
  assert.deepEqual(units(loadProgram(root)), [["", "main", false], ["a_b", "a+b", true], ["c_d", "c+d", true], ["shared", "shared", false]]);
});

test("same-named packages in one cycle get distinct prefixes", () => {
  const root = tree({
    "main.vidar": 'package main\nimport "x/util"\nmain :: proc() {}\n',
    "x/util/u.vidar": 'package util\nimport "../../y/util"\nf :: proc() {}\n',
    "y/util/u.vidar": 'package util\nimport "../../x/util"\nf :: proc() {}\n',
  });
  const p = loadProgram(root);
  const prefixes = p.packages.filter((x) => x.name === "util").map((x) => x.prefix).sort();
  assert.deepEqual(prefixes, ["util2__", "util__"]);
  assert.equal(new Set(emitProgram(p).files.keys()).size, 3);
});

test("an entry package inside a cycle keeps its names", () => {
  const root = tree({
    "main.vidar": 'package main\nimport "lib"\nVERSION :: 1\nmain :: proc() { _ = lib.v() }\n',
    "lib/lib.vidar": 'package lib\nimport app ".."\nv :: proc() -> int { return app.VERSION }\n',
  });
  const out = emitProgram(loadProgram(root)).files;
  assert.match(out.get("main.odin"), /VERSION :: 1\nmain :: proc\(\) \{ _ = lib__v\(\) \}/);
  assert.match(out.get("lib__lib.odin"), /lib__v :: proc\(\) -> int \{ return VERSION \}/);
});

test("collection imports are left alone and plain .odin files in a package are sources", () => {
  const root = tree({
    "main.vidar": 'package main\nimport "core:fmt"\nmain :: proc() { fmt.println(helper()) }\n',
    "helper.odin": "package main\nhelper :: proc() -> int { return 1 }\n",
  });
  const out = emitProgram(loadProgram(root)).files;
  assert.deepEqual([...out.keys()].sort(), ["helper.odin", "main.odin"]);
});

test("tolerant loading collects errors from every package", () => {
  const root = tree({
    "main.vidar": 'package main\nimport "a"\nmain :: proc() { _ = a.missing }\n',
    "a/a.vidar": "package a\nbad :: proc() { x := 1; f := proc[]() -> int { return x } }\n",
  });
  const p = loadProgram(root, { tolerant: true });
  const messages = p.errors.map((e) => e.message).join("\n");
  assert.match(messages, /has no member 'missing'/);
  assert.match(messages, /not captured/);
});

test("@(hot) warns about -opt decisions against code inside it, only with -opt", () => {
  const { hotWarnings } = require("../../dist/checks.js");
  const root = tree({
    "main.vidar": `package main
@(hot)
mix :: proc(a, b: []int, f: closure(int) -> int) -> (t: int) {
	for i in 0..<len(a) {
		t += a[i]
		t += b[a[i]] + f(i)
		tmp := make([]int, 2)
		delete(tmp)
	}
	return
}
cool :: proc(a, b: []int) -> (t: int) {
	for i in 0..<len(a) do t += b[i]
	return
}
main :: proc() {
	xs := []int{1}
	f := proc[](x: int) -> int { return x }
	_ = mix(xs, xs, f) + cool(xs, xs)
}
`,
  });
  const warnings = (optimize) => {
    const p = loadProgram(root, { optimize });
    emitProgram(p);
    return hotWarnings(p.analyzer).map((w) => `${w.pos.line}: ${w.message.split(": ").slice(0, 2).join(": ")}`);
  };
  assert.deepEqual(warnings(true), [
    "6: @(hot) 'mix': no bounds proof",
    "6: @(hot) 'mix': no direct call",
    "7: @(hot) 'mix': allocates in a loop",
  ]);
  assert.deepEqual(warnings(false), []);
});
