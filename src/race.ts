import { dirname } from "node:path";
import { children, Expr, Node } from "./ast";
import { A, Analyzer } from "./analyzer";
import { schedSourcePath } from "./project";
import type { Sym, Ty } from "./scope";

/**
 * -define:VIDAR_RACE=true: marks the writes the race check in vidar:sched watches. A write is an
 * assignment whose target is a global variable, or a local captured by reference (`&x`), or a
 * field or fixed-array element of one, held in place (not reached through a pointer, a slice or
 * a map). The emitter writes such a target `x` as `sched.race_w(&x)^` (`_race`), and a captured
 * local's declaration gets a `sched.race_decl(&x)` after it (`_raceDecl`), so its shadow word
 * starts with the goroutine that declared it (a stack address may have held another variable).
 */
export function markRaces(an: Analyzer): void {
  const schedDir = dirname(schedSourcePath());
  if (!an.packages.some((p) => p.dir === schedDir)) return;
  const visit = (n: Node, inDo: boolean): void => {
    if (n.k === "Assign") for (const lhs of n.lhs) if (watched(an, lhs)) A(lhs)._race = true;
    if (n.k === "Block") {
      const isDo = n.toks[n.start]?.text === "do";
      for (const s of n.stmts) {
        if (s.k !== "ValueDecl" || s.isConst || isDo || inDo) continue;
        const names = (A(s)._syms as (Sym | undefined)[] | undefined)?.flatMap((sym) => (sym?.kind === "local" && sym.refCaptured && sym.declKind === "decl" ? [sym.name] : [])) ?? [];
        if (names.length) A(s)._raceDecl = names;
      }
    }
    for (const c of children(n)) visit(c, inDo || (n.k === "Block" && n.toks[n.start]?.text === "do"));
  };
  for (const pkg of an.packages) if (pkg.dir !== schedDir) for (const f of pkg.files) for (const s of f.stmts) visit(s, false);
}

/** Whether a write to `e` writes memory the race check watches. */
function watched(an: Analyzer, e: Expr): boolean {
  return placeOf(an, e) !== undefined;
}

/** The type of `e` when it names memory held in place in a watched variable. */
function placeOf(an: Analyzer, e: Expr): Ty | null | undefined {
  switch (e.k) {
    case "Paren":
      return placeOf(an, e.x);
    case "Ident":
      return rootType(an, A(e)._sym);
    case "Selector": {
      const member: Sym | undefined = A(e)._pkgMember;
      if (member) return rootType(an, member);
      const base = placeOf(an, e.x);
      if (base === undefined) return undefined;
      const n = an.normalize(base ?? undefined);
      // through a pointer, or a type the analyzer can't see: not in place
      if (n?.t !== "node" || n.node.k !== "StructType") return undefined;
      return an.fieldOf(n, e.name) ?? null;
    }
    case "Index": {
      if (e.slice) return undefined;
      const base = placeOf(an, e.x);
      if (base === undefined) return undefined;
      const n = an.normalize(base ?? undefined);
      if (n?.t !== "node" || n.node.k !== "TypeExpr" || n.node.what !== "array") return undefined;
      return an.elemOf(n) ?? null;
    }
  }
  return undefined;
}

/** A watched variable's type (null when unknown, which is fine for the variable itself), or undefined when `sym` isn't watched. */
function rootType(an: Analyzer, sym: Sym | undefined): Ty | null | undefined {
  if (!sym) return undefined;
  if (sym.kind === "global") {
    if (sym.isConst || sym.decl.attrs.some((a) => a.includes("thread_local"))) return undefined;
    if (sym.decl.type) return { t: "node", node: sym.decl.type, scope: sym.scope };
    const v = sym.decl.values[sym.index];
    return (v && an.typeOf(v, sym.scope)) ?? null;
  }
  if (sym.kind === "capture") {
    if (!sym.byRef) return undefined;
    let t: Sym = sym;
    while (t.kind === "capture") t = t.target;
    return t.declKind === "decl" ? t.ty ?? null : undefined;
  }
  if (sym.kind === "local") return sym.refCaptured && sym.declKind === "decl" ? sym.ty ?? null : undefined;
  return undefined;
}
