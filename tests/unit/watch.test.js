const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { watch, runChild, projectFiles, wantsWatch } = require("../../dist/watch.js");

/** Writes { "dir/file.vidar": text } under a fresh temp dir and returns its path. */
function tree(files) {
  const root = mkdtempSync(join(tmpdir(), "vidar-unit-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Waits until `cond()` holds; the timeout is generous so a loaded machine doesn't fail the test. */
async function until(cond, what, ms = 15000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

/** A watcher that counts runs and whether it is waiting for changes. */
function counting(opts) {
  const s = { runs: 0, waiting: 0 };
  s.w = watch({
    ...opts,
    run: async (signal) => {
      s.runs++;
      if (opts.run) await opts.run(signal);
    },
    onWaiting: () => s.waiting++,
  });
  return s;
}

// a killed process nobody has reaped yet (a zombie) still answers signal 0
const alive = (pid) => {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return true;
  }
};

test("wantsWatch only looks before --", () => {
  assert.equal(wantsWatch(["run", "x", "--watch"]), true);
  assert.equal(wantsWatch(["check", "--watch", "x"]), true);
  assert.equal(wantsWatch(["run", "x", "--", "--watch"]), false);
  assert.equal(wantsWatch(["run", "x"]), false);
});

test("projectFiles lists the project's package directories, not bundled ones", () => {
  const root = tree({
    "main.vidar": 'package main\nimport "a"\nimport "vidar:sched"\nimport "core:fmt"\nmain :: proc() { fmt.println(a.x) }\n',
    "a/a.vidar": "package a\nx :: 1\n",
    "other/b.vidar": "package b\n",
  });
  assert.deepEqual(projectFiles(root).sort(), [root, join(root, "a")].sort());
  // a single file is watched as itself, plus the packages it imports
  assert.deepEqual(projectFiles(join(root, "main.vidar")).sort(), [join(root, "main.vidar"), join(root, "a")].sort());
  // a program with errors still gives its files
  writeFileSync(join(root, "a", "a.vidar"), "package a\nx :: (\n");
  assert.deepEqual(projectFiles(root).sort(), [root, join(root, "a")].sort());
});

test("changes in quick succession give one rerun", async () => {
  const root = tree({ "main.vidar": "package main\n" });
  const s = counting({ files: () => [root] });
  try {
    await until(() => s.waiting === 1, "the first run");
    for (let i = 0; i < 5; i++) writeFileSync(join(root, "main.vidar"), `package main\n// ${i}\n`);
    await until(() => s.waiting === 2, "the rerun");
    await sleep(500);
    assert.equal(s.runs, 2);
  } finally {
    await s.w.close();
  }
});

test("reruns on a change to any watched file, and recomputes the file set", async () => {
  const root = tree({ "main.vidar": "package main\n", "notes.txt": "", "lib/lib.vidar": "package lib\n", "single.vidar": "" });
  let set = [root];
  const s = counting({ files: () => set });
  try {
    await until(() => s.waiting === 1, "the first run");
    // not a source file, and a package nobody imports yet
    writeFileSync(join(root, "notes.txt"), "x");
    writeFileSync(join(root, "lib", "lib.vidar"), "package lib\n// 1\n");
    await sleep(600);
    assert.equal(s.runs, 1);
    // a new source file in a watched package counts
    writeFileSync(join(root, "new.vidar"), "package main\n");
    await until(() => s.waiting === 2, "the rerun for a new file");
    set = [root, join(root, "lib")];
    writeFileSync(join(root, "main.vidar"), "package main\n// 1\n");
    await until(() => s.waiting === 3, "the rerun that picks up lib/");
    writeFileSync(join(root, "lib", "lib.vidar"), "package lib\n// 2\n");
    await until(() => s.waiting === 4, "the rerun for lib/");
    assert.equal(s.runs, 4);
  } finally {
    await s.w.close();
  }
});

test("a watched single file ignores its neighbours", async () => {
  const root = tree({ "one.vidar": "package main\n", "two.vidar": "package main\n" });
  const s = counting({ files: () => [join(root, "one.vidar")] });
  try {
    await until(() => s.waiting === 1, "the first run");
    writeFileSync(join(root, "two.vidar"), "package main\n// 1\n");
    await sleep(600);
    assert.equal(s.runs, 1);
    writeFileSync(join(root, "one.vidar"), "package main\n// 1\n");
    await until(() => s.waiting === 2, "the rerun");
  } finally {
    await s.w.close();
  }
});

test("polling sees changes too", async () => {
  const root = tree({ "main.vidar": "package main\n" });
  const s = counting({ files: () => [root], poll: 50 });
  try {
    await until(() => s.waiting === 1, "the first run");
    writeFileSync(join(root, "main.vidar"), "package main\n// a longer file\n");
    await until(() => s.waiting === 2, "the rerun");
    writeFileSync(join(root, "added.vidar"), "package main\n");
    await until(() => s.waiting === 3, "the rerun for a new file");
  } finally {
    await s.w.close();
  }
});

test("a change kills the running child and what it started", async () => {
  const root = tree({ "main.vidar": "package main\n" });
  const pids = join(root, "pids.txt");
  // the child starts a grandchild (as `odin run` starts the program), records both pids, and never exits
  const grandchild = "setInterval(() => {}, 1000)";
  const child = `
    const { spawn } = require("node:child_process");
    const g = spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: "ignore" });
    require("node:fs").appendFileSync(${JSON.stringify(pids)}, process.pid + " " + g.pid + "\\n");
    setInterval(() => {}, 1000);`;
  const codes = [];
  const s = counting({
    files: () => [root],
    run: async (signal) => codes.push(await runChild(process.execPath, ["-e", child], signal)),
  });
  try {
    const lines = () => (existsSync(pids) ? readFileSync(pids, "utf8").trim().split("\n") : []);
    await until(() => lines().length === 1, "the first child");
    const first = lines()[0].split(" ").map(Number);
    assert.ok(first.every(alive));
    writeFileSync(join(root, "main.vidar"), "package main\n// 1\n");
    await until(() => lines().length === 2, "the second child");
    assert.deepEqual(codes, [null]);
    await until(() => !first.some(alive), "the first child and grandchild to be gone");
    const second = lines()[1].split(" ").map(Number);
    assert.ok(second.every(alive));
    await s.w.close();
    await until(() => !second.some(alive), "close() to kill the second child and grandchild");
    assert.equal(s.runs, 2);
  } finally {
    await s.w.close();
  }
});

test("runChild resolves with the exit code", async () => {
  const code = await runChild(process.execPath, ["-e", "process.exit(3)"], new AbortController().signal);
  assert.equal(code, 3);
});
