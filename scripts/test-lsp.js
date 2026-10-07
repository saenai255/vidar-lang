// End-to-end language server test: drives dist/lsp/server.js over stdio.
const { spawn, spawnSync } = require("node:child_process");
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync, cpSync } = require("node:fs");
const { dirname, join } = require("node:path");
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
  const init = await request("initialize", { processId: null, rootUri: pathToFileURL(dir).toString(), capabilities: { workspace: { workspaceFolders: true } } });
  const semLegend = init.result?.capabilities?.semanticTokensProvider?.legend ?? { tokenTypes: [], tokenModifiers: [] };
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
  check("definition of macro call jumps to the comptime proc", defMacro.result?.range.start.line === at("twice :: proc!", "twice").line, JSON.stringify(defMacro.result));

  // hover on a macro call's name shows the code it expands to
  const expansion = async (lineHas, name) => (await request("textDocument/hover", { textDocument: doc, position: at(lineHas, name, 1) })).result?.contents?.value ?? "";
  const hx = await expansion("fmt.println", "twice");
  check("hover on an expression macro shows its expansion", hx.includes("*expands to*") && hx.includes("count * 2"), hx);
  const hc = await expansion("check!(count", "check");
  check("hover on a built-in macro shows its expansion", hc.includes("__check_lhs := count") && hc.includes("__vidar.check_failed_cmp"), hc);
  const hs = await expansion("geo.swap!", "swap");
  check("hover on a statement macro from another package shows its expansion", /tmp\w* := lo\n\s*lo = hi\n\s*hi = tmp/.test(hs), hs);
  const hDecl = (await request("textDocument/hover", { textDocument: doc, position: at("twice :: proc!", "twice", 1) })).result?.contents?.value ?? "";
  check("hover on a macro's declaration shows no expansion", hDecl.includes("proc!") && !hDecl.includes("expands to"), hDecl);

  const refs = await request("textDocument/references", { textDocument: doc, position: at("count := 0", "count"), context: { includeDeclaration: true } });
  check("references include capture list, closure body and macro argument", refs.result?.length === 6, JSON.stringify(refs.result?.map((r) => r.range.start)));

  const ren = await request("textDocument/rename", { textDocument: doc, position: at("count := 0", "count"), newName: "clicks" });
  check("rename edits every reference", ren.result?.changes?.[uri]?.length === 6, JSON.stringify(ren.result));

  const edits = [...(ren.result?.changes?.[uri] ?? [])].sort((a, b) => b.range.start.line - a.range.start.line || b.range.start.character - a.range.start.character);
  const renamed = lines.slice();
  for (const e of edits) {
    const l = renamed[e.range.start.line];
    renamed[e.range.start.line] = l.slice(0, e.range.start.character) + e.newText + l.slice(e.range.end.character);
  }
  const { emitProgram, loadProgram } = require("../dist/project.js");
  let renameOk = false;
  try {
    const out = emitProgram(loadProgram(dirname(file), { overrides: new Map([[file, renamed.join("\n")]]) })).files.get("main.odin");
    renameOk = !/\bcount\b/.test(renamed.join("\n")) && out.includes("clicks := 0");
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
  const genAt = await request("vidar/generatedOdin", { uri, line: at("fmt.println(v.x", "fmt").line });
  const genLine = (genAt.result?.files?.["main.odin"] ?? "").split("\n")[genAt.result?.line ?? -1] ?? "";
  check("generated Odin request finds the line matching a .vidar line, past expanded macros", genLine.includes("fmt.println(v.x") && genAt.result.line > at("fmt.println(v.x", "fmt").line, JSON.stringify([genAt.result?.line, genLine]));

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
  check("completion offers the built-in macros", ["scoped!", "check!", "do!", "comptime!", "dbg!", "locked!"].every((m) => scopeItems.includes(m)), JSON.stringify(scopeItems.filter((x) => x.endsWith("!"))));

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

  // @(hot): -opt decisions against code inside it are warnings
  const hot = original + "\n@(hot)\nhot_sum :: proc(a, b: []int) -> (t: int) {\n\tfor i in 0..<len(a) do t += b[a[i]]\n\treturn\n}\n";
  const warned = nextDiagnostics((d) => d.diagnostics.some((x) => x.severity === 2));
  change(hot);
  const w = (await warned).diagnostics.find((x) => x.severity === 2);
  const hotLine = hot.split("\n").findIndex((l) => l.includes("t += b[a[i]]"));
  check("@(hot) warns about a bounds check left in", w.range.start.line === hotLine && w.message.includes("no bounds proof"), JSON.stringify(w));

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

  // ---- workspace symbols, implementations and the call hierarchy (tests/lsp/nav) ----
  const nav = realpathSync(mkdtempSync(join(tmpdir(), "vidar-lsp-nav-")));
  cpSync("tests/lsp/nav", nav, { recursive: true });
  const nMain = pathToFileURL(join(nav, "main.vidar")).toString();
  const nShapes = pathToFileURL(join(nav, "shapes", "shapes.vidar")).toString();
  const nText = { [nMain]: readFileSync(join(nav, "main.vidar"), "utf8"), [nShapes]: readFileSync(join(nav, "shapes", "shapes.vidar"), "utf8") };
  /** Like `at`, in one of the nav fixture's files. */
  const nAt = (u, lineHas, needle = lineHas, nth = 0) => {
    const ls = nText[u].split("\n");
    const line = ls.findIndex((l) => l.includes(lineHas));
    if (line < 0) throw new Error(`no line with ${lineHas}`);
    let col = -1;
    for (let i = 0; i <= nth; i++) col = ls[line].indexOf(needle, col + 1);
    if (col < 0) throw new Error(`no '${needle}' on line ${line + 1}`);
    return { line, character: col + 1 };
  };
  const nLine = (u, lineHas) => nText[u].split("\n").findIndex((l) => l.includes(lineHas));
  const nDiag = nextDiagnostics((d) => d.uri === nMain);
  notify("textDocument/didOpen", { textDocument: { uri: nMain, languageId: "vidar", version: 1, text: nText[nMain] } });
  check("navigation fixture has no errors", (await nDiag).diagnostics.length === 0, "");

  const wsCube = (await request("workspace/symbol", { query: "cube" })).result ?? [];
  const wsNames = wsCube.map((s) => `${s.containerName}.${s.name}`);
  check("workspace symbols search every analyzed package", ["shapes.Cube", "shapes.cube_area", "shapes.cube_volume", "shapes.grow_cube"].every((n) => wsNames.includes(n)), JSON.stringify(wsNames));
  const wsArea = wsCube.find((s) => s.name === "cube_area");
  check("workspace symbols point at the declaration", wsArea?.location?.uri === nShapes && wsArea.location.range.start.line === nLine(nShapes, "cube_area :: proc") && wsArea.kind === 12, JSON.stringify(wsArea));
  const wsFuzzy = ((await request("workspace/symbol", { query: "cbvol" })).result ?? []).map((s) => s.name);
  check("workspace symbols match the query's letters in order", wsFuzzy.includes("cube_volume") && !wsFuzzy.includes("cube_area"), JSON.stringify(wsFuzzy));
  const wsAll = ((await request("workspace/symbol", { query: "" })).result ?? []).map((s) => s.name);
  check("workspace symbols never list generated names", wsAll.includes("report") && wsAll.includes("Shape") && !wsAll.some((n) => n.startsWith("__")), JSON.stringify(wsAll.filter((n) => n.startsWith("_"))));

  const implOf = async (u, pos) => ((await request("textDocument/implementation", { textDocument: { uri: u }, position: pos })).result ?? []).map((l) => `${l.uri === nShapes ? "shapes" : l.uri}:${l.range.start.line}`);
  const implShape = await implOf(nMain, nAt(nMain, "a, b: shapes.Shape", "Shape"));
  check("implementations of an interface, from another package, include types implementing an extension of it",
    implShape.length === 2 && implShape.includes(`shapes:${nLine(nShapes, "Sq :: struct")}`) && implShape.includes(`shapes:${nLine(nShapes, "Cube :: struct")}`), JSON.stringify(implShape));
  const implArea = await implOf(nShapes, nAt(nShapes, "area :: proc(s: Shape)", "area"));
  check("implementations of an interface method are the procs bound to it",
    implArea.length === 2 && implArea.includes(`shapes:${nLine(nShapes, "sq_area :: proc")}`) && implArea.includes(`shapes:${nLine(nShapes, "cube_area :: proc")}`), JSON.stringify(implArea));
  const implProc = await implOf(nShapes, nAt(nShapes, "sq_area :: proc", "sq_area"));
  check("a proc has no implementations", implProc.length === 0, JSON.stringify(implProc));

  const prepare = async (u, pos) => (await request("textDocument/prepareCallHierarchy", { textDocument: { uri: u }, position: pos })).result ?? [];
  const calls = async (dir, item) => ((await request(`callHierarchy/${dir}Calls`, { item })).result ?? []).map((c) => {
    const it = c.from ?? c.to;
    return { name: it.name, uri: it.uri, lines: c.fromRanges.map((r) => r.start.line) };
  });
  const callNames = (cs) => cs.map((c) => c.name).sort().join(",");
  const [repItem] = await prepare(nMain, nAt(nMain, "report :: proc", "report"));
  check("call hierarchy prepares on a proc's declaration", repItem?.name === "report" && repItem.uri === nMain && repItem.selectionRange.start.line === nLine(nMain, "report :: proc"), JSON.stringify(repItem));
  const repOut = await calls("outgoing", repItem);
  check("outgoing calls go through proc groups and macro expansions, at the macro call",
    callNames(repOut) === "doubled,grow_cube,grow_sq,sq_area" && repOut.find((c) => c.name === "sq_area")?.lines[0] === nLine(nMain, "return doubled!") && repOut.find((c) => c.name === "grow_sq")?.uri === nShapes, JSON.stringify(repOut));
  const repIn = await calls("incoming", repItem);
  check("incoming calls of a proc", callNames(repIn) === "main" && repIn[0].lines[0] === nLine(nMain, "fmt.println(shapes.total"), JSON.stringify(repIn));
  // from the other package's file: callers in the importing package are found too
  notify("textDocument/didOpen", { textDocument: { uri: nShapes, languageId: "vidar", version: 1, text: nText[nShapes] } });
  const [sqArea] = await prepare(nShapes, nAt(nShapes, "sq_area :: proc", "sq_area"));
  const sqIn = await calls("incoming", sqArea);
  check("incoming calls cross packages and come through a closed interface's method",
    callNames(sqIn) === "main,report,total" && sqIn.find((c) => c.name === "total")?.uri === nShapes && sqIn.find((c) => c.name === "main")?.uri === nMain, JSON.stringify(sqIn));
  const [areaItem] = await prepare(nMain, nAt(nMain, "fmt.println(shapes.total", "area"));
  const areaIn = await calls("incoming", areaItem);
  check("call hierarchy on an interface method call", areaItem?.name === "area" && areaItem.uri === nShapes && callNames(areaIn) === "main,total", JSON.stringify([areaItem, areaIn]));
  const [mainItem] = await prepare(nMain, nAt(nMain, "main :: proc", "main"));
  const mainOut = await calls("outgoing", mainItem);
  check("outgoing calls of an interface method call list the bound procs", callNames(mainOut) === "cube_area,report,sq_area,total", JSON.stringify(mainOut));
  const [growItem] = await prepare(nShapes, nAt(nShapes, "grow :: proc{", "grow"));
  check("a proc group's outgoing calls are its members", callNames(await calls("outgoing", growItem)) === "grow_cube,grow_sq", "");
  const noItem = await prepare(nMain, nAt(nMain, "sq := shapes.Sq", "sq"));
  check("no call hierarchy on a variable", noItem.length === 0, JSON.stringify(noItem));

  // ---- macros, comptime code and interfaces: code the analyzer expands or folds away ----
  const mac = realpathSync(mkdtempSync(join(tmpdir(), "vidar-lsp-macros-")));
  cpSync("tests/lsp/macros", mac, { recursive: true });
  const mPath = join(mac, "main.vidar");
  const mUri = pathToFileURL(mPath).toString();
  const mText = readFileSync(mPath, "utf8");
  const mLines = mText.split("\n");
  const mDoc = { uri: mUri };
  /** Like `at`, for the macros fixture. */
  const mAt = (lineHas, needle, offset = 0, nth = 0) => {
    const line = mLines.findIndex((l) => l.includes(lineHas));
    if (line < 0) throw new Error(`no line with ${lineHas}`);
    let col = -1;
    for (let i = 0; i <= nth; i++) col = mLines[line].indexOf(needle, col + 1);
    if (col < 0) throw new Error(`no '${needle}' on line ${line + 1}`);
    return { line, character: col + offset };
  };
  const mHover = async (pos) => (await request("textDocument/hover", { textDocument: mDoc, position: pos })).result?.contents?.value ?? "";
  const mDef = async (pos) => (await request("textDocument/definition", { textDocument: mDoc, position: pos })).result;
  const mRefs = async (pos) => (await request("textDocument/references", { textDocument: mDoc, position: pos, context: { includeDeclaration: true } })).result ?? [];
  const sameLine = (loc, pos) => loc?.uri === mUri && loc.range.start.line === pos.line && loc.range.start.character === pos.character;
  const refLines = (refs) => refs.map((r) => r.range.start.line + 1).join(",");

  const mDiag = nextDiagnostics((d) => d.uri === mUri);
  notify("textDocument/didOpen", { textDocument: { uri: mUri, languageId: "vidar", version: 1, text: mText } });
  const md = await mDiag;
  check("macros fixture has no errors", md.diagnostics.length === 0, JSON.stringify(md.diagnostics));

  // comptime proc bodies are never analyzed as Odin, but their names still resolve
  const hovParam = await mHover(mAt("return n if n < 2", "n if", 0));
  check("hover on a comptime proc parameter inside its body", hovParam.includes("n: int") && hovParam.includes("parameter"), hovParam);
  const defParam = await mDef(mAt("return n if n < 2", "n", 0, 2));
  check("definition of a comptime proc parameter", sameLine(defParam, mAt("fib :: proc!", "n:")), JSON.stringify(defParam));
  const defSplice = await mDef(mAt("return quote($x * 2)", "x"));
  check("definition of a $splice inside quote jumps to the macro parameter", sameLine(defSplice, mAt("double :: proc!", "x:")), JSON.stringify(defSplice));
  const defLocal = await mDef(mAt("return quote($name)", "name"));
  check("definition of a comptime local used in a quote", sameLine(defLocal, mAt("name := type_name", "name")), JSON.stringify(defLocal));
  const fibRefs = await mRefs(mAt("fib :: proc!", "fib"));
  check("references to a comptime proc include recursive calls and compile-time calls", fibRefs.length === 4, refLines(fibRefs));

  // compile-time calls fold to literals; the names in them are still references
  const limitRefs = await mRefs(mAt("LIMIT :: 10", "LIMIT"));
  check("references to a constant include compile-time calls and comptime! blocks", limitRefs.length === 3, refLines(limitRefs));
  const defTotal = await mDef(mAt("take total", "total"));
  check("definition inside a comptime! block", sameLine(defTotal, mAt("total := 0", "total")), JSON.stringify(defTotal));

  // statement macros and their arguments
  const hovSwap = await mHover(mAt("swap!(x, y)", "swap", 1));
  check("hover on a statement macro call shows the macro", hovSwap.includes("swap :: proc!") && hovSwap.includes("macro"), hovSwap);
  const defSwap = await mDef(mAt("swap!(x, y)", "swap", 1));
  check("definition of a statement macro call", sameLine(defSwap, mAt("swap :: proc!", "swap")), JSON.stringify(defSwap));
  const defCheck = await mDef(mAt("check!(x > y)", "check", 1));
  const checkPath = defCheck?.uri?.startsWith("file:") ? require("node:url").fileURLToPath(defCheck.uri) : "";
  check("definition of a built-in statement macro opens the prelude", checkPath.endsWith(".vidar") && readFileSync(checkPath, "utf8").split("\n")[defCheck.range.start.line].startsWith("check :: proc!"), JSON.stringify(defCheck));
  const pairRefs = await mRefs(mAt("Pair :: struct", "Pair"));
  check("references include a type passed to a macro that only inspects it", pairRefs.some((r) => r.range.start.line === mAt("describe!(Pair)", "Pair").line && r.range.start.character === mAt("describe!(Pair)", "Pair").character), refLines(pairRefs));
  const madeRefs = await mRefs(mAt("declare!(made", "made"));
  check("a name declared through an Ident macro argument is linked to its uses", madeRefs.length === 2, refLines(madeRefs));
  const hovWords = await mHover(mAt("fmt.println(words", "words", 1));
  check("hover on a local declared in a macro block", hovWords.includes("words: int"), hovWords);

  // interfaces: the method list and impl bindings name the method
  const labelRefs = await mRefs(mAt("label :: proc", "label"));
  check("references to an interface method include the interface and impl bindings", labelRefs.length === 4, refLines(labelRefs));
  const defBinding = await mDef(mAt("impl Named for Pair", "label", 1));
  check("definition of an impl binding name jumps to the interface method", sameLine(defBinding, mAt("label :: proc", "label")), JSON.stringify(defBinding));

  // named results and catch bindings
  const valueRefs = await mRefs(mAt("parse :: proc", "value"));
  check("named results are declarations with references", valueRefs.length === 2, refLines(valueRefs));
  const hovErr = await mHover(mAt("fmt.println(\"bad\", err)", "err", 1));
  check("hover on a catch error binding", hovErr.includes("err:"), hovErr);
  const defErr = await mDef(mAt("fmt.println(\"bad\", err)", "err", 1));
  check("definition of a catch error binding", sameLine(defErr, mAt("catch err", "err")), JSON.stringify(defErr));

  // renaming every symbol must give a program that still transpiles to the same code
  const emitted = (d, overrides) => {
    const p = loadProgram(d, { tolerant: true, overrides });
    if (p.errors.length) return `error: ${p.errors[0].message}`;
    return [...emitProgram(p).files].map(([k, v]) => `${k}\n${v}`).join("\n");
  };
  const renameAll = async (d, path, text) => {
    const u = pathToFileURL(path).toString();
    const base = emitted(d);
    const broken = [];
    const seen = new Set();
    const tLines = text.split("\n");
    for (let line = 0; line < tLines.length; line++) {
      if (tLines[line].startsWith("import")) continue;
      for (const m of tLines[line].matchAll(/::|:=|:/g)) {
        // the name just before a declaration operator
        const name = /([A-Za-z_]\w*)\s*(?:,\s*[A-Za-z_]\w*\s*)*$/.exec(tLines[line].slice(0, m.index));
        if (!name || seen.has(`${line}:${name.index}`)) continue;
        seen.add(`${line}:${name.index}`);
        const fresh = `zz_${name[1]}`;
        const r = await request("textDocument/rename", { textDocument: { uri: u }, position: { line, character: name.index }, newName: fresh });
        const edits = r.result?.changes?.[u];
        if (!edits?.length) continue;
        const out = tLines.slice();
        for (const e of [...edits].sort((a, b) => b.range.start.line - a.range.start.line || b.range.start.character - a.range.start.character)) {
          const l = out[e.range.start.line];
          out[e.range.start.line] = l.slice(0, e.range.start.character) + fresh + l.slice(e.range.end.character);
        }
        const after = emitted(d, new Map([[path, out.join("\n")]]));
        if (after.split(fresh).join(name[1]) !== base) broken.push(`${name[1]} (line ${line + 1}): ${after.startsWith("error") ? after : "output differs"}`);
      }
    }
    return broken;
  };
  const brokenMac = await renameAll(mac, mPath, mText);
  check("renaming any symbol in the macros fixture keeps the program equivalent", brokenMac.length === 0, brokenMac.join("\n  "));

  const renImport = await request("textDocument/rename", { textDocument: mDoc, position: mAt('import "core:fmt"', "fmt"), newName: "f" });
  const importEdits = renImport.result?.changes?.[mUri] ?? [];
  const importDecl = importEdits.find((e) => e.range.start.line === mAt('import "core:fmt"', "fmt").line);
  check("renaming an import without an alias adds one", importDecl?.newText === "f " && importDecl.range.start.character === importDecl.range.end.character && importEdits.length === 4, JSON.stringify(importEdits));
  const renPrelude = await request("textDocument/rename", { textDocument: mDoc, position: mAt("check!(x > y)", "check", 1), newName: "verify" });
  check("renaming a built-in macro is refused", !!renPrelude.error && !renPrelude.result, JSON.stringify(renPrelude));

  // completion where scopes only exist in expanded or folded code
  const completeIn = async (u, text, after, line) => {
    const ls = text.split("\n");
    const at = ls.findIndex((l) => l.includes(after)) + 1;
    ls.splice(at, 0, line);
    notify("textDocument/didChange", { textDocument: { uri: u, version: ++version }, contentChanges: [{ text: ls.join("\n") }] });
    await new Promise((r) => setTimeout(r, 300));
    const res = await request("textDocument/completion", { textDocument: { uri: u }, position: { line: at, character: line.length } });
    return (res.result ?? []).map((c) => c.label);
  };
  const inBlock = await completeIn(mUri, mText, "words := double!(n)", "\t\two");
  check("completion inside a macro block offers its locals and the enclosing ones", inBlock.includes("words") && inBlock.includes("small") && inBlock.includes("made"), JSON.stringify(inBlock.slice(0, 20)));
  const inDo = await completeIn(mUri, mText, "total := 0", "\t\tto");
  check("completion inside a comptime! block offers its locals", inDo.includes("total") && inDo.includes("LIMIT"), JSON.stringify(inDo.slice(0, 20)));
  const inComptime = await completeIn(mUri, mText, "name := type_name(T)", "\tna");
  check("completion inside a comptime proc offers its parameters and locals", inComptime.includes("name") && inComptime.includes("T"), JSON.stringify(inComptime.slice(0, 20)));

  // ---- hover on every name and keyword ----
  const hovDir = realpathSync(mkdtempSync(join(tmpdir(), "vidar-lsp-hover-")));
  cpSync("tests/lsp/hover", hovDir, { recursive: true });
  const hPath = join(hovDir, "main.vidar");
  const hUri = pathToFileURL(hPath).toString();
  const hText = readFileSync(hPath, "utf8");
  const hLines = hText.split("\n");
  const hAt = (lineHas, needle, offset = 0, nth = 0) => {
    const line = hLines.findIndex((l) => l.includes(lineHas));
    if (line < 0) throw new Error(`no line with ${lineHas}`);
    let col = -1;
    for (let i = 0; i <= nth; i++) col = hLines[line].indexOf(needle, col + 1);
    if (col < 0) throw new Error(`no '${needle}' on line ${line + 1}`);
    return { line, character: col + offset };
  };
  const hHover = async (pos) => (await request("textDocument/hover", { textDocument: { uri: hUri }, position: pos })).result?.contents?.value ?? "";
  const hDef = async (pos) => (await request("textDocument/definition", { textDocument: { uri: hUri }, position: pos })).result;
  const hDiag = nextDiagnostics((d) => d.uri === hUri);
  notify("textDocument/didOpen", { textDocument: { uri: hUri, languageId: "vidar", version: 1, text: hText } });
  const hd = await hDiag;
  check("hover fixture has no errors", hd.diagnostics.length === 0, JSON.stringify(hd.diagnostics));

  const expectHover = async (name, pos, ...needles) => {
    const h = await hHover(pos);
    check(name, needles.every((n) => h.includes(n)), h);
  };
  await expectHover("hover on the package clause", hAt("package main", "main"), "package main");
  await expectHover("hover on a keyword", hAt("for n, i in nums", "for"), "keyword");
  await expectHover("hover on a vidar keyword", hAt('parse("7") catch', "catch"), "keyword", "catch");
  await expectHover("hover on `proc!` explains comptime procs", hAt("swap :: proc!", "proc"), "proc!");
  await expectHover("hover on quote", hAt("return quote {", "quote"), "keyword", "$name");
  await expectHover("hover on a builtin type", hAt("Point :: struct { x, y: int }", " int", 1), "builtin type");
  await expectHover("hover on a builtin proc", hAt("append(&nums", "len"), "len :: proc");
  await expectHover("hover on a macro parameter kind", hAt("swap :: proc!", "Expr"), "macro kind");
  await expectHover("hover on a struct field declaration", hAt("Point :: struct", "y"), "y: int", "field of struct", "Point");
  await expectHover("hover on an enum member declaration", hAt("Error :: enum", "Too_Big"), "Error.Too_Big = 2");
  await expectHover("hover on an implicit enum selector", hAt("return 0, .Bad_Number", "Bad_Number"), "Error.Bad_Number = 1");
  await expectHover("hover on a field name in a typed literal", hAt("q := Point{x = 3", "x"), "x: int", "Point");
  await expectHover("hover on a field name in a literal typed by its declaration", hAt("p: Point = {x = 1", "y"), "y: int");
  await expectHover("hover on a field name in a returned literal", hAt("return {x = 0", "y"), "y: int");
  await expectHover("hover on a type switch variable inside a case", hAt("case Circle: return", "v"), "v: Circle");
  await expectHover("hover on a field through a type switch variable", hAt("case Rect:", "h"), "h: f64", "Rect");
  await expectHover("hover on a closure type's parameter name", hAt("Handler :: closure", "msg"), "msg: string", "closure type");
  await expectHover("hover on a polymorphic parameter", hAt("helper :: proc", "T", 0, 0), "polymorphic");
  await expectHover("hover on a struct's polymorphic parameter", hAt("Box :: struct", "T"), "polymorphic");
  await expectHover("hover on a local declared in quoted code", hAt("$b = tmp", "tmp"), "renames it");
  await expectHover("hover on an attribute", hAt("@(private)", "private"), "attribute");
  await expectHover("hover on a context field", hAt("fmt.println(context", "allocator"), "allocator: runtime.Allocator");
  await expectHover("hover on a builtin constant", hAt("when ODIN_OS", "ODIN_OS"), "ODIN_OS");
  await expectHover("hover on the blank identifier", hAt("_ = true", "_"), "blank identifier");
  await expectHover("hover on a field of a generic struct value", hAt("b.value", "value"), "value");
  const catchErr = await hHover(hAt('parse("7") catch err', "err", 1, 1));
  check("a catch after a bare call binds the error (the last result), not the first", catchErr.includes("err: Error") && catchErr.includes("catch"), catchErr);

  const defMember = await hDef(hAt("return 0, .Bad_Number", "Bad_Number"));
  check("definition of an implicit enum selector jumps to the member", defMember?.range.start.line === hAt("Error :: enum", "Bad_Number").line && defMember.range.start.character === hAt("Error :: enum", "Bad_Number").character, JSON.stringify(defMember));
  const defLitField = await hDef(hAt("q := Point{x = 3", "y"));
  check("definition of a field name in a literal jumps to the field", defLitField?.range.start.line === hAt("Point :: struct", "y").line, JSON.stringify(defLitField));
  const defCase = await hDef(hAt("case Circle: return", "r"));
  check("definition of a field through a type switch variable", defCase?.range.start.line === hAt("Circle :: struct", "r").line, JSON.stringify(defCase));

  // every identifier and keyword in the fixtures shows something
  const { lex } = require("../dist/lexer.js");
  const noHover = async (u, text) => {
    const missing = [];
    for (const t of lex(text, "x")) {
      if (t.kind !== "ident" && t.kind !== "kw") continue;
      const pos = { line: t.pos.line - 1, character: t.pos.col - 1 };
      const r = await request("textDocument/hover", { textDocument: { uri: u }, position: pos });
      if (!r.result?.contents?.value) missing.push(`${t.text}@${t.pos.line}:${t.pos.col}`);
    }
    return missing;
  };
  const hMissing = await noHover(hUri, hText);
  check("every name and keyword in the hover fixture has a hover", hMissing.length === 0, hMissing.join(" "));
  notify("textDocument/didChange", { textDocument: { uri: mUri, version: ++version }, contentChanges: [{ text: mText }] });
  await new Promise((r) => setTimeout(r, 300));
  const mMissing = await noHover(mUri, mText);
  check("every name and keyword in the macros fixture has a hover", mMissing.length === 0, mMissing.join(" "));

  // ---- inlay hints: what -opt decides ----
  const optDir = realpathSync(mkdtempSync(join(tmpdir(), "vidar-lsp-opt-")));
  cpSync("tests/lsp/opt", optDir, { recursive: true });
  const oUri = pathToFileURL(join(optDir, "main.vidar")).toString();
  const oText = readFileSync(join(optDir, "main.vidar"), "utf8");
  const oLines = oText.split("\n");
  /** the position just past `needle` on the first line containing `lineHas` */
  const oEnd = (lineHas, needle = lineHas) => {
    const line = oLines.findIndex((l) => l.includes(lineHas));
    return { line, character: oLines[line].indexOf(needle) + needle.length };
  };
  const oDiag = nextDiagnostics((d) => d.uri === oUri);
  notify("textDocument/didOpen", { textDocument: { uri: oUri, languageId: "vidar", version: 1, text: oText } });
  check("-opt fixture has no errors", (await oDiag).diagnostics.length === 0, "");
  const optHints = async () =>
    (await request("textDocument/inlayHint", { textDocument: { uri: oUri }, range: { start: { line: 0, character: 0 }, end: { line: oLines.length, character: 0 } } })).result ?? [];
  const hintsAt = (hints, pos) => hints.filter((h) => h.position.line === pos.line && h.position.character === pos.character).map((h) => h.label);
  let oh = await optHints();
  const ohs = JSON.stringify(oh.map((h) => [h.label, h.position.line, h.position.character]));
  check("inlay hint after an automatic table's name, with the reason as tooltip", hintsAt(oh, oEnd("bits :: proc", "bits")).includes("table") && oh.find((h) => h.label === "table")?.tooltip?.includes("256 results"), ohs);
  check("inlay hint after a specialized proc's name counts its copies", hintsAt(oh, oEnd("blur :: proc", "blur")).includes("specialized ×2"), ohs);
  check("inlay hint on a statement whose indexing is unchecked", hintsAt(oh, oEnd("total += a[i]")).includes("unchecked"), ohs);
  check("inlay hints on constant-size makes put on the stack", hintsAt(oh, oEnd("tmp := make([]int, 16)")).includes("stack buffer") && hintsAt(oh, oEnd("out := make([]int, 16)")).includes("stack buffer"), ohs);
  check("inlay hint on a compiled fmt call", hintsAt(oh, oEnd('fmt.printf("%d %d\\n", bits(7), double(3))')).includes("fmt inlined"), ohs);
  check("inlay hints tell devirtualized and direct interface calls apart", hintsAt(oh, oEnd("area(s)")).includes("devirtualized") && hintsAt(oh, oEnd("area(&sq)")).includes("direct"), ohs);
  check("inlay hints from a macro's expansion go at the macro call", oh.some((h) => h.label === "unchecked" && h.position.line === oEnd("sum_all!(out)").line && h.tooltip?.startsWith("in sum_all!:")), ohs);
  check("inlay hints leave out what -opt decided against by default", !oh.some((h) => /^not? /.test(h.label)), ohs);
  const oGen = await request("vidar/generatedOdin", { uri: oUri });
  check("hints don't turn -opt on for the generated Odin", !/__fmt_|#no_bounds_check/.test(oGen.result?.files?.["main.odin"] ?? "__fmt_"), JSON.stringify(oGen.result).slice(0, 200));

  notify("workspace/didChangeConfiguration", { settings: { vidar: { optHints: "all" } } });
  oh = await optHints();
  check("optHints: all adds the decisions against, with the reason", oh.some((h) => h.label === "no table" && h.tooltip?.includes("cheaper than a memory load") && h.position.line === oEnd("double :: proc").line), JSON.stringify(oh.map((h) => h.label)));
  notify("workspace/didChangeConfiguration", { settings: { vidar: { optHints: "off" } } });
  check("optHints: off shows none", (await optHints()).length === 0, "");
  notify("workspace/didChangeConfiguration", { settings: { vidar: { optHints: "on" } } });

  // ---- vidar/optReport and code lenses: -opt decisions by proc ----
  const reportRes = await request("vidar/optReport", { uri: oUri });
  const report = reportRes.result;
  const rs = JSON.stringify(reportRes).slice(0, 400);
  const procOf = (name) => report?.files?.[0]?.procs.find((p) => p.name === name);
  check("optReport covers just the file asked for", report?.files?.length === 1 && report.files[0].uri === oUri, rs);
  check("optReport puts a proc's own decision under it", procOf("bits")?.decisions.some((d) => d.label === "table" && !d.against && d.tooltip?.includes("256 results") && d.range.start.line === oEnd("bits :: proc").line), rs);
  check("optReport marks decisions against and counts both", procOf("double")?.decisions.some((d) => d.label === "no table" && d.against) && procOf("double").against === 1 && procOf("double").optimizations === 0, JSON.stringify(procOf("double")));
  check("optReport groups decisions in a body under the enclosing proc", ["stack buffer", "fmt inlined", "devirtualized", "direct"].every((l) => procOf("main")?.decisions.some((d) => d.label === l)) && procOf("main").decisions.some((d) => d.label === "unchecked" && d.range.start.line === oEnd("sum_all!(out)").line), JSON.stringify(procOf("main")?.decisions.map((d) => d.label)));
  check("optReport gives each proc its name's range", procOf("sum")?.selectionRange.start.line === oEnd("sum :: proc").line && procOf("sum").selectionRange.start.character === 0, JSON.stringify(procOf("sum")));
  const all = (await request("vidar/optReport", {})).result;
  check("optReport without a uri covers every analyzed program", all?.files?.some((f) => f.uri === oUri), JSON.stringify(all?.files?.map((f) => f.uri)));
  const lenses = async () => (await request("textDocument/codeLens", { textDocument: { uri: oUri } })).result ?? [];
  let ls = await lenses();
  const lensAt = (name) => ls.find((l) => l.command?.arguments?.[1] === name);
  check("a code lens over each proc with decisions", ["bits", "double", "blur", "sum", "main"].every((n) => lensAt(n)?.range.start.line === oEnd(`${n} :: proc`).line) && !lensAt("sq_area"), JSON.stringify(ls.map((l) => [l.command?.title, l.range.start.line])));
  check("code lens counts optimizations and decisions against", lensAt("double")?.command.title === "0 optimizations, 1 not" && lensAt("bits")?.command.title === "1 optimization, 0 not", JSON.stringify(ls.map((l) => l.command?.title)));
  check("code lens opens the report on its proc", lensAt("bits")?.command.command === "vidar.showOptReport" && lensAt("bits").command.arguments[0] === oUri && lensAt("bits").command.arguments[2] === oEnd("bits :: proc").line, JSON.stringify(lensAt("bits")));
  notify("workspace/didChangeConfiguration", { settings: { vidar: { optHints: "off" } } });
  check("no code lenses while optHints is off", (await lenses()).length === 0, "");
  notify("workspace/didChangeConfiguration", { settings: { vidar: { optHints: "on", optCodeLens: false } } });
  check("optCodeLens: false turns the lenses off", (await lenses()).length === 0, "");
  notify("workspace/didChangeConfiguration", { settings: { vidar: { optHints: "on", optCodeLens: true } } });
  ls = await lenses();
  check("optCodeLens: true brings them back", ls.length > 0, "");

  const shifted = nextDiagnostics((d) => d.uri === oUri);
  notify("textDocument/didChange", { textDocument: { uri: oUri, version: 2 }, contentChanges: [{ text: "\n" + oText }] });
  await shifted;
  oh = await optHints();
  check("inlay hints follow edits", hintsAt(oh, { ...oEnd("bits :: proc", "bits"), line: oEnd("bits :: proc").line + 1 }).includes("table"), JSON.stringify(oh.map((h) => [h.label, h.position.line])));

  // ---- semantic tokens ----
  const semDir = realpathSync(mkdtempSync(join(tmpdir(), "vidar-lsp-semantic-")));
  cpSync("tests/lsp/semantic", semDir, { recursive: true });
  const semUri = pathToFileURL(join(semDir, "main.vidar")).toString();
  const semText = readFileSync(join(semDir, "main.vidar"), "utf8");
  const semLines = semText.split("\n");
  const semDiag = nextDiagnostics((d) => d.uri === semUri);
  notify("textDocument/didOpen", { textDocument: { uri: semUri, languageId: "vidar", version: 1, text: semText } });
  check("semantic tokens fixture has no errors", (await semDiag).diagnostics.length === 0, "");
  /** Decodes LSP's relative token stream into { line, character, text, type, modifiers }. */
  const decode = (data) => {
    const out = [];
    let line = 0;
    let char = 0;
    for (let i = 0; i + 4 < data.length; i += 5) {
      line += data[i];
      char = data[i] ? data[i + 1] : char + data[i + 1];
      const mods = semLegend.tokenModifiers.filter((_, b) => data[i + 4] & (1 << b));
      out.push({ line, character: char, text: semLines[line]?.substr(char, data[i + 2]), type: semLegend.tokenTypes[data[i + 3]], modifiers: mods });
    }
    return out;
  };
  const semFull = decode((await request("textDocument/semanticTokens/full", { textDocument: { uri: semUri } })).result?.data ?? []);
  /** the token for the `nth` `needle` on the first line containing `lineHas` */
  const tokAt = (toks, lineHas, needle, nth = 0) => {
    const line = semLines.findIndex((l) => l.includes(lineHas));
    let col = -1;
    for (let i = 0; i <= nth; i++) col = semLines[line].indexOf(needle, col + 1);
    return toks.find((t) => t.line === line && t.character === col);
  };
  const semIs = (name, t, type, mods = [], noMods = []) =>
    check(`semantic token: ${name}`, t?.type === type && mods.every((m) => t.modifiers.includes(m)) && !noMods.some((m) => t.modifiers.includes(m)), JSON.stringify(t));
  semIs("interface declaration", tokAt(semFull, "Shape :: interface", "Shape"), "interface", ["declaration"]);
  semIs("interface used as a type", tokAt(semFull, "s: Shape = &sq", "Shape"), "interface");
  semIs("interface method in the interface's list", tokAt(semFull, "Shape :: interface", "area"), "method");
  semIs("interface method call", tokAt(semFull, "fmt.println(apply", "area"), "method");
  semIs("closure variable", tokAt(semFull, "add := proc[step]", "add"), "function", ["declaration", "closure"]);
  semIs("closure parameter of a named closure type", tokAt(semFull, "apply :: proc", "f"), "function", ["closure"]);
  semIs("by-value capture is captured and read-only", tokAt(semFull, "add := proc[step]", "step"), "variable", ["captured", "readonly"], ["byRef"]);
  semIs("by-value capture used in the body", tokAt(semFull, "add := proc[step]", "step", 1), "variable", ["captured", "readonly"]);
  semIs("by-reference capture", tokAt(semFull, "bump := proc[&total]", "total"), "variable", ["captured", "byRef"], ["readonly"]);
  semIs("by-reference capture written in the body", tokAt(semFull, "bump := proc[&total]", "total", 1), "variable", ["captured", "byRef"]);
  semIs("captured variable outside the closure is a plain variable", tokAt(semFull, "fmt.println(apply", "total"), "variable", [], ["captured"]);
  semIs("macro declaration", tokAt(semFull, "twice :: proc!", "twice"), "macro", ["declaration"]);
  semIs("macro call", tokAt(semFull, "fmt.println(apply", "twice"), "macro");
  semIs("closure parameter of a closure literal", tokAt(semFull, "add := proc[step]", "x"), "parameter", ["declaration"]);
  semIs("local constant", tokAt(semFull, "fmt.println(apply", "LIMIT"), "variable", ["readonly"]);
  semIs("enum member declaration", tokAt(semFull, "Color :: enum", "Red"), "enumMember", ["declaration"]);
  semIs("package alias", tokAt(semFull, "fmt.println(apply", "fmt"), "namespace");
  semIs("goroutine start", tokAt(semFull, "sched.go(", "go"), "function", ["async", "defaultLibrary"]);
  semIs("bundled package", tokAt(semFull, "sched.go(", "sched"), "namespace", ["defaultLibrary"]);
  check("semantic tokens never cover generated __ names", semFull.length > 30 && !semFull.some((t) => !t.text || t.text.startsWith("__")), JSON.stringify(semFull.filter((t) => !t.text || t.text.startsWith("__"))));
  const bumpLine = semLines.findIndex((l) => l.includes("bump := proc"));
  const semRange = decode((await request("textDocument/semanticTokens/range", { textDocument: { uri: semUri }, range: { start: { line: bumpLine, character: 0 }, end: { line: bumpLine + 1, character: 0 } } })).result?.data ?? []);
  check("semantic tokens for a range stay in the range", semRange.length >= 3 && semRange.every((t) => t.line === bumpLine) && semRange.some((t) => t.modifiers.includes("byRef")), JSON.stringify(semRange));
  // a file that doesn't parse still gets tokens for what was analyzed, and the request never fails
  const semBroken = semText.replace("bump()", "bump( +");
  const semBad = nextDiagnostics((d) => d.uri === semUri && d.diagnostics.length > 0);
  notify("textDocument/didChange", { textDocument: { uri: semUri, version: 2 }, contentChanges: [{ text: semBroken }] });
  await semBad;
  const semB = await request("textDocument/semanticTokens/full", { textDocument: { uri: semUri } });
  const semBToks = decode(semB.result?.data ?? []);
  check("semantic tokens for a file with a syntax error", !semB.error && semBToks.some((t) => t.type === "interface") && semBToks.some((t) => t.type === "macro"), JSON.stringify(semB.error ?? semBToks.slice(0, 5)));

  // ---- field and enum member uses (tests/lsp/members) ----
  {
    const memDir = realpathSync(mkdtempSync(join(tmpdir(), "vidar-lsp-members-")));
    cpSync("tests/lsp/members", memDir, { recursive: true });
    const mmPath = join(memDir, "main.vidar");
    const mmUri = pathToFileURL(mmPath).toString();
    const shapesUri = pathToFileURL(join(memDir, "shapes", "shapes.vidar")).toString();
    const mmText = readFileSync(mmPath, "utf8");
    const mmLines = mmText.split("\n");
    const mmAt = (lineHas, needle, offset = 0, nth = 0) => {
      const line = mmLines.findIndex((l) => l.includes(lineHas));
      if (line < 0) throw new Error(`no line with ${lineHas}`);
      let col = -1;
      for (let i = 0; i <= nth; i++) col = mmLines[line].indexOf(needle, col + 1);
      if (col < 0) throw new Error(`no '${needle}' on line ${line + 1}`);
      return { line, character: col + offset };
    };
    const mmDoc = { uri: mmUri };
    const mmDiag = nextDiagnostics((d) => d.uri === mmUri);
    notify("textDocument/didOpen", { textDocument: { uri: mmUri, languageId: "vidar", version: 1, text: mmText } });
    check("members fixture has no errors", (await mmDiag).diagnostics.length === 0, "");
    const mmHover = async (pos) => (await request("textDocument/hover", { textDocument: mmDoc, position: pos })).result?.contents?.value ?? "";
    const mmDef = async (pos) => (await request("textDocument/definition", { textDocument: mmDoc, position: pos })).result;
    const mmRefs = async (pos) => (await request("textDocument/references", { textDocument: mmDoc, position: pos, context: { includeDeclaration: true } })).result ?? [];
    const isAt = (l, pos, u = mmUri) => l?.uri === u && l.range.start.line === pos.line && l.range.start.character === pos.character;

    const hImplicit = await mmHover(mmAt("_ = paint(q, .Blue)", "Blue"));
    check("hover on an implicit enum selector in a call argument names its enum", hImplicit.includes("Color.Blue = 2") && hImplicit.includes("enum member of* `Color`"), hImplicit);
    const hQual = await mmHover(mmAt("c := Color.Blue", "Blue"));
    check("hover on Enum.Member", hQual.includes("Color.Blue = 2"), hQual);
    const hUsing = await mmHover(mmAt("fmt.println(p.x, q.y", "p.id", 2));
    check("hover on a field reached through a using field", hUsing.includes("id: int") && hUsing.includes("field of struct* `Base`"), hUsing);
    const hSoa = await mmHover(mmAt("grid[0].age = 3", "age"));
    check("hover on a field of an #soa element", hSoa.includes("age: int") && hSoa.includes("`Cell`"), hSoa);

    const declOf = (lineHas, name) => mmAt(lineHas, name);
    check("definition of .Green in a struct literal", isAt(await mmDef(mmAt("tint = .Green", "Green")), declOf("Color :: enum", "Green")), JSON.stringify(await mmDef(mmAt("tint = .Green", "Green"))));
    check("definition of .Red in a case", isAt(await mmDef(mmAt("case .Red, .Blue", "Red")), declOf("Color :: enum", "Red")), "");
    check("definition of .Red in a return", isAt(await mmDef(mmAt("if c == .Blue do return .Red", "Red")), declOf("Color :: enum", "Red")), "");
    check("definition of a field through a pointer", isAt(await mmDef(mmAt("fmt.println(p.x, q.y", "y")), declOf("x, y: f64", "y")), "");
    check("definition of a field through using", isAt(await mmDef(mmAt("fmt.println(p.x, q.y", "id")), declOf("Base :: struct", "id")), "");
    check("definition of a field of another package's struct", isAt(await mmDef(mmAt("fmt.println(shapes.area(r), r.w)", "w")), { line: 2, character: 17 }, shapesUri), JSON.stringify(await mmDef(mmAt("fmt.println(shapes.area(r), r.w)", "w"))));

    const refsTint = await mmRefs(mmAt("tint: Color", "tint"));
    check("references of a field: declaration, literal, assignment, return, switch", refsTint.length === 5, JSON.stringify(refsTint.map((r) => r.range.start)));
    const refsBlue = await mmRefs(mmAt("Color :: enum", "Blue"));
    check("references of an enum member: comparisons, arguments, cases, Enum.Member", refsBlue.length === 5, JSON.stringify(refsBlue.map((r) => r.range.start)));
    const refsW = await mmRefs(mmAt("r := shapes.Rect", "w"));
    check("references of a field cross packages", refsW.length === 4 && refsW.some((r) => r.uri === shapesUri), JSON.stringify(refsW));

    const renX = await request("textDocument/rename", { textDocument: mmDoc, position: mmAt("x, y: f64", "x"), newName: "px" });
    const xEdits = renX.result?.changes?.[mmUri] ?? [];
    const xText = mmLines.slice();
    for (const e of [...xEdits].sort((a, b) => b.range.start.line - a.range.start.line || b.range.start.character - a.range.start.character)) {
      const l = xText[e.range.start.line];
      xText[e.range.start.line] = l.slice(0, e.range.start.character) + e.newText + l.slice(e.range.end.character);
    }
    const { emitProgram: emitP, loadProgram: loadP } = require("../dist/project.js");
    let xOk = false;
    try {
      const before = emitP(loadP(memDir)).files.get("main.odin");
      const after = emitP(loadP(memDir, { overrides: new Map([[mmPath, xText.join("\n")]]) })).files.get("main.odin");
      xOk = after.split("px").join("x") === before;
    } catch {}
    check("rename of a field edits its declaration and every use", xEdits.length === 4 && xOk, JSON.stringify(xEdits.map((e) => e.range.start)));
    const renBuf = await request("textDocument/rename", { textDocument: mmDoc, position: mmAt("Buffer :: struct", "buf"), newName: "bytes" });
    check("rename of a field is refused while a use of that name can't be resolved", !!renBuf.error && /can't rename field 'buf'.*main\.vidar:43/.test(renBuf.error.message), JSON.stringify(renBuf));
    const renBlue = await request("textDocument/rename", { textDocument: mmDoc, position: mmAt("case .Red, .Blue", "Blue"), newName: "Navy" });
    check("rename of an enum member from a use", (renBlue.result?.changes?.[mmUri] ?? []).length === 5, JSON.stringify(renBlue));

    const mmToks = (await request("textDocument/semanticTokens/full", { textDocument: mmDoc })).result?.data ?? [];
    const mmDecoded = [];
    for (let i = 0, line = 0, char = 0; i + 4 < mmToks.length; i += 5) {
      line += mmToks[i];
      char = mmToks[i] ? mmToks[i + 1] : char + mmToks[i + 1];
      mmDecoded.push({ line, character: char, type: semLegend.tokenTypes[mmToks[i + 3]], modifiers: semLegend.tokenModifiers.filter((_, b) => mmToks[i + 4] & (1 << b)) });
    }
    const mmTok = (pos) => mmDecoded.find((t) => t.line === pos.line && t.character === pos.character);
    semIs("field use", mmTok(mmAt("grid[0].age = 3", "age")), "property", [], ["declaration"]);
    semIs("field name in a struct literal", mmTok(mmAt("p := Point{x = 1", "x")), "property");
    semIs("implicit enum selector", mmTok(mmAt("case .Green", "Green")), "enumMember", [], ["declaration"]);
    semIs("Enum.Member", mmTok(mmAt("c := Color.Blue", "Blue")), "enumMember");
    semIs("field declaration", mmTok(mmAt("tint: Color", "tint")), "property", ["declaration"]);
  }
  // ---- vidar/expandAt: the Odin for the statement at the cursor ----
  const exDir = realpathSync(mkdtempSync(join(tmpdir(), "vidar-lsp-expand-")));
  cpSync("tests/lsp/expand", exDir, { recursive: true });
  const exUri = pathToFileURL(join(exDir, "main.vidar")).toString();
  const exText = readFileSync(join(exDir, "main.vidar"), "utf8");
  const exLines = exText.split("\n");
  const exAt = (lineHas, needle = lineHas) => {
    const line = exLines.findIndex((l) => l.includes(lineHas));
    return { line, character: exLines[line].indexOf(needle) };
  };
  const exDiag = nextDiagnostics((d) => d.uri === exUri);
  notify("textDocument/didOpen", { textDocument: { uri: exUri, languageId: "vidar", version: 1, text: exText } });
  check("expand fixture has no errors", (await exDiag).diagnostics.length === 0, "");
  const exExpand = async (pos, opt) => (await request("vidar/expandAt", { uri: exUri, position: pos, opt })).result ?? {};
  const exLineOf = (has) => exAt(has).line;
  const exSpans = (r, from, to, below = 0) => r.range?.start.line === exLineOf(from) && r.range?.end.line === exLineOf(to) + below;
  let ex = await exExpand(exAt("add := proc[k]", "add"));
  check("expandAt on a closure literal shows the call and the generated closure proc", ex.code?.includes("add := __closure_0(k)") && ex.code.includes("__closure_0 :: proc") && ex.code.includes("return x + __env.k") && exSpans(ex, "add := proc[k]", "return x + k", 1), JSON.stringify(ex));
  const exInBody = await exExpand(exAt("return x + k", "x"));
  check("expandAt inside a closure body shows the closure's statement", exInBody.code === ex.code, JSON.stringify(exInBody));
  ex = await exExpand(exAt('parse("7") catch', "catch"));
  check("expandAt on a catch shows the lowered error check", /^n, __err\d+ := parse\("7"\)$/m.test(ex.code ?? "") && ex.code.includes("if __vidar.failed(") && ex.code.includes("fmt.println(\"bad:\", err)") && exSpans(ex, 'parse("7") catch', 'parse("7") catch', 3), JSON.stringify(ex));
  const exInCatch = await exExpand(exAt('fmt.println("bad:"', "fmt"));
  check("expandAt inside a catch block shows the whole catch", exInCatch.code === ex.code, JSON.stringify(exInCatch));
  ex = await exExpand(exAt("half := do!", "do"));
  check("expandAt on a do! shows its labeled block and the result", /^__do\d+: \{$/m.test(ex.code ?? "") && /^half := __do\d+_result$/m.test(ex.code) && /^\t__do\d+_result = v \/ 2$/m.test(ex.code) && exSpans(ex, "half := do!", "take v / 2", 1), JSON.stringify(ex));
  const exInDo = await exExpand(exAt("v := n * 3", "v"));
  check("expandAt on an unchanged statement inside a do! shows the whole do!", exInDo.code === ex.code, JSON.stringify(exInDo));
  const exTake = await exExpand(exAt("take v / 2", "take"));
  check("expandAt on a take shows the assignment and the break it becomes", /^__do\d+_result = v \/ 2\nbreak __do\d+$/m.test(exTake.code ?? "") && exSpans(exTake, "take v / 2", "take v / 2"), JSON.stringify(exTake));
  ex = await exExpand(exAt("total += xs[i]", "total"));
  check("expandAt on an unchanged statement shows just that statement", ex.code?.split("\n").slice(1).join("\n") === "total += xs[i]\n" && exSpans(ex, "total += xs[i]", "total += xs[i]"), JSON.stringify(ex));
  const exOpt = await exExpand(exAt("total += xs[i]", "total"), true);
  check("expandAt with opt shows the -opt output", exOpt.code?.includes("(-opt)") && exOpt.code.includes("#no_bounds_check") && !ex.code?.includes("#no_bounds_check"), JSON.stringify(exOpt));
  const exCatchOpt = await exExpand(exAt('parse("7") catch', "catch"), true);
  check("expandAt with opt marks the catch's failure path cold", exCatchOpt.code?.includes("__vidar.expect(__vidar.failed(") && !(await exExpand(exAt('parse("7") catch', "catch"))).code.includes("expect("), JSON.stringify(exCatchOpt));
  const exDoOpt = await exExpand(exAt("half := do!", "do"), true);
  check("expandAt with opt on a do! is the same code", exDoOpt.code?.replace(" (-opt)", "") === (await exExpand(exAt("half := do!", "do"))).code, JSON.stringify(exDoOpt));
  const exClosureOpt = await exExpand(exAt("add := proc[k]", "add"), true);
  check("expandAt with opt on a closure literal still shows its proc", exClosureOpt.code?.includes("__closure_0 :: proc"), JSON.stringify(exClosureOpt));
  const exBroken = nextDiagnostics((d) => d.uri === exUri && d.diagnostics.length > 0);
  notify("textDocument/didChange", { textDocument: { uri: exUri, version: 2 }, contentChanges: [{ text: exText.replace("return x + k", "k += x\n\t\treturn x + k") }] });
  await exBroken;
  ex = await exExpand(exAt("total += xs[i]", "total"));
  check("expandAt on a program with errors says so", /^fix 1 error/.test(ex.error ?? ""), JSON.stringify(ex));
  // ---- code actions: quick fixes for errors, opt-outs from -opt decisions ----
  {
  const actDir = realpathSync(mkdtempSync(join(tmpdir(), "vidar-lsp-actions-")));
  cpSync("tests/lsp/actions", actDir, { recursive: true });
  const aUri = pathToFileURL(join(actDir, "main.vidar")).toString();
  const aText = readFileSync(join(actDir, "main.vidar"), "utf8");
  const aLines = aText.split("\n");
  const aLine = (has) => aLines.findIndex((l) => l.includes(has));
  /** LSP text edits applied to `text`, last first */
  const applyEdits = (text, edits) => {
    const offset = (p) => text.split("\n").slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + p.character;
    const sorted = [...edits].sort((x, y) => offset(y.range.start) - offset(x.range.start));
    for (const e of sorted) text = text.slice(0, offset(e.range.start)) + e.newText + text.slice(offset(e.range.end));
    return text;
  };
  const aDiag = nextDiagnostics((d) => d.uri === aUri);
  notify("textDocument/didOpen", { textDocument: { uri: aUri, languageId: "vidar", version: 1, text: aText } });
  const ad = (await aDiag).diagnostics;
  const ads = JSON.stringify(ad.map((d) => [d.code, d.range.start.line, d.message.slice(0, 60)]));
  const diagOn = (has, code) => ad.find((d) => d.code === code && d.range.start.line === aLine(has));
  check("interface conversion errors carry a code, one per conversion in a proc", diagOn("s: Shape = sq", "iface-value") && diagOn("return built", "iface-value") && diagOn("area(Shape(p))", "iface-value"), ads);
  check("the diagnostic says why &x would dangle", diagOn("return built", "iface-value")?.message.includes("&x would dangle: the interface value is returned (line"), ads);
  check("&x would dangle through a call", diagOn("keep(mine)", "iface-value")?.message.includes("&x would dangle: the interface value is passed to keep (line 36), where it is appended to a global (line 32)"), ads);
  check("the diagnostic says why a parameter can't be pointed to", diagOn("area(Shape(p))", "iface-value")?.message.includes("Odin can't take the address of the parameter 'p'"), ads);
  check("a by-value capture write carries a code", diagOn("inc := proc[n]", "capture-by-value"), ads);
  check("a core package used without its import is an error", diagOn("fmt.println", "missing-import")?.message.includes('"core:fmt"') && !ad.some((d) => d.code === "missing-import" && d.message.includes("strings")), ads);

  const actionsOn = async (has, only) => {
    const line = aLine(has);
    const range = { start: { line, character: 0 }, end: { line, character: aLines[line].length } };
    return (await request("textDocument/codeAction", { textDocument: { uri: aUri }, range, context: { diagnostics: ad.filter((d) => d.range.start.line === line), ...(only ? { only } : {}) } })).result ?? [];
  };
  const titles = (acts) => JSON.stringify(acts.map((x) => [x.title, x.isPreferred]));
  const edited = (act) => applyEdits(aText, act?.edit?.changes?.[aUri] ?? []);
  const NEW_CLONE = "Allocate a heap copy (new_clone, caller frees)";

  let acts = await actionsOn("s: Shape = sq");
  const addr = acts.find((x) => x.title.includes("&sq"));
  const clone = acts.find((x) => x.title === NEW_CLONE);
  check("interface conversion: &x is the preferred quick fix", addr?.isPreferred === true && addr.kind === "quickfix" && edited(addr).includes("s: Shape = &sq\n") && addr.diagnostics?.[0]?.code === "iface-value", titles(acts));
  check("interface conversion: new_clone is offered separately, never preferred", clone && clone.isPreferred !== true && edited(clone).includes("s: Shape = new_clone(sq)\n"), titles(acts));
  acts = await actionsOn("return built");
  check("when &x would dangle, only new_clone is offered", acts.length === 1 && acts[0].title === NEW_CLONE && acts[0].isPreferred !== true && edited(acts[0]).includes("return new_clone(built)"), titles(acts));
  acts = await actionsOn("area(Shape(p))");
  check("a parameter gets only new_clone", acts.length === 1 && acts[0].title === NEW_CLONE && edited(acts[0]).includes("area(Shape(new_clone(p)))"), titles(acts));
  acts = await actionsOn("keep(mine)");
  check("passed to a proc that keeps it: only new_clone", acts.length === 1 && acts[0].title === NEW_CLONE && edited(acts[0]).includes("keep(new_clone(mine))"), titles(acts));
  acts = await actionsOn("n += 1");
  check("a write to a by-value capture: capture by reference", acts.some((x) => x.isPreferred && edited(x).includes("inc := proc[&n]() { n += 1 }")), titles(acts));
  acts = await actionsOn("fmt.println");
  const imp = acts.find((x) => x.title === 'Add import "core:fmt"');
  check("a missing import is added after the last one", imp?.isPreferred && edited(imp).includes('import "core:strings"\nimport "core:fmt"\n'), titles(acts));
  // packages outside the fixed table come from `odin root`
  const hasOdin = spawnSync("odin", ["root"]).status === 0;
  if (!hasOdin) console.log("SKIP lsp: odin not on PATH, so only the fixed package table is known");
  else {
    check("a package outside the fixed table is found under odin root", diagOn("xml.Document", "missing-import")?.message.includes('"core:encoding/xml"'), ads);
    check("a name two packages share lists both", /"core:crypto\/noise".*"core:math\/noise"/.test(diagOn("noise.noise_2d", "missing-import")?.message ?? ""), ads);
    acts = await actionsOn("xml.Document");
    const xmlImp = acts.find((x) => x.title === 'Add import "core:encoding/xml"');
    check("its import is the preferred fix", xmlImp?.isPreferred && edited(xmlImp).includes('import "core:strings"\nimport "core:encoding/xml"\n'), titles(acts));
    acts = await actionsOn("noise.noise_2d");
    check("a shared name offers each package, none preferred", acts.length === 2 && acts.every((x) => !x.isPreferred && x.title.startsWith('Add import "core:')) && acts.some((x) => x.title.includes("core:math/noise")), titles(acts));
  }
  acts = await actionsOn("bits :: proc");
  const noTable = acts.find((x) => x.title.includes("@(no_table)"));
  check("an automatic table can be turned off with @(no_table)", noTable && !noTable.isPreferred && edited(noTable).includes("@(no_table)\nbits :: proc"), titles(acts));

  const everyLine = (await request("textDocument/codeAction", { textDocument: { uri: aUri }, range: { start: { line: 0, character: 0 }, end: { line: aLines.length, character: 0 } }, context: { diagnostics: ad } })).result ?? [];
  check("new_clone is never a preferred fix", everyLine.some((x) => x.title === NEW_CLONE) && everyLine.every((x) => !(x.isPreferred && JSON.stringify(x.edit).includes("new_clone"))), titles(everyLine));
  const all = await actionsOn("package main", ["source.fixAll"]);
  const fixedAll = edited(all[0]);
  check("fix all applies the preferred fixes and never allocates", all.length === 1 && !fixedAll.includes("new_clone") && fixedAll.includes("s: Shape = &sq") && fixedAll.includes("proc[&n]") && fixedAll.includes('import "core:fmt"') && fixedAll.includes("return built"), fixedAll);
  if (hasOdin) check("fix all adds an unambiguous import from odin root, and not a shared name's", fixedAll.includes('import "core:encoding/xml"') && !fixedAll.includes("noise\""), fixedAll);

  // fixed by hand where no preferred fix applies: the program has no errors left
  const fixedText = fixedAll.replace("return built", "return new_clone(built)").replace("area(Shape(p))", "area(Shape(new_clone(p)))").replace("keep(mine)", "keep(new_clone(mine))").replace('import "core:strings"\n', 'import "core:strings"\nimport "core:math/noise"\n');
  const aFixed = nextDiagnostics((d) => d.uri === aUri);
  notify("textDocument/didChange", { textDocument: { uri: aUri, version: 2 }, contentChanges: [{ text: fixedText }] });
  const afd = (await aFixed).diagnostics;
  check("after the fixes the file has no errors", afd.length === 0, JSON.stringify(afd.map((d) => d.message)));
  }
  // ---- formatting ----
  const fmtDir = realpathSync(mkdtempSync(join(tmpdir(), "vidar-lsp-fmt-")));
  const fUri = pathToFileURL(join(fmtDir, "main.vidar")).toString();
  const fText = "package main\n\nmain :: proc() {\n    x:=1+2   \n  add := proc[x](y: int) -> int { return x+y }\n        _ = add( x )\n}\n";
  notify("textDocument/didOpen", { textDocument: { uri: fUri, languageId: "vidar", version: 1, text: fText } });
  const fEdits = (await request("textDocument/formatting", { textDocument: { uri: fUri }, options: { tabSize: 4, insertSpaces: false } })).result ?? [];
  const fLines = fText.split("\n");
  for (const e of fEdits) fLines[e.range.start.line] = fLines[e.range.start.line].slice(0, e.range.start.character) + e.newText + fLines[e.range.end.line].slice(e.range.end.character);
  const fWant = "package main\n\nmain :: proc() {\n\tx := 1 + 2\n\tadd := proc[x](y: int) -> int { return x + y }\n\t_ = add(x)\n}\n";
  check("formatting edits only the lines that change, and give vidar fmt's result", fEdits.length === 3 && fLines.join("\n") === fWant, JSON.stringify(fEdits));
  notify("textDocument/didChange", { textDocument: { uri: fUri, version: 2 }, contentChanges: [{ text: "x := `unterminated\n" }] });
  const fBad = await request("textDocument/formatting", { textDocument: { uri: fUri }, options: { tabSize: 4, insertSpaces: false } });
  check("formatting a file that doesn't lex gives no edits", Array.isArray(fBad.result) && fBad.result.length === 0, JSON.stringify(fBad));

  // ---- the workspace index: programs under a workspace folder, never opened (tests/lsp/index) ----
  {
    const idxDir = realpathSync(mkdtempSync(join(tmpdir(), "vidar-lsp-index-")));
    cpSync("tests/lsp/index", idxDir, { recursive: true });
    // directories the index skips (out/ can't be checked in)
    for (const [sub, name] of [["out", "out"], ["node_modules/pkg", "node"], [".hidden", "hidden"], ["tool/expected", "expected"]]) {
      mkdirSync(join(idxDir, sub), { recursive: true });
      writeFileSync(join(idxDir, sub, "x.vidar"), `package skipped\n\nindex_skipped_${name} :: proc() {}\n`);
    }
    const idxUri = pathToFileURL(idxDir).toString();
    const sent = diagnostics.length;
    notify("workspace/didChangeWorkspaceFolders", { event: { added: [{ uri: idxUri, name: "index" }], removed: [] } });
    let found = [];
    for (let i = 0; i < 100 && !["index_app_main", "index_lib_helper", "index_tool_bits"].every((n) => found.includes(n)); i++) {
      await new Promise((r) => setTimeout(r, 150));
      found = ((await request("workspace/symbol", { query: "index_" })).result ?? []).map((s) => s.name);
    }
    check("workspace symbols find programs whose files were never opened, and what they import", ["index_app_main", "index_lib_helper", "index_tool_bits"].every((n) => found.includes(n)), JSON.stringify(found));
    check("the workspace index skips out/, node_modules/, hidden and expected/ directories", !found.some((n) => n.startsWith("index_skipped")), JSON.stringify(found));
    const toolUri = pathToFileURL(join(idxDir, "tool", "main.vidar")).toString();
    const idxReport = (await request("vidar/optReport", {})).result;
    const toolReport = idxReport?.files?.find((f) => f.uri === toolUri);
    check("optReport without a uri covers a program only the workspace index analyzed", toolReport?.procs.some((p) => p.name === "index_tool_bits" && p.decisions.some((d) => d.label === "table")), JSON.stringify(idxReport?.files?.map((f) => f.uri)));
    check("programs only the workspace index analyzed get no diagnostics", !diagnostics.slice(sent).some((d) => d.uri.startsWith(idxUri)), JSON.stringify(diagnostics.slice(sent).map((d) => d.uri)));
    const toolDiag = nextDiagnostics((d) => d.uri === toolUri);
    notify("textDocument/didOpen", { textDocument: { uri: toolUri, languageId: "vidar", version: 1, text: readFileSync(join(idxDir, "tool", "main.vidar"), "utf8") } });
    check("opening a file of an indexed program publishes its diagnostics", (await toolDiag).diagnostics.length === 0, "");
    notify("workspace/didChangeWorkspaceFolders", { event: { added: [], removed: [{ uri: idxUri, name: "index" }] } });
    await new Promise((r) => setTimeout(r, 100));
    const afterRemove = ((await request("workspace/symbol", { query: "index_" })).result ?? []).map((s) => s.name);
    check("removing a workspace folder drops its unopened programs", !afterRemove.includes("index_app_main") && afterRemove.includes("index_tool_bits"), JSON.stringify(afterRemove));
  }

  writeFileSync(file, original);
  const restored = nextDiagnostics((d) => d.uri === uri && d.diagnostics.length === 0);
  change(original);
  await restored;
  const brokenMain = await renameAll(dir, file, original);
  check("renaming any symbol in the main fixture keeps the program equivalent", brokenMain.length === 0, brokenMain.join("\n  "));

  console.log(`\n${pass} passed, ${fail} failed`);
  await request("shutdown", null);
  notify("exit", null);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
