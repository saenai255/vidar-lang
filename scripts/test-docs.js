#!/usr/bin/env node
// Tests the book in docs/src: every `vidar` code block compiles (or fails to, for compile_fail), programs
// followed by an ```output block print it, and every link resolves. See scripts/docblocks.js for the
// attributes a block can carry.
//
//   node scripts/test-docs.js [-jN] [--only <text>] [--show] [--links]
//     --only <text>  only pages whose path contains <text>
//     --show         print what each program printed (to write an ```output or ```error block)
//     --links        only check the links
// Programs that import vidar:sched are only compiled, unless VIDAR_DOCS_RUN_GOROUTINES=1 is set.
// Runs dist/: `npm run build` first.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { parseBlocks, compiled, isVidar } = require("./docblocks");

const root = path.join(__dirname, "..");
const srcDir = path.join(root, "docs", "src");
const cli = path.join(root, "dist", "cli.js");

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const jobs = Number((args.find((a) => /^-j\d+$/.test(a)) ?? `-j${Math.max(1, Math.floor(os.cpus().length / 2))}`).slice(2));
const only = opt("--only");
const show = flag("--show");

const pages = [];
const walk = (dir) => {
  for (const f of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (f.endsWith(".md")) pages.push(p);
  }
};
walk(srcDir);
const rel = (p) => path.relative(srcDir, p).split(path.sep).join("/");

// ---- links ----

const slug = (heading) =>
  heading
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .split("")
    .map((ch) => (/[\p{L}\p{N}_-]/u.test(ch) ? ch.toLowerCase() : /\s/.test(ch) ? "-" : ""))
    .join("");

const anchorsOf = new Map();
const anchors = (file) => {
  if (anchorsOf.has(file)) return anchorsOf.get(file);
  const ids = new Set();
  const seen = new Map();
  const text = fs.readFileSync(file, "utf8");
  const code = new Set();
  for (const b of parseBlocks(text)) for (let i = b.start; i <= b.end; i++) code.add(i);
  text.split("\n").forEach((line, i) => {
    if (code.has(i)) return;
    const m = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (m) {
      let id = slug(m[1]);
      const n = seen.get(id) ?? 0;
      seen.set(id, n + 1);
      if (n) id = `${id}-${n}`;
      ids.add(id);
    }
    for (const a of line.matchAll(/id="([^"]+)"/g)) ids.add(a[1]);
  });
  anchorsOf.set(file, ids);
  return ids;
};

const linkFailures = [];
const inSummary = new Set();
for (const page of pages) {
  const text = fs.readFileSync(page, "utf8");
  const code = new Set();
  for (const b of parseBlocks(text)) for (let i = b.start; i <= b.end; i++) code.add(i);
  text.split("\n").forEach((line, i) => {
    if (code.has(i)) return;
    const stripped = line.replace(/`[^`]*`/g, "");
    for (const m of stripped.matchAll(/\]\(([^)\s]+)\)/g)) {
      const href = m[1];
      if (/^(https?:|mailto:)/.test(href)) continue;
      const [file, anchor] = href.split("#");
      const target = file ? path.resolve(path.dirname(page), file) : page;
      const where = `${rel(page)}:${i + 1}`;
      if (!fs.existsSync(target)) {
        linkFailures.push(`${where}: no such file: ${href}`);
        continue;
      }
      if (rel(page) === "SUMMARY.md") inSummary.add(target);
      if (anchor && target.endsWith(".md") && !anchors(target).has(anchor)) linkFailures.push(`${where}: no heading #${anchor} in ${file || rel(page)}`);
    }
  });
}
for (const page of pages) {
  if (rel(page) !== "SUMMARY.md" && !inSummary.has(page)) linkFailures.push(`${rel(page)}: not listed in SUMMARY.md`);
}

// ---- programs ----

const IMPORTS = {
  fmt: "core:fmt", strings: "core:strings", strconv: "core:strconv", os: "core:os", math: "core:math", mem: "core:mem",
  time: "core:time", sync: "core:sync", testing: "core:testing", log: "core:log", slice: "core:slice",
  json: "core:encoding/json", intrinsics: "base:intrinsics", runtime: "base:runtime", rand: "core:math/rand",
  sched: "vidar:sched", rc: "vidar:rc", filepath: "core:path/filepath", utf8: "core:unicode/utf8",
  unicode: "core:unicode", linalg: "core:math/linalg", bufio: "core:bufio", io: "core:io", sort: "core:sort",
  queue: "core:container/queue", bits: "core:math/bits", net: "core:net", small_array: "core:container/small_array",
  thread: "core:thread", virtual: "core:mem/virtual", simd: "core:simd", nbio: "core:nbio", hash: "core:hash", reflect: "core:reflect", unicode_utf8: "core:unicode/utf8",
};

