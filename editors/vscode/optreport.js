// "Vidar: Optimization Report": every -opt decision from the language server's `vidar/optReport`, as a tree of file -> proc -> decision.
const vscode = require("vscode");

const VIEW = "vidar.optReport";

const counts = (n, m) => `${n} optimization${n === 1 ? "" : "s"}, ${m} not`;

class OptReportProvider {
  constructor(getClient) {
    this.getClient = getClient;
    this.files = [];
    this.parents = new Map();
    this.changed = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changed.event;
  }

  /** Asks the server again; `uri` adds that file even if its package isn't analyzed yet. */
  async refresh(uri) {
    const client = this.getClient();
    if (!client || !client.isRunning?.()) return;
    try {
      const all = await client.sendRequest("vidar/optReport", {});
      const files = all.files ?? [];
      if (uri && !files.some((f) => f.uri === uri)) files.push(...((await client.sendRequest("vidar/optReport", { uri })).files ?? []));
      files.sort((a, b) => a.uri.localeCompare(b.uri));
      this.files = files.map((f) => ({ kind: "file", uri: f.uri, procs: f.procs }));
      this.parents.clear();
      for (const f of this.files) {
        f.children = f.procs.map((p) => ({ kind: "proc", uri: f.uri, proc: p }));
        for (const p of f.children) {
          this.parents.set(p, f);
          p.children = p.proc.decisions.map((d) => ({ kind: "decision", uri: f.uri, decision: d }));
          for (const d of p.children) this.parents.set(d, p);
        }
      }
    } catch (err) {
      this.files = [];
      console.error(`vidar: optimization report failed: ${err}`);
    }
    this.changed.fire();
  }

  getChildren(el) {
    return el ? el.children : this.files;
  }

  getParent(el) {
    return this.parents.get(el);
  }

  getTreeItem(el) {
    const C = vscode.TreeItemCollapsibleState;
    if (el.kind === "file") {
      const item = new vscode.TreeItem(vscode.Uri.parse(el.uri), C.Expanded);
      const n = el.procs.reduce((s, p) => s + p.optimizations, 0);
      const m = el.procs.reduce((s, p) => s + p.against, 0);
      item.description = counts(n, m);
      return item;
    }
    if (el.kind === "proc") {
      const p = el.proc;
      const item = new vscode.TreeItem(p.name, C.Collapsed);
      item.description = counts(p.optimizations, p.against);
      item.iconPath = new vscode.ThemeIcon("symbol-function");
      item.command = this.jump(el.uri, p.selectionRange);
      return item;
    }
    const d = el.decision;
    const item = new vscode.TreeItem(d.label, C.None);
    item.description = `line ${d.range.start.line + 1}${d.against ? " · not done" : ""}`;
    item.tooltip = new vscode.MarkdownString(`**${d.label}**${d.against ? " (decided against)" : ""}${d.tooltip ? `\n\n${d.tooltip}` : ""}`);
    item.iconPath = d.against
      ? new vscode.ThemeIcon("circle-slash", new vscode.ThemeColor("problemsWarningIcon.foreground"))
      : new vscode.ThemeIcon("zap", new vscode.ThemeColor("charts.green"));
    item.command = this.jump(el.uri, d.range);
    return item;
  }

  jump(uri, range) {
    const r = new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character);
    return { title: "Go to", command: "vscode.open", arguments: [vscode.Uri.parse(uri), { selection: r }] };
  }

  /** The proc node for (uri, name, line), or the one around `line`. */
  find(uri, name, line) {
    const f = this.files.find((x) => x.uri === uri);
    if (!f) return undefined;
    return f.children.find((p) => p.proc.name === name && p.proc.selectionRange.start.line === line)
      ?? f.children.find((p) => p.proc.range.start.line <= line && line <= p.proc.range.end.line)
      ?? f;
  }
}

/** Registers the tree view and its commands; `getClient` returns the current language client. */
function register(context, getClient) {
  const provider = new OptReportProvider(getClient);
  const view = vscode.window.createTreeView(VIEW, { treeDataProvider: provider, showCollapseAll: true });
  const activeUri = () => {
    const e = vscode.window.activeTextEditor;
    return e && e.document.languageId === "vidar" ? e.document.uri.toString() : undefined;
  };
  vscode.commands.executeCommand("setContext", "vidar.active", true);
  context.subscriptions.push(
    view,
    vscode.commands.registerCommand("vidar.refreshOptReport", () => provider.refresh(activeUri())),
    // from a code lens: (uri, proc name, line); from the palette: the proc at the cursor
    vscode.commands.registerCommand("vidar.showOptReport", async (uri, name, line) => {
      const e = vscode.window.activeTextEditor;
      uri ??= activeUri();
      line ??= e?.selection.active.line ?? 0;
      await vscode.commands.executeCommand(`${VIEW}.focus`);
      await provider.refresh(uri);
      const node = uri && provider.find(uri, name, line);
      if (node) await view.reveal(node, { select: true, focus: true, expand: true });
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.languageId === "vidar" && view.visible) provider.refresh(doc.uri.toString());
    }),
    view.onDidChangeVisibility(({ visible }) => visible && provider.refresh(activeUri())),
  );
  return provider;
}

module.exports = { register };
