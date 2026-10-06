#!/usr/bin/env node
// Builds both slime_mud servers and compares build time, startup time, simulation speed and
// server throughput. Run from the repository root after `npm run build`:
//   node examples/slime_mud/bench/bench.js [--quick]
// Prints a Markdown report and writes it to examples/slime_mud/bench/results.md.
const { spawnSync, spawn } = require("node:child_process");
const { mkdirSync, rmSync, statSync, readdirSync, readFileSync, writeFileSync, mkdtempSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { tmpdir, cpus, totalmem, release } = require("node:os");
const dgram = require("node:dgram");

const QUICK = process.argv.includes("--quick");
const ROOT = resolve(__dirname, "../../..");
const EX = resolve(__dirname, "..");
const WORK = mkdtempSync(join(tmpdir(), "slime-bench-"));
const CLI = join(ROOT, "dist/cli.js");

const RUNS = {
  build: QUICK ? 2 : 5,
  startup: QUICK ? 10 : 100,
  sim: QUICK ? 1 : 5,
  load: QUICK ? 1 : 3,
};
const SIM_ARGS = ["--sim", "2000", "--slimes", "20000", "--sim-players", "500"];
const LOAD = { clients: QUICK ? 16 : 64, commands: QUICK ? 200 : 2000 };

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))];
const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6;
const fmt = (x, d = 1) => x.toFixed(d);

