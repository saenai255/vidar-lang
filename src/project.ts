import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, posix, resolve } from "node:path";
import { CompileError, lex } from "./lexer";
import { Parser } from "./parser";
import { A, Analyzer } from "./analyzer";
import { Emitter, CLOSURE_RUNTIME } from "./emitter";
import { resetGensym } from "./comptime";
import type { File } from "./ast";
import { PackageInfo, Scope, Unit } from "./scope";
import { PRELUDE_PATH, PRELUDE_SOURCE } from "./prelude";
import { SCHED_ASM, SCHED_IMPORT, SCHED_SOURCE } from "./sched";

export interface Source {
  path: string;
  text: string;
}

export interface Program {
  entry: PackageInfo;
  packages: PackageInfo[];
  units: Unit[];
  analyzer: Analyzer;
  sources: Source[];
  /** empty when the program is valid */
  errors: CompileError[];
}

export interface LoadOptions {
  /** collect errors and keep going (language server) instead of throwing the first one */
  tolerant?: boolean;
  /** load packages named by relative imports (default true) */
  followImports?: boolean;
  /** unsaved editor contents, by absolute path */
  overrides?: Map<string, string>;
  /** rewrite plain Odin for speed: specialized fmt calls, proven bounds checks, grouped allocations, tables and specialized procs */
  optimize?: boolean;
  /** with optimize: collect what it decided per proc in `analyzer.report` */
  report?: boolean;
}

const SOURCE_EXTS = [".vidar", ".odin"];
export const RUNTIME_DIR = "vidar_runtime";

const bundledPaths = new Map<string, string>();

/**
 * Where a bundled source lives. It is written to a real file so editors can open it from
 * go-to-definition; the directory name is a hash of the source, so versions don't clash.
 */
function bundledSourcePath(name: string, source: string): string {
  const known = bundledPaths.get(name);
  if (known) return known;
  const dir = join(tmpdir(), `vidar-${name}-${createHash("sha1").update(source).digest("hex").slice(0, 12)}`);
  const path = join(dir, `${name}.vidar`);
  bundledPaths.set(name, path);
  try {
    if (!existsSync(path) || readFileSync(path, "utf8") !== source) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, source);
    }
  } catch {
    // unwritable temp dir: the path is still a fine name for the in-memory source
  }
  return path;
}

/** The bundled "vidar:sched" package. */
export function schedSourcePath(): string {
  return bundledSourcePath("sched", SCHED_SOURCE);
}

/** A real file holding the prelude, for editors (the compiler itself reads it as PRELUDE_PATH). */
export function preludeSourcePath(): string {
  return bundledSourcePath("prelude", PRELUDE_SOURCE);
}

/** Collection imports (`core:fmt`) are plain Odin; everything else is a path relative to the importing package. */
export function isRelativeImport(path: string): boolean {
  return !/^\w+:/.test(path);
}

function packageFiles(dir: string, overrides?: Map<string, string>): string[] {
  const names = new Set<string>();
  if (existsSync(dir) && statSync(dir).isDirectory()) {
    for (const n of readdirSync(dir)) if (SOURCE_EXTS.some((e) => n.endsWith(e))) names.add(join(dir, n));
  }
  for (const p of overrides?.keys() ?? []) if (dirname(p) === dir && SOURCE_EXTS.some((e) => p.endsWith(e))) names.add(p);
  // an .odin file generated next to its .vidar source is not a separate source
  return [...names].filter((p) => !(p.endsWith(".odin") && names.has(p + "pp"))).sort();
}

/**
 * Loads the package at `entry` (a directory, a single file, or in-memory sources) plus every
 * package it imports by relative path, then analyzes them together. Packages that import each
 * other in a cycle are grouped into one unit, which is emitted as a single Odin package.
 */
