import { basename } from "node:path";
import { Expr, Node } from "./ast";
import { A, Analyzer, posOf, unwrapProc } from "./analyzer";
import { CompileError } from "./lexer";
import { kids } from "./optimize";
import type { GlobalSym, Sym } from "./scope";

type ProcLit = Extract<Expr, { k: "ProcLit" }>;

/**
 * Promises a proc's attributes make, checked by the compiler:
 * - `@(no_alloc)`: nothing the proc runs can allocate (an error otherwise)
 * - `@(hot)`: every -opt decision against something inside it is a warning
 */

const ALLOCATING_BUILTINS = new Set(["make", "new", "new_clone", "append", "append_elems", "append_elem", "append_string", "append_soa", "append_nothing",
  "non_zero_append", "inject_at", "inject_at_elem", "inject_at_elems", "assign_at", "assign_at_elem", "assign_at_elems", "resize", "non_zero_resize",
  "reserve", "non_zero_reserve", "shrink", "make_map", "make_map_cap", "make_dynamic_array", "make_dynamic_array_len", "make_dynamic_array_len_cap",
  "make_slice", "make_multi_pointer", "make_soa", "map_insert", "map_upsert", "map_entry"]);

const QUIET_BUILTINS = new Set(["len", "cap", "min", "max", "abs", "clamp", "size_of", "align_of", "offset_of", "offset_of_by_string", "type_of", "typeid_of",
  "type_info_of", "raw_data", "swizzle", "complex", "quaternion", "real", "imag", "jmag", "kmag", "conj", "transmute", "auto_cast", "cast", "copy",
  "copy_slice", "copy_from_string", "delete", "delete_key", "free", "free_all", "clear", "pop", "pop_safe", "pop_front", "pop_front_safe",
  "unordered_remove", "ordered_remove", "remove_range", "panic", "assert", "assert_contextless", "ensure", "unreachable", "unimplemented", "card",
  "expand_values", "compress_values", "soa_zip", "soa_unzip", "string", "cstring", "rune", "bool", "b8", "b16", "b32", "b64", "int", "uint", "i8",
  "i16", "i32", "i64", "i128", "u8", "u16", "u32", "u64", "u128", "uintptr", "byte", "f16", "f32", "f64", "rawptr", "typeid", "any", "complex64",
  "complex128", "quaternion256", "container_of", "init_global_temporary_allocator"]);

/** core packages none of whose procs allocate */
const QUIET_PACKAGES = new Set(["base:intrinsics", "core:intrinsics", "core:math", "core:math/linalg", "core:math/bits", "core:simd", "core:unicode",
  "core:unicode/utf8", "core:sync"]);

/** procs in other core packages known not to allocate */
const QUIET_PROCS: Record<string, string[]> = {
  "core:fmt": ["print", "println", "printf", "printfln", "eprint", "eprintln", "eprintf", "eprintfln", "fprint", "fprintln", "fprintf", "fprintfln",
    "bprint", "bprintln", "bprintf", "bprintfln", "wprint", "wprintln", "wprintf", "wprintfln"],
  "core:strings": ["has_prefix", "has_suffix", "contains", "contains_rune", "contains_any", "index", "index_byte", "index_rune", "index_any",
    "last_index", "last_index_byte", "last_index_any", "compare", "equal_fold", "count", "trim", "trim_space", "trim_left", "trim_right",
    "trim_prefix", "trim_suffix", "trim_null", "builder_len", "builder_cap", "builder_space", "builder_reset", "to_string", "builder_from_bytes",
    "truncate_to_byte", "truncate_to_rune", "rune_count", "prefix_length", "common_prefix", "cut", "split_iterator", "split_lines_iterator", "fields_iterator"],
  "core:time": ["now", "since", "diff", "tick_now", "tick_since", "tick_diff", "tick_lap_time", "duration_nanoseconds", "duration_microseconds",
    "duration_milliseconds", "duration_seconds", "duration_minutes", "duration_hours", "sleep", "to_unix_seconds", "to_unix_nanoseconds",
    "stopwatch_start", "stopwatch_stop", "stopwatch_reset", "stopwatch_duration"],
  "core:mem": ["copy", "copy_non_overlapping", "set", "zero", "zero_item", "zero_slice", "compare", "compare_ptrs", "ptr_offset", "ptr_sub",
    "slice_ptr", "byte_slice", "slice_to_bytes", "slice_data_cast", "any_to_bytes", "is_power_of_two", "align_forward_int", "align_forward_uintptr",
    "panic_allocator", "nil_allocator"],
  "core:slice": ["contains", "linear_search", "binary_search", "binary_search_by", "reverse", "swap", "swap_between", "sort", "sort_by",
    "sort_by_key", "is_sorted", "is_sorted_by", "equal", "simple_equal", "min", "max", "min_max", "sum", "product", "first", "last", "fill",
    "zero", "rotate_left", "rotate_right", "has_prefix", "has_suffix", "to_bytes", "reinterpret", "count", "any_of", "all_of", "none_of"],
};

