import { CompileError, Pos, Token, lex } from "./lexer";
import type { Block, Expr, Stmt } from "./ast";
import { Parser } from "./parser";
import type { Analyzer } from "./analyzer";
import type { GlobalSym, Scope, Ty } from "./scope";

type ProcLit = Extract<Expr, { k: "ProcLit" }>;

export type Val =
  /** `ty` is the integer type it has; untyped constants have none */
  | { k: "int"; v: bigint; ty?: string }
  | { k: "float"; v: number }
  | { k: "bool"; v: boolean }
  | { k: "string"; v: string }
  | { k: "array"; items: Val[] }
  | { k: "struct"; fields: Map<string, Val> }
  | { k: "nil" }
  | { k: "void" }
  | { k: "expr"; toks: Token[]; node?: Expr; ty?: Ty; scope?: Scope }
  | { k: "stmts"; toks: Token[] }
  | { k: "type"; toks: Token[]; node?: Expr; scope?: Scope }
  | { k: "ident"; name: string }
  | { k: "proc"; sym: GlobalSym; lit: ProcLit }
  | { k: "ref"; cell: Cell };

interface Cell {
  v: Val;
}

/** The expression depends on something only known at run time. */
export class NotConstant extends CompileError {}

const VOID: Val = { k: "void" };
const MAX_STEPS = 5_000_000;
const INT_BITS: Record<string, [bits: number, signed: boolean]> = {
  int: [64, true], uint: [64, false], uintptr: [64, false], i8: [8, true], i16: [16, true], i32: [32, true], i64: [64, true],
  i128: [128, true], u8: [8, false], u16: [16, false], u32: [32, false], u64: [64, false], u128: [128, false], byte: [8, false], rune: [32, true],
};
const MAX_SHIFT = 4096n;

const BASIC_TYPES = new Set([
  "int", "uint", "i8", "i16", "i32", "i64", "i128", "u8", "u16", "u32", "u64", "u128", "uintptr", "byte",
  "f16", "f32", "f64", "bool", "b8", "b16", "b32", "b64", "string", "cstring", "rune", "rawptr", "typeid", "any",
]);

class Env {
  vars = new Map<string, Cell>();
  constructor(public parent: Env | null, public scope: Scope) {}

  find(name: string): Cell | undefined {
    for (let e: Env | null = this; e; e = e.parent) {
      const c = e.vars.get(name);
      if (c) return c;
    }
    return undefined;
  }
}

type Completion = { k: "normal" } | { k: "break" } | { k: "continue" } | { k: "return"; v: Val } | { k: "take"; v: Val };
const NORMAL: Completion = { k: "normal" };

let gensym = 0;

/** Restarts hygienic renaming so output is deterministic per transpile. */
export function resetGensym(): void {
  gensym = 0;
}

const posOf = (n: { toks: Token[]; start: number }): Pos => n.toks[n.start]?.pos ?? n.toks[0].pos;

export class Interp {
  private steps = 0;
  /** where the macro currently being expanded was invoked */
  callSite: Pos | undefined;
  /** the scope it was invoked in */
  scope: Scope | undefined;
  /** while evaluating code at compile time (`comptime! { ... }`, `name!(...)` inside comptime code): its environment */
  foldEnv: Env | undefined;

  constructor(readonly an: Analyzer) {}

  callComptime(sym: GlobalSym, lit: ProcLit, args: Val[], pos: Pos, scope?: Scope): Val {
    this.steps = 0;
    const [outerSite, outerScope, outerFold] = [this.callSite, this.scope, this.foldEnv];
    this.callSite = pos;
    this.scope = scope;
    this.foldEnv = undefined;
    try {
      return this.invoke({ k: "proc", sym, lit }, args, pos);
    } finally {
      this.callSite = outerSite;
      this.scope = outerScope;
      this.foldEnv = outerFold;
    }
  }

  evalIn(e: Expr, scope: Scope): Val {
    this.steps = 0;
    return this.eval(e, new Env(null, scope));
  }

  /** Evaluates an expression written in ordinary code at compile time. */
  evalAt(e: Expr, scope: Scope, pos: Pos): Val {
    const [outerSite, outerScope, outerSteps, outerFold] = [this.callSite, this.scope, this.steps, this.foldEnv];
    this.callSite = pos;
    this.scope = scope;
    this.steps = 0;
    this.foldEnv = new Env(null, scope);
    try {
      return this.eval(e, this.foldEnv);
    } finally {
      [this.callSite, this.scope, this.steps, this.foldEnv] = [outerSite, outerScope, outerSteps, outerFold];
    }
  }

  private tick(pos: Pos): void {
    if (++this.steps > MAX_STEPS) throw new CompileError("compile-time evaluation exceeded the step limit (infinite loop?)", pos);
  }

  private invoke(p: Extract<Val, { k: "proc" }>, args: Val[], pos: Pos): Val {
    const env = new Env(null, p.sym.scope);
    const params = p.lit.sig.params.flatMap((g) => g.names.map((n) => ({ name: n.name, def: g.value, type: g.type })));
    if (args.length > params.length) throw new CompileError(`'${p.sym.name}' takes ${params.length} argument(s), got ${args.length}`, pos);
    params.forEach((param, i) => {
      const v = args[i] ?? (param.def ? this.eval(param.def, env) : undefined);
      if (!v) throw new CompileError(`missing argument '${param.name}' for '${p.sym.name}'`, pos);
      env.vars.set(param.name, { v: typed(param.type, v) });
    });
    if (!p.lit.body) throw new NotConstant(`'${p.sym.name}' has no body to evaluate`, pos);
    const c = this.block(p.lit.body, env);
    return c.k === "return" ? typed(p.lit.sig.results[0]?.type, c.v) : VOID;
  }

  // ---- names ----

  lookup(name: string, env: Env, pos: Pos): Val {
    const cell = env.find(name);
    if (cell) return cell.v;
    if (name === "true" || name === "false") return { k: "bool", v: name === "true" };
    if (name === "nil") return { k: "nil" };
    const sym = this.an.lookup(name, env.scope, null);
    if (!sym) {
      if (BASIC_TYPES.has(name)) return { k: "type", toks: tokensOf(name, pos) };
      throw new NotConstant(`'${name}' is not known at compile time`, pos);
    }
    return this.symVal(sym, pos);
  }

