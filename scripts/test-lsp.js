// End-to-end language server test: drives dist/lsp/server.js over stdio.
const { spawn, spawnSync } = require("node:child_process");
const { mkdtempSync, readFileSync, writeFileSync, realpathSync, cpSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { pathToFileURL } = require("node:url");

const dir = realpathSync(mkdtempSync(join(tmpdir(), "vidar-lsp-test-")));
cpSync("tests/lsp/workspace", dir, { recursive: true });
const file = join(dir, "main.vidar");
const geoFile = join(dir, "geo", "geo.vidar");
const original = readFileSync(file, "utf8");
const uri = pathToFileURL(file).toString();
const lines = original.split("\n");

/** Position of the `nth` occurrence of `needle` on the first line containing `lineHas`, plus `offset`. */
function at(lineHas, needle, offset = 0, nth = 0) {
  const line = lines.findIndex((l) => l.includes(lineHas));
  if (line < 0) throw new Error(`no line with ${lineHas}`);
  let col = -1;
  for (let i = 0; i <= nth; i++) col = lines[line].indexOf(needle, col + 1);
  if (col < 0) throw new Error(`no '${needle}' on line ${line + 1}`);
  return { line, character: col + offset };
}

// VIDAR_LSP="<path> [args]" tests a built binary instead of dist/lsp/server.js
const server = process.env.VIDAR_LSP
  ? spawn(process.env.VIDAR_LSP.split(" ")[0], process.env.VIDAR_LSP.split(" ").slice(1), { stdio: ["pipe", "pipe", "inherit"] })
  : spawn(process.execPath, ["dist/lsp/server.js", "--stdio"], { stdio: ["pipe", "pipe", "inherit"] });
let buf = Buffer.alloc(0);
let nextId = 1;
const pending = new Map();
const diagnostics = [];
let diagWaiters = [];

server.stdout.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const sep = buf.indexOf("\r\n\r\n");
    if (sep < 0) return;
    const len = Number(/Content-Length: (\d+)/.exec(buf.slice(0, sep).toString())[1]);
    if (buf.length < sep + 4 + len) return;
    const msg = JSON.parse(buf.slice(sep + 4, sep + 4 + len).toString());
    buf = buf.slice(sep + 4 + len);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method === "textDocument/publishDiagnostics") {
      diagnostics.push(msg.params);
      const ws = diagWaiters;
      diagWaiters = [];
      ws.forEach((w) => w(msg.params));
    }
  }
});

function send(obj) {
  const body = JSON.stringify({ jsonrpc: "2.0", ...obj });
  server.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}
const request = (method, params) => new Promise((resolve) => {
  const id = nextId++;
  pending.set(id, resolve);
  send({ id, method, params });
});
const notify = (method, params) => send({ method, params });
function nextDiagnostics(pred = () => true, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timed out waiting for diagnostics")), timeout);
    const wait = (d) => (pred(d) ? (clearTimeout(t), resolve(d)) : diagWaiters.push(wait));
    diagWaiters.push(wait);
  });
}

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"} lsp: ${name}${ok ? "" : `\n  ${detail}`}`);
}
const doc = { uri };
let version = 1;
function change(text) {
  notify("textDocument/didChange", { textDocument: { uri, version: ++version }, contentChanges: [{ text }] });
}

