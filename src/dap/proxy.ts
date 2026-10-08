// `vidar dap`: a debug adapter for .vidar programs. It sits between the editor and lldb-dap, builds
// the program with `vidar build -debug` on launch, and rewrites positions both ways, so breakpoints
// and stack frames are on .vidar lines rather than lines of the generated Odin.
import { ChildProcess, spawn, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { readRunMap } from "../runmap";
import { DapMap, PendingBreakpoints } from "./translate";
import { DapMessage, MessageReader, frame } from "./wire";

const USAGE = `usage:
  vidar dap [--backend <lldb-dap>]

a debug adapter on stdin/stdout. The launch request takes
  program    a .vidar file or package directory (built with 'vidar build -debug')
  args, cwd, env, stopOnEntry    as lldb-dap's launch request
  opt, odinFlags, outDir         how to build; outDir defaults to out/<name>-debug
the backend is lldb-dap (or lldb-vscode) from PATH, Xcode or LLVM, unless --backend or
VIDAR_DAP_BACKEND names one.`;

export function findBackend(): string | undefined {
  const named = process.env.VIDAR_DAP_BACKEND;
  if (named) return named;
  for (const name of ["lldb-dap", "lldb-vscode"]) {
    if (spawnSync(name, ["--help"], { stdio: "ignore" }).error === undefined) return name;
    if (process.platform === "darwin") {
      const r = spawnSync("xcrun", ["-f", name], { encoding: "utf8" });
      if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
    }
  }
  return undefined;
}

export function dapMain(argv: string[], self: string[]): Promise<number> {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.error(USAGE);
    return Promise.resolve(0);
  }
  const at = argv.indexOf("--backend");
  const backend = (at >= 0 ? argv[at + 1] : undefined) ?? findBackend();
  if (!backend) {
    console.error("error: no lldb-dap found; install LLVM's lldb-dap or Xcode's command line tools, or pass --backend <path>");
    return Promise.resolve(1);
  }
  return new Promise((done) => {
    const child = spawn(backend, [], { stdio: ["pipe", "pipe", "inherit"] });
    child.on("error", (err) => {
      console.error(`error: could not run ${backend}: ${err.message}`);
      done(1);
    });
    const proxy = new Proxy(child, self);
    child.on("exit", (code) => done(code ?? 0));
    process.stdin.on("data", (d: Buffer) => proxy.fromClientBytes(d));
    process.stdin.on("end", () => child.kill());
  });
}

// the debugger numbers its own messages; ours start far above
const SERVER_SEQ = 2_000_000;

export class Proxy {
  private map?: DapMap;
  private readonly fromClient = new MessageReader((m) => (this.clientQueue = this.clientQueue.then(() => this.handleClient(m))));
  private readonly fromBackend = new MessageReader((m) => this.backendMessage(m));
  private clientQueue: Promise<void> = Promise.resolve();
  private backendQueue: Promise<void> = Promise.resolve();
  private breakpoints = new Map<number, PendingBreakpoints>();
  private serverSeq = 0;

  constructor(private readonly backend: ChildProcess, private readonly self: string[]) {
    backend.stdout!.on("data", (d: Buffer) => this.fromBackend.push(d));
  }

  fromClientBytes(d: Buffer): void {
    this.fromClient.push(d);
  }

  private toBackend(m: DapMessage): void {
    this.backend.stdin!.write(frame(m));
  }

  private toClient(m: DapMessage): void {
    process.stdout.write(frame(m));
  }

  private event(event: string, body?: any): void {
    this.toClient({ seq: ++this.serverSeq + SERVER_SEQ, type: "event", event, body });
  }

  private reply(req: DapMessage, fields: Partial<DapMessage>): void {
    this.toClient({ seq: ++this.serverSeq + SERVER_SEQ, type: "response", request_seq: req.seq, command: req.command, success: true, ...fields });
  }

  // ---- editor -> debugger ----

  private async handleClient(m: DapMessage): Promise<void> {
    if (m.type !== "request") return this.toBackend(m);
    switch (m.command) {
      case "launch":
        return this.launch(m);
      case "attach":
        return this.reply(m, { success: false, message: "vidar debugs programs it builds: use a launch request" });
      case "setBreakpoints": {
        if (!this.map) break;
        const { args, pending } = this.map.setBreakpoints(m.arguments);
        if (pending) this.breakpoints.set(m.seq, pending);
        return this.toBackend({ ...m, arguments: args });
      }
    }
    this.toBackend(m);
  }

  private async launch(m: DapMessage): Promise<void> {
    const a = m.arguments ?? {};
    if (!a.program) return this.reply(m, { success: false, message: "launch needs `program`: a .vidar file or package directory" });
    const cwd = resolve(a.cwd ?? process.cwd());
    const input = resolve(cwd, a.program);
    const name = input.replace(/[\\/]+$/, "").split(/[\\/]/).pop()!.replace(/\.vidar$/, "");
    const outDir = a.outDir ? resolve(cwd, a.outDir) : join(cwd, "out", `${name}-debug`);
    const flags: string[] = a.odinFlags ?? [];
    const build = await run(this.self[0], [...this.self.slice(1), "build", input, "-debug", "-o", outDir, ...(a.opt ? ["-opt"] : []), ...(flags.length ? ["--", ...flags] : [])]);
    if (build.status !== 0) {
      this.event("output", { category: "stderr", output: build.stderr });
      return this.reply(m, { success: false, message: `vidar build -debug failed (exit ${build.status})` });
    }
    const binary = /^built (.+) with debug info$/m.exec(build.stderr)?.[1];
    if (!binary) return this.reply(m, { success: false, message: "vidar build -debug did not report a binary" });
    this.map = new DapMap(outDir, readRunMap(outDir));
    const { opt, odinFlags, outDir: _out, ...rest } = a;
    this.toBackend({ ...m, arguments: { ...rest, program: binary, cwd: a.cwd ?? dirname(input) } });
  }

  // ---- debugger -> editor ----

  private backendMessage(m: DapMessage): void {
    this.backendQueue = this.backendQueue.then(() => this.handleBackend(m));
  }

  private async handleBackend(m: DapMessage): Promise<void> {
    const map = this.map;
    if (map && m.type === "response" && m.success) {
      if (m.command === "setBreakpoints") {
        const pending = this.breakpoints.get(m.request_seq!);
        this.breakpoints.delete(m.request_seq!);
        if (pending) m = { ...m, body: map.breakpointsResponse(pending, m.body) };
      } else if (m.command === "stackTrace" && m.body?.stackFrames) {
        m = { ...m, body: { ...m.body, stackFrames: map.frames(m.body.stackFrames) } };
      }
    } else if (map && m.type === "event") {
      if (m.event === "output" && typeof m.body?.output === "string") m = { ...m, body: { ...m.body, output: map.mapOutput(m.body.output) } };
      else if (m.event === "breakpoint" && m.body?.breakpoint) m = { ...m, body: { ...m.body, breakpoint: map.breakpoint(m.body.breakpoint) } };
    }
    this.toClient(m);
  }
}

function run(cmd: string, args: string[]): Promise<{ status: number | null; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d: string) => (stderr += d));
    child.on("error", (err) => done({ status: 1, stderr: `${stderr}could not run ${cmd}: ${err.message}\n` }));
    child.on("close", (status) => done({ status, stderr }));
  });
}
