const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { parseManifest, resolveCollection } = require("../../dist/manifest.js");

test("parseManifest: reads [collections], skips other tables and comments", () => {
  const m = parseManifest('# c\n[package]\nname = "x"\nversion = "1"\n\n[collections]\na = "./vendor/a" # note\nb = \'/abs/b\'\n', "vidar.toml");
  assert.deepEqual([...m], [["a", "./vendor/a"], ["b", "/abs/b"]]);
});

test("parseManifest: rejects malformed lines, non-strings and duplicates", () => {
  assert.throws(() => parseManifest("[collections]\nnope\n", "vidar.toml"), /cannot parse/);
  assert.throws(() => parseManifest("[collections]\na = 3\n", "vidar.toml"), /must be a string/);
  assert.throws(() => parseManifest('[collections]\na = "x"\na = "y"\n', "vidar.toml"), /twice/);
});

test("resolveCollection: relative to the manifest, null for unknown names", () => {
  const manifest = { dir: path.resolve("/p"), collections: new Map([["ui", "./vendor/ui"]]) };
  assert.equal(resolveCollection(manifest, "ui:widgets/button"), path.resolve("/p/vendor/ui/widgets/button"));
  assert.equal(resolveCollection(manifest, "core:fmt"), null);
  assert.equal(resolveCollection(null, "ui:x"), null);
});
