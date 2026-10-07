// Workspace symbols, find implementations and the call hierarchy.
import type { Token } from "../lexer";
import { Node, Stmt, children } from "../ast";
import { A, IfaceMethod } from "../analyzer";
import type { Program as Analysis } from "../project";
import type { GlobalSym, Sym } from "../scope";
import { Index, Location, Position, Range, SymbolKind, canonical, declToken, tokRange } from "./features";

function nodeRange(n: Node): Range {
  const first = n.toks[n.start];
  const last = n.toks[Math.max(n.start, n.end - 1)];
  return { start: tokRange(first).start, end: tokRange(last).end };
}

function contains(r: Range, p: Position): boolean {
  const after = p.line > r.start.line || (p.line === r.start.line && p.character >= r.start.character);
  const before = p.line < r.end.line || (p.line === r.end.line && p.character <= r.end.character);
  return after && before;
}

const keyOf = (t: Token) => `${t.pos.file}:${t.pos.line}:${t.pos.col}`;

function globalsOf(a: Analysis): GlobalSym[] {
  return a.packages.flatMap((p) => [...p.scope.syms.values()]).filter((s): s is GlobalSym => s.kind === "global");
}

const valueOf = (g: GlobalSym) => g.decl.values[g.index];
const ifaceMethodOf = (g: GlobalSym): IfaceMethod | undefined => {
  const v = valueOf(g);
  return v?.k === "ProcLit" ? A(v)._ifaceMethod : undefined;
};

function kindOf(g: GlobalSym): SymbolKind {
  const v = valueOf(g);
  switch (v?.k) {
    case "ProcLit": return v.comptime ? "macro" : A(v)._ifaceMethod ? "method" : "function";
    case "ProcGroup": return "function";
    case "StructType": return "struct";
    case "InterfaceType": return "interface";
    case "EnumType": return "enum";
    case "UnionType": return "union";
    case "ProcType": case "ClosureType": case "TypeExpr": return "type";
  }
  return g.isConst ? "constant" : "variable";
}

/** A global's declaration, if its token really is at its position (not in generated code). */
function declLocation(g: GlobalSym, sources: Map<string, string[]>): Location | undefined {
  const t = declToken(g);
  if (!t) return undefined;
  const line = sources.get(t.pos.file)?.[t.pos.line - 1];
  if (line === undefined || line.substr(t.pos.col - 1, t.text.length) !== t.text) return undefined;
  return { file: t.pos.file, range: tokRange(t) };
}

function sourceLines(programs: Analysis[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const a of programs) for (const s of a.sources) if (!out.has(s.path)) out.set(s.path, s.text.split("\n"));
  return out;
}

// ---- workspace/symbol ----

export interface WorkspaceSymbol extends Location {
  name: string;
  kind: SymbolKind;
  container: string;
}

/** 0 for a substring match (earlier is better), 1000+ for the query's letters in order, -1 for no match. */
function score(name: string, query: string): number {
  if (!query) return 0;
  const n = name.toLowerCase();
  const q = query.toLowerCase();
  const at = n.indexOf(q);
  if (at >= 0) return at;
  let i = 0;
  for (const c of n) if (c === q[i]) i++;
  return i === q.length ? 1000 + n.length : -1;
}

