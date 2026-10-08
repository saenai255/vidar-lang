import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { CompileError } from "./lexer";

export const MANIFEST = "vidar.toml";

export interface Manifest {
  dir: string;
  collections: Map<string, string>;
}

const KEY = /^[A-Za-z_][\w-]*$/;

/** The `[collections]` table of a vidar.toml: `name = "path"`. Other tables are reserved and skipped. */
export function parseManifest(text: string, file: string): Map<string, string> {
  const collections = new Map<string, string>();
  let table = "";
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const fail = (msg: string) => new CompileError(msg, { file, line: i + 1, col: 1 });
    if (!line || line.startsWith("#")) continue;
    const header = /^\[([\w.-]+)\]\s*(#.*)?$/.exec(line);
    if (header) {
      table = header[1];
      continue;
    }
    const kv = /^([\w-]+)\s*=\s*(.*)$/.exec(line);
    if (!kv) throw fail(`cannot parse '${line}'`);
    if (table !== "collections") continue;
    if (!KEY.test(kv[1])) throw fail(`invalid collection name '${kv[1]}'`);
    const str = /^"((?:[^"\\]|\\.)*)"\s*(#.*)?$/.exec(kv[2]) ?? /^'([^']*)'\s*(#.*)?$/.exec(kv[2]);
    if (!str) throw fail(`collection '${kv[1]}' must be a string`);
    if (collections.has(kv[1])) throw fail(`collection '${kv[1]}' is defined twice`);
    collections.set(kv[1], str[1].replace(/\\(.)/g, "$1"));
  }
  return collections;
}

/** The nearest vidar.toml at or above `dir`. */
export function findManifest(dir: string, read: (path: string) => string = (p) => readFileSync(p, "utf8")): Manifest | null {
  for (let d = resolve(dir); ; d = dirname(d)) {
    const file = join(d, MANIFEST);
    if (existsSync(file)) return { dir: d, collections: parseManifest(read(file), file) };
    if (dirname(d) === d) return null;
  }
}

/** The directory a `name:rest` import points at, or null when `name` is not a declared collection. */
export function resolveCollection(manifest: Manifest | null, path: string): string | null {
  const colon = path.indexOf(":");
  const root = manifest?.collections.get(path.slice(0, colon));
  if (!manifest || root === undefined) return null;
  const base = root.startsWith("~/") ? join(homedir(), root.slice(2)) : isAbsolute(root) ? root : resolve(manifest.dir, root);
  return resolve(base, path.slice(colon + 1));
}
