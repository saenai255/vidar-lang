// End-to-end debug adapter test: drives `vidar dap` over stdio against a real lldb-dap.
const { spawn, spawnSync } = require("node:child_process");
const { mkdtempSync, realpathSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { tmpdir } = require("node:os");
const assert = require("node:assert/strict");
const { findBackend } = require("../dist/dap/proxy.js");
const { MessageReader, frame } = require("../dist/dap/wire.js");

if (!findBackend() || spawnSync("odin", ["version"], { stdio: "ignore" }).status !== 0) {
  console.log("SKIP dap: needs lldb-dap and odin");
  process.exit(0);
}

const program = resolve("tests/dap/closure");
const source = join(program, "main.vidar");
const lineOf = (text) => require("node:fs").readFileSync(source, "utf8").split("\n").findIndex((l) => l.includes(text)) + 1;
const out = realpathSync(mkdtempSync(join(tmpdir(), "vidar-dap-test-")));

const adapter = spawn(process.execPath, ["dist/cli.js", "dap"], { stdio: ["pipe", "pipe", "inherit"] });
let seq = 0;
const waiting = new Map();
const events = [];
const eventWaiters = [];
const reader = new MessageReader((m) => {
  if (m.type === "response") waiting.get(m.request_seq)?.(m);
  else if (m.type === "event") {
    events.push(m);
    for (const w of eventWaiters.splice(0)) w();
  }
});
adapter.stdout.on("data", (d) => reader.push(d));

const request = (command, args) =>
  new Promise((done) => {
    const s = ++seq;
    waiting.set(s, done);
    adapter.stdin.write(frame({ seq: s, type: "request", command, arguments: args }));
  });

/** The next event named `name` not yet taken. */
async function event(name, ms = 60_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const i = events.findIndex((e) => e.event === name);
    if (i >= 0) return events.splice(i, 1)[0];
    if (Date.now() > deadline) throw new Error(`no '${name}' event in ${ms} ms`);
    await new Promise((r) => (eventWaiters.push(r), setTimeout(r, 200)));
  }
}

let thread;

async function stopAt(line) {
  const stopped = await event("stopped");
  thread = stopped.body.threadId;
  const trace = await request("stackTrace", { threadId: thread, levels: 5 });
  assert.ok(trace.success, JSON.stringify(trace));
  const top = trace.body.stackFrames[0];
  assert.equal(top.source.path, source);
  assert.equal(top.line, line);
  return trace.body.stackFrames;
}

async function main() {
  const init = await request("initialize", { adapterID: "vidar", linesStartAt1: true, columnsStartAt1: true, pathFormat: "path" });
  assert.ok(init.success);
  const launched = request("launch", { program, outDir: out });
  await event("initialized");
  const body = lineOf("y := x + n");
  const set = await request("setBreakpoints", { source: { path: source }, breakpoints: [{ line: body }, { line: 1 }] });
  assert.ok(set.success, JSON.stringify(set));
  assert.equal(set.body.breakpoints[0].verified, true);
  assert.equal(set.body.breakpoints[0].line, body);
  assert.equal(set.body.breakpoints[1].verified, false);
  await request("configurationDone", {});
  assert.ok((await launched).success);

  const frames = await stopAt(body);
  assert.equal(frames[1].source.path, source);
  assert.equal(frames[1].line, lineOf("total := add(1)"));

  const step = async (command) => {
    await request(command, { threadId: thread });
    await event("stopped");
    const trace = await request("stackTrace", { threadId: thread, levels: 8 });
    return trace.body.stackFrames;
  };
  const here = (f) => `${f.source?.path === source ? "main.vidar" : f.source?.path}:${f.line}`;

  let top = (await step("next"))[0];
  assert.equal(here(top), `main.vidar:${lineOf("return triple(y)")}`);

  // into a proc of the program
  const inside = await step("stepIn");
  assert.ok(inside[0].source.path === source && [lineOf("triple :: proc"), lineOf("return x * 3")].includes(inside[0].line), `stopped in ${here(inside[0])}`);
  assert.equal(inside[1].line, lineOf("return triple(y)"));
  await step("stepOut");

  // stepping into fmt.println comes back out: Odin's own code isn't the program's
  let after = await step("next");
  for (let i = 0; i < 6 && after[0].line !== lineOf("fmt.println(total)"); i++) after = await step("next");
  assert.equal(here(after[0]), `main.vidar:${lineOf("fmt.println(total)")}`);
  after = await step("stepIn");
  assert.equal(after[0].source.path, source, `stopped in ${here(after[0])}`);

  await request("disconnect", { terminateDebuggee: true });
}

main().then(
  () => (console.log("PASS dap"), adapter.kill(), process.exit(0)),
  (err) => (console.error(`FAIL dap: ${err.stack ?? err}`), adapter.kill(), process.exit(1)),
);
