# Reference sources

The examples and notes behind the generated pages of the book (`scripts/gen-docs.js`). Each file has one
`## name` section per entry; the generator puts the section's text under the entry's description, which
comes from the compiler's sources. Every entry needs a section, with at least one example (`vidar`, or
`bash` for build flags), and a section for a name the compiler doesn't have is an error.

| File | Entries | Descriptions from |
|---|---|---|
| `keywords.md` | keywords | `KEYWORD_DOCS` in `src/lsp/docs.ts` |
| `attributes.md` | `@(...)` attributes | `ATTRIBUTE_DOCS` |
| `directives.md` | `#...` directives | `DIRECTIVE_DOCS` |
| `builtin-procs.md` | built-in procedures | `BUILTIN_PROC_DOCS` |
| `builtin-types.md` | built-in types | `BUILTIN_TYPE_DOCS` |
| `constants.md` | `ODIN_*` constants | `ODIN_CONSTANT_DOCS` |
| `context.md` | `context` fields | `CONTEXT_FIELD_DOCS` |
| `comptime.md` | comptime helpers and macro parameter kinds | `COMPTIME_BUILTIN_DOCS`, `MACRO_KIND_DOCS` |
| `macros.md` | built-in macros | the comments in `src/prelude.vidar` |
| `build-flags.md` | `-define:VIDAR_*` flags | the comments above each `#config` in `src/sched.ts` and `src/emitter.ts` |
| `rc.md` | `vidar:rc` | the comments in `src/rc.ts` |
| `sched.md` | `vidar:sched` | the comments in `src/sched.ts` |
| `errors.md` | compile errors | `tests/errors/` and `tests/errors_pkg/`: say what went wrong and show a program that compiles |

Code blocks follow the book's rules (see `scripts/docblocks.js`): a `vidar` block is compiled, and run when
an `output` block follows it. Run `npm run docs:gen`, then `npm run test:docs -- --only reference` (or
`--only appendix`) to check them.
