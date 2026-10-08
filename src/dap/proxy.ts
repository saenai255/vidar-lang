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
// requests the adapter makes itself are numbered from here, so their answers aren't passed on
const INTERNAL_SEQ = 1_000_000;
// most steps taken on one step request to get past generated code
const MAX_AUTO_STEPS = 50;

export class Proxy {
  private map?: DapMap;
  private readonly fromClient = new MessageReader((m) => (this.clientQueue = this.clientQueue.then(() => this.handleClient(m))));
  private readonly fromBackend = new MessageReader((m) => this.backendMessage(m));
  private clientQueue: Promise<void> = Promise.resolve();
  private backendQueue: Promise<void> = Promise.resolve();
  private breakpoints = new Map<number, PendingBreakpoints>();
  private internal = new Map<number, (m: DapMessage) => void>();
  private nextInternal = INTERNAL_SEQ;
  private serverSeq = 0;
  private evaluates = new Map<number, any>();
  private lastStep?: { command: string; args: any };
  private autoSteps = 0;
  private justMyCode = true;

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

  private ask(command: string, args: any): Promise<DapMessage | undefined> {
    return new Promise((done) => {
      const seq = this.nextInternal++;
      const timer = setTimeout(() => (this.internal.delete(seq), done(undefined)), 10_000);
      this.internal.set(seq, (m) => (clearTimeout(timer), done(m.success ? m : undefined)));
      this.toBackend({ seq, type: "request", command, arguments: args });
    });
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
      case "evaluate":
        this.evaluates.set(m.seq, m.arguments);
        break;
      case "next":
      case "stepIn":
      case "stepOut":
        this.lastStep = { command: m.command, args: m.arguments };
        this.autoSteps = 0;
        break;
      case "continue":
      case "pause":
        this.lastStep = undefined;
        break;
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
    this.justMyCode = a.justMyCode !== false;
    const { opt, odinFlags, outDir: _out, justMyCode: _jmc, ...rest } = a;
    this.toBackend({ ...m, arguments: { ...rest, program: binary, cwd: a.cwd ?? dirname(input) } });
  }

  // ---- debugger -> editor ----

  private backendMessage(m: DapMessage): void {
    const answer = m.type === "response" && m.request_seq !== undefined ? this.internal.get(m.request_seq) : undefined;
    if (answer) {
      this.internal.delete(m.request_seq!);
      return answer(m);
    }
    if (m.type === "response" && m.request_seq! >= INTERNAL_SEQ) return;
    this.backendQueue = this.backendQueue.then(() => this.handleBackend(m));
  }

  private async handleBackend(m: DapMessage): Promise<void> {
    const map = this.map;
    if (map && m.type === "response" && m.command === "evaluate") {
      m = await this.evaluateCaptured(m);
    } else if (map && m.type === "response" && m.success) {
      if (m.command === "setBreakpoints") {
        const pending = this.breakpoints.get(m.request_seq!);
        this.breakpoints.delete(m.request_seq!);
        if (pending) m = { ...m, body: map.breakpointsResponse(pending, m.body) };
      } else if (m.command === "stackTrace" && m.body?.stackFrames) {
        m = { ...m, body: { ...m.body, stackFrames: map.frames(m.body.stackFrames) } };
      } else if (m.command === "variables" && Array.isArray(m.body?.variables)) {
        m = { ...m, body: { ...m.body, variables: await this.withCaptures(m.body.variables) } };
      }
    } else if (map && m.type === "event") {
      if (m.event === "output" && typeof m.body?.output === "string") m = { ...m, body: { ...m.body, output: map.mapOutput(m.body.output) } };
      else if (m.event === "breakpoint" && m.body?.breakpoint) m = { ...m, body: { ...m.body, breakpoint: map.breakpoint(m.body.breakpoint) } };
      else if (m.event === "stopped" && (await this.stepOn(map, m.body))) return;
    }
    this.toClient(m);
  }

  /** A closure's `__env` and its padding give way to the variables it captured. */
  private async withCaptures(vars: any[]): Promise<any[]> {
    const out: any[] = [];
    for (const v of vars) {
      if (v.name === "__env_raw") continue;
      if (v.name === "__env" && v.variablesReference > 0) out.push(...(await this.captures(v.variablesReference)));
      else out.push(v);
    }
    return out;
  }

  private async captures(reference: number, depth = 0): Promise<any[]> {
    const kids: any[] = (await this.ask("variables", { variablesReference: reference }))?.body?.variables ?? [];
    const out: any[] = [];
    for (const k of kids) {
      if (k.name === "__pad") continue;
      if (k.name === "__caps" && k.variablesReference > 0 && depth < 2) out.push(...(await this.captures(k.variablesReference, depth + 1)));
      else out.push(k);
    }
    return out;
  }

  /** `n` inside a closure is `__env.__caps.n` to the debugger: a failed watch or hover is retried that way. */
  private async evaluateCaptured(m: DapMessage): Promise<DapMessage> {
    const args = this.evaluates.get(m.request_seq!);
    this.evaluates.delete(m.request_seq!);
    if (m.success || !args?.frameId || args.context === "repl") return m;
    const scopes: any[] = (await this.ask("scopes", { frameId: args.frameId }))?.body?.scopes ?? [];
    const locals = scopes[0] && (await this.ask("variables", { variablesReference: scopes[0].variablesReference }))?.body?.variables;
    const env = locals?.find((v: any) => v.name === "__env");
    if (!env?.variablesReference) return m;
    const names = new Set((await this.captures(env.variablesReference)).map((c) => c.name as string));
    // whole identifiers that aren't fields (`a.b`) and aren't in strings
    const rewritten = (args.expression as string).replace(/(?<![\w.$"'])[A-Za-z_]\w*/g, (id) => (names.has(id) ? `__env.__caps.${id}` : id));
    if (rewritten === args.expression) return m;
    const retry = await this.ask("evaluate", { ...args, expression: rewritten });
    return retry ? { ...m, success: true, message: undefined, body: retry.body } : m;
  }

  /** A step ended on generated code with no source line (or inside Odin's own code): steps again, and says whether it did. */
  private async stepOn(map: DapMap, stop: any): Promise<boolean> {
    const step = this.lastStep;
    if (stop?.reason !== "step" || !step || this.autoSteps >= MAX_AUTO_STEPS) return false;
    const top = (await this.ask("stackTrace", { threadId: stop.threadId, startFrame: 0, levels: 1 }))?.body?.stackFrames?.[0];
    const command = top && map.keepStepping(top, step.command, this.justMyCode);
    if (!command) return false;
    this.autoSteps++;
    this.toBackend({ seq: this.nextInternal++, type: "request", command, arguments: { threadId: stop.threadId, singleThread: step.args?.singleThread } });
    return true;
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
