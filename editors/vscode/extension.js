const vscode = require("vscode");
const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
const { LanguageClient, TransportKind } = require("vscode-languageclient/node");
const optReport = require("./optreport");

let client;
let extensionPath;
let context;

/** The server shipped inside a platform-specific .vsix, if any. */
function bundledServer() {
  const file = path.join(extensionPath, "server", process.platform === "win32" ? "vidar-lsp.exe" : "vidar-lsp");
  if (!fs.existsSync(file)) return undefined;
  try {
    fs.chmodSync(file, 0o755); // zip extraction may drop the executable bit
  } catch {}
  return file;
}

function serverOptions() {
  const cfg = vscode.workspace.getConfiguration("vidar");
  const configured = cfg.inspect("server.path");
  const explicit = configured.workspaceFolderValue ?? configured.workspaceValue ?? configured.globalValue;
  const path = explicit ?? bundledServer() ?? configured.defaultValue;
  // a .js path runs with VS Code's own Node; anything else is an executable on PATH
  if (path.endsWith(".js")) return { module: path, transport: TransportKind.stdio };
  return { command: path, args: ["--stdio"], transport: TransportKind.stdio };
}

async function start() {
  const cfg = vscode.workspace.getConfiguration("vidar");
  client = new LanguageClient("vidar", "Vidar", serverOptions(), {
    documentSelector: [{ scheme: "file", language: "vidar" }],
    initializationOptions: { odinCheckOnSave: cfg.get("odinCheckOnSave"), odinPath: cfg.get("odinPath"), ols: cfg.get("ols"), olsPath: cfg.get("olsPath"), optHints: cfg.get("optHints") },
    synchronize: { configurationSection: "vidar" },
  });
  await client.start();
}

/** The first generated line (0-based) for .vidar line `line` (0-based), skipping comment-only lines; as `generatedLine` in src/runmap.ts. */
function generatedLine(lines, line, text) {
  const want = line + 1;
  const code = (i) => !/^\s*(\/\/.*)?$/.test(text[i] ?? "");
  let near = -1;
  let any = -1;
  for (let i = 0; i < lines.length; i++) {
    if (Math.abs(lines[i]) !== want) continue;
    if (any < 0) any = i;
    if (!code(i)) continue;
    if (lines[i] === want) return i;
    if (near < 0) near = i;
  }
  if (near >= 0 || any >= 0) return near >= 0 ? near : any;
  let best = -1;
  for (let i = 0; i < lines.length; i++) if (lines[i] > want && (best < 0 || lines[i] < lines[best])) best = i;
  return best;
}

async function revealLine(doc, line, column) {
  const editor = await vscode.window.showTextDocument(doc, { viewColumn: column, preview: true });
  if (line < 0) return;
  const pos = new vscode.Position(line, 0);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
}

/**
 * The generated file from the last debug build that came from `source`, if that build is up to
 * date with it: there a breakpoint binds, since it is the file the binary was built from.
 */
function debugBuildFile(source, document) {
  const dir = context?.workspaceState.get("vidar.debugOutDir");
  if (!dir || document.isDirty) return undefined;
  try {
    const mapFile = path.join(dir, "vidar.map.json");
    const map = JSON.parse(fs.readFileSync(mapFile, "utf8"));
    const entry = Object.entries(map.files ?? {}).find(([, f]) => f.source === source);
    if (!entry || fs.statSync(source).mtimeMs > fs.statSync(mapFile).mtimeMs) return undefined;
    return { file: path.join(dir, entry[0]), lines: entry[1].lines };
  } catch {
    return undefined;
  }
}

async function showGeneratedOdin() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== "vidar") return;
  const line = editor.selection.active.line;
  const built = debugBuildFile(editor.document.uri.fsPath, editor.document);
  if (built) {
    const doc = await vscode.workspace.openTextDocument(built.file);
    return revealLine(doc, generatedLine(built.lines, line, doc.getText().split("\n")), vscode.ViewColumn.Beside);
  }
  const res = await client.sendRequest("vidar/generatedOdin", { uri: editor.document.uri.toString(), line });
  if (res.error) return vscode.window.showErrorMessage(res.error);
  const multi = Object.keys(res.files).length > 1;
  const content = Object.entries(res.files)
    .sort(([a], [b]) => (a === res.main ? -1 : b === res.main ? 1 : a.localeCompare(b)))
    .map(([name, text]) => (multi ? `// ==== ${name} ====\n${text}` : text))
    .join("\n");
  const doc = await vscode.workspace.openTextDocument({ language: "odin", content });
  // the main file comes first, after its header line when there are several
  await revealLine(doc, res.line === undefined ? -1 : res.line + (multi ? 1 : 0), vscode.ViewColumn.Beside);
}