  private symVal(sym: import("./scope").Sym, pos: Pos): Val {
    switch (sym.kind) {
      case "global": {
        const value = sym.decl.values[sym.index];
        if (!sym.isConst || !value) throw new NotConstant(`'${sym.name}' is a runtime variable and is not available at compile time`, pos);
        if (value.k === "ProcLit") return { k: "proc", sym, lit: value };
        if (isType(value)) return { k: "type", toks: slice(value), node: value, scope: sym.scope };
        if (sym.constVal) return sym.constVal;
        if (sym.evaluating) throw new CompileError(`constant '${sym.name}' depends on itself`, pos);
        sym.evaluating = true;
        try {
          sym.constVal = this.eval(value, new Env(null, sym.scope));
          return sym.constVal;
        } finally {
          sym.evaluating = false;
        }
      }
      case "local":
        if (sym.isConst && sym.value) {
          if (isType(sym.value)) return { k: "type", toks: slice(sym.value), node: sym.value, scope: sym.scope };
          return this.eval(sym.value, new Env(null, sym.scope));
        }
        throw new NotConstant(`'${sym.name}' is a runtime value and is not available at compile time`, pos);
      default:
        throw new NotConstant(`'${sym.name}' is not available at compile time`, pos);
    }
  }

  // ---- statements ----

  private block(b: Block, env: Env): Completion {
    const inner = b.inline ? env : new Env(env, env.scope);
    for (const s of b.stmts) {
      const c = this.exec(s, inner);
      if (c.k !== "normal") return c;
    }
    return NORMAL;
  }

  private exec(s: Stmt, env: Env): Completion {
    this.tick(posOf(s));
    switch (s.k) {
      case "Empty":
        return NORMAL;
      case "ValueDecl": {
        let vals: Val[];
        if (s.values.length) vals = s.values.map((v) => (s.type ? typed(s.type, this.eval(v, env)) : defaultTyped(this.eval(v, env))));
        else vals = s.names.map(() => (s.type ? zero(s.type) : VOID));
        if (vals.length !== s.names.length) throw new CompileError("multi-value declarations are not supported at compile time", posOf(s));
        s.names.forEach((n, i) => env.vars.set(n.name, { v: vals[i] }));
        return NORMAL;
      }
      case "Assign": {
        if (s.lhs.length !== s.rhs.length) throw new CompileError("multi-value assignment is not supported at compile time", posOf(s));
        const vals = s.rhs.map((r) => this.eval(r, env));
        s.lhs.forEach((l, i) => {
          const cell = this.place(l, env);
          const old = cell.get();
          const v = s.op === "=" ? vals[i] : binop(s.op.slice(0, -1), old, vals[i], posOf(s));
          cell.set(old.k === "int" && old.ty && v.k === "int" && !v.ty ? wrapInt(v.v, old.ty) : v);
        });
        return NORMAL;
      }
      case "ExprStmt":
        this.eval(s.x, env);
        return NORMAL;
      case "Block":
        return this.block(s, env);
      case "If": {
        const inner = new Env(env, env.scope);
        if (s.init) this.exec(s.init, inner);
        if (truthy(this.eval(s.cond, inner), posOf(s))) return this.block(s.then, inner);
        if (s.else) return s.else.k === "Block" ? this.block(s.else, inner) : this.exec(s.else, inner);
        return NORMAL;
      }
      case "For": {
        const inner = new Env(env, env.scope);
        if (s.init) this.exec(s.init, inner);
        while (!s.cond || truthy(this.eval(s.cond, inner), posOf(s))) {
          this.tick(posOf(s));
          const c = this.block(s.body, inner);
          if (c.k === "break") break;
          if (c.k === "return" || c.k === "take") return c;
          if (s.post) this.exec(s.post, inner);
        }
        return NORMAL;
      }
      case "RangeFor":
        return this.rangeFor(s, env);
      case "Switch": {
        const inner = new Env(env, env.scope);
        if (s.init) this.exec(s.init, inner);
        const tag = s.tag ? this.eval(s.tag, inner) : { k: "bool" as const, v: true };
        for (const c of s.cases) {
          const hit = c.exprs.length === 0 || c.exprs.some((e) => valEq(this.eval(e, inner), tag));
          if (hit) {
            const r = this.block({ k: "Block", toks: c.toks, start: c.start, end: c.end, stmts: c.body }, inner);
            return r.k === "break" ? NORMAL : r;
          }
        }
        return NORMAL;
      }
      case "Return":
        if (s.results.length > 1) throw new CompileError("comptime procs return a single value", posOf(s));
        return { k: "return", v: s.results.length ? this.eval(s.results[0], env) : VOID };
      case "Take":
        if (s.results.length !== 1) throw new CompileError("'take' takes exactly one value", posOf(s));
        return { k: "take", v: this.eval(s.results[0], env) };
      case "Branch":
        if (s.op === "break") return { k: "break" };
        if (s.op === "continue") return { k: "continue" };
        break;
    }
    throw new NotConstant(`'${s.k}' is not supported in comptime code`, posOf(s));
  }

  private rangeFor(s: Extract<Stmt, { k: "RangeFor" }>, env: Env): Completion {
    const items: [Val, Val][] = [];
    const index = (i: number): Val => ({ k: "int", v: BigInt(i), ty: "int" });
    if (s.x.k === "Binary" && (s.x.op === "..<" || s.x.op === "..=")) {
      const loV = this.eval(s.x.x, env);
      const hiV = this.eval(s.x.y, env);
      const ty = (loV.k === "int" && loV.ty) || (hiV.k === "int" && hiV.ty) || "int";
      const lo = num(loV, posOf(s));
      const hi = num(hiV, posOf(s)) + (s.x.op === "..=" ? 1 : 0);
      for (let i = lo; i < hi; i++) items.push([{ k: "int", v: BigInt(i), ty }, index(i - lo)]);
    } else {
      const it = this.eval(s.x, env);
      if (it.k === "array") it.items.forEach((v, i) => items.push([v, index(i)]));
      else if (it.k === "string") {
        let offset = 0;
        for (const ch of it.v) {
          items.push([{ k: "int", v: BigInt(ch.codePointAt(0)!), ty: "rune" }, index(offset)]);
          offset += new TextEncoder().encode(ch).length;
        }
      } else throw new CompileError(`cannot iterate over ${it.k} at compile time`, posOf(s));
    }
    for (const [v, i] of items) {
      this.tick(posOf(s));
      const inner = new Env(env, env.scope);
      if (s.vals[0]) inner.vars.set(s.vals[0].name, { v });
      if (s.vals[1]) inner.vars.set(s.vals[1].name, { v: i });
      const c = this.block(s.body, inner);
      if (c.k === "break") break;
      if (c.k === "return" || c.k === "take") return c;
    }
    return NORMAL;
  }

