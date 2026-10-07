import { ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { relativeInside } from "../paths";
import {
  CompletionItem, CompletionList, Hover, Location, LocationLink, MessageConnection, Position, SignatureHelp,
  StreamMessageReader, StreamMessageWriter, createMessageConnection,
} from "vscode-languageserver/node";
import { Program as Analysis, Output, outputName } from "../project";
import type { ColumnEntry } from "../emitter";

/**
 * Forwards requests on plain Odin code to ols, run over a shadow copy of the generated Odin.
 *
 * Lines vidar does not rewrite come out unchanged, and the emitter's line map says where each
 * one went, so a position on such a line has a matching position in the shadow file.
 */

interface ShadowFile {
  source?: string;
  text: string;
  version: number;
  open: boolean;
}

interface Shadow {
  dir: string;
  files: Map<string, ShadowFile>;
  bySource: Map<string, string>;
  /** per output file, the source line of each shadow line (see `EmittedFile.lines`) */
  lines: Map<string, number[]>;
  /** per output file, the emit it was patched from, for the column map */
  patched: Map<string, { good: GoodEmit; out: Patched }>;
}

interface GoodEmit {
  sourceText: string;
  output: string;
  lines: number[];
  /** where each source name went (see `EmittedFile.columns`) */
  columns?: ColumnEntry[];
}

/** A request's place in the shadow tree: `shift` (source minus shadow column) applies inside `span`, the token's shadow columns. */
interface Target {
  textDocument: { uri: string };
  position: Position;
  lines: number[];
  shift: number;
  span?: [number, number];
}

export interface Patched {
  text: string;
  lines: number[];
  /** how the old output and source carry over: see `oldSourceLine` and `newOutputLine` */
  keep?: { pre: number; suf: number; cut: number; tail: number; middle: number; shift: number; lines: number };
}

/** The line (1-based) of the old source that current source line `line` still is, or 0 for an edited line. */
export function oldSourceLine(p: Patched, line: number): number {
  const k = p.keep;
  if (!k) return 0;
  if (line <= k.pre) return line;
  if (line > k.lines - k.suf && line <= k.lines) return line - k.shift;
  return 0;
}

/** The line (0-based) of the patched output that old output line `line` became, or -1 when it was cut. */
export function newOutputLine(p: Patched, line: number): number {
  const k = p.keep;
  if (!k) return -1;
  if (line < k.cut) return line;
  if (line >= k.tail) return line - k.tail + k.cut + k.middle;
  return -1;
}

/** The column map's entry for the token at `character` (0-based, also just after it) of source line `line` (1-based). */
export function columnAt(columns: ColumnEntry[], line: number, character: number): ColumnEntry | undefined {
  let lo = 0;
  let hi = columns.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (columns[mid].line < line) lo = mid + 1;
    else hi = mid;
  }
  let best: ColumnEntry | undefined;
  for (let i = lo; i < columns.length && columns[i].line === line; i++) {
    const e = columns[i];
    const from = e.col - 1;
    // inside the token wins over just after it (`a.b` at the `.`: `a`, at `b`: `b`)
    if (character >= from && character < from + e.len) return e;
    if (character === from + e.len) best = e;
  }
  return best;
}

const TIMEOUT_MS = 2000;
const GENERATED_NAME = /^__|^vidar_runtime$/;

/**
 * Generated Odin for `current` built from an older (source, output) pair: unchanged leading and
 * trailing lines keep their generated text, edited lines are taken from `current` as is.
 * `oldLines` is the old output's line map; without one, output lines are taken to match source lines.
 */
export function patch(oldSource: string, oldOutput: string, current: string, oldLines?: number[]): Patched {
  const s0 = oldSource.split("\n");
  const o0 = oldOutput.split("\n");
  const s1 = current.split("\n");
  const map = oldLines ?? o0.map((_, i) => (i < s0.length ? i + 1 : 0));
  if (o0.length < s0.length && !oldLines) return { text: current, lines: s1.map((_, i) => i + 1) };
  let pre = 0;
  while (pre < s0.length && pre < s1.length && s0[pre] === s1[pre]) pre++;
  let suf = 0;
  while (suf < s0.length - pre && suf < s1.length - pre && s0[s0.length - 1 - suf] === s1[s1.length - 1 - suf]) suf++;
  // output lines before the first one from an edited line, and from the first one after them
  let cut = 0;
  while (cut < o0.length && map[cut] !== 0 && Math.abs(map[cut]) <= pre) cut++;
  let tail = cut;
  while (tail < o0.length && map[tail] !== 0 && Math.abs(map[tail]) <= s0.length - suf) tail++;
  const shift = s1.length - s0.length;
  const middle = s1.slice(pre, s1.length - suf);
  return {
    text: [...o0.slice(0, cut), ...middle, ...o0.slice(tail)].join("\n"),
    lines: [...map.slice(0, cut), ...middle.map((_, i) => pre + i + 1), ...map.slice(tail).map((l) => (l === 0 ? 0 : l + Math.sign(l) * shift))],
    keep: { pre, suf, cut, tail, middle: middle.length, shift, lines: s1.length },
  };
}

