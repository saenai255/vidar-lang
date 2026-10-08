# Language server

`vidar-lsp` speaks standard LSP over stdio, so any editor can use it. Put the standalone binaries on your PATH, or run `npm link` in this repo.

The server analyzes the program rooted at the open file's package: that package plus everything it imports, cycles included. Unsaved editor contents are used. Editing a file re-checks every open program that contains it.

## Contents

- [Features](#features): diagnostics, navigation, editing, information
- [Custom requests](#custom-requests)
- [Workspace index](#workspace-index)
- [How ols is used](#how-ols-is-used)
- [Editor setup](#editor-setup): VS Code, Neovim, Helix
- [Options](#options)

## Features

### Diagnostics

- Vidar errors as you type, several at once.
- A declaration that doesn't parse is skipped, and the rest of the file is still checked.
- On save, `odin check` runs on the generated code, and its errors are shown on the matching `.vidar` lines.

### Reading code

| Feature | Details |
|---|---|
| **Hover** | Signature and kind for procs, types, interfaces (with their impls), interface methods (with their interface and the procs implementing them), macros, imports, locals, struct fields and enum members (also at their uses: `x.field`, `Enum.Member`, `.Member`). Also shows the generated Odin name (when a cycle prefixes it) and whether a variable is captured through a pointer (`&x`). On a macro call's name: the code it expands to, as the emitter writes it, with statements it runs first (`do!`); cut after 40 lines. |
| **Outline** | Procs, macros, structs (fields), interfaces (methods), impl blocks (bindings). |
| **Inlay hints** | What `-opt` would decide, without building with it. See [Inlay hints](#inlay-hints-and-code-lens). |
| **Semantic tokens** | Names colored by what they are rather than how they look. See [Semantic tokens](#semantic-tokens). |

### Navigation

| Feature | Details |
|---|---|
| **Go to definition** | Names; `pkg.member` (into the other package's file); macro calls (`name!`, `pkg.name!`); struct fields and enum members; procs bound in an `impl`; captured variables (jumps to the original declaration). |
| **References / rename** | Follows a variable through closure capture lists and into macro arguments, and works across packages. Also covers struct fields and enum members; see [Fields and enum members](#fields-and-enum-members). |
| **Go to implementation** | On an interface: the types implementing it, also through interfaces that extend it. On an interface method: the procs bound to it in each `impl`. A plain proc has none. |
| **Workspace symbols** | Every global of every package the server has analyzed (each open program and what it imports, and every program under the workspace folders, see [Workspace index](#workspace-index)), by substring or by the query's letters in order. Generated `__` names are left out. |
| **Call hierarchy** | Incoming and outgoing calls of procs, proc groups, interface methods and macros, across packages. See [Call hierarchy](#call-hierarchy). |
| **Completion** | After `pkg.`: the package's public members. After `value.`: struct fields. Otherwise: everything in scope, plus macros and keywords. While the line you're typing doesn't parse yet, completion uses the last good analysis. |

### Fields and enum members

Uses are resolved through the analyzer's types. Hover, definition, references, rename and semantic tokens all use them.

**Resolved uses:**

- `x.field` through pointers, `using` fields, `#soa` containers and parametric structs;
- field names in literals;
- `Enum.Member`;
- `.Member` where the expected type is known: declarations, assignments, comparisons, `case`, call arguments, returns, `or_return .Err`, literal elements, enumerated-array indexes.

**Renaming** a field or member edits its declaration and every resolved use. It is **refused**, naming the first place, while some `.name` with that name can't be resolved:

- a receiver or expected type vidar couldn't infer (a value from a core proc, a `$T`);
- code in a comptime proc;
- a plain name in a proc with `using`.

### Call hierarchy

- A call to a proc group counts as a call to each of its members.
- A call to a closed interface's method (one no other package extends) counts as a call to every proc bound to it.
- Calls a macro expands to count at the macro call, and calls in closures count at the proc that holds them.
- Calls through closure values and proc variables aren't followed.

### Editing

| Feature | Details |
|---|---|
| **Formatting** | `textDocument/formatting` runs [`vidar fmt`](../cli.md#vidar-fmt) on the open file, with one edit per changed line. A file that doesn't lex gets no edits. |
| **Quick fixes** | Code actions for common errors. See [Quick fixes](#quick-fixes). |
| **Plain Odin via ols** | If [ols](https://github.com/DanielGavin/ols) is on your PATH, requests vidar can't answer go to it: hover, definition and signature help for core library procs and types, and `fmt.`-style completion (merged with vidar's own). See [How ols is used](#how-ols-is-used). |

### Quick fixes

`source.fixAll` applies every *preferred* fix in the file.

**A plain value converted to an interface**

- **"Use a pointer to it (`&x`)"** is the preferred fix, the one "fix all" and auto-fix apply.
- **"Allocate a heap copy (`new_clone`, caller frees)"** is a separate action and is never preferred, so an allocation is only added when you choose it.
- When `&x` would dangle, only `new_clone` is offered, and the diagnostic says why. It dangles when the value is a local, or a literal, of the proc and the interface value leaves it: it is returned, stored through a pointer, in a slice or in a global, appended to something the proc doesn't own, passed to a proc that does one of these with it, or passed to `sched.go`. These are the same rules `src/escape.ts` applies to closures.
- `new_clone` is also the only fix for a parameter or a loop value, since Odin can't take their address.

**A write to a by-value capture:** capture a pointer (`proc[&n]`).

**A package used without its import** (`fmt.println` with no `import "core:fmt"`): an error, with "Add import" as the fix.

- The packages are every directory of `core/`, `base/` and `vendor/` under `odin root` (read once, with the `odinPath` setting), by their last path part, plus `vidar:sched`. Without `odin`, a fixed table of about 40 common ones is used.
- When several packages share the name (`noise` is `core:crypto/noise` and `core:math/noise`), each gets an action. One is preferred only when it is the common one from the table, or the only one outside `vendor:`.

**An `-opt` decision you want undone** (an automatic table, specialization or memo, a stack buffer, a perfect-hash switch): add its opt-out attribute (`@(no_table)`, `@(no_specialize)`, ...) to the proc.

### Inlay hints and code lens

**Inlay hints** show what `-opt` would decide, without building with it:

- `table` / `specialized ×2` after a proc's name;
- `unchecked` after a statement whose indexes are proven in bounds;
- `grouped alloc`, `fmt inlined`;
- `direct` / `devirtualized` / `vtable` after an interface method call.

The tooltip gives the reason. The `optHints` setting (initialization option, or `vidar.optHints` in `workspace/didChangeConfiguration`) is:

| Value | Shows |
|---|---|
| `"on"` (default) | decisions for a rewrite |
| `"all"` | also what `-opt` decided against, e.g. `no table` |
| `"off"` | nothing |

They come from a second analysis with `-opt` on, made only when hints are requested. Diagnostics and generated code are unaffected.

**Code lens:** over each proc with `-opt` decisions, "N optimizations, M not" (M counts the decisions against, those whose label starts with "no" or "not"). Its command, `vidar.showOptReport` with the file's URI, the proc's name and its line, opens the report on that proc in VS Code. There is none while `optHints` is `"off"`, or with the setting `optCodeLens` set to `false`.

### Semantic tokens

`textDocument/semanticTokens/full` and `/range`, from the analyzer's symbols.

**Token types:**

| Type | Used for |
|---|---|
| `namespace`, `type`, `interface`, `struct`, `enum`, `enumMember`, `typeParameter` | declarations and uses of those |
| `function` | procs; closure-valued locals and parameters |
| `method` | interface methods, in the interface, its `impl`s and calls |
| `parameter`, `variable` | parameters and variables |
| `property` | field declarations and resolved uses (`enumMember` likewise) |
| `macro` | comptime procs and every `name!` call, including procs run at compile time |

**Modifiers:**

| Modifier | Meaning |
|---|---|
| `declaration` | a declaration |
| `readonly` | constants, and by-value captures (which a closure can't write) |
| `defaultLibrary` | the built-in macros and `vidar:sched` |
| `async` | `sched.go` |
| `closure` (custom) | a closure value or type |
| `captured` (custom) | a captured variable inside its closure |
| `byRef` (custom) | captured through a pointer (`&x`) |

Generated `__` names never get a token. A file with errors gets tokens for what was analyzed.

## Custom requests

| Request | Purpose |
|---|---|
| `vidar/optReport` | `{ uri? }` returns every `-opt` decision, grouped by file and enclosing proc. See below. |
| `vidar/generatedOdin` | Returns the generated Odin for a file. Given a `.vidar` `line` (0-based), it also returns the matching `line` of the file's generated Odin. |
| `vidar/expandAt` | `{ uri, position, opt? }` returns `{ code, range }` (or `{ error }`): the generated Odin for the statement at the position, and that statement's source range. See below. |

**`vidar/optReport`** returns:

```json
{ "files": [{ "uri": "...", "procs": [{ "name": "...", "range": {}, "selectionRange": {}, "optimizations": 0, "against": 0,
  "decisions": [{ "range": {}, "label": "...", "tooltip": "...", "against": false }] }] }] }
```

- Without `uri`, it covers every program the server has analyzed, which with the workspace index is every program in the workspace.
- Decisions outside any proc (a reordered struct, say) are grouped under `(top level)`.

**`vidar/expandAt`** returns the output lines mapped to the statement's lines. The emitter keeps line structure, so this includes:

- the comments and hoisted temporaries it writes before the statement;
- followed by the generated helpers they name: a closure literal's `__closure_N` proc, interface helpers, `-opt` fmt writers.

A statement that comes out unchanged gives way to the innermost enclosing one that changed (inside a closure literal, a `catch` or a `do!`, the whole construct), short of a top-level declaration. `opt: true` shows the `-opt` output, from a separate `-opt` analysis.

## Workspace index

After `initialized`, and when a workspace folder is added, the server looks for every package directory with `.vidar` files under the workspace folders and analyzes each program in the background.

- **Skipped:** hidden directories such as `.git`, and `out/`, `node_modules/` and `expected/`.
- **Order:** roots (packages nothing else there imports) first, one program at a time, only after 400 ms without edits or requests.
- **Effect:** workspace symbols and `vidar/optReport` (whose `-opt` analysis it also prepares) cover programs whose files were never opened.
- **Diagnostics:** these programs get none until one of their files is opened. Removing the folder drops them.
- **Turn it off** with the option `indexWorkspace: false`.

## How ols is used

The server keeps a shadow copy of the generated Odin in a temp directory and runs ols on it.

**Unchanged lines.** Lines vidar doesn't rewrite are unchanged, and the emitter's line map says where each one went. A request on such a line is sent to ols at the matching position. Results that point into generated code are dropped; results in the shadow tree map back to the `.vidar` file.

**While a file has errors,** the last good output is reused for unchanged lines, and the edited lines are passed to ols as typed, so completion keeps working mid-edit.

**Who answers first.** Vidar answers for its own constructs (closures, captures, interfaces, impls, macros, anonymous structs). ols is the fallback, and for hover it also wins when vidar couldn't infer a local's type.

**Lines vidar rewrites** (a closure literal, a line that uses a pointer capture, a `catch`): the emitter's column map says where each name kept in the output went (for a closure body, into the helper proc at the end of the file), and a request on such a name goes there. A range in the answer maps back only when it lies inside that name. The map is recorded only for the language server's shadow copy, and only for lines unchanged since the last error-free emit.

## Editor setup

### VS Code

See [editors/vscode](../../editors/vscode). The extension provides:

- highlighting and the client;
- **Vidar: Show Generated Odin**, which opens at the cursor's line;
- a `vidar` debug configuration (see [Debugging](debugging.md));
- **Vidar: Expand at Cursor**: a read-only Odin view beside the editor showing the code generated for the statement at the cursor (a closure literal, `catch`, `do!`, `go` call, lowered `for`, interface call). It follows the cursor from statement to statement. **Vidar: Toggle -opt in Expand at Cursor** (also a button on the view's title bar) switches it between the plain and the `-opt` output;
- a **Vidar: Optimization Report** view in the explorer: every `-opt` decision grouped by file and proc, decisions against marked, each entry jumping to its line. It refreshes on save, and the code lenses open it on their proc.

**Semantic token colors.** The extension declares the custom modifiers and maps them to TextMate scopes for themes without semantic colors:

- `entity.name.function.closure.vidar`
- `variable.other.captured.vidar`
- `variable.other.captured.reference.vidar`
- `entity.name.function.goroutine.vidar`
- `entity.name.function.macro.vidar`

To color them in any theme, use `editor.semanticTokenColorCustomizations`:

```json
"rules": { "*.captured": { "italic": true }, "*.byRef": { "underline": true } }
```

> [!NOTE]
> VS Code runs the `vidar-lsp` bundled in the installed `.vsix`, not `dist/`. After an analyzer or LSP change, run `npm run vsix` and reload the window.

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

## Options

LSP `initializationOptions`:

| Option | Default | Meaning |
|---|---|---|
| `odinCheckOnSave` | `true` | run `odin check` on save |
| `odinPath` | `"odin"` | the `odin` binary |
| `ols` | `true` | forward to ols |
| `olsPath` | `"ols"` | the ols binary |
| `optHints` | `"on"` | `"on"`, `"all"` (also decisions against), or `"off"` |
| `optCodeLens` | `true` | show the code lens |
| `indexWorkspace` | `true` | analyze every program in the workspace folders |
