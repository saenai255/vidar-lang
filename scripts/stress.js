// Runs one program many times to catch rare hangs and wrong output.
//   node scripts/stress.js <case> [-n 500] [-t 10] [-jN] [-opt] [-o:speed] [-define:NAME=VALUE ...]
//
// <case> is a tests/cases/<name> or examples/<name> directory, or a .vidar file or package directory.
// The program is built once, then run -n times, -jN at a time, each with a -t second timeout.
// Output is compared with the case's stdout.txt when it has one.
// On a hang the process is left running long enough to take its stack (`sample` on macOS,
// `gdb` on Linux, when installed), which is saved next to the binary; then it is killed.
// The binary and stacks stay in $TMPDIR/vidar-stress-*. Exits 1 on any hang or wrong output.
const { existsSync, mkdtempSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir, availableParallelism } = require("node:os");
const { spawn, spawnSync } = require("node:child_process");

const args = process.argv.slice(2);
const flag = (name, dflt) => (args.includes(name) ? Number(args[args.indexOf(name) + 1]) : dflt);
const target = args.find((a, i) => !a.startsWith("-") && !["-n", "-t"].includes(args[i - 1]));
if (!target) {
  console.error("usage: node scripts/stress.js <case> [-n 500] [-t 10] [-jN] [-opt] [-o:speed] [-define:NAME=VALUE ...]");
  process.exit(2);
}
const RUNS = flag("-n", 500);
const TIMEOUT = flag("-t", 10) * 1000;
const JOBS = Number(args.find((a) => /^-j\d+$/.test(a))?.slice(2)) || Math.max(2, Math.floor(availableParallelism() / 2));
const odinFlags = args.filter((a) => a.startsWith("-define:") || a.startsWith("-o:"));

let entry = target;
let stdout;
if (existsSync(join(target, "input.vidar"))) entry = join(target, "input.vidar");
else if (existsSync(join(target, "input"))) entry = join(target, "input");
if (existsSync(join(target, "stdout.txt"))) stdout = readFileSync(join(target, "stdout.txt"), "utf8");
const optimize = args.includes("-opt") || /(^|\/)opt_[^/]*\/?$/.test(target);

const work = mkdtempSync(join(tmpdir(), "vidar-stress-"));
const prog = join(work, "prog");
const step = (cmd, cmdArgs) => {
  const r = spawnSync(cmd, cmdArgs, { encoding: "utf8" });
  if (r.status !== 0) {
    console.error(`${cmd} ${cmdArgs.join(" ")} failed:\n${r.stdout}${r.stderr}`);
    process.exit(2);
  }
};
step("node", [join(__dirname, "../dist/cli.js"), "build", entry, "-o", join(work, "src"), ...(optimize ? ["-opt"] : []), ...odinFlags.filter((f) => f.startsWith("-define:"))]);
step("odin", ["build", join(work, "src"), `-out:${prog}`, ...odinFlags]);
console.log(`built ${prog}; ${RUNS} runs, ${JOBS} at a time, ${TIMEOUT / 1000} s each`);

/** A stack of every thread of a hung process, or why there is none. */
function stackOf(pid) {
  const r =
    process.platform === "darwin"
      ? spawnSync("sample", [String(pid), "3"], { encoding: "utf8" })
      : spawnSync("gdb", ["-p", String(pid), "-batch", "-ex", "thread apply all bt"], { encoding: "utf8" });
  return r.error ? `no stack: ${r.error.message}` : r.stdout + r.stderr;
}

let hangs = 0;
let bad = 0;
let next = 0;
function runOne(i) {
  return new Promise((resolve) => {
    const child = spawn(prog, [], { stdio: ["ignore", "pipe", "pipe"], cwd: work });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => {
      hangs++;
      // near 100% is a busy loop, near 0% a wait that never ends
      const cpu = spawnSync("ps", ["-o", "%cpu=", "-p", String(child.pid)], { encoding: "utf8" }).stdout.trim();
      const file = join(work, `hang-${i}.txt`);
      writeFileSync(file, `run ${i}, pid ${child.pid}, ${cpu}% cpu, output so far:\n${out}\n---- stack ----\n${stackOf(child.pid)}`);
      console.log(`HANG run ${i} (pid ${child.pid}, ${cpu}% cpu); stack in ${file}`);
      child.kill("SIGKILL");
    }, TIMEOUT);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (signal !== "SIGKILL" && (code !== 0 || (stdout !== undefined && out !== stdout))) {
        bad++;
        const file = join(work, `bad-${i}.txt`);
        writeFileSync(file, `run ${i}, exit ${code ?? signal}:\n${out}`);
        console.log(`BAD run ${i} (exit ${code ?? signal}); output in ${file}`);
      }
      resolve();
    });
  });
}

async function worker() {
  while (next < RUNS) await runOne(next++);
}

const start = Date.now();
Promise.all(Array.from({ length: JOBS }, worker)).then(() => {
  console.log(`${RUNS} runs in ${((Date.now() - start) / 1000).toFixed(1)} s: ${hangs} hung, ${bad} wrong`);
  process.exit(hangs || bad ? 1 : 0);
});