  private place(e: Expr, env: Env): { get: () => Val; set: (v: Val) => void } {
    if (e.k === "Ident") {
      if (e.name === "_") return { get: () => VOID, set: () => {} };
      const cell = env.find(e.name);
      if (!cell) throw new CompileError(`cannot assign to '${e.name}' at compile time`, posOf(e));
      return { get: () => cell.v, set: (v) => (cell.v = v) };
    }
    if (e.k === "Selector") {
      const obj = this.eval(e.x, env);
      if (obj.k !== "struct") throw new CompileError("can only assign fields of structs", posOf(e));
      return { get: () => obj.fields.get(e.name) ?? VOID, set: (v) => obj.fields.set(e.name, v) };
    }
    if (e.k === "Index" && !e.slice) {
      const obj = this.eval(e.x, env);
      const i = num(this.eval(e.indices[0]!, env), posOf(e));
      if (obj.k !== "array") throw new CompileError("can only index-assign arrays", posOf(e));
      return { get: () => obj.items[i] ?? VOID, set: (v) => (obj.items[i] = v) };
    }
    if (e.k === "Paren") return this.place(e.x, env);
    throw new CompileError("invalid assignment target at compile time", posOf(e));
  }

  // ---- expressions ----

  eval(e: Expr, env: Env): Val {
    this.tick(posOf(e));
    switch (e.k) {
      case "Lit":
        return literal(e.toks[e.start], posOf(e));
      case "Ident":
        return this.lookup(e.name, env, posOf(e));
      case "Paren":
        return this.eval(e.x, env);
      case "Unary": {
        if (e.op === "&") return { k: "ref", cell: this.refCell(e.x, env) };
        const v = this.eval(e.x, env);
        if (e.op === "!") return { k: "bool", v: !truthy(v, posOf(e)) };
        if (e.op === "-" && v.k === "int") return wrapInt(-v.v, v.ty);
        if (e.op === "-" && v.k === "float") return { k: "float", v: -v.v };
        if (e.op === "+") return v;
        if (e.op === "~" && v.k === "int") return wrapInt(~v.v, v.ty);
        throw new NotConstant(`unsupported unary '${e.op}' at compile time`, posOf(e));
      }
      case "Binary": {
        if (e.op === "&&") return { k: "bool", v: truthy(this.eval(e.x, env), posOf(e)) && truthy(this.eval(e.y, env), posOf(e)) };
        if (e.op === "||") return { k: "bool", v: truthy(this.eval(e.x, env), posOf(e)) || truthy(this.eval(e.y, env), posOf(e)) };
        return binop(e.op, this.eval(e.x, env), this.eval(e.y, env), posOf(e));
      }
      case "Ternary":
        return truthy(this.eval(e.cond, env), posOf(e)) ? this.eval(e.a, env) : this.eval(e.b, env);
      case "Index": {
        const obj = this.eval(e.x, env);
        if (e.slice) {
          const lo = e.indices[0] ? num(this.eval(e.indices[0], env), posOf(e)) : 0;
          if (obj.k === "array") return { k: "array", items: obj.items.slice(lo, e.indices[1] ? num(this.eval(e.indices[1], env), posOf(e)) : undefined) };
          if (obj.k === "string") return { k: "string", v: obj.v.slice(lo, e.indices[1] ? num(this.eval(e.indices[1], env), posOf(e)) : undefined) };
        }
        const i = num(this.eval(e.indices[0]!, env), posOf(e));
        if (obj.k === "array") {
          if (i < 0 || i >= obj.items.length) throw new CompileError(`index ${i} out of bounds (len ${obj.items.length})`, posOf(e));
          return obj.items[i];
        }
        if (obj.k === "string") {
          const bytes = new TextEncoder().encode(obj.v);
          if (i < 0 || i >= bytes.length) throw new CompileError(`index ${i} out of bounds (len ${bytes.length})`, posOf(e));
          return { k: "int", v: BigInt(bytes[i]), ty: "u8" };
        }
        throw new CompileError(`cannot index ${obj.k} at compile time`, posOf(e));
      }
      case "Selector": {
        const pm = e.x.k === "Ident" && !env.find(e.x.name) ? this.an.pkgMember(e, env.scope, e) : undefined;
        if (pm) return this.symVal(pm.member, posOf(e));
        const obj = this.eval(e.x, env);
        if (obj.k === "struct") {
          const f = obj.fields.get(e.name);
          if (!f) throw new CompileError(`no field '${e.name}'`, posOf(e));
          return f;
        }
        throw new NotConstant(`cannot select '${e.name}' from ${obj.k} at compile time`, posOf(e));
      }
      case "CompoundLit":
        return this.compound(e, env);
      case "Call":
        return this.call(e, env);
      case "Cast": {
        const v = this.eval(e.x, env);
        return e.type ? convert(slice(e.type).map((t) => t.text).join(""), v) : v;
      }
      case "Quote":
        return instantiate(e.body, e.kind, env, this, posOf(e));
      case "MacroCall":
        return this.evalMacro(e, env);
    }
    throw new NotConstant(`this expression is not supported at compile time`, posOf(e));
  }

  /** `name!(...)` in code that runs at compile time: a comptime proc is expanded and the code it produced evaluated; any other proc is called. */
  private evalMacro(call: Extract<Expr, { k: "MacroCall" }>, env: Env): Val {
    const pos = posOf(call);
    if (!this.an.macroTarget(call, env.scope)) return this.eval(this.an.macroAsCall(call), env);
    const { sym, lit, args } = this.an.macroInvocation(call, env.scope, (node) => this.eval(node, env));
    const outerFold = this.foldEnv;
    this.foldEnv = env;
    let v: Val;
    try {
      v = this.invoke({ k: "proc", sym, lit }, args, pos);
    } finally {
      this.foldEnv = outerFold;
    }
    if (v.k === "stmts") throw new NotConstant(`'${sym.name}!' produces statements`, pos);
    if (v.k !== "expr") return v;
    const p = new Parser([...v.toks, { kind: "eof", text: "", pre: "", pos }]);
    const node = p.parseExpr();
    p.expectEnd();
    return this.eval(node, env);
  }

