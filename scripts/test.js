// Test runner.
//   node scripts/test.js            compare against fixtures
//   node scripts/test.js --update   regenerate transpiled fixtures and expected stdout
//   node scripts/test.js --only <s> only the cases and error tests whose name contains <s>
//
// Each case is a program (a single .vidar file, or a directory that is the entry package
// plus any packages it imports) with two fixtures:
//   - the transpiled Odin tree (one file per generated output, in subdirectories per package)
//   - the stdout of running it with `odin run`
// Cases named opt_* are transpiled with -opt. Every case whose output -opt changes is also run the
// other way, and must print the same.
// tests/sched_debug/<name>/ are vidar:sched debugging checks (deadlocks, trace files, races), each
// built with its own odin flags; see testSchedDebug.
const { readdirSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, statSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir, availableParallelism } = require("node:os");
const { spawn, execSync } = require("node:child_process");
const { transpile } = require("../dist/cli.js");
const { loadProgram, emitProgram } = require("../dist/project.js");
const { CompileError } = require("../dist/lexer.js");

const UPDATE = process.argv.includes("--update");
// extra flags for every odin build, e.g. VIDAR_ODIN_FLAGS="-define:VIDAR_THREADS=4"
const EXTRA = (process.env.VIDAR_ODIN_FLAGS ?? "").split(/\s+/).filter(Boolean);
const ONLY = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : undefined;
const picked = (name) => !ONLY || name.includes(ONLY);

let pass = 0;
let fail = 0;
const JOBS = Number(process.argv.find((a) => a.startsWith("-j"))?.slice(2)) || Math.max(2, Math.floor(availableParallelism() / 2));

/** Counts the result and prints it, or adds it to `log` to print in order later. */
const report = (ok, name, detail = "", log = null) => {
  ok ? pass++ : fail++;
  const line = `${ok ? "PASS" : "FAIL"} ${name}${detail ? `\n${detail}` : ""}`;
  log ? log.push(line) : console.log(line);
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
].filter((c) => picked(c.name));

const work = mkdtempSync(join(tmpdir(), "vidar-test-"));

/** Runs `cmd` and resolves with its exit and output; a run past `ms` is killed. */
function run(cmd, args, ms, env) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env: env ? { ...process.env, ...env } : undefined });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8").on("data", (d) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
    const timer = setTimeout(() => ((timedOut = true), child.kill("SIGKILL")), ms);
    child.on("error", (err) => ((stderr += err.message), resolve({ status: -1, stdout, stderr, timedOut })));
    child.on("close", (status) => (clearTimeout(timer), resolve({ status: timedOut ? -1 : status, stdout, stderr, timedOut })));
  });
}

// build and run apart, so a hang in either fails the case instead of the whole run
async function odinRun(dir) {
  const prog = join(dir, "prog");
  let b;
  // odin's checker sometimes hangs; one retry
  for (let i = 0; i < 2; i++) {
    b = await run("odin", ["build", dir, `-out:${prog}`, ...EXTRA], 120_000);
    if (!b.timedOut) break;
  }
  if (b.status !== 0) return { status: b.status, stdout: "", stderr: b.timedOut ? "odin build timed out\n" : b.stderr };
  const r = await run(prog, [], 30_000);
  return r.timedOut ? { ...r, stderr: `timed out after 30s\n${r.stderr}` } : r;
}

