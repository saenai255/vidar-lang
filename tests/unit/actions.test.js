const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { packageIndex, packagesNamed } = require("../../dist/lsp/actions.js");

/** A fake `odin root`: each path gets a .odin file. */
function fakeRoot(paths) {
  const root = mkdtempSync(join(tmpdir(), "vidar-unit-odinroot-"));
  for (const p of paths) {
    mkdirSync(join(root, p), { recursive: true });
    writeFileSync(join(root, p, "x.odin"), "package x\n");
  }
  mkdirSync(join(root, "core", "empty"), { recursive: true });
  return root;
}

test("packageIndex lists package directories by their last path part, core first", () => {
  const index = packageIndex(
    fakeRoot(["core/fmt", "core/math/linalg", "vendor/stb/image", "core/image", "core/image/png", "base/runtime", "core/image/tests", "core/_internal", "core/os/.hidden", "core/a-b"]),
  );
  assert.deepEqual(index.get("linalg"), ["core:math/linalg"]);
  assert.deepEqual(index.get("image"), ["core:image", "vendor:stb/image"]);
  assert.deepEqual(index.get("png"), ["core:image/png"]);
  assert.deepEqual(index.get("runtime"), ["base:runtime"]);
  for (const skipped of ["tests", "_internal", ".hidden", "a-b", "empty", "math", "stb"]) assert.equal(index.get(skipped), undefined, skipped);
});

test("packagesNamed: the table first, then odin root; preferred only when unambiguous", () => {
  const index = packageIndex(fakeRoot(["core/crypto/noise", "core/math/noise", "core/encoding/xml", "core/c/libc", "vendor/libc", "vendor/zlib", "vendor/sdl2/ttf", "vendor/sdl3/ttf"]));
  assert.deepEqual(packagesNamed("xml", index), { paths: ["core:encoding/xml"], preferred: "core:encoding/xml" });
  assert.deepEqual(packagesNamed("noise", index), { paths: ["core:crypto/noise", "core:math/noise"], preferred: undefined });
  assert.deepEqual(packagesNamed("libc", index), { paths: ["core:c/libc", "vendor:libc"], preferred: "core:c/libc" });
  assert.deepEqual(packagesNamed("zlib", index), { paths: ["vendor:zlib"], preferred: "vendor:zlib" });
  assert.deepEqual(packagesNamed("ttf", index), { paths: ["vendor:sdl2/ttf", "vendor:sdl3/ttf"], preferred: undefined });
  assert.deepEqual(packagesNamed("sched", index), { paths: ["vidar:sched"], preferred: "vidar:sched" });
  assert.deepEqual(packagesNamed("toString", index).paths, []);
});

test("packagesNamed falls back to the fixed table without odin", () => {
  assert.deepEqual(packagesNamed("fmt", null), { paths: ["core:fmt"], preferred: "core:fmt" });
  assert.deepEqual(packagesNamed("linalg", null), { paths: ["core:math/linalg"], preferred: "core:math/linalg" });
  assert.deepEqual(packagesNamed("xml", null).paths, []);
  assert.deepEqual(packagesNamed("constructor", null).paths, []);
});
