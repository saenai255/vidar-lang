// The -opt decisions of a program, grouped by file and enclosing proc: the `vidar/optReport` request and code lenses.
import type { Token } from "../lexer";
import type { Stmt } from "../ast";
import type { OptHint } from "../analyzer";
import type { Program as Analysis } from "../project";
import { Position, Range, tokRange } from "./features";

export interface OptDecision {
  range: Range;
  label: string;
  tooltip?: string;
  /** a decision against: its label starts with "no" or "not" */
  against: boolean;
}

export interface OptProc {
  /** the proc's name, or "(top level)" for decisions outside any proc */
  name: string;
  /** the whole declaration; for the top-level group, the first decision */
  range: Range;
  /** the proc's name */
  selectionRange: Range;
  /** decisions for, and against */
  optimizations: number;
  against: number;
  decisions: OptDecision[];
}

export interface OptFile {
  file: string;
  procs: OptProc[];
}

export const TOP_LEVEL = "(top level)";

export const isAgainst = (label: string) => /^not? /.test(label);

/** Range of the token a hint is about, ending where the inlay hint goes (tokens may span lines). */
function hintRange(t: Token): Range {
  const lines = t.text.split("\n");
  const start = { line: t.pos.line - 1, character: t.pos.col - 1 };
  const last = lines[lines.length - 1].length;
  const end: Position = { line: start.line + lines.length - 1, character: lines.length > 1 ? last : start.character + last };
  return { start, end };
}

interface ProcSpan {
  name: string;
  nameTok: number;
  start: number;
  end: number;
  declStart: number;
  declEnd: number;
}

/** Top-level proc declarations of a file (also inside top-level `when` and blocks), by token span. */
function procSpans(stmts: Stmt[]): ProcSpan[] {
  const out: ProcSpan[] = [];
  const visit = (s: Stmt) => {
    if (s.k === "ValueDecl") {
      s.names.forEach((n, i) => {
        let v = s.values[i];
        while (v?.k === "Directive" && v.x) v = v.x; // #force_inline proc ...
        if (v?.k === "ProcLit") out.push({ name: n.name, nameTok: n.tok, start: v.start, end: v.end, declStart: s.start, declEnd: s.end });
      });
    } else if (s.k === "When") {
      s.then.stmts.forEach(visit);
      if (s.else) visit(s.else);
    } else if (s.k === "Block") s.stmts.forEach(visit);
  };
  stmts.forEach(visit);
  return out;
}

/** Every -opt decision in `files` (default: the program's own sources), grouped by enclosing proc in source order. */
export function optReport(a: Analysis, files?: string[]): OptFile[] {
  const wanted = new Set(files ?? a.sources.map((s) => s.path));
  const hints = a.analyzer.hints ?? [];
  const out: OptFile[] = [];
  for (const f of a.packages.flatMap((p) => p.files)) {
    if (!wanted.has(f.path)) continue;
    wanted.delete(f.path);
    const spans = procSpans(f.stmts);
    const groups = new Map<ProcSpan | undefined, { hint: OptHint; range: Range }[]>();
    for (const h of hints) {
      if (h.at.toks !== f.toks) continue;
      const span = spans.find((s) => (h.name !== undefined && h.name === s.name && h.tok === s.nameTok) || (h.tok >= s.start && h.tok < s.end))
        ?? spans.find((s) => h.tok >= s.declStart && h.tok < s.declEnd);
      const list = groups.get(span) ?? [];
      list.push({ hint: h, range: hintRange(f.toks[h.tok]) });
      groups.set(span, list);
    }
    const procs: OptProc[] = [];
    for (const [span, list] of groups) {
      list.sort((x, y) => x.range.start.line - y.range.start.line || x.range.start.character - y.range.start.character);
      const decisions = list.map(({ hint, range }) => ({ range, label: hint.label, tooltip: hint.tooltip, against: isAgainst(hint.label) }));
      const against = decisions.filter((d) => d.against).length;
      const sel = span ? tokRange(f.toks[span.nameTok]) : decisions[0].range;
      const range = span ? { start: tokRange(f.toks[span.declStart]).start, end: hintRange(f.toks[Math.max(span.declStart, span.declEnd - 1)]).end } : sel;
      procs.push({ name: span?.name ?? TOP_LEVEL, range, selectionRange: sel, optimizations: decisions.length - against, against, decisions });
    }
    procs.sort((x, y) => x.selectionRange.start.line - y.selectionRange.start.line || x.selectionRange.start.character - y.selectionRange.start.character);
    if (procs.length) out.push({ file: f.path, procs });
  }
  return out;
}

/** "N optimizations, M not", the code lens title over a proc. */
export function lensTitle(p: OptProc): string {
  return `${p.optimizations} optimization${p.optimizations === 1 ? "" : "s"}, ${p.against} not`;
}
