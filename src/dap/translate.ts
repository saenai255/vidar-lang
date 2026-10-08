// Positions in a debug session, in the generated Odin and in the .vidar source they came from.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import * as nodePath from "node:path";
import { pathKey } from "../paths";
import { RunMap, generatedLine, locationMapper, sourceLine } from "../runmap";

export interface MappedFile {
  source: string;
  gen: string;
  lines: number[];
  text: string[];
}

export interface PendingBreakpoints {
  file: MappedFile;
  /** the lines the client asked for */
  requested: number[];
  /** for each breakpoint sent on, its index in `requested` */
  sent: number[];
}

const canon = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return nodePath.resolve(p);
  }
};
const key = (p: string) => pathKey(canon(p));

export class DapMap {
  private readonly bySource = new Map<string, MappedFile>();
  private readonly byGen = new Map<string, MappedFile>();
  readonly mapOutput: (text: string) => string;

  constructor(readonly outDir: string, map: RunMap) {
    for (const [rel, e] of Object.entries(map.files)) {
      const gen = nodePath.join(outDir, rel);
      const text = existsSync(gen) ? readFileSync(gen, "utf8").split("\n") : [];
      const file = { source: e.source, gen, lines: e.lines, text };
      this.bySource.set(key(e.source), file);
      this.byGen.set(key(gen), file);
    }
    this.mapOutput = locationMapper(map, [outDir]);
  }

  forSource(path: string | undefined): MappedFile | undefined {
    return path ? this.bySource.get(key(path)) : undefined;
  }

  forGen(path: string | undefined): MappedFile | undefined {
    return path ? this.byGen.get(key(path)) : undefined;
  }

  /** `setBreakpoints` arguments for a .vidar file, rewritten for the generated one; lines with no code are left out. */
  setBreakpoints(args: any): { args: any; pending?: PendingBreakpoints } {
    const file = this.forSource(args?.source?.path);
    if (!file) return { args };
    const asked: any[] = args.breakpoints ?? (args.lines ?? []).map((line: number) => ({ line }));
    const requested = asked.map((b) => b.line as number);
    const sent: number[] = [];
    const breakpoints: any[] = [];
    asked.forEach((b, i) => {
      const line = generatedLine(file.lines, b.line, file.text);
      if (!line) return;
      sent.push(i);
      breakpoints.push({ ...b, line, column: undefined });
    });
    const source = { name: nodePath.basename(file.gen), path: file.gen };
    return { args: { ...args, source, breakpoints, lines: undefined, sourceModified: undefined }, pending: { file, requested, sent } };
  }

  /** The answer to such a request, in terms of the lines the client asked for. */
  breakpointsResponse(pending: PendingBreakpoints, body: any): any {
    const got: any[] = body?.breakpoints ?? [];
    const out = pending.requested.map((line): any => ({ verified: false, line, message: "no code is generated for this line" }));
    pending.sent.forEach((at, i) => {
      if (got[i]) out[at] = this.breakpoint(got[i], pending.requested[at]);
    });
    return { ...body, breakpoints: out };
  }

  /** A breakpoint the debugger reports, moved to the .vidar line (`fallback` if it has none). */
  breakpoint(bp: any, fallback?: number): any {
    const file = this.forGen(bp.source?.path);
    if (!file) return bp;
    const line = bp.line ? sourceLine(file.lines, bp.line) || fallback : fallback;
    return { ...bp, source: sourceOf(file), line, column: undefined, endLine: undefined, endColumn: undefined };
  }

  frames(frames: any[]): any[] {
    return frames.map((f) => {
      const file = this.forGen(f.source?.path);
      if (!file) return f;
      f = { ...f, name: f.name?.replace(/^_proclit\$anon-\d+$/, "closure") };
      const line = sourceLine(file.lines, f.line);
      // generated code with no source line is shown dimmed, as the debugger gave it
      if (!line) return { ...f, presentationHint: "subtle" };
      return { ...f, source: sourceOf(file), line, column: 1, endLine: undefined, endColumn: undefined };
    });
  }

  /** After a step stopped in `frame`: keep going (`next`/`stepIn`/`stepOut`), or null to stop here. */
  keepStepping(frame: any, command: string, justMyCode: boolean): "next" | "stepIn" | "stepOut" | null {
    const file = this.forGen(frame?.source?.path);
    if (file) return sourceLine(file.lines, frame.line) ? null : command === "stepIn" ? "stepIn" : "next";
    // stepped into code that isn't the user's (Odin's core, the runtime): back out
    return justMyCode && command === "stepIn" && frame?.source?.path ? "stepOut" : null;
  }
}

function sourceOf(file: MappedFile) {
  return { name: nodePath.basename(file.source), path: file.source };
}
