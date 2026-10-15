const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");

// impl Destroy copies in generic code: Odin's #assert where the file can name the type, a run-time stop elsewhere
const cli = join(__dirname, "../../dist/cli.js");
const vidar = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
const hasOdin = spawnSync("odin", ["version"]).status === 0;

const FILE = `File :: struct { name: string }
file_destroy :: proc(f: ^File) {}
impl Destroy for File { destroy = file_destroy }
`;
const KEEP = `keep :: proc(x: $T) -> T {
	return x
}
`;

test("a generic copy of a type the file can name fails to compile", { skip: !hasOdin && "odin not on PATH" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "vidar-unit-destroy-"));
  writeFileSync(join(dir, "main.vidar"), `package main\n\n${FILE}\n${KEEP}\nmain :: proc() {\n\tf := File{"f"}\n\tg := keep(f)\n}\n`);
  const r = vidar("run", join(dir, "main.vidar"));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /main\.vidar\(8:\d+\).*this copies a value whose type has impl Destroy/);
});

test("a generic copy in a package that can't name the type stops at run time", { skip: !hasOdin && "odin not on PATH" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "vidar-unit-destroy-"));
  mkdirSync(join(dir, "lib"));
  writeFileSync(join(dir, "lib", "lib.vidar"), `package lib\n\n${KEEP}`);
  writeFileSync(join(dir, "main.vidar"), `package main\n\nimport "lib"\n\n${FILE}\nmain :: proc() {\n\tf := File{"f"}\n\tg := lib.keep(f)\n}\n`);
  const r = vidar("run", join(dir, "main.vidar"));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /lib\.vidar\(4:\d+\): a File was copied, but its type has impl Destroy/);
});
