// Plain Odin must pass through vidar unchanged.
const { readFileSync } = require("node:fs");
const { transpile } = require("../dist/cli.js");
let ok = 0;
const bad = [];
for (const f of process.argv.slice(2)) {
  const text = readFileSync(f, "utf8");
  try {
    const out = transpile([{ path: f, text }]);
    const [only] = out.values();
    if (out.size === 1 && only === text) ok++;
    else bad.push(`DIFF ${f}`);
  } catch (e) {
    bad.push(`FAIL ${f} ${e.pos ? `${e.pos.line}:${e.pos.col}` : ""} ${e.message}`);
  }
}
console.log(bad.slice(0, 15).join("\n"));
console.log(`${ok} identical, ${bad.length} not`);