  /** `do!` at compile time: runs the block now and yields what it takes. */
  runBlock(body: Token[], type: string | undefined, pos: Pos): Val {
    const block = new Parser([...body, { kind: "eof", text: "", pre: "", pos }], { take: true }).parseBlock();
    const c = this.block(block, this.foldEnv!);
    if (c.k === "return") throw new CompileError("do!: 'return' cannot leave a block that runs at compile time; use 'take value'", pos);
    if (c.k !== "take") throw new CompileError("do!: the block needs a 'take value'", pos);
    return type ? convert(type, c.v) : c.v;
  }

  /** `comptime! { ... }`: evaluates the block in the transpiler; its value is its single expression, or what it takes. */
  foldBlock(body: Token[], pos: Pos): Val {
    const outer = this.foldEnv;
    const env = outer ? new Env(outer, outer.scope) : new Env(null, this.scope!);
    this.foldEnv = env;
    try {
      const block = new Parser([...body, { kind: "eof", text: "", pre: "", pos }], { take: true }).parseBlock();
      const only = block.stmts.length === 1 ? block.stmts[0] : undefined;
      if (only?.k === "ExprStmt") return this.eval(only.x, env);
      const c = this.block(block, env);
      if (c.k === "take") return c.v;
      if (c.k === "return") throw new CompileError("comptime!: use 'take value' to give the block its value", pos);
      throw new CompileError("comptime!: the block needs a single expression or a 'take value'", pos);
    } finally {
      this.foldEnv = outer;
    }
  }

  private refCell(e: Expr, env: Env): Cell {
    if (e.k === "Ident") {
      const c = env.find(e.name);
      if (c) return c;
    }
    const p = this.place(e, env);
    const cell: Cell = { v: p.get() };
    return cell;
  }

  private compound(e: Extract<Expr, { k: "CompoundLit" }>, env: Env): Val {
    const named = e.elems.some((x) => x.k === "FieldValue");
    if (named) {
      const fields = new Map<string, Val>();
      for (const x of e.elems) if (x.k === "FieldValue") fields.set(x.name, this.eval(x.value, env));
      return { k: "struct", fields };
    }
    return { k: "array", items: e.elems.map((x) => this.eval(x, env)) };
  }

  private call(e: Extract<Expr, { k: "Call" }>, env: Env): Val {
    const fn = e.fn;
    const pos = posOf(e);
    if (fn.k === "Ident" && !env.find(fn.name) && !this.an.lookup(fn.name, env.scope, null)) {
      const b = BUILTINS[fn.name];
      if (b) return b(e.args.map((a) => this.eval(a, env)), pos, this);
      if (BASIC_TYPES.has(fn.name)) return convert(fn.name, this.eval(e.args[0], env));
    }
    if (fn.k === "Selector" && fn.x.k === "Ident" && fn.x.name === "fmt" && !env.find("fmt")) {
      const b = FMT[fn.name];
      if (!b) throw new NotConstant(`fmt.${fn.name} is not available at compile time`, pos);
      return b(e.args.map((a) => this.eval(a, env)), pos, this);
    }
    const f = this.eval(fn, env);
    const args = e.args.map((a) => this.eval(a.k === "FieldValue" ? a.value : a, env));
    if (f.k === "proc") return this.invoke(f, args, pos);
    if (f.k === "type") return convert(f.toks.map((t) => t.text).join(""), args[0]);
    throw new NotConstant(`${f.k} is not callable at compile time`, pos);
  }

  /** A builtin callable at compile time without a declaration (`len`, `min`, a basic type conversion, ...). */
  isBuiltin(name: string): boolean {
    return name in BUILTINS || BASIC_TYPES.has(name);
  }

  fieldsOf(t: Extract<Val, { k: "type" }>, pos: Pos): string[] {
    let node = t.node;
    let scope = t.scope;
    for (let i = 0; node && i < 16 && node.k !== "StructType"; i++) {
      if (node.k !== "Ident" && node.k !== "Selector") break;
      const v = this.eval(node, new Env(null, scope!));
      if (v.k !== "type") break;
      node = v.node;
      scope = v.scope;
    }
    if (node?.k !== "StructType") throw new CompileError(`'${display(t)}' is not a struct type`, pos);
    return node.fields.flatMap((f) => f.names.map((n) => n.name));
  }
}

// ---- helpers ----

function slice(n: { toks: Token[]; start: number; end: number }): Token[] {
  return n.toks.slice(n.start, n.end);
}

function isType(e: Expr): boolean {
  return ["StructType", "UnionType", "EnumType", "TypeExpr", "ProcType", "ClosureType"].includes(e.k);
}

function zero(t: Expr): Val {
  if (t.k === "TypeExpr" && ["dynamic", "slice", "array"].includes(t.what)) return { k: "array", items: [] };
  if (t.k === "Ident") {
    if (t.name === "string") return { k: "string", v: "" };
    if (t.name === "bool") return { k: "bool", v: false };
    if (/^(f16|f32|f64)$/.test(t.name)) return { k: "float", v: 0 };
    if (INT_BITS[t.name]) return { k: "int", v: 0n, ty: t.name };
  }
  return { k: "nil" };
}

/** Integers wrap around like they do at run time. */
export function wrapInt(v: bigint, ty: string | undefined): Val {
  const size = ty ? INT_BITS[ty] : undefined;
  if (!size) return { k: "int", v, ty };
  return { k: "int", v: size[1] ? BigInt.asIntN(size[0], v) : BigInt.asUintN(size[0], v), ty };
}

/** A value stored in a slot of a basic type (a parameter, a typed declaration, a result) takes that type. */
function typed(type: Expr | null | undefined, v: Val): Val {
  return type?.k === "Ident" && BASIC_TYPES.has(type.name) ? convert(type.name, v) : v;
}

/** `x := 1`: an untyped integer constant gets its default type. */
function defaultTyped(v: Val): Val {
  return v.k === "int" && !v.ty ? wrapInt(v.v, "int") : v;
}