export function loadProgram(entry: string | Source[], opts: LoadOptions = {}): Program {
  resetGensym();
  const tolerant = !!opts.tolerant;
  const errors: CompileError[] = [];
  const analyzer = new Analyzer();
  if (tolerant) analyzer.errors = errors;
  analyzer.optimize = !!opts.optimize;
  if (opts.optimize && opts.report) analyzer.report = [];
  const byDir = new Map<string, PackageInfo>();
  const sources: Source[] = [];
  const read = (path: string) => opts.overrides?.get(path) ?? readFileSync(path, "utf8");

  const fail = (err: unknown) => {
    if (!tolerant || !(err instanceof CompileError)) throw err;
    errors.push(err);
  };

  function loadPackage(dir: string, srcs: Source[]): PackageInfo {
    const files: File[] = [];
    for (const s of srcs) {
      sources.push(s);
      try {
        files.push(new Parser(lex(s.text, s.path)).parseFile(s.path, tolerant ? errors : undefined));
      } catch (err) {
        fail(err);
      }
    }
    const names = files.map((f) => f.stmts.find((s) => s.k === "Package")).filter((s) => s?.k === "Package");
    const name = names[0]?.k === "Package" ? names[0].name : "main";
    for (const n of names) if (n?.k === "Package" && n.name !== name) fail(new CompileError(`package '${n.name}' does not match package '${name}' of the other files in ${dir}`, n.toks[n.start].pos));
    const pkg: PackageInfo = { dir, name, files, scope: undefined as unknown as Scope, fileScopes: new Map(), prefix: "", unit: undefined as unknown as Unit, deps: new Set() };
    pkg.scope = new Scope(analyzer.global, pkg);
    byDir.set(dir, pkg);
    if (opts.followImports === false) return pkg;
    for (const f of files) {
      for (const s of f.stmts) {
        if (s.k === "Import" && s.path === SCHED_IMPORT) {
          const path = schedSourcePath();
          pkg.deps.add(byDir.get(dirname(path)) ?? loadPackage(dirname(path), [{ path, text: SCHED_SOURCE }]));
          continue;
        }
        if (s.k !== "Import" || !isRelativeImport(s.path)) continue;
        const target = resolve(dir, s.path);
        let dep = byDir.get(target);
        if (!dep) {
          const paths = packageFiles(target, opts.overrides);
          if (!paths.length) {
            fail(new CompileError(`cannot find a package at '${s.path}' (no .odin or .vidar files in ${target})`, s.toks[s.pathTok].pos));
            continue;
          }
          dep = loadPackage(target, paths.map((p) => ({ path: p, text: read(p) })));
        }
        if (dep !== pkg) pkg.deps.add(dep);
      }
    }
    return pkg;
  }

  let root: PackageInfo;
  if (Array.isArray(entry)) root = loadPackage(dirname(resolve(entry[0].path)), entry);
  else {
    const path = resolve(entry);
    if (existsSync(path) && statSync(path).isDirectory()) {
      const paths = packageFiles(path, opts.overrides);
      if (!paths.length) throw new CompileError(`no .vidar or .odin files in ${path}`);
      root = loadPackage(path, paths.map((p) => ({ path: p, text: read(p) })));
    } else root = loadPackage(dirname(path), [{ path, text: read(path) }]);
  }

  const packages = [...byDir.values()];
  const units = groupCycles(root, packages);
  analyzer.resolveImport = (fromDir, path) => (path === SCHED_IMPORT ? byDir.get(dirname(schedSourcePath())) ?? null : isRelativeImport(path) ? byDir.get(resolve(fromDir, path)) ?? null : null);
  analyzer.run([preludePackage(analyzer), ...packages]);
  return { entry: root, packages, units, analyzer, sources, errors };
}

/**
 * The built-in library, declared straight into the scope every package scope inherits from, so
 * user declarations shadow it. It only holds comptime procs, so it's never emitted.
 */
function preludePackage(analyzer: Analyzer): PackageInfo {
  const file = new Parser(lex(PRELUDE_SOURCE, PRELUDE_PATH)).parseFile(PRELUDE_PATH);
  const unit: Unit = { name: "vidar_prelude", packages: [], outDir: RUNTIME_DIR, merged: false };
  const pkg: PackageInfo = { dir: PRELUDE_PATH, name: "vidar_prelude", files: [file], scope: analyzer.global, fileScopes: new Map(), prefix: "", unit, deps: new Set() };
  unit.packages.push(pkg);
  return pkg;
}

