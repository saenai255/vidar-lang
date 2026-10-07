#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { Analyzer, posOf } from "./analyzer";
import { hotWarnings } from "./checks";
import { fmtMain } from "./format";
import { newMain } from "./scaffold";
import { CompileError } from "./lexer";
import { Output, Program, emitProgram, loadProgram, transpile } from "./project";
import { wantsWatch, watchCommand } from "./watch";
import { LineFilter, MAP_FILE, locationMapper, mapText, readRunMap, runMapOf } from "./runmap";

export { transpile };
export const EXT = ".vidar";

function formatError(err: CompileError, program: Program | undefined, kind = "error"): string {
  if (!err.pos) return `${kind}: ${err.message}`;
  const { file, line, col } = err.pos;
  const source = program?.sources.find((s) => s.path === file)?.text ?? (existsSync(file) ? readFileSync(file, "utf8") : "");
  const text = source.split("\n")[line - 1] ?? "";
  return `${file}:${line}:${col}: ${kind}: ${err.message}\n  ${text.replace(/\t/g, "    ")}\n  ${" ".repeat(Math.max(0, text.slice(0, col - 1).replace(/\t/g, "    ").length))}^`;
}

function usage(): never {
  console.error(`usage:
  vidar build <dir|file${EXT}> [-opt] [-o <out-dir>] [-debug] [-- odin flags]
                     transpile the program (default out dir: ./out/<name>) and write <out-dir>/vidar.map.json;
                     -debug also builds it with 'odin build -debug', next to the generated .odin
  vidar run   <dir|file${EXT}> [-opt] [-- args...]      transpile and 'odin run'
  vidar test  <dir|file${EXT}> [-opt] [--run <name>[,<name>...]] [-- odin flags]
                     transpile and 'odin test' the @(test) procs; --run runs only those tests
  vidar check <dir|file${EXT}> [-opt]                   transpile and 'odin check'
  vidar emit  <dir|file${EXT}> [-opt]                   print the generated Odin to stdout
  vidar map   <out-dir> < log                     rewrite generated .odin locations in a saved log to .vidar ones
  -opt-report in place of -opt also prints what -opt decided, where, and why
  --watch (run, check, test) reruns when a .vidar file of the program changes; --clear clears the screen first
  vidar fmt   <files|dirs> [--check|--write]        format .vidar files (default: print to stdout)
  vidar new   <dir> [--lib]                         start a program (or a library package with a test) in an empty dir
  -define:NAME=value is passed on to odin; run and test print panics, failed asserts and test
  messages at .vidar locations
  vidar lsp                                     run the language server on stdio (same as vidar-lsp)
  vidar --version

A directory is a package. Packages it imports by relative path are transpiled too;
packages that import each other in a cycle are merged into one Odin package.
-opt also rewrites plain Odin where that is provably the same program, only faster:
fmt calls with a literal format, bounds checks a loop already guarantees, and
allocations freed together. It also turns pure integer procs over bool, u8 or i8
that loop into lookup tables, and copies procs whose constant arguments bound a
loop into versions where they are compile-time, and procs passed closure literals
into copies that call them directly, and puts constant-size makes freed by a defer
on the stack, switches on 8 or more strings through a perfect hash, and memoizes pure
procs that call themselves more than once per call. @(no_table), @(no_specialize),
@(no_memo), @(no_stack_buffer) and @(no_perfect_hash) opt a proc out.
@(no_alloc) makes it an error for a proc to allocate; with -opt, @(hot) warns about
every -opt decision against something inside a proc.`);
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

export function main(argv: string[]): number | Promise<number> {
  if (argv[0] === "--version" || argv[0] === "-v") {
    console.log(`vidar ${version()}`);
    return 0;
  }
  if (argv[0] === "fmt") return fmtMain(argv.slice(1));
  if (argv[0] === "new") return newMain(argv.slice(1));
  const [cmd, input, ...args] = argv;
  if (cmd === "map" && input) return mapCommand(input);
  const end = args.indexOf("--");
  const flags = end < 0 ? args : args.slice(0, end);
  const tail = end < 0 ? [] : args.slice(end + 1);
  const report = flags.includes("-opt-report");
  const optimize = report || flags.includes("-opt");
  const debug = flags.includes("-debug");
  const valueOf = (flag: string) => (flags.includes(flag) ? flags[flags.indexOf(flag) + 1] : undefined);
  // -define:NAME=value goes to odin, for every command that runs it
  const defines = flags.filter((f) => f.startsWith("-define:"));
  if (!cmd || !input || !["build", "run", "check", "emit", "test"].includes(cmd)) usage();
  if (!existsSync(input)) {
    console.error(`error: ${input} does not exist`);
    return 1;
  }
  let program: Program | undefined;
  let out: Output;
  try {
    program = loadProgram(input, { optimize, race: defines.some((d) => /^-define:VIDAR_RACE=(true|1)$/.test(d)) });
    out = emitProgram(program);
    if (report) printReport(program.analyzer.hints);
    for (const w of hotWarnings(program.analyzer)) console.error(formatError(w, program, "warning"));
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
  const o = valueOf("-o");
  const outDir = cmd === "build" ? resolve(o ?? join("out", name)) : mkdtempSync(join(tmpdir(), "vidar-"));
  mkdirSync(outDir, { recursive: true });
  writeOutput(out, outDir);
  writeFileSync(join(outDir, MAP_FILE), JSON.stringify(runMapOf(out)) + "\n");
  const mapper = locationMapper(runMapOf(out), [outDir]);
  if (cmd === "build") {
    console.error(`wrote ${out.files.size} file(s) to ${outDir}`);
    if (!debug) return 0;
    // the generated .odin stays next to the binary, so the debugger can show it
    const binary = join(outDir, binaryName(name));
    const r = spawnSync("odin", ["build", outDir, "-debug", `-out:${binary}`, ...defines, ...tail], { encoding: "utf8", stdio: ["inherit", "inherit", "pipe"] });
    if (r.stderr) process.stderr.write(mapper(r.stderr));
    if (r.status === 0) console.error(`built ${binary} with debug info`);
    return r.status ?? 1;
  }
  if (cmd === "check") {
    const r = spawnSync("odin", ["check", outDir, ...defines], { encoding: "utf8", stdio: ["inherit", "inherit", "pipe"] });
    if (r.stderr) process.stderr.write(mapper(r.stderr));
    return r.status ?? 1;
  }
  if (cmd === "run") {
    const odinArgs = ["run", outDir, `-out:${join(outDir, binaryName(name))}`, ...defines, ...(tail.length ? ["--", ...tail] : [])];
    return runMapped(odinArgs, mapper, false);
  }
  // test: `--run a,b` is ODIN_TEST_NAMES with the package filled in
  const names = valueOf("--run");
  const pkg = [...out.files].find(([f]) => !f.includes("/"))?.[1].match(/^\s*package\s+(\w+)/m)?.[1] ?? "main";
  const select = names ? [`-define:ODIN_TEST_NAMES=${names.split(",").map((n) => (n.includes(".") ? n : `${pkg}.${n}`)).join(",")}`] : [];
  return runMapped(["test", outDir, `-out:${join(outDir, binaryName(name))}`, ...defines, ...select, ...tail], mapper, true);
}

/** Runs odin with its stderr (and stdout, for `odin test`) rewritten line by line to .vidar locations. */
function runMapped(odinArgs: string[], mapper: (line: string) => string, mapStdout: boolean): Promise<number> {
  return new Promise((done) => {
    const child = spawn("odin", odinArgs, { stdio: ["inherit", mapStdout ? "pipe" : "inherit", "pipe"] });
    const filters: LineFilter[] = [];
    const pipe = (stream: NodeJS.ReadableStream | null, to: NodeJS.WriteStream) => {
      if (!stream) return;
      const f = new LineFilter(mapper, (text) => to.write(text));
      filters.push(f);
      stream.setEncoding("utf8");
      stream.on("data", (d: string) => f.push(d));
    };
    pipe(child.stdout, process.stdout);
    pipe(child.stderr, process.stderr);
    // Ctrl-C reaches the program too; wait for it to exit and report its status
    const ignore = () => {};
    process.on("SIGINT", ignore);
    child.on("error", (err) => {
      process.off("SIGINT", ignore);
      console.error(`error: could not run odin: ${err.message}`);
      done(1);
    });
    child.on("close", (code, signal) => {
      process.off("SIGINT", ignore);
      for (const f of filters) f.end();
      done(code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 1));
    });
  });
}

/** `vidar map <out>`: rewrites a saved log on stdin to .vidar locations, using `<out>/vidar.map.json`. */
function mapCommand(dir: string): Promise<number> {
  let mapper: (line: string) => string;
  try {
    mapper = locationMapper(readRunMap(dir), [dir]);
  } catch (err) {
    console.error(`error: ${(err as Error).message}`);
    return Promise.resolve(1);
  }
  const f = new LineFilter(mapper, (text) => process.stdout.write(text));
  return new Promise((done) => {
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d: string) => f.push(d));
    process.stdin.on("end", () => (f.end(), done(0)));
  });
}

function printReport(hints: Analyzer["hints"]): void {
  const notes = (hints ?? []).map((h) => ({ ...h, pos: posOf(h.at) }));
  const sorted = notes.sort((a, b) => a.pos.file.localeCompare(b.pos.file) || a.pos.line - b.pos.line || a.pos.col - b.pos.col);
  if (!sorted.length) console.error("-opt: nothing to report");
  for (const n of sorted) console.error(`${relative(process.cwd(), n.pos.file)}:${n.pos.line}: ${n.name ? n.name + ": " : ""}${n.label}${n.tooltip ? ": " + n.tooltip : ""}`);
}

/** The program's file name: Windows wants the `.exe`. */
export function binaryName(name: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? `${name}.exe` : name;
}

/** Points `file.odin(line:col)` locations in Odin's output at the .vidar files and lines they came from. */
export function mapLocations(text: string, out: Output, root: string): string {
  return mapText(text, runMapOf(out), [root]);
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (wantsWatch(argv)) watchCommand(argv, [process.execPath, __filename]);
  else {
    const code = main(argv);
    // a pipe may still be writing out the program's output: let it drain instead of exiting at once
    if (typeof code === "number") process.exit(code);
    else code.then((c) => (process.exitCode = c));
  }
}