function num(v: Val, pos: Pos): number {
  if (v.k === "int") return Number(v.v);
  if (v.k === "float") return v.v;
  throw new CompileError(`expected a number, got ${v.k}`, pos);
}

function truthy(v: Val, pos: Pos): boolean {
  if (v.k !== "bool") throw new CompileError(`expected a bool, got ${v.k}`, pos);
  return v.v;
}

function convert(type: string, v: Val): Val {
  if (v.k !== "int" && v.k !== "float") return v;
  if (/^(f16|f32|f64)$/.test(type)) {
    const f = Number(v.v);
    return { k: "float", v: type === "f64" ? f : Math.fround(f) };
  }
  if (INT_BITS[type]) {
    if (v.k === "float" && !Number.isFinite(v.v)) throw new CompileError(`cannot convert ${v.v} to ${type}`);
    return wrapInt(v.k === "int" ? v.v : BigInt(Math.trunc(v.v)), type);
  }
  return v;
}

function literal(t: Token, pos: Pos): Val {
  switch (t.kind) {
    case "int": {
      const s = t.text.replace(/_/g, "");
      if (!/^(\d+|0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+)$/.test(s)) throw new CompileError(`unsupported literal '${t.text}' at compile time`, pos);
      return { k: "int", v: BigInt(s.replace(/^0[XBO]/, (p) => p.toLowerCase())) };
    }
    case "float":
      return { k: "float", v: Number(t.text.replace(/_/g, "")) };
    case "string":
      return { k: "string", v: t.text.startsWith("`") ? t.text.slice(1, -1) : unescape(t.text.slice(1, -1), pos) };
    case "rune":
      return { k: "int", v: BigInt(unescape(t.text.slice(1, -1), pos).codePointAt(0) ?? 0), ty: "rune" };
  }
  throw new CompileError(`unsupported literal '${t.text}' at compile time`, pos);
}

function unescape(s: string, pos: Pos): string {
  return s.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (_, c: string) => {
    switch (c[0]) {
      case "n": return "\n";
      case "t": return "\t";
      case "r": return "\r";
      case "0": return "\0";
      case "\\": return "\\";
      case "'": return "'";
      case '"': return '"';
      case "x": case "u": case "U": return String.fromCodePoint(parseInt(c.slice(1), 16));
      default: throw new CompileError(`unknown escape '\\${c}'`, pos);
    }
  });
}

function binop(op: string, a: Val, b: Val, pos: Pos): Val {
  if (op === "==") return { k: "bool", v: valEq(a, b) };
  if (op === "!=") return { k: "bool", v: !valEq(a, b) };
  if (a.k === "string" && b.k === "string") {
    if (op === "+") return { k: "string", v: a.v + b.v };
    if (op === "<") return { k: "bool", v: a.v < b.v };
    if (op === ">") return { k: "bool", v: a.v > b.v };
    if (op === "<=") return { k: "bool", v: a.v <= b.v };
    if (op === ">=") return { k: "bool", v: a.v >= b.v };
  }
  if ((a.k !== "int" && a.k !== "float") || (b.k !== "int" && b.k !== "float"))
    throw new CompileError(`operator '${op}' is not supported for ${a.k} and ${b.k} at compile time`, pos);
  if (a.k === "int" && b.k === "int") return intOp(op, a, b, pos);
  const x = Number(a.v);
  const y = Number(b.v);
  switch (op) {
    case "+": return { k: "float", v: x + y };
    case "-": return { k: "float", v: x - y };
    case "*": return { k: "float", v: x * y };
    case "/": return { k: "float", v: x / y };
    case "<": return { k: "bool", v: x < y };
    case ">": return { k: "bool", v: x > y };
    case "<=": return { k: "bool", v: x <= y };
    case ">=": return { k: "bool", v: x >= y };
  }
  throw new CompileError(`operator '${op}' is not supported for floats at compile time`, pos);
}

function intOp(op: string, a: Extract<Val, { k: "int" }>, b: Extract<Val, { k: "int" }>, pos: Pos): Val {
  const ty = a.ty ?? b.ty;
  const x = a.v;
  const y = b.v;
  const nonZero = () => {
    if (y === 0n) throw new CompileError("division by zero at compile time", pos);
  };
  switch (op) {
    case "+": return wrapInt(x + y, ty);
    case "-": return wrapInt(x - y, ty);
    case "*": return wrapInt(x * y, ty);
    case "/": nonZero(); return wrapInt(x / y, ty);
    case "%": nonZero(); return wrapInt(x % y, ty);
    case "%%": nonZero(); return wrapInt(((x % y) + y) % y, ty);
    case "&": return wrapInt(x & y, ty);
    case "|": return wrapInt(x | y, ty);
    case "~": return wrapInt(x ^ y, ty);
    case "&~": return wrapInt(x & ~y, ty);
    case "<<":
    case ">>": {
      if (y < 0n) throw new CompileError("negative shift count at compile time", pos);
      const bits = a.ty ? INT_BITS[a.ty]?.[0] : undefined;
      if (bits !== undefined && y >= BigInt(bits)) return wrapInt(op === "<<" || x >= 0n ? 0n : -1n, a.ty);
      if (y > MAX_SHIFT) throw new CompileError("shift count too large at compile time", pos);
      return wrapInt(op === "<<" ? x << y : x >> y, a.ty);
    }
    case "<": return { k: "bool", v: x < y };
    case ">": return { k: "bool", v: x > y };
    case "<=": return { k: "bool", v: x <= y };
    case ">=": return { k: "bool", v: x >= y };
  }
  throw new CompileError(`operator '${op}' is not supported at compile time`, pos);
}

function valEq(a: Val, b: Val): boolean {
  if (a.k === "int" && b.k === "int") return a.v === b.v;
  if ((a.k === "int" || a.k === "float") && (b.k === "int" || b.k === "float")) return Number(a.v) === Number(b.v);
  if (a.k !== b.k) return false;
  switch (a.k) {
    case "bool": case "string": return a.v === (b as typeof a).v;
    case "ident": return a.name === (b as typeof a).name;
    case "type": case "expr": case "stmts": return display(a) === display(b);
    case "nil": case "void": return true;
    default: return a === b;
  }
}

