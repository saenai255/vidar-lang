#!/usr/bin/env node
import {
  CodeActionKind, CompletionItem, DidChangeWatchedFilesNotification, CompletionItemKind, Diagnostic, DiagnosticSeverity, DocumentSymbol, InitializeResult, ProposedFeatures,
  SymbolKind as LspSymbolKind, TextDocumentSyncKind, TextDocuments, TextEdit, createConnection,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { CompileError } from "../lexer";
import { Program as Analysis, emitProgram, loadProgram, outputName, preludeSourcePath } from "../project";
import { optimizeAll } from "../optimize";
import { hotWarnings } from "../checks";
import { PRELUDE_PATH } from "../prelude";
import { writeOutput } from "../cli";
import { formatEdits } from "../format";
import { generatedLine } from "../runmap";
import { relativeInside } from "../paths";
import * as F from "./features";
import * as Actions from "./actions";
import { OdinBridge } from "./odin";
import * as N from "./navigation";
import * as Sem from "./semantic";
import * as R from "./optreport";
import { expandAt } from "./expand";
import { WorkspaceIndex } from "./workspace";

// editors usually pass --stdio; default to it so `vidar-lsp` alone works too
if (!process.argv.some((a) => /^--(stdio|node-ipc|socket|pipe)/.test(a))) process.argv.push("--stdio");

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

interface PackageState {
  current?: Analysis;
  index?: F.Index;
  lastGood?: Analysis;
  /** a separate analysis with -opt on, made when hints are asked for */
  opt?: { of: Analysis; program: Analysis };
  /** @(hot) warnings, from the -opt analysis */
  hotWarnings: CompileError[];
  odinDiagnostics: Map<string, Diagnostic[]>;
  /** analyzed by the workspace index only: no diagnostics published */
  quiet?: boolean;
}

const packages = new Map<string, PackageState>();
const timers = new Map<string, NodeJS.Timeout>();
let settings = { odinCheckOnSave: true, odinPath: "odin", ols: true, olsPath: "ols", optHints: "on" as string | boolean, optCodeLens: true, indexWorkspace: true };
/** workspace folders, for the workspace index; `folderEvents`: the client sends folder changes */
let workspaceRoots: string[] = [];
let folderEvents = false;
let ols: OdinBridge | undefined;
let hintRefresh = false;
let semanticRefresh = false;
let watchRegistration = false;
let lensRefresh = false;

const toPath = (uri: string) => fileURLToPath(uri);
const toUri = (path: string) => pathToFileURL(path === PRELUDE_PATH ? preludeSourcePath() : path).toString();

function pkg(dir: string): PackageState {
  let p = packages.get(dir);
  if (!p) packages.set(dir, (p = { hotWarnings: [], odinDiagnostics: new Map() }));
  return p;
}

/** Unsaved editor contents, used instead of what is on disk. */
function overrides(): Map<string, string> {
  return new Map(documents.all().map((d) => [toPath(d.uri), d.getText()]));
}

function toDiagnostic(err: CompileError, source: string, severity: DiagnosticSeverity = DiagnosticSeverity.Error): Diagnostic {
  const line = (err.pos?.line ?? 1) - 1;
  const col = (err.pos?.col ?? 1) - 1;
  return {
    range: { start: { line, character: col }, end: { line, character: col + 1 } },
    severity,
    source,
    ...(Actions.fixCode(err) ? { code: Actions.fixCode(err) } : {}),
    message: err.message + Actions.fixNote(err),
  };
}

/**
 * `quiet`: a program found by the workspace index, with no file open: analyzed for workspace symbols and the
 * `-opt` report, without diagnostics, ols or `@(hot)` warnings until a file of it is opened.
 */
function analyzePackage(dir: string, quiet = false): PackageState {
  const state = pkg(dir);
  let a: Analysis;
  try {
    // the package in `dir` is the entry; packages it imports (and import cycles) come along
    a = loadProgram(dir, { tolerant: true, overrides: overrides() });
  } catch (err) {
    // internal failure: keep serving the last analysis rather than crashing
    connection.console.error(`vidar: analysis failed: ${err instanceof Error ? err.stack : err}`);
    return state;
  }
  state.current = a;
  state.index = new F.Index(a);
  if (!a.errors.length) state.lastGood = a;
  state.quiet = quiet;
  if (quiet) return state;
  const opt = a.analyzer.hotProcs.size && !a.errors.length ? optAnalysis(state, dir) : undefined;
  state.hotWarnings = opt ? hotWarnings(opt.analyzer) : [];
  if (ols) syncOdin(dir, a);
  publish(dir, state);
  if (hintRefresh && settings.optHints !== "off" && settings.optHints !== false) connection.languages.inlayHint.refresh().catch(() => {});
  if (semanticRefresh) connection.languages.semanticTokens.refresh();
  return state;
}

function syncOdin(dir: string, a: Analysis): void {
  if (!a.errors.length) {
    try {
      ols!.recordEmit(dir, a, emitProgram(a, undefined, { columns: true }));
    } catch {}
  }
  ols!.sync(dir, a, overrides()).catch((err) => connection.console.error(`vidar: ols sync failed: ${err}`));
}

function publish(dir: string, state: PackageState): void {
  const a = state.current;
  if (!a) return;
  for (const s of a.sources) {
    const diags = a.errors.filter((e) => (e.pos?.file ?? a.sources[0].path) === s.path).map((e) => toDiagnostic(e, "vidar"));
    diags.push(...state.hotWarnings.filter((w) => w.pos?.file === s.path).map((w) => toDiagnostic(w, "vidar", DiagnosticSeverity.Warning)));
    diags.push(...Actions.importDiagnostics(a, s.path, s.text));
    diags.push(...(state.odinDiagnostics.get(s.path) ?? []));
    connection.sendDiagnostics({ uri: toUri(s.path), diagnostics: diags });
  }
}

/** Whether a file of the package in `dir` is open in the editor. */
function isOpen(dir: string): boolean {
  return documents.all().some((d) => d.uri.startsWith("file:") && dirname(toPath(d.uri)) === dir);
}

function schedule(dir: string): void {
  Idx.touch();
  clearTimeout(timers.get(dir));
  // a program only the workspace index knows stays quiet while none of its root package's files is open
  timers.set(dir, setTimeout(() => analyzePackage(dir, !!pkg(dir).quiet && !isOpen(dir)), 150));
}

function stateFor(uri: string): { state: PackageState; path: string } {
  Idx.touch();
  const path = toPath(uri);
  const dir = dirname(path);
  const state = pkg(dir);
  if (!state.current) analyzePackage(dir);
  return { state, path };
}

// ---- the workspace index: every program under the workspace folders, analyzed in the background ----

const Idx = new WorkspaceIndex({
  analyzed: (dir) => [...packages.values()].some((st) => st.current?.packages.some((p) => p.dir === dir)),
  analyze: (dir) => {
    const state = analyzePackage(dir, true);
    // the -opt report without a uri covers every program: have it ready
    if (state.current && !state.current.errors.length) optAnalysis(state, dir);
  },
  forget: (root) => {
    for (const [dir, st] of packages) if (st.quiet && !isOpen(dir) && (dir === root || dir.startsWith(root + sep))) packages.delete(dir);
  },
  log: (m) => connection.console.log(m),
});

// ---- odin check on save ----

const ODIN_DIAG = /^(.*?)\((\d+):(\d+)\)\s+(Error|Warning|Syntax Error):\s*(.*)$/;

function odinCheck(dir: string): void {
  const state = pkg(dir);
  const a = state.current;
  if (!settings.odinCheckOnSave || !a || a.errors.length) return;
  let out: ReturnType<typeof emitProgram>;
  try {
    out = emitProgram(a);
  } catch {
    return;
  }
  const work = realpathSync(mkdtempSync(join(tmpdir(), "vidar-lsp-")));
  writeOutput(out, work);
  const proc = spawn(settings.odinPath, ["check", work], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  proc.stderr.on("data", (d) => (stderr += d));
  proc.on("error", () => rmSync(work, { recursive: true, force: true }));
  proc.on("close", () => {
    rmSync(work, { recursive: true, force: true });
    const diags = new Map<string, Diagnostic[]>();
    const lines = stderr.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = ODIN_DIAG.exec(lines[i].trim());
      if (!m) continue;
      // on Windows Odin may print the path with other slashes, or the drive letter in another case
      const name = relativeInside(work, m[1]) ?? m[1].split("\\").join("/");
      const sourcePath = out.sourceOf.get(name);
      const source = a.sources.find((s) => s.path === sourcePath);
      if (!source) continue;
      const lineCount = source.text.split("\n").length;
      const mapped = out.lineMap.get(name)?.[Number(m[2]) - 1] ?? 0;
      // helper code vidar appends has no source line; report it on the last one
      const line = (mapped ? Math.abs(mapped) : lineCount) - 1;
      const inGenerated = mapped <= 0;
      const detail = lines[i + 1]?.trim();
      const list = diags.get(source.path) ?? [];
      list.push({
        range: { start: { line, character: Number(m[3]) - 1 }, end: { line, character: Number(m[3]) } },
        severity: m[4] === "Warning" ? DiagnosticSeverity.Warning : DiagnosticSeverity.Error,
        source: "odin",
        message: `${m[5]}${inGenerated ? " (in code generated by vidar)" : ""}${detail && !ODIN_DIAG.test(detail) ? `\n${detail}` : ""}`,
      });
      diags.set(source.path, list);
    }
    state.odinDiagnostics = diags;
    publish(dir, state);
  });
}

// ---- protocol ----

connection.onInitialize((params): InitializeResult => {
  const opts = params.initializationOptions ?? {};
  settings = { ...settings, ...opts };
  Actions.setOdinPath(settings.odinPath);
  hintRefresh = !!params.capabilities.workspace?.inlayHint?.refreshSupport;
  semanticRefresh = !!params.capabilities.workspace?.semanticTokens?.refreshSupport;
  watchRegistration = !!params.capabilities.workspace?.didChangeWatchedFiles?.dynamicRegistration;
  lensRefresh = !!params.capabilities.workspace?.codeLens?.refreshSupport;
  if (settings.ols) ols = new OdinBridge(settings.olsPath, (m) => connection.console.warn(m));
  const roots = params.workspaceFolders?.map((f) => f.uri) ?? (params.rootUri ? [params.rootUri] : params.rootPath ? [pathToFileURL(params.rootPath).toString()] : []);
  workspaceRoots = roots.filter((u) => u.startsWith("file:")).map(toPath);
  folderEvents = !!params.capabilities.workspace?.workspaceFolders;
  return {
    capabilities: {
      workspace: { workspaceFolders: { supported: true, changeNotifications: true } },
      textDocumentSync: { openClose: true, change: TextDocumentSyncKind.Incremental, save: { includeText: false } },
      hoverProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      renameProvider: true,
      documentSymbolProvider: true,
      completionProvider: { triggerCharacters: [":", ".", ">"] },
      signatureHelpProvider: { triggerCharacters: ["(", ","], retriggerCharacters: [","] },
      inlayHintProvider: true,
      workspaceSymbolProvider: true,
      implementationProvider: true,
      callHierarchyProvider: true,
      semanticTokensProvider: { legend: Sem.LEGEND, full: true, range: true },
      codeLensProvider: { resolveProvider: false },
      codeActionProvider: { codeActionKinds: [CodeActionKind.QuickFix, CodeActionKind.SourceFixAll] },
      documentFormattingProvider: true,
    },
    serverInfo: { name: "vidar-lsp", version: "0.1.0" },
  };
});

connection.onInitialized(() => {
  if (watchRegistration) connection.client.register(DidChangeWatchedFilesNotification.type, { watchers: [{ globPattern: "**/vidar.toml" }] }).catch(() => {});
  if (!settings.indexWorkspace) return;
  Idx.addRoots(workspaceRoots);
  if (folderEvents) {
    connection.workspace.onDidChangeWorkspaceFolders((e) => {
      Idx.removeRoots(e.removed.filter((f) => f.uri.startsWith("file:")).map((f) => toPath(f.uri)));
      Idx.addRoots(e.added.filter((f) => f.uri.startsWith("file:")).map((f) => toPath(f.uri)));
    });
  }
});

/** Every analyzed program that contains `path` (its own package, plus programs importing it). */
function programsWith(path: string): string[] {
  const dirs = new Set([dirname(path)]);
  for (const [dir, st] of packages) if (st.current?.sources.some((s) => s.path === path)) dirs.add(dir);
  return [...dirs];
}

documents.onDidChangeContent((e) => {
  for (const dir of programsWith(toPath(e.document.uri))) {
    pkg(dir).odinDiagnostics.clear();
    schedule(dir);
  }
});

documents.onDidSave((e) => {
  for (const dir of programsWith(toPath(e.document.uri))) {
    clearTimeout(timers.get(dir));
    analyzePackage(dir, !!pkg(dir).quiet && !isOpen(dir));
  }
  odinCheck(dirname(toPath(e.document.uri)));
});

// a changed vidar.toml moves imports of every analyzed program (the client sends these once it watches the file)
connection.onDidChangeWatchedFiles((e) => {
  if (!e.changes.some((c) => c.uri.endsWith("/vidar.toml"))) return;
  for (const [dir, st] of packages) if (st.current) schedule(dir);
});

documents.onDidClose((e) => connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] }));

