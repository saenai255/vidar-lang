import { CodeAction, CodeActionContext, CodeActionKind, Diagnostic, DiagnosticSeverity, Range, TextEdit } from "vscode-languageserver/node";
import type { CompileError, ErrorFix, Pos, Token } from "../lexer";
import { Node, Stmt, children } from "../ast";
import { A, OptHint, importName } from "../analyzer";
import type { Program as Analysis } from "../project";
import { scopeAt } from "./features";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Quick fixes, built from the data the analyzer attaches to its errors (`CompileError.fix`), the
 * -opt decisions (`an.hint`) and names used as `pkg.name` of a core package the file doesn't
 * import. An allocation is never the preferred fix: `new_clone` is always an action of its own.
 */

export const NEW_CLONE_TITLE = "Allocate a heap copy (new_clone, caller frees)";

/** Packages a bare `name.member` most likely means, by the name they are imported as; the only ones known when `odin root` can't be read. */
const KNOWN_PACKAGES: Record<string, string> = {
  fmt: "core:fmt", strings: "core:strings", strconv: "core:strconv", os: "core:os", mem: "core:mem", virtual: "core:mem/virtual",
  math: "core:math", linalg: "core:math/linalg", rand: "core:math/rand", bits: "core:math/bits", cmplx: "core:math/cmplx",
  slice: "core:slice", sort: "core:sort", time: "core:time", unicode: "core:unicode", utf8: "core:unicode/utf8", utf16: "core:unicode/utf16",
  json: "core:encoding/json", base64: "core:encoding/base64", hex: "core:encoding/hex", csv: "core:encoding/csv",
  bytes: "core:bytes", bufio: "core:bufio", io: "core:io", log: "core:log", sync: "core:sync", thread: "core:thread", chan: "core:sync/chan",
  filepath: "core:path/filepath", reflect: "core:reflect", hash: "core:hash", testing: "core:testing", queue: "core:container/queue",
  small_array: "core:container/small_array", net: "core:net", nbio: "core:nbio", c: "core:c", libc: "core:c/libc", runtime: "base:runtime",
  intrinsics: "base:intrinsics", sched: "vidar:sched",
};

/** Directories under `odin root` that hold no library packages: tests, examples and internal (`_x`) packages. */
const SKIP_DIRS = /^(\.|_)|^(tests?|examples?)$/;

let odinPath = "odin";
let odinIndex: Map<string, string[]> | null | undefined;

/** The `odin` the package index is read from (the language server's `odinPath` setting). */
export function setOdinPath(path: string): void {
  if (path !== odinPath) odinIndex = undefined;
  odinPath = path;
}

const collectionRank = (path: string) => ["core", "base", "vendor"].indexOf(path.slice(0, path.indexOf(":")));

/**
 * Every package directory (one holding a `.odin` file) under `root`'s `core/`, `base/` and
 * `vendor/`, by its last path part: `linalg` -> `core:math/linalg`. Each list is in order of
 * preference: core, base, vendor, then the shallowest.
 */
export function packageIndex(root: string): Map<string, string[]> {
  const index = new Map<string, string[]>();
  const walk = (collection: string, dir: string, rel: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const name = rel.slice(rel.lastIndexOf("/") + 1);
    if (rel && /^[A-Za-z_]\w*$/.test(name) && entries.some((e) => e.isFile() && e.name.endsWith(".odin"))) {
      const list = index.get(name) ?? [];
      list.push(`${collection}:${rel}`);
      index.set(name, list);
    }
    for (const e of entries) if (e.isDirectory() && !SKIP_DIRS.test(e.name)) walk(collection, join(dir, e.name), rel ? `${rel}/${e.name}` : e.name);
  };
  for (const collection of ["core", "base", "vendor"]) walk(collection, join(root, collection), "");
  for (const list of index.values())
    list.sort((x, y) => collectionRank(x) - collectionRank(y) || x.split("/").length - y.split("/").length || (x < y ? -1 : 1));
  return index;
}

/** The package index of `odin root`, read once; null when `odin` can't be run. */
function odinPackages(): Map<string, string[]> | null {
  if (odinIndex !== undefined) return odinIndex;
  odinIndex = null;
  try {
    const r = spawnSync(odinPath, ["root"], { encoding: "utf8", timeout: 5000 });
    const root = r.status === 0 ? r.stdout.trim() : "";
    if (root) odinIndex = packageIndex(root);
  } catch {}
  return odinIndex;
}

