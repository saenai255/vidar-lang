// Comparing file paths that reach vidar from different places: Odin's messages, ols' URIs and
// the editor's URIs. On Windows the same file can come back as `C:\out\main.odin`,
// `C:/out/main.odin` (Odin prints forward slashes) or `c:\out\main.odin` (an editor's
// `file:///c%3A/...` URI), so there paths compare without case and with either slash.
// Every function takes the `node:path` flavor to use, so tests can pass `path.win32` anywhere.
import * as nodePath from "node:path";

export type PathModule = typeof nodePath.posix;

const windows = (p: PathModule) => p.sep === "\\";

/**
 * `path` as a key to compare or look up by: on Windows, lower-cased and `\`-separated. The key
 * has the same length as `path`, character for character, outside a few non-ASCII letters.
 */
export function pathKey(path: string, p: PathModule = nodePath): string {
  return windows(p) ? path.replace(/\//g, "\\").toLowerCase() : path;
}

/**
 * `file` relative to `dir`, '/'-separated, when it is inside `dir`; otherwise null. On Windows
 * either slash separates and case doesn't matter.
 */
export function relativeInside(dir: string, file: string, p: PathModule = nodePath): string | null {
  const win = windows(p);
  const base = dir.replace(win ? /[\\/]+$/ : /\/+$/, "");
  if (file.length <= base.length + 1 || pathKey(file.slice(0, base.length), p) !== pathKey(base, p)) return null;
  const s = file[base.length];
  if (s !== "/" && !(win && s === "\\")) return null;
  return file.slice(base.length + 1).split(win ? /[\\/]/ : "/").join("/");
}

/**
 * A regular-expression source matching `path` as printed: on Windows with either slash at each
 * separator (match it with the `i` flag, and look the match up by `pathKey`).
 */
export function pathPattern(path: string, p: PathModule = nodePath): string {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return windows(p) ? path.split(/[\\/]/).map(escape).join("[\\\\/]") : escape(path);
}
