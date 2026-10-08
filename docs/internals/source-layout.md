# Source layout

For how these files fit together, read [Architecture](architecture.md) first.

| File | Role |
|---|---|
| `src/lexer.ts` | Odin lexer with automatic semicolons; keeps whitespace and comments on each token |
| `src/parser.ts` | Odin parser: every node keeps its token range for lossless re-emission |
| `src/analyzer.ts` | scopes, imports and package members, capture rules, best-effort type inference, macro expansion |
| `src/comptime.ts` | interpreter for comptime procs, `quote`/splicing, hygiene |
| `src/race.ts` | `-define:VIDAR_RACE=true`: marks the writes `vidar:sched`'s race check watches |
| `src/sched.ts` | the bundled `vidar:sched` package (scheduler, channels, `select`, nbio-backed I/O) and its stack-switching assembly |
| `src/emitter.ts` | re-emits tokens and lowers closures, interfaces, cross-package references and expansions |
| `src/optimize.ts` | `-opt` rewrites inside a proc: proven bounds checks, allocations freed together, `reserve` before append loops |
| `src/soa.ts` | `-opt`: which local arrays of structs become `#soa` |
| `src/reorder.ts` | `-opt`: struct field reordering |
| `src/valueiface.ts` | `-opt`: interface arrays that hold their values inline |
| `src/jsonopt.ts` | `-opt`: generated `json.marshal` writers |
| `src/jsonread.ts` | `-opt`: generated `json.unmarshal` readers, with encoding/json for anything but strict JSON |
| `src/printers.ts` | `-opt`: generated `%v` / `%#v` printers |
| `src/strswitch.ts` | `-opt`: perfect hashes for string switches |
| `src/stackbuf.ts` | `-opt`: which constant-size `make`s go on the stack |
| `src/escape.ts` | the error for a closure holding `&x` that outlives `x`, through locals and calls (per-proc parameter summaries) |
| `src/autoopt.ts` | `-opt` after analysis: which procs become tables or specialized copies, and the `-opt-report` notes |
| `src/members.ts` | field and enum-member uses, resolved through the analyzer's types after analysis, for the language server (never run by the compiler) |
| `src/checks.ts` | `@(no_alloc)` (what a proc can allocate through) and `@(hot)` (warnings from the `-opt` decisions inside it) |
| `src/fmtspec.ts` | reads `fmt` format strings for `-opt` |
| `src/manifest.ts` | reads `vidar.toml` and resolves declared collection imports to directories |
| `src/project.ts` | loads a program by following imports, groups import cycles (Tarjan's algorithm), and emits the output tree; shared by the CLI and the language server |
| `src/cli.ts` | `build` / `run` / `test` / `check` / `emit` / `fmt` / `map` / `new` / `dap` |
| `src/scaffold.ts` | `vidar new`: the files of a new program or library package |
| `src/paths.ts` | comparing paths from Odin, ols and the editor: on Windows without case and with either slash |
| `src/runmap.ts` | generated `.odin` locations mapped back to `.vidar` lines: compile errors, the line filter on `run` / `test` output, `vidar.map.json` and `vidar map`, and the reverse lookup for *Show Generated Odin* |
| `src/watch.ts` | `--watch`: the files of a program, the watch loop (`fs.watch` on each package directory, polling as the fallback, debounced), and rerunning the command in a child process that is killed on change |
| `src/format.ts` | `vidar fmt`: token-based formatter (indentation, spacing, trailing whitespace), its per-line edits for the language server, and the `fmt` command |
| `src/dap/` | `vidar dap`: `wire.ts` (DAP framing), `translate.ts` (the `.vidar` ↔ generated positions of breakpoints, frames and steps, from `vidar.map.json`) and `proxy.ts` (builds on launch, runs lldb-dap, rewrites messages both ways, steps past generated code, shows a closure's captures as variables) |
| `src/bin.ts` | entry point of the standalone binary (`vidar`, `vidar-lsp`) |
| `src/lsp/` | language server: `features.ts` (index, hover, definition, completion, …), `navigation.ts` (workspace symbols, implementations, call hierarchy), `semantic.ts` (semantic tokens), `actions.ts` (quick fixes), `expand.ts` (the code for the statement at the cursor), `optreport.ts` (`-opt` decisions by proc, for `vidar/optReport` and code lenses), `server.ts` (protocol, `odin check` on save), `workspace.ts` (the workspace index) and `odin.ts` (shadow tree and forwarding to ols) |
| `editors/vscode/` | VS Code extension: grammar, client, the Optimization Report view (`optreport.js`) and the `vidar` debug configuration |