// ---- Expand at Cursor: the Odin for the statement at the cursor, in a read-only side editor ----

const EXPAND_URI = vscode.Uri.from({ scheme: "vidar-expand", path: "/Expand at Cursor.odin" });
const expand = { opt: false, source: undefined, version: undefined, code: "", range: undefined, timer: undefined, changed: new vscode.EventEmitter() };
const expandVisible = () => vscode.window.visibleTextEditors.some((e) => e.document.uri.toString() === EXPAND_URI.toString());
/** The .vidar editor to expand: the active one, else the one last expanded */
const expandSource = () =>
  vscode.window.activeTextEditor?.document.languageId === "vidar"
    ? vscode.window.activeTextEditor
    : vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === expand.source?.toString());

/** Asks the server for the statement at the cursor, unless (without `force`) the cursor is still in the last one. */
async function refreshExpansion(editor, force) {
  if (!editor || editor.document.languageId !== "vidar" || !client) return;
  const pos = editor.selection.active;
  const same = expand.source?.toString() === editor.document.uri.toString() && expand.version === editor.document.version;
  if (!force && same && expand.range?.contains(pos)) return;
  const res = await client.sendRequest("vidar/expandAt", { uri: editor.document.uri.toString(), position: { line: pos.line, character: pos.character }, opt: expand.opt });
  expand.source = editor.document.uri;
  expand.version = editor.document.version;
  expand.range = res.error ? undefined : new vscode.Range(res.range.start.line, res.range.start.character, res.range.end.line, res.range.end.character);
  const code = res.error ? `// ${res.error.split("\n").join("\n// ")}\n` : res.code;
  if (code === expand.code) return;
  expand.code = code;
  expand.changed.fire(EXPAND_URI);
}

async function expandAtCursor() {
  const editor = expandSource();
  if (!editor) return vscode.window.showInformationMessage("Vidar: Expand at Cursor works in a .vidar file");
  await refreshExpansion(editor, true);
  const doc = await vscode.workspace.openTextDocument(EXPAND_URI);
  if (doc.languageId !== "odin") {
    try {
      await vscode.languages.setTextDocumentLanguage(doc, "odin");
    } catch {} // no Odin language installed: plain text
  }
  await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true, preview: true });
}

async function toggleExpandOpt() {
  expand.opt = !expand.opt;
  vscode.window.setStatusBarMessage(`Vidar: Expand at Cursor shows the ${expand.opt ? "-opt" : "plain"} output`, 3000);
  if (expandSource()) await expandAtCursor();
}

function followCursor(e) {
  if (e.textEditor.document.languageId !== "vidar" || !expandVisible()) return;
  clearTimeout(expand.timer);
  expand.timer = setTimeout(() => refreshExpansion(e.textEditor, false).catch(() => {}), 150);
}

// ---- debugging: build with `vidar build -debug`, then hand the binary to CodeLLDB or gdb ----

/** How to run the vidar CLI: `vidar.cliPath`, else the bundled binary in CLI mode, else `vidar` on PATH. */
function cliCommand() {
  const cfg = vscode.workspace.getConfiguration("vidar");
  const configured = cfg.get("cliPath");
  if (configured) return configured.endsWith(".js") ? { command: "node", args: [configured], env: {} } : { command: configured, args: [], env: {} };
  const server = cfg.inspect("server.path");
  const explicit = server.workspaceFolderValue ?? server.workspaceValue ?? server.globalValue;
  // dist/lsp/server.js sits next to dist/cli.js
  if (explicit?.endsWith(".js")) return { command: "node", args: [path.join(path.dirname(explicit), "..", "cli.js")], env: {} };
  const bundled = bundledServer();
  if (bundled) return { command: bundled, args: [], env: { VIDAR_CLI: "1" } };
  return { command: "vidar", args: [], env: {} };
}

let output;

