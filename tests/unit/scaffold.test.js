const { test } = require("node:test");
const assert = require("node:assert/strict");
const { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");
const { packageName } = require("../../dist/scaffold.js");

const cli = join(__dirname, "../../dist/cli.js");
const vidar = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
const hasOdin = spawnSync("odin", ["version"]).status === 0;
const work = () => mkdtempSync(join(tmpdir(), "vidar-unit-new-"));

test("package names are Odin identifiers", () => {
  assert.equal(packageName("/x/my-app"), "my_app");
  assert.equal(packageName("Geo Tools"), "geo_tools");
  assert.equal(packageName("2d"), "pkg_2d");
  assert.equal(packageName("proc"), "proc_pkg");
  assert.equal(packageName("---"), "app");
});

test("vidar new writes a program that runs", { skip: !hasOdin && "odin not on PATH" }, () => {
  const dir = join(work(), "hello-world");
  const r = vidar("new", dir);
  assert.equal(r.status, 0, r.stderr);
  for (const f of ["main.vidar", ".gitignore", ".vscode/launch.json", "README.md"]) assert.ok(existsSync(join(dir, f)), f);
  assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), "out/\n");
  const launch = JSON.parse(readFileSync(join(dir, ".vscode/launch.json"), "utf8"));
  assert.deepEqual(launch.configurations.map((c) => [c.type, c.request, c.program]), [["vidar", "launch", "${workspaceFolder}"]]);
  assert.match(readFileSync(join(dir, "main.vidar"), "utf8"), /^package main\n/);
  const run = vidar("run", dir);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, "Hello from hello_world!\n");
  const t = vidar("test", dir);
  assert.equal(t.status, 0, t.stderr);
  assert.equal(vidar("fmt", "--check", dir).status, 0);
});

test("vidar new --lib writes a library package whose test passes", { skip: !hasOdin && "odin not on PATH" }, () => {
  const dir = join(work(), "geo");
  const r = vidar("new", dir, "--lib");
  assert.equal(r.status, 0, r.stderr);
  const src = readFileSync(join(dir, "main.vidar"), "utf8");
  assert.match(src, /^package geo\n/);
  assert.match(src, /@\(test\)/);
  const t = vidar("test", dir);
  assert.equal(t.status, 0, t.stdout + t.stderr);
  assert.match(t.stdout + t.stderr, /1 test/);
  assert.equal(vidar("fmt", "--check", dir).status, 0);
});

test("vidar new refuses a directory that isn't empty", () => {
  const dir = work();
  writeFileSync(join(dir, "keep.txt"), "mine\n");
  const r = vidar("new", dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /is not empty/);
  assert.equal(existsSync(join(dir, "main.vidar")), false);
  const empty = join(dir, "empty");
  mkdirSync(empty);
  assert.equal(vidar("new", empty).status, 0);
  assert.equal(vidar("new").status, 2);
});
