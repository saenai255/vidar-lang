const { test } = require("node:test");
const assert = require("node:assert/strict");
const { existsSync, readFileSync, readdirSync, statSync } = require("node:fs");
const { join, resolve } = require("node:path");

const root = resolve(__dirname, "../..");
const dist = join(root, "dist");
const { format, formatEdits } = require("../../dist/format.js");
const { lex } = require("../../dist/lexer.js");

const walk = (d) =>
  readdirSync(d).sort().flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".vidar") ? [p] : [];
  });

test("indents by bracket depth with tabs, case at its switch's level", () => {
  const src = "main :: proc() {\n    x := 1\n  switch x {\n      case 1:\n  f(a,\n b)\n    }\n}\n";
  assert.equal(format(src), "main :: proc() {\n\tx := 1\n\tswitch x {\n\tcase 1:\n\t\tf(a,\n\t\t\tb)\n\t}\n}\n");
});

test("a continued expression goes one deeper; brackets opened on one line share a level", () => {
  assert.equal(format("f :: proc() {\nx := a +\nb\n}\n"), "f :: proc() {\n\tx := a +\n\t\tb\n}\n");
  assert.equal(format("x := foo(Bar{\na = 1,\n})\n"), "x := foo(Bar{\n\ta = 1,\n})\n");
  assert.equal(format("call(a, proc() {\ninner()\n}, proc() {\ninner()\n})\n"), "call(a, proc() {\n\tinner()\n}, proc() {\n\tinner()\n})\n");
});

test("spaces binary operators and commas, tightens parens, calls and selectors", () => {
  const f = (s) => format(`f :: proc() {\n\t${s}\n}\n`).split("\n")[1].slice(1);
  assert.equal(f("x:=1+2*3"), "x := 1 + 2 * 3");
  assert.equal(f("y := foo( x , -1 )"), "y := foo(x, -1)");
  assert.equal(f("if x>2&&y<3 {}"), "if x > 2 && y < 3 {}");
  assert.equal(f("p := a . b"), "p := a.b");
  assert.equal(f("g(a[1:2], -x, &y, cast(int)-x, p^)"), "g(a[1:2], -x, &y, cast(int)-x, p^)");
  assert.equal(f("for i := 0; i<10; i+=1 {}"), "for i := 0; i < 10; i += 1 {}");
  assert.equal(f("q := sum!(x)*2"), "q := sum!(x) * 2");
  assert.equal(f("take -1"), "take -1");
});

test("leaves what it isn't sure about: attributes, alignment, specializations, ranges", () => {
  const keep = [
    '@(require_results, link_name="x")\n',
    "a   :: 1\nbcd :: 2\n",
    "f :: proc($T: typeid/[]$E) {}\n",
    "g :: proc() { for i in 0..<10 {} }\n",
    "x := 1  // aligned comment\n",
    "s := `raw\n   text   `\n",
    "/* block\n   comment */\nx := 1\n",
  ];
  for (const s of keep) assert.equal(format(s), s);
});

test("strips trailing whitespace and trailing blank lines but keeps every line", () => {
  assert.equal(format("x := 1   \n\n\n\ny := 2\n\t\n\n"), "x := 1\n\n\n\ny := 2\n");
  assert.equal(format(""), "");
  assert.equal(format("x := 1"), "x := 1\n");
  assert.equal(format("x := 1\r\ny := 2\r\n"), "x := 1\r\ny := 2\r\n");
});

test("formatEdits replaces only the lines that change", () => {
  const edits = formatEdits("x := 1\ny:=2\nz := 3\n");
  assert.deepEqual(edits, [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } }, newText: "y := 2" }]);
  assert.deepEqual(formatEdits("x := 1\n"), []);
});

// ---- over every case and example: idempotent, and the program transpiles the same apart from whitespace ----

const corpus = [...walk(join(root, "tests")), ...walk(join(root, "examples")), join(root, "src", "prelude.vidar")];

test("formatting is idempotent over every .vidar file in the repository, and indentation comes from the tokens alone", () => {
  for (const f of corpus) {
    const src = readFileSync(f, "utf8");
    const once = format(src, f);
    assert.equal(format(once, f), once, f);
    assert.equal(format(scramble(src, false), f), once, `${f}: reindents differently`);
  }
});

