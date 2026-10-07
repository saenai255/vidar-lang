import type { Token } from "../lexer";
import { Node, Stmt, children } from "../ast";
import { A } from "../analyzer";
import { type Output, type Program, emitProgram, outputName } from "../project";
import type { Position, Range } from "./features";

/** What `vidar/expandAt` answers: the Odin for the statement at a position, and that statement's source range. */
export interface Expansion {
  code: string;
  range: Range;
}

/** Generated helpers (closure procs, interface dispatchers, ...) pulled in after the statement, by depth of reference. */
const HELPER_DEPTH = 2;
const HELPER_LIMIT = 12;

const outputs = new WeakMap<Program, Output>();

function emitted(a: Program): Output {
  let out = outputs.get(a);
  if (!out) outputs.set(a, (out = emitProgram(a)));
  return out;
}

/** Source lines (1-based) a statement's own tokens span in `file`. */
function linesOf(n: Node, file: string): { first: number; last: number; start: Token; end: Token } | undefined {
  const toks = n.toks.slice(n.start, n.end).filter((t) => t.pos.file === file && t.text !== "");
  if (!toks.length) return undefined;
  return { first: toks[0].pos.line, last: toks[toks.length - 1].pos.line, start: toks[0], end: toks[toks.length - 1] };
}

/** Statements whose lines hold `p`, outermost first; on a line with several, the one under the cursor. */
function statementsAt(stmts: Stmt[], file: string, p: Position): Stmt[] {
  const line = p.line + 1;
  const path: Stmt[] = [];
  const pick = (list: Stmt[]): Stmt | undefined => {
    const hits = list.filter((s) => {
      const r = linesOf(s, file);
      return r && r.first <= line && line <= r.last;
    });
    const col = p.character + 1;
    return hits.find((s) => {
      const r = linesOf(s, file)!;
      return (r.first < line || r.start.pos.col <= col) && (r.last > line || r.end.pos.col + r.end.text.length >= col);
    }) ?? hits[0];
  };
  /** statement lists below `n`: blocks and case bodies, through expressions and parsed macro arguments */
  const lists = (n: Node): Stmt[][] => {
    const out: Stmt[][] = [];
    const visit = (x: Node) => {
      if (x.k === "Block") return void out.push(x.stmts);
      if (x.k === "Case") return void out.push(x.body);
      for (const c of [...children(x), ...((A(x)._argNodes as Node[] | undefined) ?? [])]) visit(c);
    };
    for (const c of [...children(n), ...((A(n)._argNodes as Node[] | undefined) ?? [])]) visit(c);
    return out;
  };
  let level: Stmt[][] = [stmts];
  for (;;) {
    let hit: Stmt | undefined;
    for (const l of level) if ((hit = pick(l))) break;
    if (!hit) return path;
    path.push(hit);
    level = lists(hit);
  }
}

interface Helper {
  name: string;
  lines: string[];
}

/** Code vidar appends to each output file (source line 0), cut into its declarations at blank lines. */
function helpers(out: Output): Map<string, Helper> {
  const found = new Map<string, Helper>();
  for (const [name, text] of out.files) {
    const map = out.lineMap.get(name);
    if (!map) continue;
    let chunk: string[] = [];
    const flush = () => {
      const decl = chunk.map((l) => /^(__\w+)\s*:[:=]/.exec(l)?.[1]).find(Boolean);
      if (decl && !found.has(decl)) found.set(decl, { name: decl, lines: chunk });
      chunk = [];
    };
    text.split("\n").forEach((l, i) => {
      if (map[i] !== 0) return;
      if (l.trim() === "") flush();
      else if (!l.startsWith("// ----")) chunk.push(l);
    });
    flush();
  }
  return found;
}

function dedent(lines: string[]): string[] {
  const tabs = (l: string) => l.match(/^\t*/)![0].length;
  const common = Math.min(...lines.filter((l) => l.trim()).map(tabs));
  return lines.map((l) => l.slice(Math.min(common, tabs(l))));
}

/**
 * The Odin vidar writes for the statement at `p`: the output lines mapped to the statement's source lines
 * (with the comments and hoisted statements the emitter puts before it), then the generated helpers they name.
 * A statement that comes out unchanged gives way to the statement around it, short of a top-level declaration.
 */
export function expandAt(a: Program, file: string, p: Position, opt = false): Expansion | { error: string } {
  if (a.errors.length) return { error: `fix ${a.errors.length} error(s) first:\n${a.errors.map((e) => e.message).join("\n")}` };
  const pkg = a.packages.find((x) => x.files.some((f) => f.path === file));
  const f = pkg?.files.find((x) => x.path === file);
  if (!pkg || !f) return { error: "file is not part of the program" };
  const path = statementsAt(f.stmts, file, p);
  if (!path.length) return { error: "no statement at the cursor" };
  const out = emitted(a);
  const name = outputName(pkg, f);
  const text = out.files.get(name)?.split("\n") ?? [];
  const map = out.lineMap.get(name) ?? [];
  const source = a.sources.find((s) => s.path === file)?.text.split("\n") ?? [];
  const all = helpers(out);
  const squash = (ls: string[]) => ls.map((l) => l.trim()).filter(Boolean).join("\n");

  type Pick = { stmt: Stmt; lines: string[]; first: number; last: number };
  let pick: Pick | undefined;
  let first: Pick | undefined;
  for (let i = path.length - 1; i >= 0; i--) {
    const r = linesOf(path[i], file);
    if (!r) continue;
    const lines = text.filter((_, j) => map[j] !== 0 && Math.abs(map[j]) >= r.first && Math.abs(map[j]) <= r.last);
    const own = lines.join("\n");
    const changed = lines.length && (squash(lines) !== squash(source.slice(r.first - 1, r.last)) || [...own.matchAll(/\b__\w+/g)].some((m) => all.has(m[0])));
    const here = { stmt: path[i], lines, first: r.first, last: r.last };
    // the innermost statement whose code changed, short of the top-level declarations; else the innermost
    if (changed || path.length === 1) {
      pick = here;
      break;
    }
    if (lines.length) first ??= here;
    if (i <= 1) break;
  }
  pick ??= first;
  if (!pick) return { error: "no statement at the cursor" };

  const shown = new Set<string>();
  const extra: Helper[] = [];
  let frontier = pick.lines.join("\n");
  for (let depth = 0; depth < HELPER_DEPTH && extra.length < HELPER_LIMIT; depth++) {
    const next: string[] = [];
    for (const m of frontier.matchAll(/\b__\w+/g)) {
      const h = all.get(m[0]);
      if (!h || shown.has(h.name) || extra.length >= HELPER_LIMIT) continue;
      shown.add(h.name);
      extra.push(h);
      next.push(...h.lines);
    }
    frontier = next.join("\n");
  }

  const where = `${file.split(/[\\/]/).pop()}:${pick.first}${pick.last > pick.first ? `-${pick.last}` : ""}`;
  const parts = [`// ${where}${opt ? " (-opt)" : ""}`, ...dedent(pick.lines)];
  if (extra.length) parts.push("", "// ---- generated by vidar ----", ...extra.flatMap((h) => ["", ...h.lines]));
  const r = linesOf(pick.stmt, file)!;
  return {
    code: parts.join("\n") + "\n",
    range: { start: { line: r.start.pos.line - 1, character: r.start.pos.col - 1 }, end: { line: r.end.pos.line - 1, character: r.end.pos.col - 1 + r.end.text.length } },
  };
}
