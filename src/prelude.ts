import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The built-in library: macros available in every file without an import. It is written in
 * Vidar itself (prelude.vidar); user declarations with the same names shadow these. Expansions
 * call helpers in the generated `vidar_runtime` package (spelled `__vidar` in generated code), so
 * using them needs no imports.
 */
export const PRELUDE_PATH = "<vidar prelude>";

// inlined by the binary bundle
declare const VIDAR_PRELUDE: string | undefined;

export const PRELUDE_SOURCE = typeof VIDAR_PRELUDE === "string" ? VIDAR_PRELUDE : readFileSync(join(__dirname, "prelude.vidar"), "utf8");
