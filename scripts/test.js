// Test runner.
//   node scripts/test.js            compare against fixtures
//   node scripts/test.js --update   regenerate transpiled fixtures and expected stdout
//
// Each case is a program (a single .vidar file, or a directory that is the entry package
// plus any packages it imports) with two fixtures:
//   - the transpiled Odin tree (one file per generated output, in subdirectories per package)
//   - the stdout of running it with `odin run`
// Cases named opt_* are transpiled with -opt. Every case whose output -opt changes is also run the
// other way, and must print the same.
const { readdirSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, statSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { spawnSync, execSync } = require("node:child_process");
const { transpile } = require("../dist/cli.js");
const { loadProgram, emitProgram } = require("../dist/project.js");
const { CompileError } = require("../dist/lexer.js");

const UPDATE = process.argv.includes("--update");

let pass = 0;
let fail = 0;
const report = (ok, name, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `\n${detail}` : ""}`);
};

function firstDiffLine(a, b) {
  const x = a.split("\n");
  const y = b.split("\n");
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] !== y[i]) return `${i + 1}\n    want: ${x[i] ?? "<eof>"}\n    got:  ${y[i] ?? "<eof>"}`;
  }
  return "?";
}

function listTree(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((f) => statSync(join(dir, f)).isFile())
    .map((f) => f.split("\\").join("/"))
    .sort();
}

function writeTree(dir, files) {
  for (const [file, text] of files) {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
}

const cases = [
  ...readdirSync("examples")
    // a directory without main.vidar holds more than one program (e.g. examples/slime_mud)
    .filter((name) => existsSync(join("examples", name, "main.vidar")))
    .map((name) => {
      const dir = join("examples", name);
      return { name: `examples/${name}`, entry: dir, golden: join(dir, "expected"), stdout: join(dir, "stdout.txt") };
    }),
  ...readdirSync("tests/cases").map((name) => {
    const dir = join("tests/cases", name);
    const entry = existsSync(join(dir, "input")) ? join(dir, "input") : join(dir, "input.vidar");
    return { name: `tests/cases/${name}`, entry, golden: join(dir, "expected"), stdout: join(dir, "stdout.txt"), passthrough: name.startsWith("plain_"), optimize: name.startsWith("opt_") };
  }),
];

const work = mkdtempSync(join(tmpdir(), "vidar-test-"));
for (const c of cases) {
  let out;
  try {
    out = emitProgram(loadProgram(c.entry, { optimize: !!c.optimize })).files;
  } catch (err) {
    report(false, c.name, `  transpile error: ${err.message}`);
    continue;
  }

  if (UPDATE) {
    rmSync(c.golden, { recursive: true, force: true });
    writeTree(c.golden, out);
  }
  const golden = listTree(c.golden);
  const diffs = [];
  if (!golden.length) diffs.push(`  missing fixture ${c.golden}/ (run: npm run test:update)`);
  for (const file of new Set([...golden, ...out.keys()])) {
    const want = golden.includes(file) ? readFileSync(join(c.golden, file), "utf8") : undefined;
    const got = out.get(file);
    if (want === undefined) diffs.push(`  unexpected output file ${file}`);
    else if (got === undefined) diffs.push(`  missing output file ${file}`);
    else if (want !== got) diffs.push(`  ${file} differs from fixture, first change at line ${firstDiffLine(want, got)}`);
  }
  if (c.passthrough) {
    const input = readFileSync(c.entry, "utf8");
    const [only] = out.values();
    if (out.size !== 1 || only !== input) diffs.push(`  plain Odin was not passed through unchanged, first change at line ${firstDiffLine(input, only ?? "")}`);
  }
  report(!diffs.length, `${c.name} (transpiled)`, diffs.join("\n"));

  const dir = join(work, c.name.replace(/\//g, "_"));
  writeTree(dir, out);
  const r = spawnSync("odin", ["run", dir, `-out:${join(dir, "prog")}`], { encoding: "utf8" });
  if (UPDATE && r.status === 0) writeFileSync(c.stdout, r.stdout);
  const expected = existsSync(c.stdout) ? readFileSync(c.stdout, "utf8") : undefined;
  const ok = r.status === 0 && r.stdout === expected;
  report(ok, `${c.name} (run)`, ok ? "" : `  exit ${r.status}\n--- expected\n${expected ?? "<missing fixture>\n"}--- got\n${r.stdout}${r.stderr}`);

  // the same program transpiled the other way must behave the same
  let other;
  try {
    other = emitProgram(loadProgram(c.entry, { optimize: !c.optimize })).files;
  } catch (err) {
    report(false, `${c.name} (${c.optimize ? "without" : "with"} -opt)`, `  transpile error: ${err.message}`);
    continue;
  }
  if ([...other].every(([f, text]) => out.get(f) === text) && other.size === out.size) continue;
  const odir = join(work, c.name.replace(/\//g, "_") + "_other");
  writeTree(odir, other);
  const o = spawnSync("odin", ["run", odir, `-out:${join(odir, "prog")}`], { encoding: "utf8" });
  const same = o.status === 0 && o.stdout === expected;
  report(same, `${c.name} (run ${c.optimize ? "without" : "with"} -opt)`, same ? "" : `  exit ${o.status}\n--- expected\n${expected}--- got\n${o.stdout}${o.stderr}`);
}

function expectError(name, want, f) {
  try {
    f();
    report(false, name, `  expected error containing: ${want}`);
  } catch (err) {
    const ok = err instanceof CompileError && err.message.includes(want);
    report(ok, name, ok ? "" : `  expected: ${want}\n  got: ${err.message}`);
  }
}

for (const f of readdirSync("tests/errors").filter((f) => f.endsWith(".vidar"))) {
  const path = join("tests/errors", f);
  const text = readFileSync(path, "utf8");
  expectError(path, text.match(/^\/\/ error: (.*)$/m)[1], () => transpile([{ path, text }]));
}

// multi-package programs that must fail; the expected message is on the first line of main.vidar
for (const d of readdirSync("tests/errors_pkg")) {
  const dir = join("tests/errors_pkg", d);
  const want = readFileSync(join(dir, "main.vidar"), "utf8").match(/^\/\/ error: (.*)$/m)[1];
  expectError(dir, want, () => emitProgram(loadProgram(dir)));
}

// Real-world plain Odin must come out byte-for-byte unchanged.
const root = execSync("odin root", { encoding: "utf8" }).trim();
const sample = ["core/fmt/fmt.odin", "core/strings/strings.odin", "core/mem/allocators.odin", "core/math/linalg/general.odin", "core/encoding/json/parser.odin"];
for (const rel of sample) {
  const path = join(root, rel);
  const text = readFileSync(path, "utf8");
  let ok = false;
  try {
    const out = transpile([{ path, text }]);
    ok = out.size === 1 && [...out.values()][0] === text;
  } catch {}
  report(ok, `passthrough $ODIN_ROOT/${rel}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