/** Tarjan's strongly connected components; each component becomes one emitted Odin package. */
function groupCycles(root: PackageInfo, packages: PackageInfo[]): Unit[] {
  const index = new Map<PackageInfo, number>();
  const low = new Map<PackageInfo, number>();
  const stack: PackageInfo[] = [];
  const onStack = new Set<PackageInfo>();
  const components: PackageInfo[][] = [];
  let next = 0;
  const visit = (p: PackageInfo) => {
    index.set(p, next);
    low.set(p, next++);
    stack.push(p);
    onStack.add(p);
    for (const d of p.deps) {
      if (!index.has(d)) {
        visit(d);
        low.set(p, Math.min(low.get(p)!, low.get(d)!));
      } else if (onStack.has(d)) low.set(p, Math.min(low.get(p)!, index.get(d)!));
    }
    if (low.get(p) === index.get(p)) {
      const comp: PackageInfo[] = [];
      let q: PackageInfo;
      do {
        q = stack.pop()!;
        onStack.delete(q);
        comp.push(q);
      } while (q !== p);
      components.push(comp);
    }
  };
  for (const p of packages) if (!index.has(p)) visit(p);

  const usedDirs = new Set<string>([RUNTIME_DIR]);
  const units: Unit[] = [];
  for (const comp of components) {
    comp.sort((a, b) => (a === root ? -1 : b === root ? 1 : a.name.localeCompare(b.name)));
    const merged = comp.length > 1;
    const hasRoot = comp.includes(root);
    const name = hasRoot ? root.name : comp.map((p) => p.name).join("_");
    let outDir = "";
    if (!hasRoot) {
      outDir = comp.some((p) => p.dir === dirname(schedSourcePath())) ? "vidar_sched" : name;
      for (let i = 2; usedDirs.has(outDir); i++) outDir = `${name}${i}`;
      usedDirs.add(outDir);
    }
    const unit: Unit = { name, packages: comp, outDir, merged };
    const prefixes = new Set<string>();
    for (const p of comp) {
      p.unit = unit;
      if (!merged || p === root) continue;
      let prefix = `${p.name}__`;
      for (let i = 2; prefixes.has(prefix); i++) prefix = `${p.name}${i}__`;
      prefixes.add(prefix);
      p.prefix = prefix;
    }
    units.push(unit);
  }
  return units.sort((a, b) => (a.outDir === "" ? -1 : b.outDir === "" ? 1 : a.outDir.localeCompare(b.outDir)));
}

export interface Output {
  /** output path (relative to the output root, '/'-separated) -> Odin source */
  files: Map<string, string>;
  /** output path -> the source file it was generated from */
  sourceOf: Map<string, string>;
  /** output path -> the source line of each output line (see `EmittedFile.lines`) */
  lineMap: Map<string, number[]>;
}

export function outputName(pkg: PackageInfo, f: File): string {
  const base = basename(f.path).replace(/\.vidar$/, ".odin");
  return posix.join(pkg.unit.outDir, pkg.unit.merged && pkg.prefix ? `${pkg.prefix}${base}` : base);
}

/** Generated Odin for an error-free program. */
export function emitProgram(p: Program): Output {
  const files = new Map<string, string>();
  const sourceOf = new Map<string, string>();
  const lineMap = new Map<string, number[]>();
  let closures = false;
  for (const unit of p.units) {
    const em = new Emitter(p.analyzer, unit);
    for (const pkg of unit.packages) {
      if (pkg.dir === dirname(schedSourcePath())) for (const [name, text] of SCHED_ASM) files.set(posix.join(unit.outDir, name), text);
      for (const f of pkg.files) {
        const name = outputName(pkg, f);
        const { text, lines } = em.emitFile(f, pkg);
        files.set(name, text);
        sourceOf.set(name, f.path);
        lineMap.set(name, lines);
      }
    }
    closures ||= em.usesRuntime;
  }
  if (closures) files.set(`${RUNTIME_DIR}/runtime.odin`, CLOSURE_RUNTIME);
  return { files, sourceOf, lineMap };
}

/** Transpiles in-memory sources forming one package (imports are not followed). */
export function transpile(sources: Source[]): Map<string, string> {
  return emitProgram(loadProgram(sources, { followImports: false })).files;
}

export { A };