const params = (t: { textDocument: { uri: string }; position: Position }) => ({ textDocument: t.textDocument, position: t.position });

/**
 * Where a request at `p` on a source line vidar rewrote goes in the shadow file: the column map of the emit the
 * shadow was patched from gives the name's output column. Only for lines unchanged since that emit, and only
 * when the shadow still has the name there.
 */
export function columnTarget(good: { sourceText: string; columns?: ColumnEntry[] }, out: Patched, p: Position, sourceLine: string, shadowLines: string[]): Pick<Target, "position" | "shift" | "span"> | undefined {
  if (!good.columns) return undefined;
  const old = oldSourceLine(out, p.line + 1);
  if (!old || good.sourceText.split("\n")[old - 1] !== sourceLine) return undefined;
  const e = columnAt(good.columns, old, p.character);
  const line = e ? newOutputLine(out, e.outLine) : -1;
  if (!e || line < 0 || shadowLines[line]?.substr(e.outCol, e.len) !== sourceLine.substr(e.col - 1, e.len)) return undefined;
  const shift = e.col - 1 - e.outCol;
  return { position: { line, character: p.character - shift }, shift, span: [e.outCol, e.outCol + e.len] };
}

const identity = (text: string): number[] => text.split("\n").map((_, i) => i + 1);

export class OdinBridge {
  private proc?: ChildProcess;
  private conn?: MessageConnection;
  private ready?: Promise<boolean>;
  private root = "";
  private shadows = new Map<string, Shadow>();
  private disabled = false;
  /** last error-free output per source file, re-applied around edited lines (see `patch`) */
  private lastGood = new Map<string, GoodEmit>();
  /** generated files with no source (vidar_runtime), per program */
  private extraFiles = new Map<string, Map<string, string>>();

  constructor(private olsPath: string, private log: (msg: string) => void) {}

  private start(): Promise<boolean> {
    if (this.ready) return this.ready;
    this.root = realpathSync(mkdtempSync(join(tmpdir(), "vidar-ols-")));
    const proc = spawn(this.olsPath, [], { stdio: ["pipe", "pipe", "ignore"], cwd: this.root });
    this.proc = proc;
    const conn = createMessageConnection(new StreamMessageReader(proc.stdout!), new StreamMessageWriter(proc.stdin!));
    this.conn = conn;
    conn.onRequest(() => null);
    conn.onNotification(() => {});
    conn.onError(() => {});
    this.ready = new Promise((resolve) => {
      proc.on("error", (err) => {
        this.log(`vidar: ols unavailable (${err.message}); plain Odin features come from vidar only`);
        this.shutdown();
        resolve(false);
      });
      proc.on("exit", () => {
        this.disabled = true;
        conn.dispose();
      });
      // only talk to ols once it runs: a write to a missing one rejects, and an unhandled rejection ends the server
      proc.once("spawn", () => {
        conn.listen();
        const rootUri = pathToFileURL(this.root).toString();
        conn
          .sendRequest("initialize", {
            processId: process.pid,
            rootUri,
            workspaceFolders: [{ uri: rootUri, name: "vidar" }],
            capabilities: {
              textDocument: {
                hover: { contentFormat: ["markdown", "plaintext"] },
                completion: { completionItem: { snippetSupport: true, documentationFormat: ["markdown", "plaintext"] } },
                signatureHelp: { signatureInformation: { documentationFormat: ["markdown", "plaintext"] } },
                definition: { linkSupport: false },
              },
            },
          })
          .then(() => {
            conn.sendNotification("initialized", {});
            resolve(true);
          }, () => resolve(false));
      });
    });
    return this.ready;
  }

