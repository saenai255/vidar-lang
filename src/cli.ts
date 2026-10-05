#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
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
  vidar build <dir|file${EXT}> [-o <out-dir>]    transpile the program (default out dir: ./out/<name>)
  vidar run   <dir|file${EXT}> [-- args...]      transpile and 'odin run'
  vidar check <dir|file${EXT}>                   transpile and 'odin check'
  vidar emit  <dir|file${EXT}>                   print the generated Odin to stdout
  vidar lsp                                     run the language server on stdio (same as vidar-lsp)
  vidar --version

A directory is a package. Packages it imports by relative path are transpiled too;
packages that import each other in a cycle are merged into one Odin package.`);
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
  const [cmd, input, ...rest] = argv;
  if (!cmd || !input || !["build", "run", "check", "emit"].includes(cmd)) usage();
  if (!existsSync(input)) {
    console.error(`error: ${input} does not exist`);
    return 1;
  }
  let program: Program | undefined;
  let out: Output;
  try {
    program = loadProgram(input);
    out = emitProgram(program);
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
    // generated files keep their source's line numbers, so point Odin's errors at the .vidar files
    let msg = r.stderr;
    const real = realpathSync(outDir);
    for (const [gen, src] of out.sourceOf) msg = msg.split(join(real, gen)).join(src);
    process.stderr.write(msg);
  }
  return r.status ?? 1;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
