// `--watch`: rerun a command whenever a source file of the program changes.
import { FSWatcher, existsSync, readdirSync, statSync, unwatchFile, watch as fsWatch, watchFile } from "node:fs";
import { spawn } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { loadProgram, schedSourcePath } from "./project";

/** The commands `--watch` works with. */
export const WATCH_COMMANDS = ["run", "check"];

export interface WatchOptions {
  /**
   * One run. The watcher waits for it to settle before the next one; `signal` is aborted when
   * a change arrives while it is still running (a child started with `runChild` is then killed).
   */
  run(signal: AbortSignal): unknown;
  /**
   * What to watch, asked again before every run (imports change). A file is watched on its own; a directory
   * stands for every `.vidar` and `.odin` file in it, including ones created later.
   */
  files(): Iterable<string>;
  /** quiet time after the last change before rerunning, in ms (default 100) */
  debounceMs?: number;
  /** clear the screen before each rerun */
  clear?: boolean;
  /** poll instead of `fs.watch` (it is also the fallback when `fs.watch` fails), with this interval in ms (`true`: 250) */
  poll?: boolean | number;
  /** called when a run has finished and no rerun is due yet, with what is being watched */
  onWaiting?(paths: string[]): void;
}

export interface Watcher {
  /** stops watching, aborts a running run and waits for it */
  close(): Promise<void>;
}

const SOURCE = /\.(vidar|odin)$/;

/** Runs `opts.run` now and again after every change to the watched files, until closed. */
export function watch(opts: WatchOptions): Watcher {
  const debounce = opts.debounceMs ?? 100;
  const interval = opts.poll === true ? 250 : opts.poll || 250;
  let watched = new Map<string, () => void>(); // directory (or polled path) -> stop
  let wanted = new Map<string, { all: boolean; names: Set<string> }>(); // directory -> what in it counts
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let ac: AbortController | undefined;
  let dirty = false;
  let closed = false;
  let runs = 0;

  const relevant = (dir: string, name: string | null) => {
    const w = wanted.get(dir);
    if (!w) return false;
    if (name === null) return true; // the platform didn't say which file
    return w.names.has(name) || (w.all && SOURCE.test(name));
  };

  const changed = () => {
    if (closed) return;
    dirty = true;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (running) ac?.abort();
      else start();
    }, debounce);
  };

  function poll(path: string, dir: string, name: string | null): () => void {
    const listener = (cur: { mtimeMs: number; size: number; ino: number }, prev: { mtimeMs: number; size: number; ino: number }) => {
      if (cur.mtimeMs !== prev.mtimeMs || cur.size !== prev.size || cur.ino !== prev.ino) {
        if (name === null || relevant(dir, name)) changed();
      }
    };
    watchFile(path, { interval, persistent: true }, listener);
    return () => unwatchFile(path, listener);
  }

  /**
   * Polls a directory and the files that count in it. Its mtime only changes when a file is
   * added, removed or renamed, so each file is polled too; files added later join after the next run.
   */
  function pollAll(dir: string, w: { all: boolean; names: Set<string> }, into: Map<string, () => void>): void {
    const names = new Set(w.names);
    try {
      if (w.all) for (const n of readdirSync(dir)) if (SOURCE.test(n)) names.add(n);
    } catch {
      // gone: the directory's own poll notices it coming back
    }
    into.set(dir, watched.get(dir) ?? poll(dir, dir, null));
    for (const n of names) {
      const k = join(dir, n);
      into.set(k, watched.get(k) ?? poll(k, dir, n));
    }
  }

  function rewatch(): void {
    const next = new Map<string, { all: boolean; names: Set<string> }>();
    for (const p of opts.files()) {
      const path = resolve(p);
      const isDir = existsSync(path) && statSync(path).isDirectory();
      const dir = isDir ? path : dirname(path);
      const w = next.get(dir) ?? { all: false, names: new Set<string>() };
      if (isDir) w.all = true;
      else w.names.add(basename(path));
      next.set(dir, w);
    }
    wanted = next;
    const keep = new Map<string, () => void>();
    const usePoll = opts.poll !== undefined && opts.poll !== false;
    for (const [dir, w] of next) {
      if (usePoll) {
        pollAll(dir, w, keep);
        continue;
      }
      const old = watched.get(dir);
      if (old) {
        keep.set(dir, old);
        continue;
      }
      // the directory, not the file: editors that save by renaming replace the file's inode
      try {
        const fw: FSWatcher = fsWatch(dir, { persistent: true }, (_event, name) => {
          if (relevant(dir, name === null ? null : String(name))) changed();
        });
        const stopFw = () => fw.close();
        fw.on("error", () => {
          fw.close();
          if (watched.get(dir) !== stopFw) return;
          watched.delete(dir);
          const now = wanted.get(dir);
          if (now) pollAll(dir, now, watched);
        });
        keep.set(dir, stopFw);
      } catch {
        pollAll(dir, w, keep);
      }
    }
    for (const [k, stop] of watched) if (keep.get(k) !== stop) stop();
    watched = keep;
  }

  function start(): void {
    dirty = false;
    if (opts.clear && runs > 0) process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
    runs++;
    // the file set of the program as it is about to run, watched while it runs so a change can stop it
    try {
      rewatch();
    } catch (err) {
      console.error(err);
    }
    ac = new AbortController();
    const signal = ac.signal;
    running = (async () => {
      try {
        await opts.run(signal);
      } catch (err) {
        if (!signal.aborted) console.error(err);
      }
    })().then(() => {
      running = undefined;
      if (closed) return;
      if (dirty && !timer) start();
      else opts.onWaiting?.([...wanted].flatMap(([dir, w]) => (w.all ? [dir] : [...w.names].map((n) => join(dir, n)))));
    });
  }

  start();
  return {
    async close() {
      closed = true;
      clearTimeout(timer);
      ac?.abort();
      for (const stop of watched.values()) stop();
      watched.clear();
      await running;
    },
  };
}

