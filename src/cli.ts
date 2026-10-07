#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Analyzer, posOf } from "./analyzer";
import { CompileError } from "./lexer";
import { Output, Program, emitProgram, loadProgram, transpile } from "./project";

export { transpile };
export const EXT = ".vidar";

function formatError(err: CompileError, program: Program | undefined): string {
  if (!err.pos) return `error: ${err.message}`;
  const { file, line, col } = err.pos;
  const source = program?.sources.find((s) => s.path === file)?.text ?? (existsSync(file) ? readFileSync(file, "utf8") : "");
  const text = source.split("\n")[line - 1] ?? "";
  return `${file}:${line}:${col}: error: ${err.message}\n  ${text.replace(/\t/g, "    ")}\n  ${" ".repeat(Math.max(0, text.slice(0, col - 1).replace(/\t/g, "    ").length))}^`;
}

function usage(): never {
  console.error(`usage:
  vidar build <dir|file${EXT}> [-opt] [-o <out-dir>]    transpile the program (default out dir: ./out/<name>)
  vidar run   <dir|file${EXT}> [-opt] [-- args...]      transpile and 'odin run'
  vidar check <dir|file${EXT}> [-opt]                   transpile and 'odin check'
  vidar emit  <dir|file${EXT}> [-opt]                   print the generated Odin to stdout
  -opt-report in place of -opt also prints what -opt decided, where, and why
  vidar lsp                                     run the language server on stdio (same as vidar-lsp)
  vidar --version

A directory is a package. Packages it imports by relative path are transpiled too;
packages that import each other in a cycle are merged into one Odin package.
-opt also rewrites plain Odin where that is provably the same program, only faster:
fmt calls with a literal format, bounds checks a loop already guarantees, and
allocations freed together. It also turns pure integer procs over bool, u8 or i8
that loop into lookup tables, and copies procs whose constant arguments bound a
loop into versions where they are compile-time, and procs passed closure literals
into copies that call them directly. @(no_table) and @(no_specialize) opt a proc out.`);
  process.exit(2);
}

export function writeOutput(out: Output, dir: string): void {
  for (const [file, text] of out.files) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
}

declare const VIDAR_VERSION: string | undefined;

export function version(): string {
  if (typeof VIDAR_VERSION === "string") return VIDAR_VERSION;
  try {
    return (require("../package.json") as { version: string }).version;
  } catch {
    return "dev";
  }
}

export function main(argv: string[]): number {
  if (argv[0] === "--version" || argv[0] === "-v") {
    console.log(`vidar ${version()}`);
    return 0;
  }
  const [cmd, input, ...args] = argv;
  const end = args.indexOf("--");
  const flags = args.slice(0, end < 0 ? args.length : end);
  const report = flags.includes("-opt-report");
  const optimize = report || flags.includes("-opt");
  const rest = args.filter((a, i) => (a !== "-opt" && a !== "-opt-report") || (end >= 0 && i > end));
  if (!cmd || !input || !["build", "run", "check", "emit"].includes(cmd)) usage();
  if (!existsSync(input)) {
    console.error(`error: ${input} does not exist`);
    return 1;
  }
  let program: Program | undefined;
  let out: Output;
  try {
    program = loadProgram(input, { optimize, report });
    out = emitProgram(program);
    if (report) printReport(program.analyzer.hints);
  } catch (err) {
    if (err instanceof CompileError) {
      console.error(formatError(err, program));
      return 1;
    }
    throw err;
  }
  if (cmd === "emit") {
    for (const [name, text] of out.files) process.stdout.write(out.files.size > 1 ? `// ==== ${name} ====\n${text}\n` : text);
    return 0;
  }
  const name = basename(resolve(input)).replace(/\.vidar$/, "");
  const oi = rest.indexOf("-o");
  const outDir = cmd === "build" ? resolve(oi >= 0 ? rest[oi + 1] : join("out", name)) : mkdtempSync(join(tmpdir(), "vidar-"));
  mkdirSync(outDir, { recursive: true });
  writeOutput(out, outDir);
  if (cmd === "build") {
    console.error(`wrote ${out.files.size} file(s) to ${outDir}`);
    return 0;
  }
  const dd = rest.indexOf("--");
  const progArgs = dd >= 0 ? rest.slice(dd + 1) : [];
  const odinArgs = cmd === "run" ? ["run", outDir, `-out:${join(outDir, name)}`, ...(progArgs.length ? ["--", ...progArgs] : [])] : ["check", outDir];
  const r = spawnSync("odin", odinArgs, { encoding: "utf8", stdio: ["inherit", "inherit", "pipe"] });
  if (r.stderr) {
    process.stderr.write(mapLocations(r.stderr, out, realpathSync(outDir)));
  }
  return r.status ?? 1;
}

function printReport(hints: Analyzer["hints"]): void {
  const notes = (hints ?? []).map((h) => ({ ...h, pos: posOf(h.at) }));
  const sorted = notes.sort((a, b) => a.pos.file.localeCompare(b.pos.file) || a.pos.line - b.pos.line || a.pos.col - b.pos.col);
  if (!sorted.length) console.error("-opt: nothing to report");
  for (const n of sorted) console.error(`${relative(process.cwd(), n.pos.file)}:${n.pos.line}: ${n.name ? n.name + ": " : ""}${n.label}${n.tooltip ? ": " + n.tooltip : ""}`);
}

/** Points `file.odin(line:col)` locations in Odin's output at the .vidar files and lines they came from. */
export function mapLocations(text: string, out: Output, root: string): string {
  for (const [gen, src] of out.sourceOf) {
    const path = join(root, gen);
    const lines = out.lineMap.get(gen) ?? [];
    text = text.split(path).map((part, i) => (i ? part.replace(/^\((\d+):(\d+)\)/, (m, l, c) => (lines[l - 1] ? `(${Math.abs(lines[l - 1])}:${c})` : m)) : part)).join(src);
  }
  return text;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