  shutdown(): void {
    this.disabled = true;
    this.proc?.kill();
    if (this.root) rmSync(this.root, { recursive: true, force: true });
  }

  /** Records a successful emit, so later edits can be patched onto it. */
  recordEmit(program: string, a: Analysis, out: Output): void {
    const extra = new Map<string, string>();
    for (const [name, text] of out.files) {
      const src = out.sourceOf.get(name);
      const sourceText = src && a.sources.find((s) => s.path === src)?.text;
      if (sourceText !== undefined) this.lastGood.set(src!, { sourceText, output: text, lines: out.lineMap.get(name) ?? identity(text), columns: out.columns?.get(name) });
      else extra.set(name, text);
    }
    this.extraFiles.set(program, extra);
  }

  /** Brings the shadow tree of `program` up to date with `a` (and unsaved `texts`). */
  async sync(program: string, a: Analysis, texts: Map<string, string>): Promise<void> {
    if (this.disabled || !(await this.start())) return;
    let shadow = this.shadows.get(program);
    if (!shadow) {
      shadow = { dir: join(this.root, String(this.shadows.size)), files: new Map(), bySource: new Map(), lines: new Map(), patched: new Map() };
      this.shadows.set(program, shadow);
    }
    for (const pkg of a.packages) {
      for (const f of pkg.files) {
        const name = outputName(pkg, f);
        const text = texts.get(f.path) ?? a.sources.find((s) => s.path === f.path)?.text;
        if (text === undefined) continue;
        shadow.bySource.set(f.path, name);
        this.putShadow(shadow, name, f.path, text);
      }
    }
    for (const [name, text] of this.extraFiles.get(program) ?? []) this.put(shadow, name, text);
  }

  /** Re-syncs one file from its current text before a request. */
  private refresh(shadow: Shadow, path: string, text: string): string | undefined {
    const name = shadow.bySource.get(path);
    if (!name) return undefined;
    this.putShadow(shadow, name, path, text);
    return name;
  }

  private putShadow(shadow: Shadow, name: string, path: string, text: string): void {
    const good = this.lastGood.get(path);
    const out = good ? patch(good.sourceText, good.output, text, good.lines) : { text, lines: identity(text) };
    this.put(shadow, name, out.text, path);
    shadow.lines.set(name, out.lines);
    if (good) shadow.patched.set(name, { good, out });
    else shadow.patched.delete(name);
  }

  private put(shadow: Shadow, name: string, text: string, source?: string): void {
    const file = join(shadow.dir, name);
    const uri = pathToFileURL(file).toString();
    let entry = shadow.files.get(name);
    if (entry?.text === text) return;
    if (!entry) shadow.files.set(name, (entry = { source, text, version: 0, open: false }));
    entry.text = text;
    entry.version++;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    if (!entry.open) {
      entry.open = true;
      this.conn!.sendNotification("textDocument/didOpen", { textDocument: { uri, languageId: "odin", version: entry.version, text } });
    } else {
      this.conn!.sendNotification("textDocument/didChange", { textDocument: { uri, version: entry.version }, contentChanges: [{ text }] });
    }
  }

  /**
   * The shadow document and position for `p` in `path`: on a line passed through unchanged, the same column;
   * on a line vidar rewrote, where the emitter's column map says the name under `p` went.
   */
  private target(program: string, path: string, text: string, p: Position): Target | undefined {
    const shadow = this.shadows.get(program);
    if (this.disabled || !shadow) return undefined;
    const name = this.refresh(shadow, path, text);
    if (!name) return undefined;
    const sourceLine = text.split("\n")[p.line];
    const shadowLines = shadow.files.get(name)!.text.split("\n");
    const lines = shadow.lines.get(name) ?? [];
    if (sourceLine === undefined) return undefined;
    const textDocument = { uri: pathToFileURL(join(shadow.dir, name)).toString() };
    const line = lines.findIndex((l, i) => l === p.line + 1 && shadowLines[i] === sourceLine);
    if (line >= 0) return { textDocument, position: { line, character: p.character }, lines, shift: 0 };
    const mapped = shadow.patched.get(name);
    const at = mapped && columnTarget(mapped.good, mapped.out, p, sourceLine, shadowLines);
    return at && { textDocument, lines, ...at };
  }

