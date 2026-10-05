# Vidar for VS Code

Syntax highlighting plus a client for the `vidar-lsp` language server:
- diagnostics: vidar's own errors as you type, and Odin's errors on save
- hover, go to definition, find references and rename
- completion and the outline
- an **Vidar: Show Generated Odin** command

## Install from a .vsix (recommended)

The `.vsix` bundles the language server, so nothing else needs installing, apart from `odin` for the checks on save.

```bash
cd ../.. && npm run build:binaries      # builds bin/<os>-<arch>/vidar-lsp
cd editors/vscode && npm install && npm run package
```

This produces `vidar-<os>-<arch>-<version>.vsix`. Install it with **Extensions: Install from VSIX...** in VS Code, or with `code --install-extension vidar-darwin-arm64-0.1.0.vsix`.

- `npm run package -- --target linux-x64` packages a binary built with `scripts/build-binaries.js --target linux-x64`.
- `npm run package -- --no-server` makes a platform-independent `.vsix` that uses `vidar-lsp` from your PATH.

## Settings

- `vidar.server.path`: leave unset to use the bundled server. Otherwise set an executable or a path to `dist/lsp/server.js`; it falls back to `vidar-lsp` on PATH.
- `vidar.odinCheckOnSave` (default `true`) and `vidar.odinPath` (default `odin`): run `odin check` on save.
