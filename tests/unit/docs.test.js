const test = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const { join } = require("node:path");

test("generated reference pages are up to date", () => {
  const r = spawnSync("node", [join(__dirname, "..", "..", "scripts", "gen-docs.js"), "--check"], { encoding: "utf8" });
  assert.strictEqual(r.status, 0, r.stderr);
});
