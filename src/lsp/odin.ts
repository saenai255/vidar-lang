import { ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CompletionItem, CompletionList, Hover, Location, LocationLink, MessageConnection, Position, SignatureHelp,
  StreamMessageReader, StreamMessageWriter, createMessageConnection,
} from "vscode-languageserver/node";
import { Program as Analysis, Output, outputName } from "../project";

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
}

interface GoodEmit {
  sourceText: string;
  output: string;
  lines: number[];
}

export interface Patched {
  text: string;
  lines: number[];
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
  };
}

const params = (t: { textDocument: { uri: string }; position: Position }) => ({ textDocument: t.textDocument, position: t.position });

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
      if (sourceText !== undefined) this.lastGood.set(src!, { sourceText, output: text, lines: out.lineMap.get(name) ?? identity(text) });
      else extra.set(name, text);
    }
    this.extraFiles.set(program, extra);
  }

  /** Brings the shadow tree of `program` up to date with `a` (and unsaved `texts`). */
  async sync(program: string, a: Analysis, texts: Map<string, string>): Promise<void> {
    if (this.disabled || !(await this.start())) return;
    let shadow = this.shadows.get(program);
    if (!shadow) {
      shadow = { dir: join(this.root, String(this.shadows.size)), files: new Map(), bySource: new Map(), lines: new Map() };
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

  /** The shadow document and position for `p` in `path`, if that line is passed through unchanged. */
  private target(program: string, path: string, text: string, p: Position) {
    const shadow = this.shadows.get(program);
    if (this.disabled || !shadow) return undefined;
    const name = this.refresh(shadow, path, text);
    if (!name) return undefined;
    const sourceLine = text.split("\n")[p.line];
    const shadowLines = shadow.files.get(name)!.text.split("\n");
    const lines = shadow.lines.get(name) ?? [];
    const line = lines.findIndex((l, i) => l === p.line + 1 && shadowLines[i] === sourceLine);
    if (sourceLine === undefined || line < 0) return undefined;
    return { textDocument: { uri: pathToFileURL(join(shadow.dir, name)).toString() }, position: { line, character: p.character }, lines };
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
    if (!this.root || !file.startsWith(this.root + sep)) return { uri, line };
    for (const shadow of this.shadows.values()) {
      if (!file.startsWith(shadow.dir + sep)) continue;
      const name = relative(shadow.dir, file).split(sep).join("/");
      const entry = shadow.files.get(name);
      const source = shadow.lines.get(name)?.[line] ?? 0;
      if (!entry?.source || source <= 0) return null;
      return { uri: pathToFileURL(entry.source).toString(), line: source - 1 };
    }
    return null;
  }

  /** A range on the shadow line of `t` as a range on the source line `p`; undefined for any other line. */
  private onSourceLine<R extends { start: Position; end: Position }>(r: R | undefined, t: { position: Position }, p: Position): R | undefined {
    if (!r || r.start.line !== t.position.line || r.end.line !== t.position.line) return undefined;
    return { ...r, start: { ...r.start, line: p.line }, end: { ...r.end, line: p.line } };
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

  private completionOnSource(item: CompletionItem, t: { position: Position; lines: number[] }, p: Position): CompletionItem {
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