function run(cmd, args, opts = {}) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(cmd, args, { encoding: "utf8", cwd: EX, ...opts });
  const elapsed = ms(t0);
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${r.status}):\n${r.stdout}${r.stderr}`);
  return { ...r, ms: elapsed };
}

function timeRuns(n, f) {
  const times = [];
  for (let i = 0; i < n; i++) times.push(f());
  return times;
}

// ---- build ----

const out = (name) => join(WORK, name);
const builds = {};
console.error("building...");
builds.transpile = timeRuns(RUNS.build, () => run("node", [CLI, "build", join(EX, "vidar"), "-o", out("vidar_src")]).ms);
for (const opt of ["minimal", "speed"]) {
  builds[`vidar_${opt}`] = timeRuns(RUNS.build, () => run("odin", ["build", out("vidar_src"), `-out:${out(`vidar_${opt}`)}`, `-o:${opt}`]).ms);
  builds[`odin_${opt}`] = timeRuns(RUNS.build, () => run("odin", ["build", join(EX, "odin"), `-out:${out(`odin_${opt}`)}`, `-o:${opt}`]).ms);
}
run("odin", ["build", join(EX, "bench/loadgen"), `-out:${out("loadgen")}`, "-o:speed"]);
const BIN = { vidar: out("vidar_speed"), odin: out("odin_speed") };

function sourceLines(dir, ext) {
  let n = 0;
  for (const f of readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith(ext))) {
    for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
      const t = line.trim();
      if (t && !t.startsWith("//")) n++;
    }
  }
  return n;
}
const generatedLines = (dir) => readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith(".odin"))
  .filter((f) => !f.startsWith("vidar_sched") && !f.startsWith("vidar_runtime"))
  .reduce((n, f) => n + readFileSync(join(dir, f), "utf8").split("\n").filter((l) => l.trim() && !l.trim().startsWith("//")).length, 0);

// ---- correctness: same simulation, same transcript ----

console.error("checking both versions agree...");
const simCheck = Object.fromEntries(Object.entries(BIN).map(([k, bin]) => [k, run(bin, ["--sim", "300", "--slimes", "2000", "--sim-players", "50"]).stdout]));
const simSame = simCheck.vidar === simCheck.odin;

function startServer(bin, extra = []) {
  const saves = mkdtempSync(join(WORK, "saves-"));
  const child = spawn(bin, ["--port", "0", "--udp-port", "0", "--idle-secs", "0", "--saves", saves, ...extra], { cwd: EX, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  return new Promise((ok, fail) => {
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      const m = buf.match(/ready tcp=(\d+) udp=(\d+)/);
      if (m) ok({ child, tcp: +m[1], udp: +m[2], saves, stderr: () => stderr });
    });
    child.on("exit", (code) => fail(new Error(`server exited (${code}): ${stderr}`)));
  });
}

function udpRequest(port, msg, wantReply = true) {
  return new Promise((ok) => {
    const s = dgram.createSocket("udp4");
    const timer = setTimeout(() => { s.close(); ok(""); }, 2000);
    s.on("message", (m) => { clearTimeout(timer); s.close(); ok(String(m)); });
    s.send(msg, port, "127.0.0.1", () => { if (!wantReply) { clearTimeout(timer); s.close(); ok(""); } });
  });
}

const rss = (pid) => Number(spawnSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim()) / 1024;

async function stopServer(srv) {
  const exited = new Promise((ok) => srv.child.on("exit", ok));
  await udpRequest(srv.udp, "shutdown", false);
  const timer = setTimeout(() => srv.child.kill("SIGKILL"), 5000);
  await exited;
  clearTimeout(timer);
}

async function main() {
  const transcripts = {};
  for (const [k, bin] of Object.entries(BIN)) {
    const srv = await startServer(bin, ["--tick-ms", "0"]);
    transcripts[k] = run(out("loadgen"), ["--port", String(srv.tcp), "--script", join(EX, "bench/script.txt"), "--prefix", "tester"]).stdout;
    await stopServer(srv);
  }
  const transcriptSame = transcripts.vidar === transcripts.odin;

  // ---- startup ----
  console.error("startup...");
  // alternating, so drift in the machine's load hits both alike
  const startup = { vidar: [], odin: [] };
  const saves = mkdtempSync(join(WORK, "saves-"));
  for (let i = 0; i < RUNS.startup; i++) {
    for (const [k, bin] of Object.entries(BIN)) {
      startup[k].push(run(bin, ["--ready-exit", "--port", "0", "--udp-port", "0", "--saves", saves]).ms);
    }
  }

  // ---- simulation ----
  console.error("simulation...");
  const sim = {};
  const simOut = {};
  for (const [k, bin] of Object.entries(BIN)) {
    sim[k] = timeRuns(RUNS.sim, () => {
      const r = run(bin, SIM_ARGS);
      simOut[k] = r.stdout;
      const m = r.stderr.match(/\[timed\] sim: ([\d.]+)(ms|s|µs)/);
      return Number(m[1]) * (m[2] === "s" ? 1000 : m[2] === "µs" ? 0.001 : 1);
    });
  }
  const bigSimSame = simOut.vidar === simOut.odin;

  // ---- load ----
  console.error("load...");
  const load = {};
  for (const [k, bin] of Object.entries(BIN)) {
    load[k] = [];
    for (let i = 0; i < RUNS.load; i++) {
      const srv = await startServer(bin, ["--tick-ms", "50"]);
      const idle = rss(srv.child.pid);
      const r = run(out("loadgen"), ["--port", String(srv.tcp), "--clients", String(LOAD.clients), "--commands", String(LOAD.commands)]);
      const peak = rss(srv.child.pid);
      const status = await udpRequest(srv.udp, "status");
      await stopServer(srv);
      const m = Object.fromEntries([...r.stdout.matchAll(/(\w+)=([\d.]+)/g)].map((x) => [x[1], Number(x[2])]));
      load[k].push({ ...m, idle, peak, status: status.trim() });
    }
  }

  // ---- report ----
  const pick = (k, f) => median(load[k].map(f));
  const kb = (f) => (statSync(f).size / 1024).toFixed(0);
  const odinVersion = spawnSync("odin", ["version"], { encoding: "utf8" }).stdout.trim().replace(/^.*odin version /, "");
  const lines = [];
  const row = (...cells) => lines.push(`| ${cells.join(" | ")} |`);
  lines.push(`Measured on ${cpus()[0].model}, ${cpus().length} cores, ${(totalmem() / 2 ** 30).toFixed(0)} GB, ${process.platform} ${release()}; Odin ${odinVersion}, Node ${process.version}.`);
  lines.push(`Each number is the median of the runs listed. Both versions agree: simulation ${simSame && bigSimSame ? "identical" : "DIFFERENT"}, transcript ${transcriptSame ? "identical" : "DIFFERENT"}.`);
  lines.push("");
  lines.push("**Build** (" + RUNS.build + " runs)");
  lines.push("");
  row("", "Vidar", "Odin");
  row("---", "---:", "---:");
  row("transpile (`vidar build`, Node)", `${fmt(median(builds.transpile), 0)} ms`, "–");
  row("`odin build` default (`-o:minimal`)", `${fmt(median(builds.vidar_minimal), 0)} ms`, `${fmt(median(builds.odin_minimal), 0)} ms`);
  row("`odin build -o:speed`", `${fmt(median(builds.vidar_speed), 0)} ms`, `${fmt(median(builds.odin_speed), 0)} ms`);
  row("total, default", `${fmt(median(builds.transpile) + median(builds.vidar_minimal), 0)} ms`, `${fmt(median(builds.odin_minimal), 0)} ms`);
  row("binary size (`-o:speed`)", `${kb(BIN.vidar)} KB`, `${kb(BIN.odin)} KB`);
  row("source lines (non-blank, non-comment)", `${sourceLines(join(EX, "vidar"), ".vidar")}`, `${sourceLines(join(EX, "odin"), ".odin")}`);
  row("generated Odin lines (without runtime and sched)", `${generatedLines(out("vidar_src"))}`, "–");
  lines.push("");
  lines.push(`**Startup**: process start to ports bound, \`--ready-exit\` (${RUNS.startup} runs)`);
  lines.push("");
  row("", "Vidar", "Odin");
  row("---", "---:", "---:");
  row("median", `${fmt(median(startup.vidar))} ms`, `${fmt(median(startup.odin))} ms`);
  row("p90", `${fmt(pct(startup.vidar, 0.9))} ms`, `${fmt(pct(startup.odin, 0.9))} ms`);
  lines.push("");
  lines.push(`**Simulation**: \`${SIM_ARGS.join(" ")}\`, one thread, no I/O (${RUNS.sim} runs)`);
  lines.push("");
  row("", "Vidar", "Odin");
  row("---", "---:", "---:");
  row("time", `${fmt(median(sim.vidar), 0)} ms`, `${fmt(median(sim.odin), 0)} ms`);
  row("bot commands per second", ...["vidar", "odin"].map((k) => `${fmt(2000 * 500 / (median(sim[k]) / 1000), 0)}`));
  lines.push("");
  lines.push(`**Server under load**: ${LOAD.clients} clients × ${LOAD.commands} commands over loopback, 50 ms ticks (${RUNS.load} runs)`);
  lines.push("");
  row("", "Vidar", "Odin");
  row("---", "---:", "---:");
  row("throughput", ...["vidar", "odin"].map((k) => `${fmt(pick(k, (x) => x.throughput), 0)} cmd/s`));
  row("latency p50", ...["vidar", "odin"].map((k) => `${fmt(pick(k, (x) => x.p50_ms), 3)} ms`));
  row("latency p99", ...["vidar", "odin"].map((k) => `${fmt(pick(k, (x) => x.p99_ms), 3)} ms`));
  row("latency max", ...["vidar", "odin"].map((k) => `${fmt(pick(k, (x) => x.max_ms), 1)} ms`));
  row("failed clients", ...["vidar", "odin"].map((k) => `${Math.max(...load[k].map((x) => x.failed))}`));
  row("RSS idle → after load", ...["vidar", "odin"].map((k) => `${fmt(pick(k, (x) => x.idle))} → ${fmt(pick(k, (x) => x.peak))} MB`));

  const report = lines.join("\n") + "\n";
  writeFileSync(join(EX, "bench/results.md"), report);
  process.stdout.write(report);
  rmSync(WORK, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