/** program roots: case inputs, examples with a main.vidar, slime_mud */
function programs() {
  const roots = [];
  for (const dir of [join(root, "tests", "cases"), join(root, "examples")]) {
    for (const name of readdirSync(dir).sort()) {
      const d = join(dir, name);
      const opt = name.startsWith("opt_");
      if (existsSync(join(d, "input.vidar"))) roots.push({ entry: join(d, "input.vidar"), opt });
      else if (existsSync(join(d, "input"))) roots.push({ entry: join(d, "input"), opt });
      else if (existsSync(join(d, "main.vidar"))) roots.push({ entry: d, opt });
    }
  }
  roots.push({ entry: join(root, "examples", "slime_mud", "vidar"), opt: false });
  return roots;
}

/** generated Odin as tokens, whitespace ignored (inside strings too: `dbg!`/`stringify` labels follow the source's spacing) */
const tokensOf = (text) => lex(text, "gen").map((t) => (t.kind === "string" ? t.text.replace(/\s+/g, "") : t.text)).join("\u0000");

function emitAll(project, entry, opt, overrides) {
  const program = project.loadProgram(entry, { optimize: opt, overrides });
  if (program.errors.length) throw program.errors[0];
  const out = project.emitProgram(program);
  // the scheduler's assembly isn't Odin; it is copied as is
  return { program, files: new Map([...out.files].map(([k, v]) => [k, k.endsWith(".odin") ? tokensOf(v) : v])) };
}

/** The same tokens on the same lines with the whitespace messed up: other indentation, trailing blanks, wider gaps. */
function scramble(src, gaps = true) {
  let seed = src.length;
  const pick = (xs) => xs[(seed = (seed * 1103515245 + 12345) % 2147483648) % xs.length];
  return lex(src, "x")
    .map((t) => {
      let pre = t.pre;
      if (!pre.includes("/*")) {
        if (pre.includes("\n")) pre = pre.replace(/[ \t]*\n[ \t]*/g, () => pick(["", " ", "\t "]) + "\n" + pick(["", "  ", "\t\t\t", " \t", "\t"]));
        else if (gaps && pre !== "") pre = pick([" ", "  ", "\t", pre]);
      }
      return pre + t.text;
    })
    .join("");
}

const baseline = new Map();
const key = (entry, opt) => `${entry}${opt ? " -opt" : ""}`;

test("formatting never changes what a case or example transpiles to, with and without -opt", () => {
  const project = require("../../dist/project.js");
  for (const { entry, opt } of programs()) {
    for (const optimize of [opt, !opt]) {
      const before = emitAll(project, entry, optimize);
      baseline.set(key(entry, optimize), before.files);
      // every source of the program messed up, then formatted
      const overrides = new Map();
      for (const s of before.program.sources) {
        if (!s.path.endsWith(".vidar") || !existsSync(s.path)) continue;
        const src = readFileSync(s.path, "utf8");
        const messy = format(scramble(src), s.path);
        assert.equal(format(messy, s.path), messy, `${s.path}: not idempotent after scrambling`);
        overrides.set(s.path, messy);
      }
      const after = emitAll(project, entry, optimize, overrides);
      assert.deepEqual([...after.files.keys()], [...before.files.keys()], entry);
      for (const [name, toks] of before.files) assert.ok(after.files.get(name) === toks, `${key(entry, optimize)}: ${name} transpiles differently once formatted`);
    }
  }
});

test("a formatted prelude transpiles every program the same", () => {
  // the prelude is read once, when dist/prelude.js loads; the bundle hands it in through VIDAR_PRELUDE
  globalThis.VIDAR_PRELUDE = format(scramble(readFileSync(join(root, "src", "prelude.vidar"), "utf8")));
  const saved = Object.keys(require.cache).filter((k) => k.startsWith(dist)).map((k) => [k, require.cache[k]]);
  for (const [k] of saved) delete require.cache[k];
  try {
    const fresh = require("../../dist/project.js");
    for (const { entry, opt } of programs()) {
      const before = baseline.get(key(entry, opt));
      if (before) assert.deepEqual(emitAll(fresh, entry, opt).files, before, entry);
    }
  } finally {
    delete globalThis.VIDAR_PRELUDE;
    for (const k of Object.keys(require.cache)) if (k.startsWith(dist)) delete require.cache[k];
    for (const [k, m] of saved) require.cache[k] = m;
  }
});