/**
 * Runs a command with inherited stdio and resolves with its exit code (null when killed).
 * On abort it is killed together with everything it started (its own process group on POSIX).
 */
export function runChild(cmd: string, args: string[], signal: AbortSignal): Promise<number | null> {
  return new Promise((done, fail) => {
    if (signal.aborted) return done(null);
    const group = process.platform !== "win32";
    const child = spawn(cmd, args, { stdio: "inherit", detached: group });
    const kill = (sig: NodeJS.Signals) => {
      try {
        if (group && child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        // already gone
      }
    };
    let grace: NodeJS.Timeout | undefined;
    const onAbort = () => {
      kill("SIGTERM");
      grace = setTimeout(() => kill("SIGKILL"), 2000);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    child.on("error", (err) => {
      signal.removeEventListener("abort", onAbort);
      fail(err);
    });
    child.on("exit", (code) => {
      signal.removeEventListener("abort", onAbort);
      clearTimeout(grace);
      if (signal.aborted) kill("SIGKILL"); // whatever it started and left behind
      done(signal.aborted ? null : code);
    });
  });
}

/**
 * What `--watch` watches for a program: the directory of every project package it loads (a
 * single-file entry is watched as that file), never the bundled packages or `core:`.
 */
export function projectFiles(entry: string): string[] {
  const root = resolve(entry);
  const single = !(existsSync(root) && statSync(root).isDirectory());
  try {
    const program = loadProgram(root, { tolerant: true });
    const bundled = dirname(schedSourcePath());
    const dirs = program.packages.map((p) => p.dir).filter((d) => d !== bundled && !(single && d === dirname(root)));
    return [...new Set([single ? root : undefined, ...dirs].filter((d): d is string => !!d))];
  } catch {
    return [root];
  }
}

/** Whether the command line asks for `--watch` (before any `--`, after which arguments are the program's). */
export function wantsWatch(argv: string[]): boolean {
  const end = argv.indexOf("--");
  return argv.slice(0, end < 0 ? argv.length : end).includes("--watch");
}

/**
 * `vidar <cmd> <input> --watch [--clear] ...`: reruns `self` (the command that runs this CLI)
 * with the same arguments, minus the watch flags, in a child process that is killed on change.
 */
export function watchCommand(argv: string[], self: string[]): void {
  const end = argv.indexOf("--");
  const args = argv.filter((a, i) => (a !== "--watch" && a !== "--clear") || (end >= 0 && i > end));
  const clear = argv.slice(0, end < 0 ? argv.length : end).includes("--clear");
  const [cmd, input] = args;
  if (!WATCH_COMMANDS.includes(cmd)) {
    console.error(`error: --watch works with ${WATCH_COMMANDS.join(", ")}`);
    process.exitCode = 2;
    return;
  }
  if (!input || !existsSync(input)) {
    console.error(`error: ${input ?? "<dir|file.vidar>"} does not exist`);
    process.exitCode = 1;
    return;
  }
  const w = watch({
    clear,
    files: () => projectFiles(input),
    run: async (signal) => {
      const code = await runChild(self[0], [...self.slice(1), ...args], signal);
      if (code !== null && code !== 0) console.error(`vidar: exited with code ${code}`);
    },
    onWaiting: () => console.error("vidar: waiting for changes (ctrl-c to stop)"),
  });
  const stop = (code: number) => () => void w.close().then(() => process.exit(code));
  process.once("SIGINT", stop(130));
  process.once("SIGTERM", stop(143));
}
