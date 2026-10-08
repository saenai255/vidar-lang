import { readFileSync, readdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { findManifest, resolveCollection } from "../manifest";

/**
 * The workspace index: finds every package directory with `.vidar` files under the workspace folders and
 * has each program analyzed in the background, so workspace symbols and the `-opt` report cover programs
 * whose files were never opened. Work is done in small slices on a timer, after the editor has been quiet
 * for a while, one program per slice; `stop` and `removeRoots` cancel what is left.
 */

/** directory names never searched, besides hidden ones (`.git`, `.claude`, ...) */
const SKIP = new Set(["out", "node_modules", "expected"]);
/** wait this long after the last edit or request before doing anything */
const QUIET_MS = 400;
/** before the first slice, so startup requests go first */
const START_MS = 1000;
/** between slices */
const STEP_MS = 20;
/** time spent listing directories per slice */
const SLICE_MS = 10;
const MAX_DIRS = 20000;
const MAX_PROGRAMS = 1000;

export interface IndexHost {
  /** whether some analysis already holds the package in `dir` */
  analyzed(dir: string): boolean;
  /** analyze the program rooted at `dir` (quietly) */
  analyze(dir: string): void;
  /** drop what was analyzed for programs under `root` */
  forget?(root: string): void;
  log?(message: string): void;
}

const IMPORT = /^\s*import\s+(?:[A-Za-z_]\w*\s+)?"([^"]+)"/gm;

export class WorkspaceIndex {
  private roots: string[] = [];
  private toList: string[] = [];
  /** package directories found since the last plan */
  private found: string[] = [];
  /** directories some found package imports */
  private imported = new Set<string>();
  private toAnalyze: string[] = [];
  private listed = 0;
  private analyzed = 0;
  private timer: NodeJS.Timeout | undefined;
  private lastTouch = 0;
  private stopped = false;

  constructor(private host: IndexHost) {}

  /** Something the user did: background work waits until things are quiet again. */
  touch(): void {
    this.lastTouch = Date.now();
  }

  addRoots(roots: string[]): void {
    for (const r of roots.map((x) => resolve(x))) {
      if (this.roots.includes(r)) continue;
      this.roots.push(r);
      this.toList.push(r);
    }
    this.pump(START_MS);
  }

  removeRoots(roots: string[]): void {
    for (const r of roots.map((x) => resolve(x))) {
      const under = (d: string) => d === r || d.startsWith(r + sep);
      this.roots = this.roots.filter((x) => x !== r);
      this.toList = this.toList.filter((d) => !under(d));
      this.found = this.found.filter((d) => !under(d));
      this.toAnalyze = this.toAnalyze.filter((d) => !under(d));
      this.host.forget?.(r);
    }
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Whether there is work left (for tests). */
  get busy(): boolean {
    return !!(this.toList.length || this.found.length || this.toAnalyze.length);
  }

  private pump(delay = STEP_MS): void {
    if (this.stopped || this.timer || !this.busy) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      try {
        this.step();
      } catch (err) {
        this.host.log?.(`vidar: workspace index: ${err instanceof Error ? err.message : err}`);
      }
      this.pump();
    }, delay);
    this.timer.unref?.();
  }

  private step(): void {
    const quietFor = Date.now() - this.lastTouch;
    if (quietFor < QUIET_MS) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.pump(0);
      }, QUIET_MS - quietFor);
      this.timer.unref?.();
      return;
    }
    const until = Date.now() + SLICE_MS;
    while (this.toList.length && Date.now() < until) this.list(this.toList.shift()!);
    if (this.toList.length) return;
    if (this.found.length) this.plan();
    const dir = this.toAnalyze.shift();
    if (dir && !this.host.analyzed(dir) && this.analyzed++ < MAX_PROGRAMS) this.host.analyze(dir);
  }

  private list(dir: string): void {
    if (++this.listed > MAX_DIRS) {
      if (this.listed === MAX_DIRS + 1) this.host.log?.(`vidar: workspace index stopped after ${MAX_DIRS} directories`);
      return;
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    let sources = false;
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith(".") && !SKIP.has(e.name)) this.toList.push(join(dir, e.name));
      else if (e.isFile() && e.name.endsWith(".vidar")) {
        sources = true;
        this.readImports(dir, join(dir, e.name));
      }
    }
    if (sources) this.found.push(dir);
  }

  private readImports(dir: string, file: string): void {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return;
    }
    for (const m of text.matchAll(IMPORT)) {
      if (!m[1].includes(":")) this.imported.add(resolve(dir, m[1]));
      else {
        try {
          const target = resolveCollection(findManifest(dir), m[1]);
          if (target) this.imported.add(target);
        } catch {
          // a broken vidar.toml is reported when the program is analyzed
        }
      }
    }
  }

  /** Program roots (packages nothing else found imports) first, then the rest, in case a cycle has no root. */
  private plan(): void {
    const dirs = this.found.sort();
    this.found = [];
    this.toAnalyze.push(...dirs.filter((d) => !this.imported.has(d)), ...dirs.filter((d) => this.imported.has(d)));
  }
}