  private async request<T>(method: string, params: unknown): Promise<T | undefined> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<undefined>((r) => (timer = setTimeout(() => r(undefined), TIMEOUT_MS)));
    try {
      return await Promise.race([this.conn!.sendRequest<T>(method, params), timeout]);
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Maps a location in the shadow tree back to its source; drops generated code. */
  private toSource(uri: string, line: number): { uri: string; line: number } | null {
    const file = uri.startsWith("file:") ? fileURLToPath(uri) : uri;
    // on Windows ols' URIs may spell the drive letter in another case (file:///c%3A/...)
    if (!this.root || relativeInside(this.root, file) === null) return { uri, line };
    for (const shadow of this.shadows.values()) {
      const name = relativeInside(shadow.dir, file);
      if (name === null) continue;
      const entry = shadow.files.get(name);
      const source = shadow.lines.get(name)?.[line] ?? 0;
      if (!entry?.source || source <= 0) return null;
      return { uri: pathToFileURL(entry.source).toString(), line: source - 1 };
    }
    return null;
  }

  /** A range on the shadow line of `t` as a range on the source line `p`; undefined for any other line. */
  private onSourceLine<R extends { start: Position; end: Position }>(r: R | undefined, t: Target, p: Position): R | undefined {
    if (!r || r.start.line !== t.position.line || r.end.line !== t.position.line) return undefined;
    // on a rewritten line, only a range inside the name the request was on maps back
    if (t.span && (r.start.character < t.span[0] || r.end.character > t.span[1])) return undefined;
    return { ...r, start: { line: p.line, character: r.start.character + t.shift }, end: { line: p.line, character: r.end.character + t.shift } };
  }

  async hover(program: string, path: string, text: string, p: Position): Promise<Hover | undefined> {
    const t = this.target(program, path, text, p);
    const res = t && (await this.request<Hover | null>("textDocument/hover", params(t)));
    return res ? { ...res, range: this.onSourceLine(res.range, t, p) } : undefined;
  }

  async signatureHelp(program: string, path: string, text: string, p: Position): Promise<SignatureHelp | undefined> {
    const t = this.target(program, path, text, p);
    return t && ((await this.request<SignatureHelp | null>("textDocument/signatureHelp", params(t))) ?? undefined);
  }

  async definition(program: string, path: string, text: string, p: Position): Promise<Location[]> {
    const t = this.target(program, path, text, p);
    if (!t) return [];
    const res = await this.request<Location | Location[] | LocationLink[] | null>("textDocument/definition", params(t));
    const list = res ? (Array.isArray(res) ? res : [res]) : [];
    const out: Location[] = [];
    for (const l of list) {
      const loc = "targetUri" in l ? { uri: l.targetUri, range: l.targetSelectionRange } : l;
      const src = this.toSource(loc.uri, loc.range.start.line);
      const shift = src ? src.line - loc.range.start.line : 0;
      if (src) out.push({ uri: src.uri, range: { start: { ...loc.range.start, line: src.line }, end: { ...loc.range.end, line: loc.range.end.line + shift } } });
    }
    return out;
  }

  async completion(program: string, path: string, text: string, p: Position): Promise<CompletionItem[]> {
    const t = this.target(program, path, text, p);
    if (!t) return [];
    const res = await this.request<CompletionItem[] | CompletionList | null>("textDocument/completion", params(t));
    const items = Array.isArray(res) ? res : res?.items ?? [];
    return items.filter((i) => !GENERATED_NAME.test(i.label)).map((i) => this.completionOnSource(i, t, p));
  }

  private completionOnSource(item: CompletionItem, t: Target, p: Position): CompletionItem {
    const edit = item.textEdit;
    let textEdit = edit;
    if (edit && "range" in edit) {
      const range = this.onSourceLine(edit.range, t, p);
      textEdit = range && { ...edit, range };
    } else if (edit) {
      const insert = this.onSourceLine(edit.insert, t, p);
      const replace = this.onSourceLine(edit.replace, t, p);
      textEdit = insert && replace && { ...edit, insert, replace };
    }
    // edits elsewhere in the file (auto-imports) go to the source line their shadow line came from
    const additionalTextEdits = item.additionalTextEdits?.flatMap((e) => {
      const line = t.lines[e.range.start.line] ?? 0;
      if (line <= 0 || e.range.end.line !== e.range.start.line) return [];
      return [{ ...e, range: { start: { ...e.range.start, line: line - 1 }, end: { ...e.range.end, line: line - 1 } } }];
    });
    return { ...item, textEdit, additionalTextEdits };
  }
}
