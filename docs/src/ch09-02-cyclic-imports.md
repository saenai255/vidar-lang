# Cyclic Imports

Odin rejects import cycles: if package `game` imports `ui`, then `ui` can't import `game`. The usual fix is to move whatever both need into a third package, which works, but which splits code by the shape of the import graph rather than by what it does.

Vidar accepts cycles. Here `game` defines an `Entity` interface and the world, and `ui` defines a button that implements `Entity`, and needs to read the world to draw it:

```vidar,project=cyclic,file=main.vidar
package main

import "core:fmt"
import "game"

main :: proc() {
	w := game.make_world()
	defer game.destroy_world(&w)
	fmt.println(game.run(&w))
}
```

```vidar,project=cyclic,file=game/game.vidar
package game

import "../ui"

Entity :: interface { draw }
draw :: proc(e: Entity) -> string ---

World :: struct {
	entities: [dynamic]Entity,
	frame:    int,
}

make_world :: proc() -> World {
	w: World
	append(&w.entities, ui.make_button("start"))
	return w
}

destroy_world :: proc(w: ^World) {
	for e in w.entities do free(e.data)
	delete(w.entities)
}

run :: proc(w: ^World) -> string {
	w.frame += 1
	return ui.render(w)
}
```

```vidar,project=cyclic,file=ui/ui.vidar
package ui

import "core:fmt"
import "core:strings"
import "../game"

Button :: struct { text: string }

button_draw :: proc(b: ^Button) -> string { return fmt.tprintf("[%s]", b.text) }

impl game.Entity for Button { draw = button_draw }

make_button :: proc(text: string) -> ^Button {
	return new_clone(Button{text})
}

render :: proc(w: ^game.World) -> string {
	sb := strings.builder_make(context.temp_allocator)
	fmt.sbprintf(&sb, "frame %d:", w.frame)
	for e in w.entities do fmt.sbprintf(&sb, " %s", game.draw(e))
	return strings.to_string(sb)
}
```

<span class="caption">Listing 9-2: `game` and `ui` import each other</span>

```output
frame 1: [start]
```

Notice `impl game.Entity for Button` in `ui`. An `impl` of another package's interface is only allowed in the interface's package or in a package in an import cycle with it ([Chapter 5](ch05-03-generic-impls.md#interfaces-across-packages)), and this cycle is what makes it possible.

## How It Works

1. **Load.** Vidar loads the entry package and every package it imports by relative path.
2. **Group.** It finds the groups of packages that import each other: the strongly connected components of the import graph.
3. **Emit.** Each group becomes one Odin package. Packages that aren't in a cycle stay packages of their own.

For Listing 9-2, `vidar build` writes:

```text
out/cyclic/
├── main.odin
├── game_ui/
│   ├── game__game.odin        game and ui, merged
│   └── ui__ui.odin
├── vidar_runtime/
│   └── runtime.odin
└── vidar.map.json
```

## What Merging Does

- **Prefixes.** Each merged package's members get its name as a prefix: `ui.render` becomes `ui__render`, and `game.World` becomes `game__World`. The renaming knows about scopes, so locals and struct fields keep their names.
- **Imports between members of the cycle disappear.**
- **Packages outside the cycle** import the merged package under their original name, so `game.run(&w)` in `main` becomes `game.game__run(&w)`.
- **The entry package keeps its own names** if it's in a cycle, so `main` stays `main`.
- **`@(private)` still means private to the original package**, and Vidar enforces it even after merging.
- **Errors and panics** are mapped back to the original files and lines.

Two limits come from the merging: procedures declared in `foreign` blocks of packages in a cycle aren't prefixed, so they must not clash; and only relative imports can be part of a cycle, so packages reached through a collection (`core:`, or one from `vidar.toml`) can't.

The repository's [`examples/cyclic`](../../examples/cyclic) is a larger version, with a closure and a macro shared across the cycle and a `util` package outside it.