const loc = (l: F.Location) => ({ uri: toUri(l.file), range: l.range });

/** Current text of an open document, else what the analysis read. */
function textOf(state: PackageState, uri: string, path: string): string | undefined {
  return documents.get(uri)?.getText() ?? state.current?.sources.find((s) => s.path === path)?.text;
}

connection.onHover(async ({ textDocument, position }) => {
  const { state, path } = stateFor(textDocument.uri);
  if (!state.current || !state.index) return null;
  const h = F.hover(state.current, state.index, path, position);
  if (h && !h.weak) return { contents: { kind: "markdown", value: h.markdown }, range: h.range };
  const text = textOf(state, textDocument.uri, path);
  const fromOdin = text !== undefined ? await ols?.hover(dirname(path), path, text, position) : undefined;
  if (fromOdin) return fromOdin;
  return h ? { contents: { kind: "markdown", value: h.markdown }, range: h.range } : null;
});

connection.onDefinition(async ({ textDocument, position }) => {
  const { state, path } = stateFor(textDocument.uri);
  if (!state.current || !state.index) return null;
  const d = F.definition(state.current, state.index, path, position);
  if (d) return loc(d);
  const text = textOf(state, textDocument.uri, path);
  const fromOdin = text !== undefined ? await ols?.definition(dirname(path), path, text, position) : undefined;
  return fromOdin?.length ? fromOdin : null;
});

