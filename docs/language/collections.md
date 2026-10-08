# Collections (`vidar.toml`)

No new syntax: a `vidar.toml` next to (or above) a package maps a collection name to a directory, so a package manager only has to write that file.

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

- The nearest `vidar.toml` at or above the importing package applies, so a dependency's own imports resolve against its own manifest, not the root's.
- A collection that is not declared (`core:`, `vendor:`) stays an ordinary Odin import.
- Declared collections are loaded, checked and emitted like relative imports (closures, interfaces and import cycles work across them). The emitted Odin uses relative paths, so no `-collection:` flag is needed.
- Two names that reach one directory (also through a symlink) are one package.

Example: [tests/cases/import_collection](../../tests/cases/import_collection).
