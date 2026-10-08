// Windows paths, checked on any platform by passing path.win32 where the code takes a path flavor.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathKey, pathPattern, relativeInside } = require("../../dist/paths.js");
const { locationMapper } = require("../../dist/runmap.js");
const { binaryName, artifactName } = require("../../dist/cli.js");

const win = path.win32;

test("pathKey: Windows paths compare without case and with either slash", () => {
  assert.equal(pathKey("C:/Users/Me/out/main.odin", win), pathKey("c:\\users\\me\\OUT\\main.odin", win));
  assert.notEqual(pathKey("C:\\out\\a.odin", win), pathKey("C:\\out\\b.odin", win));
  // POSIX paths are kept as they are: case matters there, and `\` is an ordinary character
  assert.equal(pathKey("/Work/a\\b", path.posix), "/Work/a\\b");
});

test("relativeInside: a file under a directory, '/'-separated", () => {
  assert.equal(relativeInside("C:\\Temp\\vidar-lsp-1", "C:/Temp/vidar-lsp-1/vidar_sched/sched.odin", win), "vidar_sched/sched.odin");
  assert.equal(relativeInside("C:\\Temp\\vidar-lsp-1", "c:\\temp\\vidar-lsp-1\\main.odin", win), "main.odin");
  assert.equal(relativeInside("C:\\Temp\\vidar-lsp-1\\", "C:\\Temp\\vidar-lsp-1\\main.odin", win), "main.odin");
  assert.equal(relativeInside("C:\\Temp\\vidar-lsp-1", "C:\\Temp\\vidar-lsp-10\\main.odin", win), null);
  assert.equal(relativeInside("C:\\Temp\\vidar-lsp-1", "D:\\Temp\\vidar-lsp-1\\main.odin", win), null);
  assert.equal(relativeInside("C:\\Temp\\vidar-lsp-1", "C:\\Temp\\vidar-lsp-1", win), null);
  assert.equal(relativeInside("/tmp/w", "/tmp/w/a/b.odin", path.posix), "a/b.odin");
  assert.equal(relativeInside("/tmp/w", "/TMP/w/a.odin", path.posix), null);
  assert.equal(relativeInside("/tmp/w", "/tmp/wx/a.odin", path.posix), null);
});

test("pathPattern: either slash at each separator on Windows, escaped as is elsewhere", () => {
  const re = new RegExp(`^${pathPattern("C:\\out (1)\\main.odin", win)}$`, "i");
  for (const p of ["C:\\out (1)\\main.odin", "C:/out (1)/main.odin", "c:\\OUT (1)/main.odin"]) assert.match(p, re);
  assert.doesNotMatch("C:\\out (1)\\mainXodin", re);
  assert.equal(pathPattern("/a.b/c", path.posix), "/a\\.b/c");
});

const map = {
  version: 1,
  files: {
    "main.odin": { source: "C:\\src\\app\\main.vidar", lines: [1, 2, -2, -2, 3, 4, 0] },
    "vidar_sched/sched.odin": { source: "C:\\src\\app\\sched.vidar", lines: [7, 8] },
  },
};
const mapLine = locationMapper(map, ["C:\\work\\out"], { cwd: "C:\\src", path: win });

test("locationMapper on Windows: backslashes, forward slashes and either drive case", () => {
  assert.equal(mapLine("C:\\work\\out\\main.odin(6:9) Index 3 is out of range"), "C:\\src\\app\\main.vidar(4:9) Index 3 is out of range");
  assert.equal(mapLine("C:/work/out/main.odin(4:2) Error: x"), "C:\\src\\app\\main.vidar(2:2) Error: x");
  assert.equal(mapLine("c:\\Work\\Out\\vidar_sched\\sched.odin(2:1) Error: y"), "C:\\src\\app\\sched.vidar(8:1) Error: y");
  assert.equal(mapLine("C:/work/out\\vidar_sched/sched.odin(1:1) mixed"), "C:\\src\\app\\sched.vidar(7:1) mixed");
  assert.equal(mapLine("[C:/work/out/main.odin:6:p()] long path"), "[C:\\src\\app\\main.vidar:4:p()] long path");
  // short [file.odin:line] paths are shown relative to cwd, with Windows separators
  assert.equal(mapLine("[ERROR] --- [main.odin:5:test_x()] failed"), "[ERROR] --- [app\\main.vidar:3:test_x()] failed");
  for (const line of ["D:\\work\\out\\main.odin(6:9) another drive", "C:\\work\\out\\main.odin(7:1) no .vidar line", "C:\\work\\outer\\main.odin(1:1) x"]) {
    assert.equal(mapLine(line), line);
  }
});

test("binaryName: the program gets .exe on Windows only", () => {
  assert.equal(binaryName("app", "win32"), "app.exe");
  assert.equal(binaryName("app", "linux"), "app");
  assert.equal(binaryName("app", "darwin"), "app");
});

test("artifactName: library file names per platform", () => {
  assert.equal(artifactName("app", "exe", "win32"), "app.exe");
  assert.equal(artifactName("app", "lib", "linux"), "libapp.a");
  assert.equal(artifactName("app", "lib", "win32"), "app.lib");
  assert.equal(artifactName("app", "dll", "darwin"), "libapp.dylib");
  assert.equal(artifactName("app", "dll", "linux"), "libapp.so");
  assert.equal(artifactName("app", "dll", "win32"), "app.dll");
});