connection.onSignatureHelp(async ({ textDocument, position }) => {
  const { state, path } = stateFor(textDocument.uri);
  const text = textOf(state, textDocument.uri, path);
  return (text !== undefined ? await ols?.signatureHelp(dirname(path), path, text, position) : undefined) ?? null;
});

connection.onReferences(({ textDocument, position, context }) => {
  const { state, path } = stateFor(textDocument.uri);
  if (!state.index) return [];
  return F.references(state.index, path, position, context.includeDeclaration).map(loc);
});

connection.onRenameRequest(({ textDocument, position, newName }) => {
  const { state, path } = stateFor(textDocument.uri);
  if (!state.index) return null;
  const r = F.rename(state.index, path, position, newName);
  if (r.error) throw new Error(r.error);
  const changes: Record<string, TextEdit[]> = {};
  for (const e of r.edits) (changes[toUri(e.file)] ??= []).push(TextEdit.replace(e.range, e.text));
  return { changes };
});

const SYMBOL_KINDS: Record<F.SymbolKind, LspSymbolKind> = {
  namespace: LspSymbolKind.Namespace, function: LspSymbolKind.Function, macro: LspSymbolKind.Operator,
  struct: LspSymbolKind.Struct, interface: LspSymbolKind.Interface, enum: LspSymbolKind.Enum, union: LspSymbolKind.Enum,
  type: LspSymbolKind.TypeParameter, constant: LspSymbolKind.Constant, variable: LspSymbolKind.Variable,
  impl: LspSymbolKind.Class, field: LspSymbolKind.Field, method: LspSymbolKind.Method,
};