/**
 * The packages a bare `name.member` can mean: the table's entry first, then every package of
 * `odin root` named `name`. `preferred` is the one a fix may apply without asking: the table's,
 * the only one, or the only one outside `vendor:`.
 */
export function packagesNamed(name: string, index: Map<string, string[]> | null = odinPackages()): { paths: string[]; preferred?: string } {
  const known = Object.hasOwn(KNOWN_PACKAGES, name) ? KNOWN_PACKAGES[name] : undefined;
  const paths = [...new Set([...(known ? [known] : []), ...(index?.get(name) ?? [])])];
  const library = paths.filter((p) => !p.startsWith("vendor:"));
  const preferred = known ?? (paths.length === 1 ? paths[0] : library.length === 1 ? library[0] : undefined);
  return { paths: preferred ? [preferred, ...paths.filter((p) => p !== preferred)] : paths, preferred };
}

/** -opt decisions an attribute undoes: the attribute that asks for it explicitly, and its opt-out. */
const OPT_OUTS: { label: RegExp; wanted?: string; attr: string; what: string }[] = [
  { label: /^specialized\b/, wanted: "specialize", attr: "no_specialize", what: "specialized copies" },
  { label: /^table( 2D)?$/, wanted: "table", attr: "no_table", what: "a lookup table" },
  { label: /^memo$/, wanted: "memo", attr: "no_memo", what: "memoization" },
  { label: /^stack buffer$/, attr: "no_stack_buffer", what: "a stack buffer" },
  { label: /^perfect hash$/, attr: "no_perfect_hash", what: "a perfect-hash switch" },
];

type ValueDecl = Extract<Stmt, { k: "ValueDecl" }>;

const lspPos = (p: Pos) => ({ line: p.line - 1, character: p.col - 1 });

function tokRange(t: Token): Range {
  const start = lspPos(t.pos);
  return { start, end: { line: start.line, character: start.character + t.text.length } };
}

function overlaps(a: Range, from: number, to: number): boolean {
  return a.start.line <= to && a.end.line >= from;
}

/** The text between two positions of `text`. */
function slice(text: string, r: Range): string {
  const lines = text.split("\n");
  if (r.start.line === r.end.line) return (lines[r.start.line] ?? "").slice(r.start.character, r.end.character);
  return [lines[r.start.line].slice(r.start.character), ...lines.slice(r.start.line + 1, r.end.line), (lines[r.end.line] ?? "").slice(0, r.end.character)].join("\n");
}

/** Extra diagnostic text for an error with a fix: why `&x` isn't offered. */
export function fixNote(err: CompileError): string {
  const f = err.fix;
  if (f?.code !== "iface-value") return "";
  if (f.dangles) return `\n&x would dangle: the interface value ${f.dangles}, and the value lives in this proc's frame, gone once it returns. Only a heap copy (new_clone) outlives it.`;
  if (!f.addressable && f.why) return `\nNo &x here: ${f.why}.`;
  return "";
}

/** The diagnostic code of an error with a fix. */
export const fixCode = (err: CompileError): string | undefined => err.fix?.code;

// ---- missing imports ----

export interface MissingImport {
  name: string;
  /** every package it can be, the preferred one first */
  paths: string[];
  /** the one a fix may apply without asking, if any */
  preferred?: string;
  range: Range;
}

/** Names used as `name.member` that no declaration or import of `file` gives, and that a package is imported as. */
export function missingImports(a: Analysis, file: string, text: string): MissingImport[] {
  const pkg = a.packages.find((p) => p.files.some((f) => f.path === file));
  const f = pkg?.files.find((x) => x.path === file);
  if (!pkg || !f) return [];
  const imported = new Set<string>();
  for (const s of f.stmts) if (s.k === "Import") imported.add(importName(s.alias, s.path, null));
  const declared = (name: string) =>
    new RegExp(`(^|[^.\\w])${name}\\s*(:|,)|(^|[^.\\w])${name}\\s+in\\b|[\\[,&]\\s*${name}\\s*[\\],]`, "m").test(text);
  const out: MissingImport[] = [];
  const visit = (n: Node) => {
    if (n.k === "ProcLit" && n.comptime) return;
    if (n.k === "Selector" && n.x.k === "Ident" && !A(n)._pkgMember && !A(n.x)._sym) {
      const name = n.x.name;
      const tok = n.x.toks[n.x.start];
      const { paths, preferred } = tok?.pos.file === file && !imported.has(name) ? packagesNamed(name) : { paths: [], preferred: undefined };
      if (paths.length && !declared(name)) {
        const range = tokRange(tok);
        const { scope } = scopeAt(a, file, range.start);
        let known = false;
        try {
          known = !!a.analyzer.lookup(name, scope, null);
        } catch {}
        if (!known) out.push({ name, paths, preferred, range });
      }
    }
    for (const c of children(n)) visit(c);
  };
  f.stmts.forEach(visit);
  return out;
}

