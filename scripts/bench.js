// Benchmark regression check.
//   node scripts/bench.js [--against <ref>] [--section <s>] [--runs N]
//
// Builds examples/negative_cost at the working tree and at a git ref (default HEAD, built in a
// temporary worktree), both with -opt and odin -o:speed. Runs the two binaries alternately with
// --bench, takes each section's median, and exits non-zero when a section got more than 15% slower
// or its checksum changed. Sections under 0.5 ms are shown but never fail.
const { mkdtempSync, symlinkSync, existsSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { tmpdir } = require("node:os");
const { spawnSync } = require("node:child_process");

const arg = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const AGAINST = arg("--against", "HEAD");
const SECTION = arg("--section", undefined);
const RUNS = Number(arg("--runs", 5));
const SLOWER = 0.15;
const NOISE_MS = 0.5;

const ROOT = resolve(__dirname, "..");
const WORK = mkdtempSync(join(tmpdir(), "vidar-bench-"));

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 << 20, ...opts });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed\n${r.stdout ?? ""}${r.stderr ?? r.error ?? ""}`);
  }
  return r.stdout;
}

/** Builds negative_cost from the checkout at `dir` and returns the binary's path. */
function build(dir, label) {
  console.error(`building ${label}...`);
  run("npm", ["run", "build"], { cwd: dir });
  const src = join(dir, "examples/negative_cost");
  if (!existsSync(join(src, "main.vidar"))) throw new Error(`${label} has no examples/negative_cost`);
  const out = join(WORK, label);
  run("node", [join(dir, "dist/cli.js"), "build", src, "-opt", "-o", out]);
  run("odin", ["build", out, "-o:speed", `-out:${join(out, "prog")}`]);
  return join(out, "prog");
}

/** Section name to { ms, checksum } for one run. */
function measure(prog) {
  const sections = new Map();
  for (const line of run(prog, ["--bench"]).split("\n")) {
    const m = /^(.+?)\s+([\d.]+) ms\s+(\S+)$/.exec(line);
    if (m) sections.set(m[1], { ms: Number(m[2]), checksum: m[3] });
  }
  return sections;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

const base = join(WORK, "base");
run("git", ["worktree", "add", "--detach", base, AGAINST], { cwd: ROOT });
let failed = false;
let broken = false;
try {
  symlinkSync(join(ROOT, "node_modules"), join(base, "node_modules"));
  const oldProg = build(base, "old");
  const newProg = build(ROOT, "new");

  const times = { old: new Map(), new: new Map() };
  const checksums = { old: new Map(), new: new Map() };
  for (let i = 0; i < RUNS; i++) {
    console.error(`run ${i + 1}/${RUNS}`);
    for (const [side, prog] of [["old", oldProg], ["new", newProg]]) {
      for (const [name, { ms, checksum }] of measure(prog)) {
        if (!times[side].has(name)) times[side].set(name, []);
        times[side].get(name).push(ms);
        checksums[side].set(name, checksum);
      }
    }
  }

  const names = [...new Set([...times.old.keys(), ...times.new.keys()])].filter((n) => !SECTION || n.includes(SECTION));
  const width = Math.max(7, ...names.map((n) => n.length));
  const fmt = (ms) => (ms === undefined ? "-" : ms.toFixed(2));
  console.log(`against ${AGAINST}, median of ${RUNS} runs, -opt, -o:speed\n`);
  console.log(`${"section".padEnd(width)}  ${"old ms".padStart(8)}  ${"new ms".padStart(8)}  ${"change".padStart(7)}`);
  for (const name of names) {
    const o = times.old.has(name) ? median(times.old.get(name)) : undefined;
    const n = times.new.has(name) ? median(times.new.get(name)) : undefined;
    let change = "";
    let note = "";
    if (o !== undefined && n !== undefined) {
      const ratio = n / o - 1;
      change = `${ratio >= 0 ? "+" : ""}${(ratio * 100).toFixed(1)}%`;
      if (ratio > SLOWER && Math.max(o, n) >= NOISE_MS) {
        note = "  SLOWER";
        failed = true;
      }
      if (checksums.old.get(name) !== checksums.new.get(name)) {
        note += `  CHECKSUM ${checksums.old.get(name)} -> ${checksums.new.get(name)}`;
        failed = true;
      }
    } else {
      change = o === undefined ? "new" : "gone";
    }
    console.log(`${name.padEnd(width)}  ${fmt(o).padStart(8)}  ${fmt(n).padStart(8)}  ${change.padStart(7)}${note}`);
  }
  if (failed) console.log(`\nfailed: a section is more than ${SLOWER * 100}% slower, or its checksum changed`);
} catch (e) {
  console.error(e.message);
  broken = true;
} finally {
  spawnSync("git", ["worktree", "remove", "--force", base], { cwd: ROOT });
}
process.exit(broken ? 2 : failed ? 1 : 0);
