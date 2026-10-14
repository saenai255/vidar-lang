import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Expr, Stmt } from "./ast";
import { lex } from "./lexer";
import { Parser } from "./parser";

/**
 * Top-level declarations of an Odin collection package (`core:`, `base:`, `vendor:`), read from
 * `odin root` on demand, so `type_of_expr` can type calls into them. Only declarations are kept;
 * nothing here is checked or emitted.
 */
export interface OdinPackage {
  /** name -> its declaration (the first one found, across `when` branches and files) */
  decls: Map<string, { decl: Extract<Stmt, { k: "ValueDecl" }>; index: number; imports: Map<string, string> }>;
}

let odinPath = "odin";
let root: string | null | undefined;
const packages = new Map<string, OdinPackage | null>();

/** The `odin` whose root is read (the language server's `odinPath` setting). */
export function setOdinPath(path: string): void {
  if (path === odinPath) return;
  odinPath = path;
  root = undefined;
  packages.clear();
}

function odinRoot(): string | null {
  if (root !== undefined) return root;
  root = process.env.ODIN_ROOT || null;
  if (!root) {
    try {
      const r = spawnSync(odinPath, ["root"], { encoding: "utf8", timeout: 5000 });
      root = r.status === 0 ? r.stdout.trim() || null : null;
    } catch {
      root = null;
    }
  }
  return root;
}

/** The package an import path such as `core:strings` names; null when it can't be read. */
export function odinPackage(path: string): OdinPackage | null {
  if (packages.has(path)) return packages.get(path)!;
  packages.set(path, null);
  const m = /^(core|base|vendor):(.+)$/.exec(path);
  const base = m && odinRoot();
  if (!m || !base) return null;
  const dir = join(base, m[1], m[2]);
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".odin") && !f.endsWith("_test.odin")).sort();
  } catch {
    return null;
  }
  const pkg: OdinPackage = { decls: new Map() };
  for (const f of files) {
    const file = join(dir, f);
    let stmts: Stmt[];
    try {
      stmts = new Parser(lex(readFileSync(file, "utf8"), file)).parseFile(file).stmts;
    } catch {
      continue; // a file vidar's parser doesn't take: its declarations stay unknown
    }
    const imports = new Map<string, string>();
    for (const s of stmts) if (s.k === "Import") imports.set(s.alias ?? s.path.replace(/^.*[:/]/, ""), s.path);
    const add = (list: Stmt[]): void => {
      for (const s of list) {
        if (s.k === "ValueDecl") s.names.forEach((n, index) => pkg.decls.has(n.name) || pkg.decls.set(n.name, { decl: s, index, imports }));
        else if (s.k === "When") {
          add(s.then.stmts);
          let e: Stmt | null = s.else;
          while (e) {
            if (e.k === "Block") {
              add(e.stmts);
              break;
            }
            if (e.k !== "When") break;
            add(e.then.stmts);
            e = e.else;
          }
        }
      }
    };
    add(stmts);
  }
  packages.set(path, pkg);
  return pkg;
}

/** The proc literals a declaration's value stands for: one proc, or every member of a group. */
export function procsOf(pkg: OdinPackage, name: string, depth = 0): Extract<Expr, { k: "ProcLit" }>[] {
  const d = pkg.decls.get(name);
  const v = d?.decl.values[d.index];
  if (!v || depth > 4) return [];
  if (v.k === "ProcLit") return [v];
  if (v.k === "Directive" && v.x?.k === "ProcLit") return [v.x];
  if (v.k === "ProcGroup") return v.procs.flatMap((p) => (p.k === "Ident" ? procsOf(pkg, p.name, depth + 1) : []));
  return [];
}