export function importDiagnostics(a: Analysis, file: string, text: string): Diagnostic[] {
  return missingImports(a, file, text).map((m) => ({
    range: m.range,
    severity: DiagnosticSeverity.Error,
    source: "vidar",
    code: "missing-import",
    message:
      m.paths.length === 1
        ? `'${m.name}' is not declared: is it the package "${m.paths[0]}"? This file doesn't import it`
        : `'${m.name}' is not declared: is it one of the packages ${m.paths.map((p) => `"${p}"`).join(", ")}? This file doesn't import any`,
  }));
}

/** Where a new import line goes: after the last import, else after the package clause. */
function importEdit(a: Analysis, file: string, paths: string[]): TextEdit | undefined {
  const f = a.packages.flatMap((p) => p.files).find((x) => x.path === file);
  if (!f) return undefined;
  const lines = paths.map((p) => `import "${p}"\n`).join("");
  const imports = f.stmts.filter((s) => s.k === "Import");
  const last = imports[imports.length - 1];
  if (last) return TextEdit.insert({ line: lastLine(last) + 1, character: 0 }, lines);
  const pkg = f.stmts.find((s) => s.k === "Package");
  return TextEdit.insert({ line: pkg ? lastLine(pkg) + 1 : 0, character: 0 }, pkg ? `\n${lines}` : `${lines}\n`);
}

/** 0-based line of a node's last real token. */
function lastLine(n: Node): number {
  let i = n.end - 1;
  while (i > n.start && (n.toks[i].kind === "semi" || n.toks[i].kind === "eof")) i--;
  return n.toks[i].pos.line - 1;
}

// ---- code actions ----

export interface ActionRequest {
  a: Analysis;
  uri: string;
  file: string;
  /** the document's current text */
  text: string;
  range: Range;
  context: CodeActionContext;
  /** the -opt analysis, for opt-out attributes; made on demand */
  opt: () => Analysis | undefined;
}

export function codeActions(req: ActionRequest): CodeAction[] {
  const only = req.context.only;
  const wants = (kind: string) => !only || only.some((k) => kind === k || kind.startsWith(`${k}.`));
  const out: CodeAction[] = [];
  if (wants(CodeActionKind.QuickFix)) out.push(...quickFixes(req, req.range));
  if (only && wants(CodeActionKind.SourceFixAll)) {
    const all = fixAll(req);
    if (all) out.push(all);
  }
  return out;
}

/** The preferred fix of every error in the file, as one action: never an allocation. */
function fixAll(req: ActionRequest): CodeAction | undefined {
  const whole = { start: { line: 0, character: 0 }, end: { line: req.text.split("\n").length, character: 0 } };
  const edits = new Map<string, TextEdit>();
  const imports: string[] = [];
  for (const action of quickFixes({ ...req, opt: () => undefined }, whole)) {
    if (!action.isPreferred) continue;
    for (const e of action.edit?.changes?.[req.uri] ?? []) {
      const m = /^import "(.*)"\n$/.exec(e.newText.trim() + "\n");
      if (m) {
        if (!imports.includes(m[1])) imports.push(m[1]);
        continue;
      }
      edits.set(`${e.range.start.line}:${e.range.start.character}:${e.newText}`, e);
    }
  }
  if (imports.length) {
    const e = importEdit(req.a, req.file, imports);
    if (e) edits.set("import", e);
  }
  if (!edits.size) return undefined;
  return { title: "Fix all with Vidar's preferred fixes", kind: CodeActionKind.SourceFixAll, edit: { changes: { [req.uri]: [...edits.values()] } } };
}

