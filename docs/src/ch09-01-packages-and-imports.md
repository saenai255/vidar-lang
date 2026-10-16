# Packages and Imports

A *package* is a directory. Every `.vidar` and `.odin` file in it belongs to the package, and all of them must start with the same `package name` line. Names declared at file scope in any of the files are visible in all of them.

A program is its entry package, the directory you pass to `vidar run` or `vidar build`, plus every package it imports by relative path. Here is a program with two packages:

```vidar,project=shapes,file=main.vidar
package main

import "core:fmt"
import "geometry"

main :: proc() {
	sq := geometry.Square{3}
	fmt.println(geometry.area(&sq))
	fmt.println(geometry.describe(&sq))
}
```

```vidar,project=shapes,file=geometry/geometry.vidar
package geometry

import "core:fmt"

Shape :: interface { area }
area :: proc(s: Shape) -> f64 ---

Square :: struct { side: f64 }

@(private)
square_area :: proc(s: ^Square) -> f64 { return s.side * s.side }

impl Shape for Square { area = square_area }

describe :: proc(s: Shape) -> string {
	return fmt.tprintf("a shape of area %.1f", area(s))
}
```

<span class="caption">Listing 9-1: A program in two packages</span>

```output
9
a shape of area 9.0
```

```text
shapes/
├── main.vidar
└── geometry/
    └── geometry.vidar
```

A few things to notice:

- `import "geometry"` is a path relative to the importing file's directory. Imports of your own packages always use relative paths: `"geometry"`, `"../util"`.
- `core:` and `vendor:` imports work as in Odin, and so do `vidar:sched` and `vidar:rc`, which come with the compiler.
- Members of another package are reached through its name: `geometry.Square`, `geometry.area`. Interface methods, closures and macros work across packages like anything else.
- `@(private)` hides a declaration from other packages, and `@(private="file")` from other files. `main` couldn't call `geometry.square_area`, though it can call `area`, which dispatches to it.

## What a Build Writes

`vidar build` writes one Odin package per Vidar package, in the same layout, plus the generated runtime package if the program needs it:

```text
out/shapes/
├── main.odin
├── geometry/
│   └── geometry.odin
├── vidar_runtime/
│   └── runtime.odin
└── vidar.map.json
```

Odin then compiles that tree as an ordinary multi-package program.