function buildForDebug(config, cwd) {
  const cli = cliCommand();
  const program = path.resolve(cwd, config.program);
  const name = path.basename(program).replace(/\.vidar$/, "");
  const outDir = path.resolve(cwd, config.outDir ?? path.join("out", `${name}-debug`));
  const args = [...cli.args, "build", program, "-debug", "-o", outDir, ...(config.opt ? ["-opt"] : []), ...(config.odinFlags?.length ? ["--", ...config.odinFlags] : [])];
  output ??= vscode.window.createOutputChannel("Vidar");
  output.appendLine(`$ ${cli.command} ${args.join(" ")}`);
  return new Promise((resolve) => {
    const child = cp.spawn(cli.command, args, { cwd, env: { ...process.env, ...cli.env } });
    let log = "";
    const take = (d) => {
      log += d;
      output.append(String(d));
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", (err) => {
      output.appendLine(String(err));
      resolve({ error: `could not run ${cli.command}: ${err.message} (set vidar.cliPath)` });
    });
    child.on("close", (code) => {
      if (code !== 0) return resolve({ error: `vidar build -debug failed (exit ${code}); see the Vidar output` });
      const binary = /^built (.+) with debug info$/m.exec(log)?.[1] ?? path.join(outDir, process.platform === "win32" ? `${name}.exe` : name);
      resolve({ binary, outDir });
    });
  });
}

const debugProvider = {
  provideDebugConfigurations() {
    return [{ type: "vidar", request: "launch", name: "Debug Vidar program", program: "${workspaceFolder}" }];
  },
  resolveDebugConfiguration(folder, config) {
    // F5 without a launch.json: debug the package of the open .vidar file
    if (!config.type && !config.request && !config.name) {
      const editor = vscode.window.activeTextEditor;
      if (editor?.document.languageId !== "vidar") return undefined;
      return { type: "vidar", request: "launch", name: "Debug Vidar program", program: path.dirname(editor.document.uri.fsPath) };
    }
    return config;
  },
  async resolveDebugConfigurationWithSubstitutedVariables(folder, config) {
    const cwd = config.cwd ?? folder?.uri.fsPath ?? (config.program ? path.dirname(path.resolve(config.program)) : process.cwd());
    if (!config.program) {
      vscode.window.showErrorMessage("vidar debug configuration: set `program` to the package directory or .vidar file");
      return undefined;
    }
    const built = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "vidar build -debug" }, () => buildForDebug(config, cwd));
    if (built.error) {
      output?.show(true);
      vscode.window.showErrorMessage(built.error);
      return undefined;
    }
    await context.workspaceState.update("vidar.debugOutDir", built.outDir);
    const common = { name: `${config.name} (${config.debugger === "gdb" ? "gdb" : "lldb"})`, request: "launch", program: built.binary, args: config.args ?? [], cwd };
    const target =
      config.debugger === "gdb"
        ? { ...common, type: "cppdbg", MIMode: "gdb", miDebuggerPath: config.debuggerPath ?? "gdb", stopAtEntry: !!config.stopOnEntry, environment: Object.entries(config.env ?? {}).map(([name, value]) => ({ name, value })) }
        : { ...common, type: "lldb", stopOnEntry: !!config.stopOnEntry, env: config.env ?? {} };
    await vscode.debug.startDebugging(folder, target);
    // the vidar configuration only builds; the session that runs is the lldb or gdb one
    return undefined;
  },
};

async function activate(ctx) {
  context = ctx;
  extensionPath = context.extensionPath;
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider("vidar", debugProvider),
    vscode.commands.registerCommand("vidar.showGeneratedOdin", showGeneratedOdin),
    vscode.commands.registerCommand("vidar.expandAtCursor", expandAtCursor),
    vscode.commands.registerCommand("vidar.expandAtCursorToggleOpt", toggleExpandOpt),
    vscode.workspace.registerTextDocumentContentProvider(EXPAND_URI.scheme, { onDidChange: expand.changed.event, provideTextDocumentContent: () => expand.code }),
    vscode.window.onDidChangeTextEditorSelection(followCursor),
    // edits move the statement: refresh once the server has the new text
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== expand.source?.toString() || !expandVisible()) return;
      clearTimeout(expand.timer);
      expand.timer = setTimeout(() => refreshExpansion(expandSource(), true).catch(() => {}), 400);
    }),
    vscode.commands.registerCommand("vidar.restartServer", async () => {
      await client?.stop();
      await start();
    }),
  );
  optReport.register(context, () => client);
  await start();
}

function deactivate() {
  return client?.stop();
}

module.exports = { activate, deactivate };