/** procs in core packages that allocate */
const ALLOCATING_PROCS: Record<string, string[]> = {
  "core:fmt": ["aprint", "aprintln", "aprintf", "aprintfln", "tprint", "tprintln", "tprintf", "tprintfln", "caprint", "caprintln", "caprintf",
    "ctprint", "ctprintln", "ctprintf", "sbprint", "sbprintln", "sbprintf", "sbprintfln"],
  "core:strings": ["clone", "clone_to_cstring", "clone_from_bytes", "clone_from_cstring", "concatenate", "join", "split", "split_n", "split_after",
    "split_lines", "fields", "repeat", "replace", "replace_all", "remove", "remove_all", "to_upper", "to_lower", "to_snake_case", "to_camel_case",
    "builder_make", "builder_make_none", "builder_make_len", "builder_make_len_cap", "builder_init", "write_string", "write_byte", "write_rune",
    "write_int", "write_uint", "write_f64", "write_quoted_string", "write_escaped_rune"],
  "core:slice": ["clone", "clone_to_dynamic", "concatenate", "filter", "mapper", "to_dynamic"],
  "core:mem": ["alloc", "alloc_bytes", "make", "new", "new_clone", "resize", "clone_slice"],
};

interface Found {
  /** the node in the proc being checked that leads to the allocation */
  at: Node;
  /** the allocation, or why the call can't be checked */
  what: string;
  /** where the allocation itself is */
  where: Node;
  /** procs from the one checked down to the one allocating */
  chain: string[];
  /** a call that can't be checked, rather than an allocation */
  unknown?: boolean;
}

const BUSY = Symbol("busy");

/** Finds what a proc can allocate through; memoized per proc literal, with recursion assumed not to allocate. */
class AllocFinder {
  private memo = new Map<ProcLit, Found | null | typeof BUSY>();

  constructor(private an: Analyzer) {}

  proc(lit: ProcLit, name: string): Found | null {
    const known = this.memo.get(lit);
    if (known === BUSY) return null;
    if (known !== undefined) return known;
    this.memo.set(lit, BUSY);
    let found: Found | null = null;
    if (lit.body) {
      const visit = (n: Node): boolean => {
        if (found) return false;
        if (n.k === "ProcLit") return false;
        const f = this.node(n);
        if (f) {
          found = { ...f, at: n, chain: [name, ...f.chain] };
          return false;
        }
        for (const c of kids(n)) visit(c);
        return true;
      };
      for (const s of lit.body.stmts) visit(s);
    }
    this.memo.set(lit, found);
    return found;
  }