export function joinTokens(toks: Token[]): string {
  let out = "";
  for (const t of toks) {
    if (t.kind === "semi") {
      out += ";";
      continue;
    }
    const space = out && t.pre !== "" && !/^[),\].]/.test(t.text) && !/[([.]$/.test(out) && !(t.text === "(" && /\w$/.test(out));
    out += (space ? " " : "") + t.text;
  }
  return out;
}

export function display(v: Val): string {
  switch (v.k) {
    case "int": case "float": return String(v.v);
    case "bool": return String(v.v);
    case "string": return v.v;
    case "array": return `[${v.items.map(display).join(", ")}]`;
    case "struct": return `{${[...v.fields].map(([k, x]) => `${k} = ${display(x)}`).join(", ")}}`;
    case "nil": return "nil";
    case "void": return "void";
    case "expr": case "stmts": case "type": return joinTokens(v.toks);
    case "ident": return v.name;
    case "proc": return `proc ${v.sym.name}`;
    case "ref": return `&${display(v.cell.v)}`;
  }
}

function strArg(args: Val[], i: number, name: string, pos: Pos): string {
  const v = args[i];
  if (v?.k !== "string") throw new CompileError(`${name}: argument ${i + 1} must be a string`, pos);
  return v.v;
}

function format(fmt: string, args: Val[]): string {
  let i = 0;
  return fmt.replace(/%[-+ #0-9.]*([vdsfqixXboc%])/g, (m, c: string) => {
    if (c === "%") return "%";
    const v = args[i++];
    if (!v) return m;
    if (c === "q") return JSON.stringify(display(v));
    if (v.k === "int" && "xXbo".includes(c)) {
      const digits = (v.v < 0n ? -v.v : v.v).toString(c === "b" ? 2 : c === "o" ? 8 : 16);
      return (v.v < 0n ? "-" : "") + (c === "X" ? digits.toUpperCase() : digits);
    }
    if (v.k === "int" && c === "c") return String.fromCodePoint(Number(v.v));
    return display(v);
  });
}

type Builtin = (args: Val[], pos: Pos, interp: Interp) => Val;

const COMPARISONS = new Set(["==", "!=", "<", ">", "<=", ">="]);

/** An Expr value's syntax tree (macro arguments carry one; quoted code is parsed on demand). */
function exprNode(v: Extract<Val, { k: "expr" }>, pos: Pos): Expr | undefined {
  if (v.node) return v.node;
  try {
    const p = new Parser([...v.toks, { kind: "eof", text: "", pre: "", pos }]);
    const e = p.parseExpr();
    p.expectEnd();
    return e;
  } catch {
    return undefined;
  }
}

const RANGES = new Set(["..<", "..="]);

function splitBinary(args: Val[], pos: Pos, name: string, ops: Set<string>): Val {
  const v = args[0];
  if (v?.k !== "expr") throw new CompileError(`${name}: expected an Expr`, pos);
  let e = exprNode(v, pos);
  while (e?.k === "Paren") e = e.x;
  if (e?.k !== "Binary" || !ops.has(e.op)) return { k: "array", items: [] };
  const part = (x: Expr): Val => ({ k: "expr", toks: slice(x), node: x, scope: v.scope });
  return { k: "array", items: [part(e.x), { k: "string", v: e.op }, part(e.y)] };
}

/** Whether evaluating `e` twice is the same as evaluating it once: no calls, no macros. */
export function repeatable(e: Expr): boolean {
  switch (e.k) {
    case "Ident": case "Lit": case "ImplicitSelector":
      return true;
    case "Paren": case "Deref": case "Unary": case "Selector":
      return repeatable(e.x);
    case "Binary":
      return repeatable(e.x) && repeatable(e.y);
    case "Index":
      return repeatable(e.x) && e.indices.every((i) => !i || repeatable(i));
  }
  return false;
}

