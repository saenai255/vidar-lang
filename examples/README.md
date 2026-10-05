# Examples

Each example is its own directory, and the directory is the program. Run one with `vidar run examples/<name>` (or `node dist/cli.js run examples/<name>`), and see the generated Odin with `vidar emit examples/<name>`.

| Example | Shows |
|---|---|
| [closures/](closures) | `proc[x, &y]` capture lists, `proc[]`, `closure(...) -> T` types and aliases, closures in structs and arrays, per-iteration loop captures, multiple results, nesting |
| [interfaces/](interfaces) | `interface` / `---` methods / `impl` bindings, static and dynamic method calls, implicit conversions (declarations, arguments, `append`, struct fields, `return`) and explicit `Shape(&x)` |
| [methods/](methods) | method calls as proc groups: static through pointers, fields, indexes and dereferences, dynamic on interface values, and a user-declared `Destroy` interface |
| [anon_structs/](anon_structs) | `x := { name = value, ... }`: struct types declared on the spot, nested literals, closure fields, structural compatibility |
| [errors/](errors) | `or_return <value>`, `catch err { ... }`, `catch { ... }`, `catch unreachable` and `errdefer`, on a small config parser |
| [macros/](macros) | `comptime proc` macros: `Expr(T)`, `Stmt`, `Type` and `Ident` parameters, `quote` and splicing, hygiene, trailing blocks, defaults, reflection, `compile_error` |
| [builtins/](builtins) | the built-in macros `format!`, `dbg!`, `check!`, `with_allocator!`, `locked!`, `timed!`, `todo!`, `unimplemented!` |
| [scoped/](scoped) | the built-in `scoped! { ... }` / `scoped!(allocator) { ... }`: a block with its own temp allocator, freed when the block ends |
| [goroutines/](goroutines) | `go`, channels (`ch <- v`, `<-ch`, close), `select` with a timeout and a default, wait groups, and a TCP echo server over `core:nbio` |
| [cyclic/](cyclic) | packages that import each other (`game` and `ui`) plus one outside the cycle (`util`), sharing an interface, closures, a macro and error handling |

See [SYNTAX.md](../SYNTAX.md) for a reference of all the syntax these use.

Each directory also holds the generated Odin in `expected/` and the program's output in `stdout.txt`. `npm test` checks both; `npm run test:update` regenerates them.