function quickFixes(req: ActionRequest, range: Range): CodeAction[] {
  const { a, file, uri, text } = req;
  const out: CodeAction[] = [];
  const action = (title: string, edits: TextEdit[], preferred: boolean, diags: Diagnostic[] = []): CodeAction => ({
    title,
    kind: CodeActionKind.QuickFix,
    ...(diags.length ? { diagnostics: diags } : {}),
    isPreferred: preferred,
    edit: { changes: { [uri]: edits } },
  });
  const diagsAt = (code: string, at: Range["start"]) =>
    req.context.diagnostics.filter((d) => d.code === code && d.range.start.line === at.line && d.range.start.character === at.character);

  for (const err of a.errors) {
    const fix: ErrorFix | undefined = err.fix;
    if (!fix || !err.pos || err.pos.file !== file) continue;
    const at = lspPos(err.pos);
    const diags = diagsAt(fix.code, at);
    if (fix.code === "iface-value") {
      if (fix.start.file !== file) continue;
      const span = { start: lspPos(fix.start), end: lspPos(fix.end) };
      if (!overlaps(range, span.start.line, span.end.line) && !overlaps(range, at.line, at.line)) continue;
      const value = slice(text, span);
      if (fix.addressable && !fix.dangles) out.push(action(`Use a pointer to it (&${value})`, [TextEdit.insert(span.start, "&")], true, diags));
      out.push(action(NEW_CLONE_TITLE, [TextEdit.insert(span.start, "new_clone("), TextEdit.insert(span.end, ")")], false, diags));
    } else if (fix.code === "capture-by-value") {
      if (fix.at.file !== file) continue;
      const cap = lspPos(fix.at);
      if (!overlaps(range, at.line, at.line) && !overlaps(range, cap.line, cap.line)) continue;
      out.push(action(`Capture '${fix.name}' by reference (&${fix.name})`, [TextEdit.insert(cap, "&")], true, diags));
    }
  }

  const seenImports = new Set<string>();
  for (const m of missingImports(a, file, text)) {
    if (!overlaps(range, m.range.start.line, m.range.end.line) || seenImports.has(m.name)) continue;
    seenImports.add(m.name);
    for (const path of m.paths) {
      const edit = importEdit(a, file, [path]);
      if (edit) out.push(action(`Add import "${path}"`, [edit], path === m.preferred, diagsAt("missing-import", m.range.start)));
    }
  }

  out.push(...optOuts(req, range));
  return out;
}

/** An opt-out attribute on the proc an -opt decision in `range` is about. */
function optOuts(req: ActionRequest, range: Range): CodeAction[] {
  const program = req.opt();
  const f = program?.packages.flatMap((p) => p.files).find((x) => x.path === req.file);
  if (!program || !f) return [];
  const out: CodeAction[] = [];
  const seen = new Set<string>();
  for (const h of (program.analyzer.hints ?? []) as OptHint[]) {
    if (h.at.toks !== f.toks) continue;
    const rule = OPT_OUTS.find((r) => r.label.test(h.label));
    if (!rule) continue;
    const decl = h.name ? (h.at as ValueDecl) : procDeclAround(f.stmts, h.tok);
    if (!decl || decl.k !== "ValueDecl") continue;
    const first = h.name ? decl.toks[decl.names[0]?.tok ?? decl.start].pos.line - 1 : h.at.toks[h.at.start].pos.line - 1;
    const last = h.name ? first : h.at.toks[h.tok].pos.line - 1;
    if (!overlaps(range, first, last)) continue;
    const attrs = decl.attrs.flatMap((x) => x.replace(/^@\(?|\)$/g, "").split(",").map((y) => y.split("=")[0].trim()));
    // asked for in so many words, or already off: nothing to undo
    if ((rule.wanted && attrs.includes(rule.wanted)) || attrs.includes(rule.attr)) continue;
    const name = decl.names[0]?.name ?? "";
    if (seen.has(`${name}:${rule.attr}`)) continue;
    seen.add(`${name}:${rule.attr}`);
    const line = decl.toks[decl.start].pos.line - 1;
    const indent = /^\s*/.exec(req.text.split("\n")[line] ?? "")?.[0] ?? "";
    out.push({
      title: `Keep -opt from making ${rule.what} of '${name}': add @(${rule.attr})`,
      kind: CodeActionKind.QuickFix,
      isPreferred: false,
      edit: { changes: { [req.uri]: [TextEdit.insert({ line, character: 0 }, `${indent}@(${rule.attr})\n`)] } },
    });
  }
  return out;
}

/** The top-level proc declaration whose tokens include token `tok`. */
function procDeclAround(stmts: Stmt[], tok: number): ValueDecl | undefined {
  for (const s of stmts) {
    if (s.k !== "ValueDecl" || !s.isConst || s.start > tok || s.end <= tok) continue;
    // the proc literal itself, or one under a directive such as #force_inline
    if (s.values.length === 1 && (s.values[0].k === "ProcLit" || children(s.values[0]).some((c) => c.k === "ProcLit"))) return s;
  }
  return undefined;
}
