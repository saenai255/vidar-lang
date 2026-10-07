const vscode = require("vscode");
const fs = require("node:fs");
const path = require("node:path");
const { LanguageClient, TransportKind } = require("vscode-languageclient/node");
const optReport = require("./optreport");

let client;
let extensionPath;

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

async function showGeneratedOdin() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== "vidar") return;
  const res = await client.sendRequest("vidar/generatedOdin", { uri: editor.document.uri.toString() });
  if (res.error) return vscode.window.showErrorMessage(res.error);
  const content = Object.entries(res.files)
    .sort(([a], [b]) => (a === res.main ? -1 : b === res.main ? 1 : a.localeCompare(b)))
    .map(([name, text]) => (Object.keys(res.files).length > 1 ? `// ==== ${name} ====\n${text}` : text))
    .join("\n");
  const doc = await vscode.workspace.openTextDocument({ language: "odin", content });
  await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: true });
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

async function activate(context) {
  extensionPath = context.extensionPath;
  context.subscriptions.push(
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
