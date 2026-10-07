import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { KEYWORDS } from "./lexer";

/** `vidar new <dir> [--lib]`: a new program (hello world) or library package (with a test) in an empty directory. */

/** A package name from a directory name: an Odin identifier, lower case. */
export function packageName(dir: string): string {
  const name = basename(resolve(dir))
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!name) return "app";
  if (/^[0-9]/.test(name)) return `pkg_${name}`;
  return KEYWORDS.has(name) ? `${name}_pkg` : name;
}

/** The files of a new project, by path relative to its directory. */
export function scaffold(dir: string, lib: boolean): Map<string, string> {
  const name = packageName(dir);
  const files = new Map<string, string>();
  files.set("main.vidar", lib ? libSource(name) : mainSource(name));
  files.set(".gitignore", "out/\n");
  const launch = {
    version: "0.2.0",
    configurations: [{ type: "vidar", request: "launch", name: `Debug ${name}`, program: "${workspaceFolder}", args: [] }],
  };
  files.set(join(".vscode", "launch.json"), JSON.stringify(launch, null, 2) + "\n");
  files.set("README.md", readme(name, lib));
  return files;
}

function mainSource(name: string): string {
  return `package main

import "core:fmt"

main :: proc() {
	name := "${name}"
	greet := proc[name](greeting: string) { fmt.printfln("%s from %s!", greeting, name) }
	greet("Hello")
}
`;
}

function libSource(name: string): string {
  return `package ${name}

import "core:testing"

// Adds up what \`f\` gives for each value of \`xs\`.
sum_by :: proc(xs: []int, f: closure(x: int) -> int) -> int {
	total := 0
	for x in xs do total += f(x)
	return total
}

@(test)
sum_by_scales :: proc(t: ^testing.T) {
	scale := 10
	got := sum_by([]int{1, 2, 3}, proc[scale](x: int) -> int { return x * scale })
	testing.expect_value(t, got, 60)
}
`;
}

function readme(name: string, lib: boolean): string {
  const commands = lib
    ? ["vidar test .     # run the @(test) procs", "vidar check .    # transpile and odin check"]
    : ["vidar run .      # transpile and odin run", "vidar test .     # run the @(test) procs", `vidar build . -o out/${name}    # write the generated Odin`];
  const lines = [`# ${name}`, "", `A [Vidar](https://github.com/saenai255/vidar-lang) ${lib ? "library package" : "program"}.`, "", "```bash", ...commands, "```"];
  if (!lib) lines.push("", "In VS Code with the Vidar extension, F5 builds it with `vidar build -debug` and starts the debugger (`.vscode/launch.json`).");
  return lines.join("\n") + "\n";
}

export function newMain(args: string[]): number {
  const lib = args.includes("--lib");
  const rest = args.filter((a) => a !== "--lib");
  if (rest.length !== 1 || rest[0].startsWith("-")) {
    console.error("usage: vidar new <dir> [--lib]");
    return 2;
  }
  const dir = rest[0];
  if (existsSync(dir)) {
    if (!statSync(dir).isDirectory()) {
      console.error(`error: ${dir} exists and is not a directory`);
      return 1;
    }
    if (readdirSync(dir).length) {
      console.error(`error: ${dir} is not empty`);
      return 1;
    }
  }
  const files = scaffold(dir, lib);
  for (const [file, text] of files) {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  console.log(`created ${lib ? "library" : "program"} ${packageName(dir)} in ${dir}: ${[...files.keys()].join(", ")}`);
  console.log(lib ? `next: vidar test ${dir}` : `next: vidar run ${dir}`);
  return 0;
}