(async () => {
  await request("initialize", { processId: null, rootUri: pathToFileURL(dir).toString(), capabilities: {} });
  notify("initialized", {});
  const firstDiags = nextDiagnostics();
  notify("textDocument/didOpen", { textDocument: { uri, languageId: "vidar", version, text: original } });
  const d0 = await firstDiags;
  check("valid file has no diagnostics", d0.diagnostics.length === 0, JSON.stringify(d0.diagnostics));

  const hov = await request("textDocument/hover", { textDocument: doc, position: at("v := geo.add", "add", 1) });
  const hv = hov.result?.contents?.value ?? "";
  check("hover on imported package member shows its signature", hv.includes("add :: proc(a, b: Vec2) -> Vec2") && hv.includes("geo.add"), hv);

  const defPkg = await request("textDocument/definition", { textDocument: doc, position: at("v := geo.add", "add", 1) });
  check("definition jumps into the imported package", defPkg.result?.uri === pathToFileURL(geoFile).toString() && defPkg.result?.range.start.line === 6, JSON.stringify(defPkg.result));

  const hovPkg = await request("textDocument/hover", { textDocument: doc, position: at("v := geo.add", "geo", 1) });
  check("hover on package alias describes the import", (hovPkg.result?.contents?.value ?? "").includes('import "geo"'), JSON.stringify(hovPkg.result));

  const hovCap = await request("textDocument/hover", { textDocument: doc, position: at("inc := proc", "count", 1, 1) });
  check("hover inside closure explains capture", (hovCap.result?.contents?.value ?? "").includes("captured by reference"), JSON.stringify(hovCap.result));

  const hovField = await request("textDocument/hover", { textDocument: doc, position: at("fmt.println(v.x", "v.x", 2) });
  check("hover on struct field shows its type", (hovField.result?.contents?.value ?? "").includes("x: f64"), JSON.stringify(hovField.result));

  const hovAnon = await request("textDocument/hover", { textDocument: doc, position: at("_ = box.size", "size", 1) });
  check("hover on anonymous struct field shows its inferred type", (hovAnon.result?.contents?.value ?? "").includes("size: int"), JSON.stringify(hovAnon.result));

  const hovAnonVar = await request("textDocument/hover", { textDocument: doc, position: at("box := {", "box", 1) });
  check("hover on anonymous struct variable lists its fields", (hovAnonVar.result?.contents?.value ?? "").includes("box: struct {\n\tsize:  int,\n\tlabel: string,\n}"), JSON.stringify(hovAnonVar.result));

  const hovAnonLit = await request("textDocument/hover", { textDocument: doc, position: at("box := {", "label", 1) });
  check("hover on a field name inside the literal shows its type", (hovAnonLit.result?.contents?.value ?? "").includes("label: string"), JSON.stringify(hovAnonLit.result));

  const defAnon = await request("textDocument/definition", { textDocument: doc, position: at("_ = box.size", "label", 1) });
  check("definition of anonymous struct field jumps into the literal", defAnon.result?.range.start.line === at("box := {", "label").line && defAnon.result?.range.start.character === at("box := {", "label").character, JSON.stringify(defAnon.result));

  const def = await request("textDocument/definition", { textDocument: doc, position: at("inc := proc", "count", 1, 1) });
  check("definition of captured variable jumps to its declaration", def.result?.range.start.line === at("count := 0", "count").line, JSON.stringify(def.result));

  const defMethod = await request("textDocument/definition", { textDocument: doc, position: at("fmt.println", "area", 1) });
  check("definition of interface method call jumps to its declaration", defMethod.result?.range.start.line === at("area :: proc", "area").line, JSON.stringify(defMethod.result));

  const hovMethod = await request("textDocument/hover", { textDocument: doc, position: at("fmt.println", "area", 1) });
  const hm = hovMethod.result?.contents?.value ?? "";
  check("hover on interface method shows its interface and implementations", hm.includes("method of `Shape`") && hm.includes("`sq_area` (`Sq`)"), hm);

  const defBound = await request("textDocument/definition", { textDocument: doc, position: at("impl Shape for Sq", "sq_area", 1) });
  check("definition of a proc bound in an impl jumps to the proc", defBound.result?.range.start.line === at("sq_area :: proc", "sq_area").line, JSON.stringify(defBound.result));

  const defMacro = await request("textDocument/definition", { textDocument: doc, position: at("fmt.println", "twice", 1) });
  check("definition of macro call jumps to the comptime proc", defMacro.result?.range.start.line === at("twice :: comptime", "twice").line, JSON.stringify(defMacro.result));

  const refs = await request("textDocument/references", { textDocument: doc, position: at("count := 0", "count"), context: { includeDeclaration: true } });
  check("references include capture list, closure body and macro argument", refs.result?.length === 5, JSON.stringify(refs.result?.map((r) => r.range.start)));

  const ren = await request("textDocument/rename", { textDocument: doc, position: at("count := 0", "count"), newName: "clicks" });
  check("rename edits every reference", ren.result?.changes?.[uri]?.length === 5, JSON.stringify(ren.result));

  const edits = [...(ren.result?.changes?.[uri] ?? [])].sort((a, b) => b.range.start.line - a.range.start.line || b.range.start.character - a.range.start.character);
  const renamed = lines.slice();
  for (const e of edits) {
    const l = renamed[e.range.start.line];
    renamed[e.range.start.line] = l.slice(0, e.range.start.character) + e.newText + l.slice(e.range.end.character);
  }
  const { transpile } = require("../dist/cli.js");
  let renameOk = false;
  try {
    const out = [...transpile([{ path: file, text: renamed.join("\n") }]).values()][0];
    renameOk = !/\bcount\b/.test(renamed.join("\n")) && out.includes("clicks := new_clone(0)");
  } catch (e) {
    renameOk = false;
  }
  check("renamed program still transpiles with no stale name", renameOk, renamed.filter((l) => /count|clicks/.test(l)).join("\n"));

  const syms = await request("textDocument/documentSymbol", { textDocument: doc });
  const names = (syms.result ?? []).map((s) => s.name);
  check("outline lists interface, impl and procs", ["Shape", "impl Shape for Sq", "twice", "main"].every((n) => names.includes(n)), JSON.stringify(names));
  const implSym = (syms.result ?? []).find((x) => x.name === "impl Shape for Sq");
  check("outline lists the impl's bindings", implSym?.children?.some((c) => c.name === "area = sq_area"), JSON.stringify(implSym));

  const gen = await request("vidar/generatedOdin", { uri });
  check("generated Odin request covers the whole program", (gen.result?.files?.["geo/geo.odin"] ?? "").includes("add :: proc") && gen.result?.main === "main.odin", JSON.stringify(gen.result).slice(0, 200));

  // completion while typing (the edited line does not parse yet)
  const typing = (line) => original.replace("\tinc()\n", `\tinc()\n\t${line}\n`);
  const typedPos = (line) => ({ line: lines.findIndex((l) => l === "\tinc()") + 1, character: line.length + 1 });
  const complete = async (line) => {
    change(typing(line));
    await new Promise((r) => setTimeout(r, 300));
    const res = await request("textDocument/completion", { textDocument: doc, position: typedPos(line) });
    return (res.result ?? []).map((c) => c.label);
  };
  const nsItems = await complete("geo.");
  check("completion after a package alias lists public members only", nsItems.includes("add") && nsItems.includes("Vec2") && !nsItems.includes("helper"), JSON.stringify(nsItems));
  const methodItems = await complete("ar");
  check("completion offers interface methods as procs", methodItems.includes("area"), JSON.stringify(methodItems));
  const fieldItems = await complete("v.");
  check("completion after struct value lists fields", fieldItems.includes("x") && fieldItems.includes("y"), JSON.stringify(fieldItems));
  const anonItems = await complete("box.");
  check("completion after anonymous struct value lists its fields", anonItems.includes("size") && anonItems.includes("label"), JSON.stringify(anonItems));
  const scopeItems = await complete("co");
  check("completion offers locals, macros and imports in scope", scopeItems.includes("count") && scopeItems.includes("twice!") && scopeItems.includes("geo"), JSON.stringify(scopeItems.slice(0, 20)));
  check("completion offers the built-in macros", ["scoped!", "check!", "format!", "dbg!", "locked!"].every((m) => scopeItems.includes(m)), JSON.stringify(scopeItems.filter((x) => x.endsWith("!"))));

  // plain Odin goes to ols, when installed
  if (spawnSync("sh", ["-c", "command -v ols"]).status !== 0) {
    console.log("SKIP lsp: ols not on PATH");
  } else {
    const odinLine = '\tfmt.println("hi", fmt.tprint(1))';
    const odinPos = (needle, offset = 0) => ({ line: typedPos("").line, character: odinLine.indexOf(needle) + offset });
    change(typing(odinLine));
    await new Promise((r) => setTimeout(r, 300));
    const olsHover = await request("textDocument/hover", { textDocument: doc, position: odinPos("tprint", 1) });
    const oh = olsHover.result?.contents?.value ?? "";
    check("hover on a core library proc comes from ols", oh.includes("fmt.tprint :: proc"), oh);
    const olsDef = await request("textDocument/definition", { textDocument: doc, position: odinPos("tprint", 1) });
    const od0 = [].concat(olsDef.result ?? [])[0];
    check("definition of a core library proc jumps into Odin's core", /\/core\/fmt\/[^/]+\.odin$/.test(od0?.uri ?? ""), JSON.stringify(olsDef.result));
    const sig = await request("textDocument/signatureHelp", { textDocument: doc, position: odinPos("1)") });
    check("signature help inside a core library call", (sig.result?.signatures?.[0]?.label ?? "").includes("args: ..any"), JSON.stringify(sig.result));
    const coreItems = await complete("fmt.");
    check("completion after a core package lists its members", coreItems.includes("println") && coreItems.includes("tprintf"), JSON.stringify(coreItems.slice(0, 20)));
    const mixedItems = await complete("co");
    check("ols completions are merged without generated names", mixedItems.includes("count") && mixedItems.includes("twice!") && !mixedItems.some((l) => l.startsWith("__")), JSON.stringify(mixedItems.filter((l) => l.startsWith("_"))));
    const capHover = await request("textDocument/hover", { textDocument: doc, position: at("inc := proc", "count", 1, 1) });
    check("vidar still answers hover on vidar constructs", (capHover.result?.contents?.value ?? "").includes("captured by reference"), JSON.stringify(capHover.result));
  }

  // diagnostics: vidar errors while typing, several at once
  const broken = original
    .replace("\tinc()\n", "\tleak := proc[]() -> int { return count }\n\tinc()\n")
    .replace("v := geo.add", "v := geo.helper()\n\tw := geo.add");
  const errs = nextDiagnostics((d) => d.diagnostics.length > 0);
  change(broken);
  const d1 = await errs;
  const msgs = d1.diagnostics.map((d) => d.message).join(" | ");
  check("vidar errors reported (several at once)", d1.diagnostics.length === 2 && msgs.includes("not captured") && msgs.includes("private"), msgs);

  // diagnostics from `odin check` on save, mapped back to the .vidar line
  const typeError = original.replace("\tinc()\n", "\tinc()\n\tbad: string = count\n");
  writeFileSync(file, typeError);
  const clean = nextDiagnostics((d) => d.diagnostics.length === 0);
  change(typeError);
  await clean;
  const odinDiags = nextDiagnostics((d) => d.diagnostics.some((x) => x.source === "odin"));
  notify("textDocument/didSave", { textDocument: doc });
  const d2 = await odinDiags;
  const od = d2.diagnostics.find((x) => x.source === "odin");
  const wantLine = typeError.split("\n").findIndex((l) => l.includes("bad: string"));
  check("odin check errors map to the .vidar line", od.range.start.line === wantLine && /string/.test(od.message), JSON.stringify(od));

  // ---- a second program whose packages import each other ----
  const cyc = realpathSync(mkdtempSync(join(tmpdir(), "vidar-lsp-cycle-")));
  cpSync("tests/lsp/cycle", cyc, { recursive: true });
  const cMain = pathToFileURL(join(cyc, "main.vidar")).toString();
  const cA = pathToFileURL(join(cyc, "a", "a.vidar")).toString();
  const cB = pathToFileURL(join(cyc, "b", "b.vidar")).toString();
  const cycDiags = nextDiagnostics((d) => d.uri === cMain);
  notify("textDocument/didOpen", { textDocument: { uri: cMain, languageId: "vidar", version: 1, text: readFileSync(join(cyc, "main.vidar"), "utf8") } });
  check("cyclic program analyzes cleanly", (await cycDiags).diagnostics.length === 0, "");

  const cycHover = await request("textDocument/hover", { textDocument: { uri: cMain }, position: { line: 5, character: 7 } });
  const ch = cycHover.result?.contents?.value ?? "";
  check("hover on a cycle member shows its prefixed Odin name and the merged package", ch.includes("a__f") && ch.includes("a_b"), ch);

  const cycRefs = await request("textDocument/references", { textDocument: { uri: cMain }, position: { line: 5, character: 7 }, context: { includeDeclaration: true } });
  const refFiles = new Set((cycRefs.result ?? []).map((r) => r.uri));
  check("references span all packages of the cycle", cycRefs.result?.length === 4 && refFiles.has(cA) && refFiles.has(cB) && refFiles.has(cMain), JSON.stringify(cycRefs.result));

  const cycRename = await request("textDocument/rename", { textDocument: { uri: cMain }, position: { line: 5, character: 7 }, newName: "compute" });
  const changed = Object.keys(cycRename.result?.changes ?? {});
  check("rename edits every package that uses the symbol", changed.length === 3 && cycRename.result.changes[cMain].length === 2, JSON.stringify(cycRename.result));

  const gCol = readFileSync(join(cyc, "a", "a.vidar"), "utf8").split("\n")[4].indexOf("b.g") + 2;
  const defG = await request("textDocument/definition", { textDocument: { uri: cA }, position: { line: 4, character: gCol } });
  check("definition from inside the cycle crosses to the other package", defG.result?.uri === cB && defG.result.range.start.line === 4, JSON.stringify(defG.result));

  // an error in an imported (unopened) file is reported on that file
  const bErr = nextDiagnostics((d) => d.uri === cB && d.diagnostics.length > 0);
  notify("textDocument/didOpen", { textDocument: { uri: cB, languageId: "vidar", version: 1, text: readFileSync(join(cyc, "b", "b.vidar"), "utf8").replace("return 41", "return a.missing") } });
  const bd = await bErr;
  check("errors in an imported package are reported on its file", bd.diagnostics[0]?.message.includes("has no member 'missing'"), JSON.stringify(bd.diagnostics));

  // completion from `a` sees b's public members only
  const aText = readFileSync(join(cyc, "a", "a.vidar"), "utf8").replace("return b.g() + 1", "return b.");
  notify("textDocument/didOpen", { textDocument: { uri: cA, languageId: "vidar", version: 1, text: aText } });
  await new Promise((r) => setTimeout(r, 300));
  const aLine = aText.split("\n").findIndex((l) => l.includes("return b."));
  const aComp = await request("textDocument/completion", { textDocument: { uri: cA }, position: { line: aLine, character: aText.split("\n")[aLine].indexOf("b.") + 2 } });
  const aLabels = (aComp.result ?? []).map((c) => c.label);
  check("completion across a cycle hides the other package's private members", aLabels.includes("g") && !aLabels.includes("h"), JSON.stringify(aLabels));

  // the bundled "vidar:sched" package: completion, and definitions that open a real file
  const sch = realpathSync(mkdtempSync(join(tmpdir(), "vidar-lsp-sched-")));
  cpSync("tests/lsp/sched", sch, { recursive: true });
  const sMainPath = join(sch, "main.vidar");
  const sMain = pathToFileURL(sMainPath).toString();
  const sText = readFileSync(sMainPath, "utf8");
  const sLines = sText.split("\n");
  const sDiag = nextDiagnostics((d) => d.uri === sMain);
  notify("textDocument/didOpen", { textDocument: { uri: sMain, languageId: "vidar", version: 1, text: sText } });
  const sd = await sDiag;
  check("a program importing vidar:sched has no errors", sd.diagnostics.length === 0, JSON.stringify(sd.diagnostics));
  const goLine = sLines.findIndex((l) => l.includes("sched.go("));
  const defGo = await request("textDocument/definition", { textDocument: { uri: sMain }, position: { line: goLine, character: sLines[goLine].indexOf("go(") } });
  const defPath = defGo.result?.uri?.startsWith("file:") ? require("node:url").fileURLToPath(defGo.result.uri) : "";
  check("definition of a vidar:sched member opens the bundled source", defPath.endsWith("sched.vidar") && readFileSync(defPath, "utf8").includes("go :: proc(task: closure())"), JSON.stringify(defGo.result));
  const sEdited = sText.replace("fmt.println(sched.recv(ch))", "sched.");
  notify("textDocument/didChange", { textDocument: { uri: sMain, version: 2 }, contentChanges: [{ text: sEdited }] });
  await new Promise((r) => setTimeout(r, 300));
  const eLine = sEdited.split("\n").findIndex((l) => l.trim() === "sched.");
  const sComp = await request("textDocument/completion", { textDocument: { uri: sMain }, position: { line: eLine, character: sEdited.split("\n")[eLine].indexOf("sched.") + 6 } });
  const sLabels = (sComp.result ?? []).map((c) => c.label);
  check("completion after sched. lists the public API only", ["go", "make_chan", "select", "on_recv", "Chan", "sleep"].every((x) => sLabels.includes(x)) && !sLabels.includes("park"), JSON.stringify(sLabels));

  console.log(`\n${pass} passed, ${fail} failed`);
  await request("shutdown", null);
  notify("exit", null);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
