const vscode = require("vscode");
const fs = require("node:fs");
const path = require("node:path");
const { LanguageClient, TransportKind } = require("vscode-languageclient/node");

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

async function activate(context) {
  extensionPath = context.extensionPath;
  context.subscriptions.push(
    vscode.commands.registerCommand("vidar.showGeneratedOdin", showGeneratedOdin),
    vscode.commands.registerCommand("vidar.restartServer", async () => {
      await client?.stop();
      await start();
    }),
  );
  await start();
}

function deactivate() {
  return client?.stop();
}

module.exports = { activate, deactivate };
