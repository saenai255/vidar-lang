# Vidar for VS Code

Syntax highlighting plus a client for the `vidar-lsp` language server:
- diagnostics: vidar's own errors as you type, and Odin's errors on save
- hover, go to definition, find references and rename
- completion and the outline
- inlay hints showing what `-opt` decides
- a **Vidar: Optimization Report** view in the explorer, listing every `-opt` decision by file and proc (decisions against marked; click to jump), refreshed on save, and a code lens over each proc, "N optimizations, M not", that opens it on that proc
- **Vidar: Expand at Cursor**: the Odin generated for the statement at the cursor, in a read-only view beside the editor that follows the cursor; **Vidar: Toggle -opt in Expand at Cursor** (or the button on the view) shows the `-opt` output
- a **Vidar: Show Generated Odin** command, opening at the line matching the cursor's `.vidar` line
- a `vidar` debug configuration: builds with `vidar build -debug` and debugs the binary with CodeLLDB or gdb

## Install from a .vsix (recommended)

The `.vsix` bundles the language server, so nothing else needs installing, apart from `odin` for the checks on save.

```bash
cd ../.. && npm run build:binaries      # builds bin/<os>-<arch>/vidar-lsp
cd editors/vscode && npm install && npm run package
```

This produces `vidar-<os>-<arch>-<version>.vsix`. From the repository root, `npm run vsix` does both steps and installs the result. Install it with **Extensions: Install from VSIX...** in VS Code, or with `code --install-extension vidar-darwin-arm64-0.1.0.vsix`.

- `npm run package -- --target linux-x64` packages a binary built with `scripts/build-binaries.js --target linux-x64`.
- `npm run package -- --no-server` makes a platform-independent `.vsix` that uses `vidar-lsp` from your PATH.

## Settings

- `vidar.server.path`: leave unset to use the bundled server. Otherwise set an executable or a path to `dist/lsp/server.js`; it falls back to `vidar-lsp` on PATH.
- `vidar.odinCheckOnSave` (default `true`) and `vidar.odinPath` (default `odin`): run `odin check` on save.
- `vidar.cliPath`: the `vidar` CLI the debug configuration builds with, an executable or a path to `dist/cli.js`. Leave unset to use the binary bundled in the `.vsix` (falling back to `vidar` on PATH, or to `dist/cli.js` next to a `vidar.server.path` that is `dist/lsp/server.js`).
- `vidar.optHints` (default `on`): inlay hints showing what `-opt` decides (`table`, `specialized ×2`, `unchecked`, `grouped alloc`, `fmt inlined`, `devirtualized` / `vtable` / `direct`); `all` also shows what it decided against, `off` hides them.
- `vidar.optCodeLens` (default `true`): the "N optimizations, M not" code lens over each proc; none while `vidar.optHints` is `off`.

## Debugging

Install [CodeLLDB](https://marketplace.visualstudio.com/items?itemName=vadimcn.vscode-lldb) (or, for `"debugger": "gdb"`, the C/C++ extension), then add to `.vscode/launch.json`:

```json
{
  "version": "0.2.0",
  "configurations": [
    { "type": "vidar", "request": "launch", "name": "Debug Vidar program", "program": "${workspaceFolder}", "args": [] }
  ]
}
```

`program` is the package directory or `.vidar` file. The configuration runs `vidar build -debug` into `outDir` (default `out/<name>-debug`), showing its output in the *Vidar* output channel, and then starts an `lldb` (or `cppdbg`) session on the binary. Other attributes: `opt`, `odinFlags`, `cwd`, `env`, `stopOnEntry`, `debugger` (`lldb` or `gdb`) and `debuggerPath`. Without a `launch.json`, F5 on a `.vidar` file debugs its package.

Stepping happens in the generated Odin. To set a breakpoint, put the cursor on the `.vidar` line and run *Vidar: Show Generated Odin*: after a debug build that is current with the file, it opens that build's generated `.odin` at the matching line, and a breakpoint set there binds.