// formatting only changes whitespace and keeps every line, so the edits are per line; a file that doesn't lex gets none
connection.onDocumentFormatting(({ textDocument }) => {
  const doc = documents.get(textDocument.uri);
  try {
    return doc ? formatEdits(doc.getText(), toPath(textDocument.uri)) : [];
  } catch {
    return [];
  }
});

connection.onDocumentSymbol(({ textDocument }) => {
  const { state, path } = stateFor(textDocument.uri);
  if (!state.current) return [];
  const conv = (s: F.DocSymbol): DocumentSymbol => ({
    name: s.name, detail: s.detail, kind: SYMBOL_KINDS[s.kind], range: s.range, selectionRange: s.selectionRange, children: s.children.map(conv),
  });
  return F.documentSymbols(state.current, path).map(conv);
});

const COMPLETION_KINDS: Record<F.CompletionKind, CompletionItemKind> = {
  namespace: CompletionItemKind.Module, function: CompletionItemKind.Function, macro: CompletionItemKind.Snippet,
  struct: CompletionItemKind.Struct, interface: CompletionItemKind.Interface, type: CompletionItemKind.TypeParameter,
  constant: CompletionItemKind.Constant, variable: CompletionItemKind.Variable, field: CompletionItemKind.Field,
  method: CompletionItemKind.Method, keyword: CompletionItemKind.Keyword,
};

