# Cyclic imports

Odin rejects import cycles. Vidar accepts them.

```odin
// game/game.vidar
package game
import "../ui"

World  :: struct { entities: [dynamic]Entity }
Entity :: interface { draw }
draw   :: proc(e: Entity) -> string ---

run :: proc(w: ^World) -> string { return ui.render(w) }
```

```odin
// ui/ui.vidar
package ui
import "../game"

Button :: struct { text: string }
button_draw :: proc(b: ^Button) -> string { return b.text }
impl game.Entity for Button { draw = button_draw }

render :: proc(w: ^game.World) -> string { ... }
```

## How it works

1. **Load.** Vidar loads the entry package and every package it imports by relative path. `core:` and `vendor:` collection imports stay ordinary Odin imports.
2. **Group.** It finds the groups of packages that import each other (strongly connected components of the import graph).
3. **Emit.** Each group becomes one Odin package; everything else stays as it is.

| Package | Result |
|---|---|
| not in a cycle | stays its own Odin package, in its own output directory |
| in a cycle | merged with the others into one Odin package (`game_ui/` above) |

## What the output looks like

For [examples/cyclic](../../examples/cyclic), where `game` and `ui` import each other and `util` doesn't:

```
examples/cyclic/            out/ (from `vidar build examples/cyclic -o out`)
├── main.vidar              ├── main.odin
├── game/game.vidar         ├── game_ui/game__game.odin     ← game and ui merged
├── ui/ui.vidar             ├── game_ui/ui__ui.odin
└── util/util.vidar         ├── util/util.odin              ← not in a cycle: its own package
                            ├── vidar_runtime/runtime.odin
                            └── vidar.map.json
```

## What merging does

- **Prefixes.** Each merged package's members get its name as a prefix: `ui.render` becomes `ui__render`, and `game.World` becomes `game__World`. The prefixing is scope-aware, so locals and struct fields are untouched.
- **Imports disappear** between members of the cycle.
- **Importers outside the cycle** import the merged package under their original alias, so `game.run(...)` becomes `game.game__run(...)`.
- **The entry package keeps its own names** if it is part of a cycle, so `main` stays `main`.
- **`@(private)`** still means private to the original package, and vidar enforces it even after merging.
- **Errors and panics** from `vidar run`, `check` and `test` are mapped back to the `.vidar` files and lines.

## Examples

- [examples/cyclic](../../examples/cyclic): a cycle that shares an interface, closures and a macro, with a separate `util` package outside the cycle.
- [tests/cases/import_cycles](../../tests/cases/import_cycles): a three-package cycle, a cycle that includes the entry package, and the same names declared in several packages.

## Related

- [Interfaces](interfaces.md#packages): an `impl` for another package's interface needs to be in that package or in a cycle with it.
- [Limits](../limits.md): foreign procs in cycles, and only relative imports can cycle.
