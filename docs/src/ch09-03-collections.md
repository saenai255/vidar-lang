# Collections and `vidar.toml`

Odin's `core:` and `vendor:` prefixes are *collections*: names for a directory of packages, so `import "core:fmt"` doesn't need a path. Vidar lets a project declare collections of its own, in a `vidar.toml` file. There's no new syntax; a package manager only has to write that file and put the packages where it says.

```toml,project=collections,file=vidar.toml
[package]
name = "app"

[collections]
greet = "./vendor/greet"
```

```vidar,project=collections,file=main.vidar
package main

import "core:fmt"
import "greet:hello"

main :: proc() {
	fmt.println(hello.greeting("vidar"))
}
```

```vidar,project=collections,file=vendor/greet/hello/hello.vidar
package hello

import "core:fmt"

greeting :: proc(name: string) -> string {
	return fmt.tprintf("hello, %s", name)
}
```

<span class="caption">Listing 9-3: Importing a package through a collection declared in `vidar.toml`</span>

```output
hello, vidar
```

```text
app/
├── vidar.toml           [collections] greet = "./vendor/greet"
├── main.vidar           import "greet:hello"
└── vendor/
    └── greet/
        └── hello/
            └── hello.vidar
```

## The Rules

- **Paths** in `[collections]` are relative to the `vidar.toml` file. `~/` and absolute paths work too, so a package manager can keep packages in one place: `ui = "~/.vidar/pkg/ui@1.2.0"`.
- **Which file applies.** The nearest `vidar.toml` at or above the importing package. A dependency's own imports resolve against its own `vidar.toml`, not the root project's.
- **Declared collections** are loaded, checked and emitted like relative imports. Closures, interfaces and macros work across them; import cycles through them don't.
- **Undeclared collections** (`core:`, `vendor:`) stay ordinary Odin imports.
- **No `-collection:` flag is needed.** The generated Odin uses relative paths.
- **One directory is one package**, even when two names reach it, through a symlink for example.
- `[package]` is reserved for package managers, and ignored for now.

## Summary

- A package is a directory; a program is its entry package and everything it imports by relative path.
- Packages may import each other; a cycle becomes one Odin package, with prefixed names.
- `vidar.toml` maps collection names to directories, for `import "name:pkg"`.
