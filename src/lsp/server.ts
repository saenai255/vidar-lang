#!/usr/bin/env node
import {
  CompletionItem, CompletionItemKind, Diagnostic, DiagnosticSeverity, DocumentSymbol, InitializeResult, ProposedFeatures,
  SymbolKind as LspSymbolKind, TextDocumentSyncKind, TextDocuments, TextEdit, createConnection,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { CompileError } from "../lexer";
import { Program as Analysis, emitProgram, loadProgram, outputName, preludeSourcePath } from "../project";
import { PRELUDE_PATH } from "../prelude";
import { writeOutput } from "../cli";
import * as F from "./features";
import { OdinBridge } from "./odin";

// editors usually pass --stdio; default to it so `vidar-lsp` alone works too
if (!process.argv.some((a) => /^--(stdio|node-ipc|socket|pipe)/.test(a))) process.argv.push("--stdio");

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

interface PackageState {
  current?: Analysis;
  index?: F.Index;
  lastGood?: Analysis;
  odinDiagnostics: Map<string, Diagnostic[]>;
}

const packages = new Map<string, PackageState>();
const timers = new Map<string, NodeJS.Timeout>();
let settings = { odinCheckOnSave: true, odinPath: "odin", ols: true, olsPath: "ols" };
let ols: OdinBridge | undefined;

const toPath = (uri: string) => fileURLToPath(uri);
const toUri = (path: string) => pathToFileURL(path === PRELUDE_PATH ? preludeSourcePath() : path).toString();

function pkg(dir: string): PackageState {
  let p = packages.get(dir);
  if (!p) packages.set(dir, (p = { odinDiagnostics: new Map() }));
  return p;
}

/** Unsaved editor contents, used instead of what is on disk. */
function overrides(): Map<string, string> {
  return new Map(documents.all().map((d) => [toPath(d.uri), d.getText()]));
}

function toDiagnostic(err: CompileError, source: string): Diagnostic {
  const line = (err.pos?.line ?? 1) - 1;
  const col = (err.pos?.col ?? 1) - 1;
  return {
    range: { start: { line, character: col }, end: { line, character: col + 1 } },
    severity: DiagnosticSeverity.Error,
    source,
    message: err.message,
  };
}

function analyzePackage(dir: string): PackageState {
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
  if (ols) syncOdin(dir, a);
  publish(dir, state);
  return state;
}

function syncOdin(dir: string, a: Analysis): void {
  if (!a.errors.length) {
    try {
      ols!.recordEmit(dir, a, emitProgram(a));
    } catch {}
  }
  ols!.sync(dir, a, overrides()).catch((err) => connection.console.error(`vidar: ols sync failed: ${err}`));
}

function publish(dir: string, state: PackageState): void {
  const a = state.current;
  if (!a) return;
  for (const s of a.sources) {
    const diags = a.errors.filter((e) => (e.pos?.file ?? a.sources[0].path) === s.path).map((e) => toDiagnostic(e, "vidar"));
    diags.push(...(state.odinDiagnostics.get(s.path) ?? []));
    connection.sendDiagnostics({ uri: toUri(s.path), diagnostics: diags });
  }
}

function schedule(dir: string): void {
  clearTimeout(timers.get(dir));
  timers.set(dir, setTimeout(() => analyzePackage(dir), 150));
}

function stateFor(uri: string): { state: PackageState; path: string } {
  const path = toPath(uri);
  const dir = dirname(path);
  const state = pkg(dir);
  if (!state.current) analyzePackage(dir);
  return { state, path };
}

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
      const rel = m[1].startsWith(work) ? m[1].slice(work.length + 1) : m[1];
      const name = rel.split("\\").join("/");
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
  if (settings.ols) ols = new OdinBridge(settings.olsPath, (m) => connection.console.warn(m));
  return {
    capabilities: {
      textDocumentSync: { openClose: true, change: TextDocumentSyncKind.Incremental, save: { includeText: false } },
      hoverProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      renameProvider: true,
      documentSymbolProvider: true,
      completionProvider: { triggerCharacters: [":", ".", ">"] },
      signatureHelpProvider: { triggerCharacters: ["(", ","], retriggerCharacters: [","] },
    },
    serverInfo: { name: "vidar-lsp", version: "0.1.0" },
  };
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
    analyzePackage(dir);
  }
  odinCheck(dirname(toPath(e.document.uri)));
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
  if (h && !h.untyped) return { contents: { kind: "markdown", value: h.markdown }, range: h.range };
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

/** Custom request: the Odin code vidar generates for a file. */
connection.onRequest("vidar/generatedOdin", ({ uri }: { uri: string }) => {
  const { state, path } = stateFor(uri);
  const a = state.current;
  if (!a) return { error: "not analyzed yet" };
  if (a.errors.length) return { error: `fix ${a.errors.length} error(s) first:\n${a.errors.map((e) => e.message).join("\n")}` };
  const out = emitProgram(a);
  const pkgOf = a.packages.find((p) => p.files.some((f) => f.path === path));
  const file = pkgOf?.files.find((f) => f.path === path);
  return { files: Object.fromEntries(out.files), main: pkgOf && file ? outputName(pkgOf, file) : undefined };
});

connection.onShutdown(() => ols?.shutdown());
process.on("exit", () => ols?.shutdown());

documents.listen(connection);
connection.listen();
