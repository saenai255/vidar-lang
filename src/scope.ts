import type { Expr, File, ProcSig, Stmt } from "./ast";
import type { Token } from "./lexer";
import type { Val } from "./comptime";

export interface Ctx {
  /** the closure literal this context belongs to (null for plain procs) */
  closure: boolean;
  /** the closure literal itself, for closures */
  lit?: Extract<Expr, { k: "ProcLit" }>;
}

/** A group of packages emitted as one Odin package: a single package, or an import cycle merged together. */
export interface Unit {
  name: string;
  packages: PackageInfo[];
  /** output directory relative to the output root ("" for the entry unit) */
  outDir: string;
  /** more than one package: cycle members are merged and their names prefixed */
  merged: boolean;
}

export interface PackageInfo {
  dir: string;
  /** the name in the `package` clause */
  name: string;
  files: File[];
  scope: Scope;
  fileScopes: Map<File, Scope>;
  /** prepended to member names in the generated Odin ("" unless merged into a cycle) */
  prefix: string;
  unit: Unit;
  /** vidar packages this package imports */
  deps: Set<PackageInfo>;
}

export interface GlobalSym {
  kind: "global";
  name: string;
  odinName: string;
  pkg: PackageInfo;
  isPrivate: boolean;
  isConst: boolean;
  decl: Extract<Stmt, { k: "ValueDecl" }>;
  index: number;
  scope: Scope;
  constVal?: Val;
  evaluating?: boolean;
}

export interface LocalSym {
  kind: "local";
  name: string;
  ctx: Ctx;
  isConst: boolean;
  ty?: Ty;
  value?: Expr;
  scope: Scope;
  refCaptured: boolean;
  /** a parameter that is called as a closure: its proc is read into a local once, on entry */
  closureCalled?: boolean;
  declKind: "decl" | "param" | "range" | "other";
  declTok?: Token;
  /** a constant: the declaration it comes from */
  constDecl?: Extract<Stmt, { k: "ValueDecl" }>;
  /** a constant a closure body uses, moved to file scope with it (as `__Local_N`) */
  lifted?: boolean;
}

export interface CaptureSym {
  kind: "capture";
  name: string;
  byRef: boolean;
  target: LocalSym | CaptureSym;
  ctx: Ctx;
  declTok?: Token;
}

/** An import in one file. `target` is null for collection imports (core:, vendor:, ...). */
export interface PkgSym {
  kind: "pkg";
  name: string;
  path: string;
  target: PackageInfo | null;
  stmt: Extract<Stmt, { k: "Import" }>;
}

export type Sym = GlobalSym | LocalSym | CaptureSym | PkgSym;

export type Ty =
  | { t: "node"; node: Expr; scope: Scope }
  | { t: "ptr"; elem: Ty }
  | { t: "sig"; closure: boolean; sig: ProcSig; scope: Scope }
  | { t: "untyped"; kind: "int" | "float" | "string" | "rune" | "bool" };

export class Scope {
  syms = new Map<string, Sym>();
  constructor(
    public parent: Scope | null,
    /** set on a package's top-level scope */
    public pkg: PackageInfo | null = null,
    /** set on the outermost scope of a procedure body */
    public procRoot: Ctx | null = null,
  ) {}

  get ctx(): Ctx | null {
    for (let s: Scope | null = this; s; s = s.parent) if (s.procRoot) return s.procRoot;
    return null;
  }

  get package(): PackageInfo | null {
    for (let s: Scope | null = this; s; s = s.parent) if (s.pkg) return s.pkg;
    return null;
  }
}