const BUILTINS: Record<string, Builtin> = {
  call_site(_args, pos, interp) {
    const at = interp.callSite ?? pos;
    return { k: "string", v: `${at.file.split(/[\\/]/).pop()}:${at.line}` };
  },
  split_comparison(args, pos) {
    return splitBinary(args, pos, "split_comparison", COMPARISONS);
  },
  split_range(args, pos) {
    return splitBinary(args, pos, "split_range", RANGES);
  },
  comptime_value(args, pos, interp) {
    const body = args[0];
    if (body?.k !== "stmts") throw new CompileError("comptime_value: expected a Stmt", pos);
    try {
      return interp.foldBlock(body.toks, interp.callSite ?? pos);
    } catch (err) {
      if (err instanceof NotConstant) err.message = `comptime!: cannot be evaluated at compile time: ${err.message}`;
      else if (err instanceof CompileError && !err.message.startsWith("comptime!:")) err.message = `comptime!: ${err.message}`;
      throw err;
    }
  },
  block_value(args, pos, interp) {
    const [type, body] = args;
    if (type?.k !== "type" || body?.k !== "stmts") throw new CompileError("block_value: expected a Type and a Stmt", pos);
    const inferred = type.toks.length === 1 && type.toks[0].text === "_";
    if (interp.foldEnv) return interp.runBlock(body.toks, inferred ? undefined : type.toks.map((t) => t.text).join(""), pos);
    return interp.an.blockValue(inferred ? undefined : type.toks, body.toks, interp.scope, interp.callSite ?? pos, ++gensym);
  },
  once(args, pos, interp) {
    const v = args[0];
    if (v?.k !== "expr") throw new CompileError("once: expected an Expr", pos);
    const e = exprNode(v, pos);
    if ((e && repeatable(e)) || interp.foldEnv) return v;
    return interp.an.hoist(v.toks, v.scope, interp.callSite ?? pos, `__once_${++gensym}`);
  },
  is_literal(args, pos) {
    const v = args[0];
    if (v?.k !== "expr") throw new CompileError("is_literal: expected an Expr", pos);
    let e = exprNode(v, pos);
    while (e?.k === "Paren" || (e?.k === "Unary" && e.op === "-")) e = e.x;
    return { k: "bool", v: e?.k === "Lit" };
  },
  parse_expr(args, pos, interp) {
    const text = strArg(args, 0, "parse_expr", pos);
    const at = interp.callSite ?? pos;
    let toks: Token[];
    try {
      toks = lex(text, at.file).filter((t) => t.kind !== "eof" && t.kind !== "semi").map((t) => ({ ...fresh(t, at), origPre: " " }));
      const p = new Parser([...toks, { kind: "eof", text: "", pre: "", pos: at }]);
      p.parseExpr();
      p.expectEnd();
    } catch (err) {
      throw new CompileError(`'${text}' is not a valid expression${err instanceof Error ? `: ${err.message}` : ""}`, at);
    }
    return { k: "expr", toks };
  },
  len(args, pos) {
    const v = args[0];
    if (v?.k === "array") return { k: "int", v: BigInt(v.items.length), ty: "int" };
    if (v?.k === "string") return { k: "int", v: BigInt(new TextEncoder().encode(v.v).length), ty: "int" };
    throw new CompileError("len: expected an array or string", pos);
  },
  append(args, pos) {
    const target = args[0];
    if (target?.k !== "ref" || target.cell.v.k !== "array") throw new CompileError("append: first argument must be &array", pos);
    target.cell.v.items.push(...args.slice(1));
    return { k: "int", v: BigInt(args.length - 1), ty: "int" };
  },
  println(args) {
    process.stderr.write(`[comptime] ${args.map(display).join(" ")}\n`);
    return VOID;
  },
  type_name(args, pos) {
    const t = args[0];
    if (t?.k !== "type") throw new CompileError("type_name: expected a Type", pos);
    return { k: "string", v: display(t) };
  },
  type_fields(args, pos, interp) {
    const t = args[0];
    if (t?.k !== "type") throw new CompileError("type_fields: expected a Type", pos);
    return { k: "array", items: interp.fieldsOf(t, pos).map((v) => ({ k: "string", v }) as Val) };
  },
  type_of_expr(args, pos) {
    const e = args[0];
    if (e?.k !== "expr") throw new CompileError("type_of_expr: expected an Expr", pos);
    const ty = e.ty;
    if (!ty) throw new CompileError("type_of_expr: the type of this expression is not known at compile time", pos);
    if (ty.t === "untyped") return { k: "type", toks: tokensOf({ int: "int", float: "f64", string: "string", rune: "rune", bool: "bool" }[ty.kind], pos) };
    if (ty.t === "node") return { k: "type", toks: slice(ty.node), node: ty.node, scope: ty.scope };
    throw new CompileError("type_of_expr: the type of this expression is not known at compile time", pos);
  },
  stringify(args, pos) {
    if (!args[0]) throw new CompileError("stringify: missing argument", pos);
    return { k: "string", v: display(args[0]) };
  },
  ident(args, pos) {
    const s = strArg(args, 0, "ident", pos);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) throw new CompileError(`ident: '${s}' is not a valid identifier`, pos);
    return { k: "ident", name: s };
  },
  compile_error(args, pos) {
    throw new CompileError(args.map(display).join(" "), pos);
  },
  min(args, pos) {
    return args.reduce((a, b) => (truthy(binop("<", b, a, pos), pos) ? b : a));
  },
  max(args, pos) {
    return args.reduce((a, b) => (truthy(binop(">", b, a, pos), pos) ? b : a));
  },
  abs(args, pos) {
    const v = args[0];
    if (v?.k === "int") return wrapInt(v.v < 0n ? -v.v : v.v, v.ty);
    return { k: "float", v: Math.abs(num(v, pos)) };
  },
};

const FMT: Record<string, Builtin> = {
  tprintf: (args, pos) => ({ k: "string", v: format(strArg(args, 0, "fmt.tprintf", pos), args.slice(1)) }),
  aprintf: (args, pos) => ({ k: "string", v: format(strArg(args, 0, "fmt.aprintf", pos), args.slice(1)) }),
  tprint: (args) => ({ k: "string", v: args.map(display).join(" ") }),
  aprint: (args) => ({ k: "string", v: args.map(display).join(" ") }),
  println: BUILTINS.println,
  printf: (args, pos) => {
    process.stderr.write(`[comptime] ${format(strArg(args, 0, "fmt.printf", pos), args.slice(1))}`);
    return VOID;
  },
};

// ---- code values <-> tokens ----

function fresh(t: Token, pos?: Pos): Token {
  return { kind: t.kind, text: t.kind === "semi" ? ";" : t.text, pre: " ", pos: pos ?? t.pos, origPre: t.origPre ?? t.pre };
}

const NO_SPACE_BEFORE = new Set([")", "]", ",", ".", ";", ":", "..<", "..="]);
const NO_SPACE_AFTER = new Set(["(", "[", ".", "$", "..<", "..="]);
const UNARY = new Set(["-", "+", "!", "&", "^", "~"]);

/** Lines of the macro call: code passed in from there keeps its line breaks and the comments in them. */
export interface CallSpan {
  file: string;
  from: number;
  to: number;
}

/** Gives synthesized tokens conventional spacing (they carry no source whitespace). */
export function respace(toks: Token[], call?: CallSpan): Token[] {
  const valueEnd = (t: Token) => t.kind !== "op" && t.kind !== "kw" && t.kind !== "semi" || [")", "]", "}", "^"].includes(t.text);
  const fromCall = (t: Token) => !!call && t.pos.file === call.file && t.pos.line >= call.from && t.pos.line <= call.to;
  return toks.map((t, i) => {
    if (i === 0) return { ...t, pre: "" };
    const prev = toks[i - 1];
    if (fromCall(t) && fromCall(prev) && t.pos.line > prev.pos.line && t.origPre?.includes("\n")) return { ...t, pre: t.origPre };
    const prevPrev = toks[i - 2];
    let space = true;
    const implicitSelector = t.text === "." && t.kind === "op" && !valueEnd(prev);
    if (t.kind === "semi" || (t.kind === "op" && NO_SPACE_BEFORE.has(t.text) && !implicitSelector)) space = false;
    else if (prev.kind === "op" && NO_SPACE_AFTER.has(prev.text)) space = false;
    else if ((t.text === "(" || t.text === "[") && t.kind === "op" && (valueEnd(prev) || (prev.kind === "kw" && prev.text === "proc"))) space = false;
    else if (t.kind === "op" && t.text === "^" && valueEnd(prev)) space = false;
    // `[]int`, `[dynamic]T`: an identifier only follows `]` in a type
    else if (t.kind === "ident" && prev.kind === "op" && prev.text === "]") space = false;
    else if (prev.kind === "op" && UNARY.has(prev.text) && (!prevPrev || !valueEnd(prevPrev))) space = false;
    return { ...t, pre: space ? " " : "" };
  });
}

