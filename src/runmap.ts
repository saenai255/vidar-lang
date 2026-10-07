// Locations in the generated Odin, mapped back to the .vidar lines they came from.
//
// Odin prints locations in two shapes:
//   /abs/out/main.odin(17:9) ...           compile errors, panics, failed asserts, bounds checks
//   [main.odin:28:test_bad()] ...          `core:log` / `core:testing` messages (short file path)
// Both are rewritten to the .vidar file and line; anything else passes through unchanged.
// The same mapping serves compile errors (`mapLocations` in cli.ts), the program's output under
// `vidar run` / `vidar test`, and `vidar map <out>`, which reads the `vidar.map.json` that
// `vidar build` writes next to the generated code.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import * as nodePath from "node:path";
import { type PathModule, pathKey, pathPattern } from "./paths";
import type { Output } from "./project";

export const MAP_FILE = "vidar.map.json";

/** The contents of `vidar.map.json`. */
export interface RunMap {
  version: 1;
  /** generated path (relative to the map's directory, '/'-separated) -> where it came from */
  files: Record<string, { source: string; lines: number[] }>;
}

export function runMapOf(out: Output): RunMap {
  const files: RunMap["files"] = {};
  for (const [gen, source] of out.sourceOf) files[gen] = { source, lines: out.lineMap.get(gen) ?? [] };
  return { version: 1, files };
}

export function readRunMap(dir: string): RunMap {
  const file = nodePath.join(dir, MAP_FILE);
  if (!existsSync(file)) throw new Error(`${file} does not exist (it is written by 'vidar build')`);
  const map = JSON.parse(readFileSync(file, "utf8")) as RunMap;
  if (map.version !== 1 || typeof map.files !== "object") throw new Error(`${file} is not a vidar map`);
  return map;
}

/** The .vidar line (1-based) of generated line `line` (1-based), or 0 if it has none. */
export function sourceLine(lines: number[], line: number): number {
  return Math.abs(lines[line - 1] ?? 0);
}

/**
 * The first generated line (1-based) written for .vidar line `line`, or 0 if there is none. Given
 * the generated `text`, lines holding only a comment (such as the one naming an expanded macro)
 * are passed over when a line with code also maps there, so a breakpoint set on it binds.
 */
export function generatedLine(lines: number[], line: number, text?: string[]): number {
  const code = (i: number) => !text || !/^\s*(\/\/.*)?$/.test(text[i] ?? "");
  let exact = 0;
  let near = 0;
  let any = 0;
  for (let i = 0; i < lines.length; i++) {
    if (Math.abs(lines[i]) !== line) continue;
    any ||= i + 1;
    if (!code(i)) continue;
    if (lines[i] === line) {
      exact = i + 1;
      break;
    }
    near ||= i + 1;
  }
  if (exact || near || any) return exact || near || any;
  // a line that produced no code (a comment, a blank line): the next one that did
  let best = 0;
  for (let i = 0; i < lines.length; i++) if (lines[i] > line && (!best || lines[i] < lines[best - 1])) best = i + 1;
  return best;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export interface MapperOptions {
  /** directory short `[file.odin:line]` paths are written relative to (default: the process's cwd) */
  cwd?: string;
  /** the `node:path` flavor the paths are in (default: this platform's; tests pass `path.win32`) */
  path?: PathModule;
}

/** Rewrites generated locations in one line (or any text) of output; `roots` are the directories the generated files are in. */
export function locationMapper(map: RunMap, roots: string[], opts: MapperOptions = {}): (text: string) => string {
  const p = opts.path ?? nodePath;
  const cwd = opts.cwd ?? process.cwd();
  // by pathKey: on Windows Odin may print either slash, and the drive letter in either case
  const byPath = new Map<string, RunMap["files"][string]>();
  const patterns = new Map<string, string>();
  const byBase = new Map<string, RunMap["files"][string] | null>();
  const dirs = [...new Set(roots.flatMap((r) => [p.resolve(r), ...(existsSync(r) ? [realpathSync(r)] : [])]))];
  for (const [gen, entry] of Object.entries(map.files)) {
    for (const dir of dirs) {
      const path = p.join(dir, gen);
      byPath.set(pathKey(path, p), entry);
      patterns.set(pathKey(path, p), pathPattern(path, p));
    }
    const base = p.posix.basename(gen);
    byBase.set(base, byBase.has(base) ? null : entry); // a name two packages share is ambiguous
  }
  if (!byPath.size) return (text) => text;
  const paths = [...patterns].sort(([a], [b]) => b.length - a.length).map(([, pattern]) => pattern);
  const bases = [...byBase].filter(([, e]) => e).map(([b]) => escape(b));
  const long = new RegExp(`(${paths.join("|")})(?:\\((\\d+):(\\d+)\\)|:(\\d+)(?=[:\\]\\s]|$))`, p.sep === "\\" ? "gi" : "g");
  const short = bases.length ? new RegExp(`\\[(${bases.join("|")}):(\\d+)(?=[:\\]])`, "g") : null;
  const shown = (source: string) => {
    const rel = p.relative(cwd, source);
    return rel && !rel.startsWith("..") && !p.isAbsolute(rel) ? rel : source;
  };
  return (text) => {
    if (!text) return text;
    text = text.replace(long, (m, path: string, l1?: string, c?: string, l2?: string) => {
      const entry = byPath.get(pathKey(path, p))!;
      const line = sourceLine(entry.lines, Number(l1 ?? l2));
      if (!line) return m;
      return l1 ? `${entry.source}(${line}:${c})` : `${entry.source}:${line}`;
    });
    if (short) {
      text = text.replace(short, (m, base: string, l: string) => {
        const entry = byBase.get(base)!;
        const line = sourceLine(entry.lines, Number(l));
        return line ? `[${shown(entry.source)}:${line}` : m;
      });
    }
    return text;
  };
}

/** Rewrites generated locations in a whole text. */
export function mapText(text: string, map: RunMap, roots: string[], opts?: MapperOptions): string {
  return locationMapper(map, roots, opts)(text);
}

/**
 * A stream filter: text goes in as it comes, and each line comes out rewritten as soon as it is
 * complete. A partial line (a prompt, a progress bar) is written out after `idleMs` without more
 * output, so nothing waits on a newline.
 */
export class LineFilter {
  private pending = "";
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly mapLine: (line: string) => string,
    private readonly write: (text: string) => void,
    private readonly idleMs = 50,
  ) {}

  push(chunk: string | Buffer): void {
    this.pending += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const nl = this.pending.lastIndexOf("\n");
    if (nl >= 0) {
      const done = this.pending.slice(0, nl + 1);
      this.pending = this.pending.slice(nl + 1);
      this.write(done.split("\n").map(this.mapLine).join("\n"));
    }
    this.arm();
  }

  /** Writes out whatever is left. */
  end(): void {
    this.disarm();
    if (this.pending) this.write(this.mapLine(this.pending));
    this.pending = "";
  }

  private arm(): void {
    this.disarm();
    if (!this.pending || this.idleMs < 0) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.pending) this.write(this.mapLine(this.pending));
      this.pending = "";
    }, this.idleMs);
  }

  private disarm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