  /** The allocation `n` itself makes, or the one a proc it calls makes. */
  node(n: Node): Omit<Found, "at"> | null {
    const own = (what: string, unknown = false) => ({ what, where: n, chain: [], unknown });
    if (n.k === "CompoundLit" && n.type) {
      const what = this.typeKind(n.type);
      if (what === "dynamic" || what === "map") return own(`a ${what === "map" ? "map" : "[dynamic]"} literal`);
    }
    if (n.k === "Assign" && n.lhs.some((l) => l.k === "Index" && !l.slice && this.isMap(l.x))) return own("an insert into a map");
    if (n.k === "ArrowCall") return own(`'->${n.name}' calls through a vtable whose targets aren't known`, true);
    if (n.k !== "Call") return null;
    if (A(n)._ifaceConv) return null;
    if (A(n)._closure) return own(`calls '${text(n.fn)}' through a closure, whose targets aren't known`, true);
    return this.callee(n, n.fn);
  }

  private callee(call: Node, fn: Expr): Omit<Found, "at"> | null {
    const own = (what: string, unknown = true) => ({ what, where: call, chain: [], unknown });
    while (fn.k === "Paren") fn = fn.x;
    if (fn.k === "Selector" && fn.x.k === "Ident") {
      const pkg: Sym | undefined = A(fn.x)._sym;
      if (pkg?.kind === "pkg" && !pkg.target) {
        if (QUIET_PACKAGES.has(pkg.path) || QUIET_PROCS[pkg.path]?.includes(fn.name)) return null;
        if (ALLOCATING_PROCS[pkg.path]?.includes(fn.name)) return own(`${pkg.name}.${fn.name}`, false);
        return own(`'${pkg.name}.${fn.name}' (${pkg.path}) isn't on the list of procs known not to allocate`);
      }
    }
    const sym: Sym | undefined = fn.k === "Ident" ? A(fn)._sym : fn.k === "Selector" ? A(fn)._pkgMember : undefined;
    if (!sym) {
      if (fn.k !== "Ident") return isTypeExpr(fn) ? null : own(`calls '${text(fn)}', whose target isn't known`);
      if (ALLOCATING_BUILTINS.has(fn.name)) return own(fn.name, false);
      if (QUIET_BUILTINS.has(fn.name)) return null;
      return own(`'${fn.name}' isn't known not to allocate`);
    }
    if (sym.kind === "global") return this.global(call, sym);
    // `T(x)` with a polymorphic type `$T`: a conversion
    if (sym.kind === "local" && this.an.polyTypes.has(sym)) return null;
    if (sym.kind === "local" && sym.isConst && sym.value) {
      const lit = unwrapProc(sym.value);
      return lit ? this.through(lit, sym.name) : null;
    }
    return own(`calls '${text(fn)}', a proc value whose target isn't known`);
  }

  private global(call: Node, sym: GlobalSym): Omit<Found, "at"> | null {
    const own = (what: string) => ({ what, where: call, chain: [], unknown: true });
    const value = sym.decl.values[sym.index];
    if (!sym.isConst || !value) return own(`calls '${sym.name}', a proc value whose target isn't known`);
    const lit = unwrapProc(value);
    if (lit?.body) return this.through(lit, sym.name);
    if (lit) {
      const method = this.an.ifaceMethods.get(sym);
      if (!method) return own(`'${sym.name}' has no body to check`);
      if (!this.an.isClosed(method.iface)) return own(`calls '${sym.name}' on interface '${method.iface.name}', whose impls aren't all known`);
      for (const impl of this.an.impls) {
        if (impl.iface !== method.iface && !this.an.ancestorsOf(impl.iface).includes(method.iface)) continue;
        const bound = impl.methods.get(method.name);
        const f = bound && this.global(call, bound);
        if (f) return f;
      }
      return null;
    }
    if (value.k === "ProcGroup") {
      for (const p of value.procs) {
        const f = this.callee(call, p);
        if (f) return f;
      }
      return null;
    }
    // a type: a conversion
    return null;
  }

