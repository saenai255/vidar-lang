# Editors and the Language Server

`vidar-lsp` is a language server: it speaks the standard Language Server Protocol over stdio, so any editor that supports LSP can use it. It analyzes the program the open file belongs to, that package plus everything it imports, using unsaved editor contents, and rechecks every open program a file belongs to when you edit it.

## Setting Up an Editor

### VS Code

Install the Vidar extension from [`editors/vscode`](../../editors/vscode) (`npm run vsix` packages and installs it). It runs `vidar-lsp` from your `PATH`, or the path in the `vidar.server.path` setting. It adds highlighting, the commands described below, a `vidar` debug configuration, and an optimization report view.

### Neovim (0.11+)

```lua
vim.filetype.add({ extension = { vidar = "vidar" } })
vim.lsp.config("vidar", { cmd = { "vidar-lsp", "--stdio" }, filetypes = { "vidar" }, root_markers = { ".git" } })
vim.lsp.enable("vidar")
```

### Helix

In `languages.toml`:

```toml
[language-server.vidar]
command = "vidar-lsp"
args = ["--stdio"]

[[language]]
name = "vidar"
scope = "source.vidar"
file-types = ["vidar"]
comment-token = "//"
language-servers = ["vidar"]
```

## What It Does

**Diagnostics.** Vidar's errors as you type, several at a time; a declaration that doesn't parse is skipped and the rest of the file still checked. On save, `odin check` runs on the generated code, and its errors appear on the matching `.vidar` lines.

**Hover** shows signatures and kinds for procedures, types, interfaces (with their impls), methods (with the procedures implementing them), macros, locals, fields and enum members, and the description of keywords, built-ins, attributes and directives (the same text as this book's [reference](reference-00.md) and [appendixes](appendix-01-keywords.md)). On a macro call, it shows the code the macro expands to. On a type with [`impl Destroy`](ch07-00-destructors.md), it says how the type is destroyed and copied; on a local, where it's destroyed.

**Navigation.** Go to definition (including into other packages, macro calls, fields and captured variables), find references and rename (following variables through capture lists and macro arguments, across packages), go to implementation (from an interface to its types, from a method to its procedures), workspace symbols, and call hierarchy.

**Completion** of names in scope, package members, struct fields, keywords and directives, each with its documentation.

**Inlay hints** show what the source doesn't spell out: where values are destroyed (`drop b, a` after a block), moved and cloned (`move`, `clone` before a copy), and what `-opt` would decide (`table`, `unchecked`, `direct`), without building with it. A code lens over each procedure counts its `-opt` decisions.

**Quick fixes** for common errors: `&x` or `new_clone(x)` for a value converted to an interface (only the allocation-free one is ever applied automatically), `proc[&n]` for a write to a by-value capture, a missing import, `move!(x)` and `#owned` for ownership errors, and the opt-out attribute for an `-opt` decision.

**Formatting** through `vidar fmt`, and **semantic tokens** that color names by what they are: closures, captured variables (and those captured by pointer), interface methods and macro calls each get their own token type or modifier.

## Plain Odin Through `ols`

If [`ols`](https://github.com/DanielGavin/ols), Odin's language server, is on your `PATH`, `vidar-lsp` forwards what it can't answer to it: hover, definition and signature help for `core:` procedures and types, and completion after `fmt.`. It keeps a shadow copy of the generated Odin, and because unchanged lines stay unchanged, it can map positions both ways.

## VS Code Commands

- **Vidar: Show Generated Odin** opens the generated Odin at the line matching the cursor.
- **Vidar: Expand at Cursor** shows, beside the editor, the Odin generated for the statement at the cursor, following the cursor as it moves. **Vidar: Toggle -opt in Expand at Cursor** switches between the plain and the `-opt` output.
- **Vidar: Optimization Report**, a view in the explorer, lists every `-opt` decision by file and procedure.

## Options

`initializationOptions`, or `vidar.*` settings in VS Code:

| Option | Default | Meaning |
|---|---|---|
| `odinCheckOnSave` | `true` | run `odin check` on save |
| `odinPath` | `"odin"` | the `odin` binary |
| `ols` | `true` | forward to `ols` |
| `olsPath` | `"ols"` | the `ols` binary |
| `optHints` | `"on"` | `"on"`, `"all"` (decisions against too), or `"off"` |
| `ownershipHints` | `true` | show where values are destroyed, moved and cloned |
| `optCodeLens` | `true` | show the code lens |
| `indexWorkspace` | `true` | analyze every program in the workspace folders, for workspace symbols and the report |

## Custom Requests

Beyond standard LSP, the server answers three requests that editor extensions can use: `vidar/generatedOdin` (the generated Odin for a file, and the line matching a `.vidar` line), `vidar/expandAt` (the Odin generated for the statement at a position) and `vidar/optReport` (every `-opt` decision, grouped by file and procedure).