export function workspaceSymbols(programs: Analysis[], query: string, limit = 500): WorkspaceSymbol[] {
  const sources = sourceLines(programs);
  const seen = new Set<string>();
  const found: { sym: WorkspaceSymbol; score: number }[] = [];
  for (const a of programs) {
    for (const g of globalsOf(a)) {
      if (g.name.startsWith("__")) continue;
      const s = score(g.name, query);
      if (s < 0) continue;
      const loc = declLocation(g, sources);
      if (!loc) continue;
      const key = `${loc.file}:${loc.range.start.line}:${loc.range.start.character}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ sym: { name: g.name, kind: kindOf(g), container: g.pkg.name, ...loc }, score: s });
    }
  }
  found.sort((x, y) => x.score - y.score || x.sym.name.localeCompare(y.sym.name));
  return found.slice(0, limit).map((f) => f.sym);
}

// ---- textDocument/implementation ----

/** The global under the cursor (a reference or its declaration). */
function globalAt(index: Index, file: string, p: Position): GlobalSym | undefined {
  const ref = index.refAt(file, p);
  const sym = ref && canonical(ref.sym);
  return sym?.kind === "global" ? sym : undefined;
}

/**
 * On an interface: the types implementing it (also through interfaces extending it). On an interface
 * method: the procs bound to it. On anything else: nothing.
 */
export function implementations(a: Analysis, index: Index, file: string, p: Position): Location[] {
  const g = globalAt(index, file, p);
  if (!g) return [];
  const sources = sourceLines([a]);
  const out: Location[] = [];
  const seen = new Set<string>();
  const push = (l: Location | undefined) => {
    if (!l) return;
    const key = `${l.file}:${l.range.start.line}:${l.range.start.character}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(l);
  };
  const method = ifaceMethodOf(g);
  if (method) {
    for (const impl of a.analyzer.variants(method.iface)) {
      const bound = impl.methods.get(method.name);
      if (bound) push(declLocation(bound, sources));
    }
    return out;
  }
  if (valueOf(g)?.k !== "InterfaceType") return [];
  for (const impl of a.analyzer.variants(g)) {
    // `impl I for Box($T)`: the parametric type
    const head = impl.node.target.k === "Call" ? impl.node.target.fn : impl.node.target;
    const target: Sym | undefined = A(head)._sym ?? A(head)._pkgMember;
    const t = target && canonical(target);
    push((t?.kind === "global" && declLocation(t, sources)) || { file: impl.node.toks[impl.node.target.start].pos.file, range: nodeRange(impl.node.target) });
  }
  return out;
}

// ---- call hierarchy ----

export interface CallItem extends Location {
  name: string;
  kind: SymbolKind;
  detail: string;
  /** the whole declaration */
  full: Range;
  /** identifies the item across requests and analyses */
  key: string;
}

export interface Call {
  item: CallItem;
  ranges: Range[];
}

function itemOf(g: GlobalSym): CallItem | undefined {
  const t = declToken(g);
  if (!t) return undefined;
  const range = tokRange(t);
  const full = nodeRange(g.decl);
  const method = ifaceMethodOf(g);
  const detail = method ? `${g.pkg.name} · method of ${method.iface.name}` : g.pkg.name;
  return { name: g.name, kind: kindOf(g), detail, file: t.pos.file, range, full: contains(full, range.start) ? full : range, key: keyOf(t) };
}

/** Things calls can be made to: procs, proc groups and interface methods (and macros, at their calls). */
function callable(g: GlobalSym): boolean {
  const v = valueOf(g);
  return v?.k === "ProcLit" || v?.k === "ProcGroup";
}

/** The procs a call to `g` may run: a group's members; a closed interface's bound procs. */
function targets(a: Analysis, g: GlobalSym, depth = 0): GlobalSym[] {
  const v = valueOf(g);
  if (v?.k === "ProcGroup" && depth < 8) {
    return v.procs.flatMap((e) => {
      const s: Sym | undefined = A(e)._sym ?? A(e)._pkgMember;
      const c = s && canonical(s);
      return c?.kind === "global" && callable(c) ? targets(a, c, depth + 1) : [];
    });
  }
  const method = ifaceMethodOf(g);
  if (method && a.analyzer.isClosed(method.iface)) {
    const bound = [...new Set(a.analyzer.variants(method.iface).map((i) => i.methods.get(method.name)).filter((s): s is GlobalSym => !!s))];
    if (bound.length) return bound;
  }
  return [g];
}

interface Edge {
  caller: GlobalSym;
  /** what the call names */
  callee: GlobalSym;
  range: Range;
}

/** The global a call's callee expression names, if any. */
function calleeOf(fn: Node): { sym: GlobalSym; tok: Token } | undefined {
  while (fn.k === "Paren") fn = fn.x;
  let sym: Sym | undefined;
  if (fn.k === "Ident") sym = A(fn)._sym;
  else if (fn.k === "Selector") sym = A(fn)._pkgMember;
  else return undefined;
  const c = sym && canonical(sym);
  return c?.kind === "global" && callable(c) ? { sym: c, tok: fn.toks[fn.end - 1] } : undefined;
}

/** Every call made in the body of `caller`, closures inside it included; calls a macro expands to count at the macro call. */
function callsIn(caller: GlobalSym, lines: Map<string, string[]>): Edge[] {
  const lit = valueOf(caller);
  if (lit?.k !== "ProcLit" || !lit.body || lit.comptime) return [];
  const out: Edge[] = [];
  const real = (t: Token) => lines.get(t.pos.file)?.[t.pos.line - 1]?.substr(t.pos.col - 1, t.text.length) === t.text;
  /** `macro`: the innermost macro call (source range and file) being expanded */
  const visit = (n: Node, macro?: { file: string; name: Range; span: Range }) => {
    const a = A(n);
    for (const p of (a._pre as Stmt[] | undefined) ?? []) visit(p, macro);
    const where = (t: Token): Range => {
      const r = tokRange(t);
      if (!macro) return r;
      return real(t) && t.pos.file === macro.file && contains(macro.span, r.start) ? r : macro.name;
    };
    if (n.k === "Call") {
      const c = calleeOf(n.fn);
      if (c) out.push({ caller, callee: c.sym, range: where(c.tok) });
    }
    if (n.k === "MacroCall" || (n.k === "ExprStmt" && a._expansion && n.x.k === "MacroCall")) {
      const call = n.k === "MacroCall" ? n : (n.x as Extract<Node, { k: "MacroCall" }>);
      const first = call.toks[call.start];
      const nameEnd = call.toks[Math.min(call.end - 1, call.start + 2 * (call.path.length - 1))];
      const inner = { file: first.pos.file, name: { start: tokRange(first).start, end: tokRange(nameEnd).end }, span: nodeRange(call) };
      const here = macro && !(real(first) && first.pos.file === macro.file && contains(macro.span, inner.name.start)) ? macro : inner;
      const ca = A(call);
      const parts: Sym[] | undefined = ca._partSyms;
      const msym: Sym | undefined = parts ? parts[parts.length - 1] : ca._macroSym;
      if (msym?.kind === "global") out.push({ caller, callee: msym, range: here.name });
      const exp: Node | undefined = a._expansion;
      if (exp) {
        if (n.k === "ExprStmt") for (const s of (exp as Extract<Node, { k: "Block" }>).stmts) visit(s, here);
        else visit(exp, here);
      }
      if (n.k === "ExprStmt") return;
    }
    for (const c of children(n)) visit(c, macro);
  };
  visit(lit.body);
  return out;
}

function findGlobal(programs: Analysis[], key: string): { a: Analysis; g: GlobalSym } | undefined {
  for (const a of programs) {
    for (const g of globalsOf(a)) {
      const t = declToken(g);
      if (t && keyOf(t) === key) return { a, g };
    }
  }
  return undefined;
}

/** The proc, proc group, interface method or macro under the cursor. */
export function prepareCallHierarchy(index: Index, file: string, p: Position): CallItem[] {
  const g = globalAt(index, file, p);
  if (!g || !callable(g)) return [];
  const item = itemOf(g);
  return item ? [item] : [];
}

function group(edges: Edge[], side: (e: Edge) => GlobalSym): Call[] {
  const byKey = new Map<string, Call>();
  const seen = new Set<string>();
  for (const e of edges) {
    const item = itemOf(side(e));
    if (!item) continue;
    // ranges are in the caller's file, so the position alone tells calls apart
    const rangeKey = `${item.key}|${e.range.start.line}:${e.range.start.character}`;
    if (seen.has(rangeKey)) continue;
    seen.add(rangeKey);
    const call = byKey.get(item.key) ?? { item, ranges: [] };
    byKey.set(item.key, call);
    call.ranges.push(e.range);
  }
  return [...byKey.values()];
}

/** Calls to `key`, made anywhere in the programs given: by name, through proc groups and closed interfaces. */
export function incomingCalls(programs: Analysis[], key: string): Call[] {
  const lines = sourceLines(programs);
  const edges: Edge[] = [];
  const callers = new Set<string>();
  for (const a of programs) {
    for (const caller of globalsOf(a)) {
      const t = declToken(caller);
      if (!t || callers.has(keyOf(t))) continue;
      callers.add(keyOf(t));
      for (const e of callsIn(caller, lines)) {
        const hit = [e.callee, ...targets(a, e.callee)].some((s) => {
          const d = declToken(s);
          return d && keyOf(d) === key;
        });
        if (hit) edges.push(e);
      }
    }
  }
  return group(edges, (e) => e.caller);
}

/** Calls made by `key`, each resolved to the procs it may run. */
export function outgoingCalls(programs: Analysis[], key: string): Call[] {
  const found = findGlobal(programs, key);
  if (!found) return [];
  const { a, g } = found;
  const v = valueOf(g);
  // a proc group "calls" its members
  if (v?.k === "ProcGroup") {
    const edges: Edge[] = [];
    for (const e of v.procs) {
      const s: Sym | undefined = A(e)._sym ?? A(e)._pkgMember;
      const c = s && canonical(s);
      if (c?.kind === "global" && callable(c)) edges.push({ caller: g, callee: c, range: nodeRange(e) });
    }
    return group(edges, (e) => e.callee);
  }
  const edges = callsIn(g, sourceLines(programs)).flatMap((e) => targets(a, e.callee).map((callee) => ({ ...e, callee })));
  return group(edges, (e) => e.callee);
}
