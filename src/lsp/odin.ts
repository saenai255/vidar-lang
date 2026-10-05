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
 * Generated code keeps the source's line numbers, and lines vidar does not rewrite come out
 * unchanged, so a position on such a line is the same position in the shadow file.
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
  /** source lines per output file; shadow lines past this are generated */
  sourceLines: Map<string, number>;
}

interface GoodEmit {
  sourceText: string;
  output: string;
}

const TIMEOUT_MS = 2000;
const GENERATED_NAME = /^__|^vidar_runtime$/;

/**
 * Generated Odin for `current` built from an older (source, output) pair: unchanged leading and
 * trailing lines keep their generated text, edited lines are taken from `current` as is.
 */
export function patch(oldSource: string, oldOutput: string, current: string): string {
  const s0 = oldSource.split("\n");
  const o0 = oldOutput.split("\n");
  const s1 = current.split("\n");
  if (o0.length < s0.length) return current;
  let pre = 0;
  while (pre < s0.length && pre < s1.length && s0[pre] === s1[pre]) pre++;
  let suf = 0;
  while (suf < s0.length - pre && suf < s1.length - pre && s0[s0.length - 1 - suf] === s1[s1.length - 1 - suf]) suf++;
  return [...o0.slice(0, pre), ...s1.slice(pre, s1.length - suf), ...o0.slice(s0.length - suf)].join("\n");
}

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
      if (sourceText !== undefined) this.lastGood.set(src!, { sourceText, output: text });
      else extra.set(name, text);
    }
    this.extraFiles.set(program, extra);
  }

  /** Brings the shadow tree of `program` up to date with `a` (and unsaved `texts`). */
  async sync(program: string, a: Analysis, texts: Map<string, string>): Promise<void> {
    if (this.disabled || !(await this.start())) return;
    let shadow = this.shadows.get(program);
    if (!shadow) {
      shadow = { dir: join(this.root, String(this.shadows.size)), files: new Map(), bySource: new Map(), sourceLines: new Map() };
      this.shadows.set(program, shadow);
    }
    for (const pkg of a.packages) {
      for (const f of pkg.files) {
        const name = outputName(pkg, f);
        const text = texts.get(f.path) ?? a.sources.find((s) => s.path === f.path)?.text;
        if (text === undefined) continue;
        shadow.bySource.set(f.path, name);
        this.put(shadow, name, this.shadowText(f.path, text), f.path);
        shadow.sourceLines.set(name, text.split("\n").length);
      }
    }
    for (const [name, text] of this.extraFiles.get(program) ?? []) this.put(shadow, name, text);
  }

  /** Re-syncs one file from its current text before a request. */
  private refresh(shadow: Shadow, path: string, text: string): string | undefined {
    const name = shadow.bySource.get(path);
    if (!name) return undefined;
    this.put(shadow, name, this.shadowText(path, text), path);
    shadow.sourceLines.set(name, text.split("\n").length);
    return name;
  }

  private shadowText(path: string, text: string): string {
    const good = this.lastGood.get(path);
    return good ? patch(good.sourceText, good.output, text) : text;
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
    if (sourceLine === undefined || shadow.files.get(name)!.text.split("\n")[p.line] !== sourceLine) return undefined;
    return { textDocument: { uri: pathToFileURL(join(shadow.dir, name)).toString() }, position: p };
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
  private toSource(uri: string, line: number): string | null | undefined {
    const file = uri.startsWith("file:") ? fileURLToPath(uri) : uri;
    if (!this.root || !file.startsWith(this.root + sep)) return uri;
    for (const shadow of this.shadows.values()) {
      if (!file.startsWith(shadow.dir + sep)) continue;
      const name = relative(shadow.dir, file).split(sep).join("/");
      const entry = shadow.files.get(name);
      if (!entry?.source || line >= (shadow.sourceLines.get(name) ?? 0)) return null;
      return pathToFileURL(entry.source).toString();
    }
    return null;
  }

  async hover(program: string, path: string, text: string, p: Position): Promise<Hover | undefined> {
    const t = this.target(program, path, text, p);
    return t && ((await this.request<Hover | null>("textDocument/hover", t)) ?? undefined);
  }

  async signatureHelp(program: string, path: string, text: string, p: Position): Promise<SignatureHelp | undefined> {
    const t = this.target(program, path, text, p);
    return t && ((await this.request<SignatureHelp | null>("textDocument/signatureHelp", t)) ?? undefined);
  }

  async definition(program: string, path: string, text: string, p: Position): Promise<Location[]> {
    const t = this.target(program, path, text, p);
    if (!t) return [];
    const res = await this.request<Location | Location[] | LocationLink[] | null>("textDocument/definition", t);
    const list = res ? (Array.isArray(res) ? res : [res]) : [];
    const out: Location[] = [];
    for (const l of list) {
      const loc = "targetUri" in l ? { uri: l.targetUri, range: l.targetSelectionRange } : l;
      const uri = this.toSource(loc.uri, loc.range.start.line);
      if (uri) out.push({ uri, range: loc.range });
    }
    return out;
  }

  async completion(program: string, path: string, text: string, p: Position): Promise<CompletionItem[]> {
    const t = this.target(program, path, text, p);
    if (!t) return [];
    const res = await this.request<CompletionItem[] | CompletionList | null>("textDocument/completion", t);
    const items = Array.isArray(res) ? res : res?.items ?? [];
    return items.filter((i) => !GENERATED_NAME.test(i.label));
  }
}