/** Lexes a snippet into standalone tokens (no trailing eof). */
export function tokensOf(src: string, pos: Pos): Token[] {
  return lex(src, pos.file).slice(0, -1).map((t) => fresh(t, pos));
}

const ATOMIC = new Set(["Ident", "Lit", "Paren", "Call", "Selector", "Index", "CompoundLit", "Deref", "ImplicitSelector", "MacroCall", "TypeAssert"]);

function isAtomic(toks: Token[], pos: Pos): boolean {
  if (toks.length <= 1) return true;
  try {
    const p = new Parser([...toks, { kind: "eof", text: "", pre: "", pos }]);
    const e = p.parseExpr();
    p.expectEnd();
    return ATOMIC.has(e.k);
  } catch {
    return false;
  }
}

export function valueToTokens(v: Val, pos: Pos, ctx: "expr" | "stmt" | "splice"): Token[] {
  switch (v.k) {
    case "expr": {
      const toks = v.toks.map((t) => fresh(t));
      return ctx !== "stmt" && !isAtomic(toks, pos) ? [fresh(op("(", pos)), ...toks, fresh(op(")", pos))] : toks;
    }
    case "stmts":
    case "type":
      return v.toks.map((t) => fresh(t));
    case "ident":
      return [{ kind: "ident", text: v.name, pre: " ", pos }];
    case "int": {
      const lit: Token = { kind: "int", text: String(v.v < 0n ? -v.v : v.v), pre: " ", pos };
      return v.v < 0n ? [fresh(op("(", pos)), fresh(op("-", pos)), lit, fresh(op(")", pos))] : [lit];
    }
    case "float": {
      const text = Number.isInteger(v.v) ? Math.abs(v.v).toFixed(1) : String(Math.abs(v.v));
      const lit: Token = { kind: "float", text, pre: " ", pos };
      return v.v < 0 ? [fresh(op("(", pos)), fresh(op("-", pos)), lit, fresh(op(")", pos))] : [lit];
    }
    case "string":
      return [{ kind: "string", text: JSON.stringify(v.v), pre: " ", pos }];
    case "bool":
      return [{ kind: "ident", text: String(v.v), pre: " ", pos }];
    case "nil":
      return [{ kind: "ident", text: "nil", pre: " ", pos }];
    case "array": {
      const stmtLike = v.items.every((x) => x.k === "stmts");
      const sep = stmtLike ? { kind: "semi" as const, text: ";", pre: "", pos } : fresh(op(",", pos));
      return v.items.flatMap((x, i) => [...(i ? [sep] : []), ...valueToTokens(x, pos, stmtLike ? "stmt" : ctx)]);
    }
  }
  throw new CompileError(`cannot turn a ${v.k} value into code`, pos);
}

function op(text: string, pos: Pos): Token {
  return { kind: "op", text, pre: "", pos };
}

function isOp(t: Token | undefined, text: string): boolean {
  return !!t && t.kind === "op" && t.text === text;
}

/** Names a quote template declares itself; they are renamed so they cannot capture user code. */
function declaredNames(body: Token[]): Set<string> {
  const names = new Set<string>();
  const atStart = (i: number) => i === 0 || body[i - 1].kind === "semi" || isOp(body[i - 1], "{") || isOp(body[i - 1], "}");
  for (let i = 0; i < body.length; i++) {
    const t = body[i];
    const prevDollar = isOp(body[i - 1], "$");
    if (t.kind === "ident" && !prevDollar && atStart(i)) {
      const group: string[] = [];
      let j = i;
      while (body[j]?.kind === "ident" && !isOp(body[j - 1], "$")) {
        group.push(body[j].text);
        if (!isOp(body[j + 1], ",")) break;
        j += 2;
      }
      const next = body[j + 1];
      if (next && next.kind === "op" && (next.text === ":=" || next.text === ":" || next.text === "::")) group.forEach((n) => names.add(n));
    }
    if (t.kind === "kw" && (t.text === "for" || t.text === "if" || t.text === "switch")) {
      let j = i + 1;
      if (isOp(body[j], "&")) j++;
      const group: string[] = [];
      while (body[j]?.kind === "ident") {
        group.push(body[j].text);
        if (!isOp(body[j + 1], ",")) break;
        j += 2;
        if (isOp(body[j], "&")) j++;
      }
      const next = body[j + 1];
      if (next && ((next.kind === "kw" && next.text === "in") || isOp(next, ":="))) group.forEach((n) => names.add(n));
    }
  }
  names.delete("_");
  return names;
}

function instantiate(body: Token[], kind: "expr" | "stmt", env: Env, interp: Interp, pos: Pos): Val {
  const rename = new Map([...declaredNames(body)].map((n) => [n, `${n}__${++gensym}`]));
  const out: Token[] = [];
  for (let i = 0; i < body.length; i++) {
    const t = body[i];
    if (isOp(t, "$")) {
      const next = body[i + 1];
      if (isOp(next, "$")) {
        out.push(fresh(t));
        i++;
        continue;
      }
      if (next?.kind === "ident") {
        out.push(...valueToTokens(interp.lookup(next.text, env, next.pos), next.pos, "splice"));
        i++;
        continue;
      }
      if (isOp(next, "(")) {
        let depth = 0;
        let j = i + 1;
        for (; j < body.length; j++) {
          if (isOp(body[j], "(")) depth++;
          else if (isOp(body[j], ")") && --depth === 0) break;
        }
        const p = new Parser([...body.slice(i + 2, j), { kind: "eof", text: "", pre: "", pos: t.pos }], { comptimeDepth: 1 });
        const e = p.parseExpr();
        p.expectEnd();
        out.push(...valueToTokens(interp.eval(e, env), t.pos, "splice"));
        i = j;
        continue;
      }
      throw new CompileError("expected an identifier or '(' after '$' (use '$$' for a literal '$')", t.pos);
    }
    const prev = body[i - 1];
    if (t.kind === "ident" && rename.has(t.text) && !isOp(prev, ".") && !isOp(prev, "->") && !isOp(prev, "$")) {
      out.push({ ...fresh(t), text: rename.get(t.text)! });
    } else out.push(fresh(t));
  }
  if (out.length) out[0] = { ...out[0], pre: "" };
  void pos;
  return kind === "expr" ? { k: "expr", toks: out } : { k: "stmts", toks: out };
}