const DECL = /^(@\(|@\w|impl\s|import\s|foreign\s|#\+|#assert|[A-Za-z_]\w*(\s*,\s*[A-Za-z_]\w*)*\s*::)/;

/** A block's lines as a whole file: `package main`, the imports it uses, and a `main` around its statements. */
const toFile = (lines, { addMain = true } = {}) => {
  if (lines.some((l) => /^package\s/.test(l))) return lines.join("\n") + "\n";
  const code = lines.map((l) => l.replace(/"(\\.|[^"\\])*"|`[^`]*`|'(\\.|[^'\\])*'/g, '""').replace(/\/\/.*$/, "")).join("\n");
  const imported = new Set();
  for (const m of lines.join("\n").matchAll(/^\s*import\s+(?:(\w+)\s+)?"([^"]+)"/gm)) imported.add(m[1] ?? m[2].split(/[:/]/).pop());
  const imports = [];
  for (const [name, pkg] of Object.entries(IMPORTS)) {
    if (imported.has(name)) continue;
    if (new RegExp(`(?<![\\w.])${name}\\.[A-Za-z_]`).test(code)) imports.push(pkg === `core:${name}` || pkg.endsWith(`/${name}`) ? `import "${pkg}"` : `import ${name} "${pkg}"`);
  }
  const decls = [];
  const stmts = [];
  let pending = [];
  let into = null;
  // With a main of its own, the block is a whole file: everything at column 0 is at file scope.
  const ownMain = lines.some((l) => /^main\s*::/.test(l));
  for (const line of ownMain ? [] : lines) {
    if (/^\s*$/.test(line) || /^\s/.test(line) || /^[})\]]/.test(line)) {
      (into ?? pending).push(line);
      continue;
    }
    if (/^\/\//.test(line)) {
      if (into === stmts) stmts.push(line);
      else pending.push(line);
      continue;
    }
    into = DECL.test(line) ? decls : stmts;
    into.push(...pending, line);
    pending = [];
  }
  (into ?? decls).push(...pending);
  if (ownMain) decls.push(...lines);
  const hasMain = ownMain;
  const body = stmts.some((l) => l.trim() && !l.trim().startsWith("//"));
  const out = ["package main", "", ...imports, "", ...decls];
  if (body) out.push("", "main :: proc() {", ...stmts, "}");
  else if (!hasMain && addMain) out.push("", "main :: proc() {}");
  return out.join("\n") + "\n";
};

// Locations differ between the page and the program that is built, and so do times, so messages are
// compared without them.
const unlocate = (s) =>
  s
    .replace(/\[\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\]/g, "")
    .replace(/\b\d+(\.\d+)?(µs|ms|ns|s)\b/g, "")
    .replace(/\[[^\]\s]*:\d+(:\w*\(\))?\]/g, "")
    .replace(/[\w./\\-]+\.(vidar|odin)\(\d+:\d+\)/g, "")
    .replace(/[\w./\\-]+\.(vidar|odin):\d+(:\d+)?:?/g, "")
    .replace(/\s+/g, " ")
    .trim();

const lines = (s) => s.replace(/\r/g, "").split("\n").map((l) => l.trimEnd());
const trimEnd = (ls) => {
  while (ls.length && !ls[ls.length - 1]) ls.pop();
  return ls;
};

/** `...` on a line of its own matches any number of lines. */
const matches = (want, got) => {
  const go = (i, j) => {
    if (i === want.length) return j === got.length;
    if (want[i] === "...") {
      for (let k = j; k <= got.length; k++) if (go(i + 1, k)) return true;
      return false;
    }
    return j < got.length && want[i] === got[j] && go(i + 1, j + 1);
  };
  return go(0, 0);
};

const tests = [];
// Projects carry over from page to page, in reading order, so a project chapter can grow one program.
const projects = new Map();
for (const page of pages) {
  if (only && !rel(page).includes(only)) continue;
  const text = fs.readFileSync(page, "utf8");
  const blocks = parseBlocks(text);
  let last = null; // the program the next ```output / ```error block belongs to
  const add = (t) => {
    tests.push(t);
    return t;
  };
  const snapshot = (name) => {
    const p = projects.get(name);
    return { files: new Map(p.files), flags: new Set(p.flags) };
  };
  for (const b of blocks) {
    if (isVidar(b) || (b.attrs.project && b.attrs.file)) {
      if (isVidar(b) && b.attrs.flags.has("ignore")) {
        last = null;
        continue;
      }
      const where = `${rel(page)}:${b.start + 1}`;
      if (b.attrs.project) {
        const p = projects.get(b.attrs.project) ?? { files: new Map(), flags: new Set(), tested: false, where };
        projects.set(b.attrs.project, p);
        const file = b.attrs.file ?? "main.vidar";
        p.files.set(file, isVidar(b) ? toFile(compiled(b.content), { addMain: file === "main.vidar" }) : b.content.join("\n") + "\n");
        for (const f of b.attrs.flags) p.flags.add(f);
        p.where = where;
        last = { project: b.attrs.project };
      } else {
        last = add({ where, files: new Map([["main.vidar", toFile(compiled(b.content))]]), flags: b.attrs.flags });
      }
      continue;
    }
    if (b.lang === "output" || b.lang === "error") {
      if (!last) continue;
      let t = last;
      if (last.project) {
        const p = projects.get(last.project);
        t = add({ where: p.where, ...snapshot(last.project) });
        p.tested = true;
        last = t;
      }
      t[b.lang] = b.content;
    }
  }
}
for (const [name, p] of projects) if (!p.tested) tests.push({ where: p.where, files: new Map(p.files), flags: new Set(p.flags) });