/** Transpiles a case and checks it against its fixture; resolves with the lines to print. */
async function testCase(c) {
  const log = [];
  let out;
  try {
    out = emitProgram(loadProgram(c.entry, { optimize: !!c.optimize })).files;
  } catch (err) {
    report(false, c.name, `  transpile error: ${err.message}`, log);
    return log;
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
  report(!diffs.length, `${c.name} (transpiled)`, diffs.join("\n"), log);

  // the same program transpiled the other way must behave the same
  let other;
  try {
    other = emitProgram(loadProgram(c.entry, { optimize: !c.optimize })).files;
  } catch (err) {
    other = err;
  }
  const differs = !(other instanceof Error) && !([...other].every(([f, text]) => out.get(f) === text) && other.size === out.size);
  const dir = join(work, c.name.replace(/\//g, "_"));
  writeTree(dir, out);
  let odir;
  if (differs) writeTree((odir = dir + "_other"), other);
  const [r, o] = await Promise.all([odinRun(dir), odir && odinRun(odir)]);

  if (UPDATE && r.status === 0) writeFileSync(c.stdout, r.stdout);
  const expected = existsSync(c.stdout) ? readFileSync(c.stdout, "utf8") : undefined;
  const ok = r.status === 0 && r.stdout === expected;
  report(ok, `${c.name} (run)`, ok ? "" : `  exit ${r.status}\n--- expected\n${expected ?? "<missing fixture>\n"}--- got\n${r.stdout}${r.stderr}`, log);

  const other_ = `${c.name} (${c.optimize ? "without" : "with"} -opt)`;
  if (other instanceof Error) report(false, other_, `  transpile error: ${other.message}`, log);
  else if (o) {
    const same = o.status === 0 && o.stdout === expected;
    report(same, `${c.name} (run ${c.optimize ? "without" : "with"} -opt)`, same ? "" : `  exit ${o.status}\n--- expected\n${expected}--- got\n${o.stdout}${o.stderr}`, log);
  }
  return log;
}

/** Runs the cases JOBS at a time, printing each one's results in case order as soon as all before it are done. */
async function runCases() {
  const logs = new Array(cases.length);
  let next = 0;
  let printed = 0;
  const flush = () => {
    while (printed < cases.length && logs[printed]) for (const line of logs[printed++]) console.log(line);
  };
  const worker = async () => {
    while (next < cases.length) {
      const i = next++;
      logs[i] = await testCase(cases[i]);
      flush();
    }
  };
  await Promise.all(Array.from({ length: Math.min(JOBS, cases.length) }, worker));
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

/** `vidar test`: examples/testing passes, and a failing test, assert and panic are reported at their .vidar lines. */
async function testCommand() {
  const cli = join(__dirname, "../dist/cli.js");
  const passing = "testing: vidar test examples/testing";
  if (picked(passing)) {
    const r = await run("node", [cli, "test", "examples/testing"], 120_000);
    const ok = r.status === 0 && /All tests were successful/.test(r.stdout + r.stderr);
    report(ok, passing, ok ? "" : `  exit ${r.status}\n${r.stdout}${r.stderr}`);
  }
  const failing = "testing: vidar test reports failures at .vidar lines";
  if (picked(failing)) {
    const file = "tests/vidar_test/failing/main.vidar";
    const marked = readFileSync(file, "utf8").split("\n").flatMap((l, i) => (l.trimEnd().endsWith("// fails here") ? [i + 1] : []));
    // one test thread: with several, a panic's location and another test's log line can share a line of output
    const r = await run("node", [cli, "test", "tests/vidar_test/failing", "--", "-define:ODIN_TEST_THREADS=1"], 120_000);
    const output = r.stdout + r.stderr;
    const missing = marked.filter((n) => !output.includes(`main.vidar:${n}:`) && !output.includes(`main.vidar(${n}:`));
    const ok = r.status !== 0 && marked.length === 3 && !missing.length && !/main\.odin[:(]/.test(output);
    report(ok, failing, ok ? "" : `  exit ${r.status}, lines not reported: ${missing.join(", ")}\n${output}`);
  }
}

/**
 * `vidar:sched` debugging: each `tests/sched_debug/<name>/` is a program and a `check.json` with
 * runs, each built with its own odin flags, that may fail (a deadlock panics) and whose stderr,
 * mapped to .vidar lines, must hold every `stderr` text (`{main.vidar}` stands for that file's
 * path). A run's `env` is set for the program (`{dir}` is the build directory), and `json` names a
 * file the program writes that must be valid JSON holding every `jsonHas` text.
 */
async function testSchedDebug() {
  const { locationMapper, runMapOf } = require("../dist/runmap.js");
  const root = "tests/sched_debug";
  if (!existsSync(root)) return;
  const pattern = (text) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\{main\\\.vidar\\\}/g, "\\S*main\\.vidar"));
  const jobs = [];
  for (const name of readdirSync(root)) {
    const entry = join(root, name);
    const check = JSON.parse(readFileSync(join(entry, "check.json"), "utf8"));
    for (const r of check.runs) {
      const label = `${entry} (${r.name})`;
      if (picked(label)) jobs.push({ entry, check, r, label });
    }
  }
  const logs = new Array(jobs.length);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const i = next++;
      const { entry, check, r, label } = jobs[i];
      const log = (logs[i] = []);
      let out;
      try {
        out = emitProgram(loadProgram(entry, { optimize: !!r.opt }));
      } catch (err) {
        report(false, label, `  transpile error: ${err.message}`, log);
        continue;
      }
      const dir = join(work, `sched_debug_${i}`);
      writeTree(dir, out.files);
      const prog = join(dir, "prog");
      // each run sets its own thread count; its defines win over VIDAR_ODIN_FLAGS
      const own = new Set([...r.flags.map((f) => f.split("=")[0]), "-define:VIDAR_THREADS"]);
      const extra = EXTRA.filter((f) => !own.has(f.split("=")[0]) && !(f.startsWith("-o:") && r.flags.some((g) => g.startsWith("-o:"))));
      const b = await run("odin", ["build", dir, `-out:${prog}`, ...r.flags, ...extra], 120_000);
      if (b.status !== 0) {
        report(false, label, `  odin build failed\n${b.stderr}`, log);
        continue;
      }
      const env = Object.fromEntries(Object.entries(r.env ?? {}).map(([k, v]) => [k, v.replace("{dir}", dir)]));
      const p = await run(prog, [], 30_000, env);
      const stderr = locationMapper(runMapOf(out), [dir])(p.stderr);
      const problems = [];
      if (p.timedOut) problems.push("timed out after 30s");
      else if (r.fails ? p.status === 0 : p.status !== 0) problems.push(`exit ${p.status}`);
      if (check.stdout !== undefined && p.stdout !== check.stdout) problems.push(`stdout:\n${p.stdout}`);
      for (const t of r.stderr ?? []) if (!pattern(t).test(stderr)) problems.push(`stderr lacks: ${JSON.stringify(t)}`);
      for (const t of r.notStderr ?? []) if (pattern(t).test(stderr)) problems.push(`stderr has: ${JSON.stringify(t)}`);
      if (r.json) {
        const file = r.json.replace("{dir}", dir);
        try {
          const text = readFileSync(file, "utf8");
          JSON.parse(text);
          for (const t of r.jsonHas ?? []) if (!text.includes(t)) problems.push(`${r.json} lacks: ${JSON.stringify(t)}`);
        } catch (err) {
          problems.push(`${r.json}: ${err.message}`);
        }
      }
      report(!problems.length, label, problems.length ? `  ${problems.join("\n  ")}\n--- stderr\n${stderr}` : "", log);
    }
  };
  await Promise.all(Array.from({ length: Math.min(JOBS, jobs.length) }, worker));
  for (const log of logs) for (const line of log) console.log(line);
}

(async () => {
  await runCases();
  await testCommand();
  await testSchedDebug();

  for (const f of readdirSync("tests/errors").filter((f) => f.endsWith(".vidar") && picked(join("tests/errors", f)))) {
    const path = join("tests/errors", f);
    const text = readFileSync(path, "utf8");
    expectError(path, text.match(/^\/\/ error: (.*)$/m)[1], () => transpile([{ path, text }]));
  }

  // multi-package programs that must fail; the expected message is on the first line of main.vidar
  for (const d of readdirSync("tests/errors_pkg").filter((d) => picked(join("tests/errors_pkg", d)))) {
    const dir = join("tests/errors_pkg", d);
    const want = readFileSync(join(dir, "main.vidar"), "utf8").match(/^\/\/ error: (.*)$/m)[1];
    expectError(dir, want, () => emitProgram(loadProgram(dir)));
  }

  // Real-world plain Odin must come out byte-for-byte unchanged.
  const root = execSync("odin root", { encoding: "utf8" }).trim();
  const sample = ["core/fmt/fmt.odin", "core/strings/strings.odin", "core/mem/allocators.odin", "core/math/linalg/general.odin", "core/encoding/json/parser.odin"];
  for (const rel of ONLY ? [] : sample) {
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
})();
