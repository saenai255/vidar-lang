# Collections (`vidar.toml`)

There is no new syntax. A `vidar.toml` next to (or above) a package maps a collection name to a directory, so a package manager only has to write that file.

```toml
[package]                       # reserved, ignored for now
name = "app"

[collections]
gsw = "./vendor/gsw"            # relative to this file
ui  = "~/.vidar/pkg/ui@1.2.0"   # `~/` and absolute paths work too
```

```odin
import "gsw:greeter"            // -> ./vendor/gsw/greeter, a Vidar package like any relative import
```

## Rules

- **Which manifest applies.** The nearest `vidar.toml` at or above the importing package. A dependency's own imports resolve against its own manifest, not the root's.
- **Undeclared collections** (`core:`, `vendor:`) stay ordinary Odin imports.
- **Declared collections** are loaded, checked and emitted like relative imports. Closures, interfaces and import cycles work across them.
- **No `-collection:` flag.** The emitted Odin uses relative paths.
- **One directory, one package.** Two names that reach the same directory (also through a symlink) are one package.

## Example

[tests/cases/import_collection](../../tests/cases/import_collection)