connection.onCompletion(async ({ textDocument, position }) => {
  const { state, path } = stateFor(textDocument.uri);
  const doc = documents.get(textDocument.uri);
  if (!state.current || !doc) return [];
  const lineText = doc.getText({ start: { line: position.line, character: 0 }, end: position });
  const items: CompletionItem[] = F.complete(state.current, state.lastGood, path, position, lineText).map((c) => ({
    label: c.label, kind: COMPLETION_KINDS[c.kind], detail: c.detail, insertText: c.insertText, sortText: `0${c.label}`,
  }));
  const seen = new Set(items.map((i) => i.label));
  for (const i of (await ols?.completion(dirname(path), path, doc.getText(), position)) ?? []) {
    if (seen.has(i.label)) continue;
    seen.add(i.label);
    items.push({ ...i, sortText: `1${i.sortText ?? i.label}` });
  }
  return items;
});

connection.onDidChangeConfiguration(({ settings: s }) => {
  if (s?.vidar?.optCodeLens !== undefined) settings.optCodeLens = s.vidar.optCodeLens;
  if (lensRefresh && (s?.vidar?.optCodeLens !== undefined || s?.vidar?.optHints !== undefined)) connection.sendRequest("workspace/codeLens/refresh").catch(() => {});
  if (s?.vidar?.optHints === undefined) return;
  settings.optHints = s.vidar.optHints;
  if (hintRefresh) connection.languages.inlayHint.refresh().catch(() => {});
});

