# Cyclic imports

Odin rejects import cycles. Vidar accepts them:

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

vidar loads the entry package and every package it imports by relative path (`core:`/`vendor:` collection imports stay ordinary Odin imports). It then finds the groups of packages that import each other (strongly connected components of the import graph):

- **A package not in a cycle** stays its own Odin package, in its own output directory.
- **Packages in a cycle** are merged into one Odin package (`game_ui/` above). Each one's members get its name as a prefix: `ui.render` becomes `ui__render`, `game.World` becomes `game__World`. That prefixing is scope-aware, so locals and struct fields are untouched. Imports between members of the cycle disappear. Importers outside the cycle import the merged package under their original alias, so `game.run(...)` becomes `game.game__run(...)`.
- If the entry package is part of a cycle, it keeps its own names, so `main` stays `main`.
- `@(private)` still means private to the original package, and vidar enforces it even after merging.
- `vidar run`/`check`/`test` map Odin's errors and panics back to the `.vidar` files and lines.

See [examples/cyclic](../../examples/cyclic) for a cycle that shares an interface, closures and a macro, with a separate `util` package outside the cycle. [tests/cases/import_cycles](../../tests/cases/import_cycles) covers a three-package cycle, a cycle that includes the entry package, and the same names declared in several packages.