  private through(lit: ProcLit, name: string): Omit<Found, "at"> | null {
    const f = this.proc(lit, name);
    return f && { what: f.what, where: f.where, chain: f.chain, unknown: f.unknown };
  }

  private typeKind(t: Expr): string | undefined {
    const n = this.an.normalize({ t: "node", node: t, scope: this.an.global });
    return n?.t === "node" && n.node.k === "TypeExpr" ? n.node.what : undefined;
  }

  private isMap(e: Expr): boolean {
    let n = this.an.normalize(this.an.typeOf(e, this.an.global));
    if (n?.t === "ptr") n = this.an.normalize(n.elem);
    return n?.t === "node" && n.node.k === "TypeExpr" && n.node.what === "map";
  }
}

function text(e: Expr): string {
  return e.toks.slice(e.start, e.end).map((t, i) => (i ? t.pre.replace(/\s+/g, " ") : "") + t.text).join("").trim();
}

function isTypeExpr(e: Expr): boolean {
  return e.k === "TypeExpr" || e.k === "StructType" || e.k === "UnionType" || e.k === "EnumType" || e.k === "ProcType";
}

const where = (n: Node) => `${basename(posOf(n).file)}:${posOf(n).line}`;

/** Errors for every @(no_alloc) proc that can allocate. */
/** Checks every @(no_alloc) proc; `guard` collects or throws each error. */
export function checkNoAlloc(an: Analyzer, guard: (f: () => void) => void): void {
  const finder = new AllocFinder(an);
  for (const [sym, lit] of an.noAllocProcs) {
    guard(() => {
      const f = finder.proc(lit, sym.name);
      if (!f) return;
      const via = f.chain.length > 1 ? `, reached through ${f.chain.join(" -> ")} at ${where(f.where)}` : "";
      throw new CompileError(`@(no_alloc) '${sym.name}' ${f.unknown ? "can't be checked" : "can allocate"}: ${f.what}${via}`, posOf(f.at));
    });
  }
}

/** labels that are decisions against, on top of those starting with "no" / "not" */
const AGAINST = new Set(["vtable", "closure not inlined"]);

export function isAgainst(label: string): boolean {
  return /^(no|not)\b/.test(label) || AGAINST.has(label);
}

/** -opt decisions against something inside each @(hot) proc, and allocations in its loops; needs `an.hints`. */
export function hotWarnings(an: Analyzer): CompileError[] {
  const out: CompileError[] = [];
  if (!an.optimize) return out;
  const seen = new Set<string>();
  const warn = (at: Node, msg: string) => {
    const p = posOf(at);
    const key = `${p.file}:${p.line}:${p.col}:${msg}`;
    if (!seen.has(key)) seen.add(key), out.push(new CompileError(msg, p));
  };
  const finder = new AllocFinder(an);
  for (const [sym, lit] of an.hotProcs) {
    const inside = (n: Node) => n.toks === lit.toks && n.start >= lit.start && n.end <= lit.end && n !== sym.decl;
    for (const h of an.hints ?? []) {
      if (inside(h.at) && isAgainst(h.label)) warn(h.at, `@(hot) '${sym.name}': ${h.label}${h.tooltip ? `: ${h.tooltip}` : ""}`);
    }
    const loops = (n: Node, depth: number): void => {
      if (n.k === "ProcLit" && n !== lit) return;
      if (depth) {
        const f = finder.node(n);
        if (f && !f.chain.length && !f.unknown) warn(n, `@(hot) '${sym.name}': allocates in a loop: ${f.what}`);
      }
      const inLoop = n.k === "For" || n.k === "RangeFor" ? 1 : 0;
      for (const c of kids(n)) loops(c, depth + inLoop);
    };
    if (lit.body) loops(lit.body, 0);
  }
  return out.sort((a, b) => a.pos!.file.localeCompare(b.pos!.file) || a.pos!.line - b.pos!.line || a.pos!.col - b.pos!.col);
}