/** A second analysis of the current one with -opt on, which emits nothing; made once per analysis. */
function optAnalysis(state: PackageState, dir: string): Analysis | undefined {
  if (state.opt?.of === state.current) return state.opt!.program;
  try {
    const program = loadProgram(dir, { tolerant: true, overrides: overrides(), optimize: true });
    optimizeAll(program.analyzer, program.packages.flatMap((p) => p.files));
    state.opt = { of: state.current!, program };
    return program;
  } catch (err) {
    connection.console.error(`vidar: -opt analysis failed: ${err instanceof Error ? err.stack : err}`);
    return undefined;
  }
}

/** What -opt decided, shown after the names and code it is about. */
connection.languages.inlayHint.on(({ textDocument, range }) => {
  if (settings.optHints === "off" || settings.optHints === false) return [];
  const { state, path } = stateFor(textDocument.uri);
  if (!state.current) return [];
  const program = optAnalysis(state, dirname(path));
  if (!program) return [];
  const inRange = (p: F.Position) => (p.line > range.start.line || (p.line === range.start.line && p.character >= range.start.character)) && (p.line < range.end.line || (p.line === range.end.line && p.character <= range.end.character));
  return F.optHints(program, path, settings.optHints === "all")
    .filter((h) => inRange(h.position))
    .map((h) => ({ position: h.position, label: h.label, tooltip: h.tooltip, paddingLeft: true }));
});

/** Custom request: every -opt decision, grouped by file and enclosing proc; `uri` limits it to one file. */
connection.onRequest("vidar/optReport", ({ uri }: { uri?: string } = {}) => {
  const dirs = uri ? [dirname(toPath(uri))] : [...packages.keys()];
  const files = new Map<string, R.OptFile>();
  for (const dir of dirs) {
    const state = uri ? stateFor(uri).state : pkg(dir);
    const program = state.current ? optAnalysis(state, dir) : undefined;
    for (const f of program ? R.optReport(program, uri ? [toPath(uri)] : undefined) : []) if (!files.has(f.file)) files.set(f.file, f);
  }
  return { files: [...files.values()].map((f) => ({ uri: toUri(f.file), procs: f.procs })) };
});

/** Over each proc with -opt decisions: "N optimizations, M not", opening the report on it. */
connection.onCodeLens(({ textDocument }) => {
  if (!settings.optCodeLens || settings.optHints === "off" || settings.optHints === false) return [];
  const { state, path } = stateFor(textDocument.uri);
  const program = state.current ? optAnalysis(state, dirname(path)) : undefined;
  if (!program) return [];
  return R.optReport(program, [path]).flatMap((f) => f.procs).filter((p) => p.name !== R.TOP_LEVEL).map((p) => ({
    range: p.selectionRange,
    command: { title: R.lensTitle(p), command: "vidar.showOptReport", arguments: [textDocument.uri, p.name, p.selectionRange.start.line] },
  }));
});

/** Quick fixes for vidar's errors and opt-outs from -opt's decisions; see actions.ts. */
connection.onCodeAction(({ textDocument, range, context }) => {
  const { state, path } = stateFor(textDocument.uri);
  const text = textOf(state, textDocument.uri, path);
  if (!state.current || text === undefined) return [];
  return Actions.codeActions({ a: state.current, uri: textDocument.uri, file: path, text, range, context, opt: () => optAnalysis(state, dirname(path)) });
});

/** Custom request: the Odin code vidar generates for a file. */
// `line` (0-based, optional) is a line of the .vidar file; the answer's `line` is the matching line of `main`
connection.onRequest("vidar/generatedOdin", ({ uri, line }: { uri: string; line?: number }) => {
  const { state, path } = stateFor(uri);
  const a = state.current;
  if (!a) return { error: "not analyzed yet" };
  if (a.errors.length) return { error: `fix ${a.errors.length} error(s) first:\n${a.errors.map((e) => e.message).join("\n")}` };
  const out = emitProgram(a);
  const pkgOf = a.packages.find((p) => p.files.some((f) => f.path === path));
  const file = pkgOf?.files.find((f) => f.path === path);
  const main = pkgOf && file ? outputName(pkgOf, file) : undefined;
  const at = main && line !== undefined ? generatedLine(out.lineMap.get(main) ?? [], line + 1, out.files.get(main)?.split("\n")) : 0;
  return { files: Object.fromEntries(out.files), main, ...(at ? { line: at - 1 } : {}) };
});