const run = (argv, cwd, tmp) =>
  new Promise((resolve) => {
    // its own process group, so a timeout also kills the odin it started
    const child = spawn(process.execPath, [cli, ...argv], { cwd, detached: true, env: { ...process.env, TMPDIR: tmp, VIDAR_GOROUTINES: "1" } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, 60_000);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code: signal ? `killed (${signal})` : code, stdout, stderr });
    });
  });

const base = fs.mkdtempSync(path.join(os.tmpdir(), "vidar-docs-"));

const check = async (t, n) => {
  const dir = path.join(base, String(n));
  const tmp = path.join(dir, "tmp");
  const prog = path.join(dir, "prog");
  fs.mkdirSync(tmp, { recursive: true });
  for (const [f, text] of t.files) {
    fs.mkdirSync(path.dirname(path.join(prog, f)), { recursive: true });
    fs.writeFileSync(path.join(prog, f), text);
  }
  // Goroutines are disabled for now (src/sched.ts): their programs are compiled, and run only when asked to.
  const usesSched = !process.env.VIDAR_DOCS_RUN_GOROUTINES && [...t.files.values()].some((f) => /"vidar:sched"/.test(f));
  const failCompile = t.flags.has("compile_fail");
  const panics = t.flags.has("should_panic");
  const testIt = t.flags.has("test") && !failCompile && !usesSched;
  const runIt = !testIt && !failCompile && !usesSched && !t.flags.has("no_run") && (t.output || panics);
  const optFlag = t.flags.has("opt") ? ["-opt"] : [];
  const command = testIt ? "test" : runIt ? "run" : "check";
  // run in the program's directory, so it can open files that sit next to it (```text,project=...,file=...)
  const argv = [command, prog, ...optFlag, ...(testIt ? ["--", "-define:ODIN_TEST_THREADS=1"] : [])];
  let r = await run(argv, prog, tmp);
  // `odin` sometimes spins on code that normally builds in a fraction of a second (AGENTS.md, "Known
  // hangs"): a run that was killed gets one retry
  if (typeof r.code === "string") r = await run(argv, prog, tmp);
  const all = r.stdout + r.stderr;
  const problems = [];
  if (failCompile) {
    if (r.code === 0) problems.push("compiled, but the block is marked compile_fail");
  } else if (panics && (runIt || testIt)) {
    if (r.code === 0) problems.push(`exited 0, but the block is marked should_panic`);
  } else if (r.code !== 0) problems.push(`exited ${r.code}`);
  if (t.output && runIt) {
    const want = trimEnd(lines(t.output.join("\n")));
    const got = trimEnd(lines(r.stdout));
    if (!matches(want, got)) problems.push(`output differs:\n--- want\n${want.join("\n")}\n--- got\n${got.join("\n")}`);
  }
  if (t.error) {
    const got = unlocate(all);
    for (const want of t.error.filter((l) => l.trim())) if (!got.includes(unlocate(want))) problems.push(`no message like: ${want.trim()}`);
  }
  if (problems.length || show) {
    const files = [...t.files].map(([f, text]) => `---- ${f}\n${text}`).join("");
    t.report = `${problems.join("\n")}${problems.length ? "\n" : ""}${show || problems.length ? `${files}---- ${command} printed:\n${all}` : ""}`;
  }
  t.ok = problems.length === 0;
  fs.rmSync(dir, { recursive: true, force: true });
};

(async () => {
  let failed = 0;
  for (const f of linkFailures) {
    console.log(`FAIL link ${f}`);
    failed++;
  }
  if (!flag("--links")) {
    let next = 0;
    await Promise.all(
      Array.from({ length: jobs }, async () => {
        while (next < tests.length) {
          const n = next++;
          await check(tests[n], n);
        }
      }),
    );
    for (const t of tests) {
      console.log(`${t.ok ? "PASS" : "FAIL"} ${t.where}`);
      if (t.report) console.log(t.report.replace(/^/gm, "    "));
      if (!t.ok) failed++;
    }
  }
  fs.rmSync(base, { recursive: true, force: true });
  const total = (flag("--links") ? 0 : tests.length) + linkFailures.length;
  console.log(`\n${total - failed} passed, ${failed} failed (${tests.length} programs, ${linkFailures.length} broken links)`);
  process.exit(failed ? 1 : 0);
})();