// ---- workspace symbols, implementations, call hierarchy (navigation.ts) ----

/** Every analysis the server holds, the one for `first` (a package directory) first. */
function analyses(first?: string): Analysis[] {
  const all = [...packages.entries()].filter(([, st]) => st.current).sort(([a], [b]) => Number(b === first) - Number(a === first));
  return all.map(([, st]) => st.current!);
}

connection.onWorkspaceSymbol(({ query }) =>
  N.workspaceSymbols(analyses(), query).map((s) => ({ name: s.name, kind: SYMBOL_KINDS[s.kind], containerName: s.container, location: loc(s) })),
);

connection.onImplementation(({ textDocument, position }) => {
  const { state, path } = stateFor(textDocument.uri);
  if (!state.current || !state.index) return null;
  return N.implementations(state.current, state.index, path, position).map(loc);
});

const callItem = (i: N.CallItem) => ({
  name: i.name, kind: SYMBOL_KINDS[i.kind], detail: i.detail, uri: toUri(i.file), range: i.full, selectionRange: i.range, data: { key: i.key },
});
const callKey = (item: { data?: unknown }) => (item.data as { key?: string } | undefined)?.key ?? "";
const callDir = (uri: string) => (uri.startsWith("file:") ? dirname(toPath(uri)) : undefined);

connection.languages.callHierarchy.onPrepare(({ textDocument, position }) => {
  const { state, path } = stateFor(textDocument.uri);
  if (!state.index) return null;
  const items = N.prepareCallHierarchy(state.index, path, position).map(callItem);
  return items.length ? items : null;
});

connection.languages.callHierarchy.onIncomingCalls(({ item }) =>
  N.incomingCalls(analyses(callDir(item.uri)), callKey(item)).map((c) => ({ from: callItem(c.item), fromRanges: c.ranges })),
);

connection.languages.callHierarchy.onOutgoingCalls(({ item }) =>
  N.outgoingCalls(analyses(callDir(item.uri)), callKey(item)).map((c) => ({ to: callItem(c.item), fromRanges: c.ranges })),
);

/** Semantic tokens: interfaces, closures, captures and macros, from the analyzer's symbols. */
connection.languages.semanticTokens.on(({ textDocument }) => {
  const { state, path } = stateFor(textDocument.uri);
  return { data: Sem.semanticTokensData(state.current, state.index, path) };
});

connection.languages.semanticTokens.onRange(({ textDocument, range }) => {
  const { state, path } = stateFor(textDocument.uri);
  return { data: Sem.semanticTokensData(state.current, state.index, path, range) };
});

/** -opt programs for `vidar/expandAt`, made fresh (not the hints' one, which is optimized without emitting) */
const expandOpt = new WeakMap<Analysis, Analysis>();

/** Custom request: the Odin code vidar generates for the statement at a position. */
connection.onRequest("vidar/expandAt", ({ uri, position, opt }: { uri: string; position: F.Position; opt?: boolean }) => {
  const { state, path } = stateFor(uri);
  let a = state.current;
  if (!a) return { error: "not analyzed yet" };
  try {
    if (opt && !a.errors.length) {
      const cur = a;
      a = expandOpt.get(cur) ?? loadProgram(dirname(path), { tolerant: true, overrides: overrides(), optimize: true });
      expandOpt.set(cur, a);
    }
    return expandAt(a, path, position, !!opt);
  } catch (err) {
    return { error: `expansion failed: ${err instanceof Error ? err.message : err}` };
  }
});

connection.onShutdown(() => {
  Idx.stop();
  ols?.shutdown();
});
process.on("exit", () => ols?.shutdown());

documents.listen(connection);
connection.listen();
