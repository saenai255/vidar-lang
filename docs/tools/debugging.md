# Debugging

Odin has no `#line` directive, so a plain debugger steps through the generated Odin rather than the `.vidar` source. Vidar keeps that code close to the source: lines it doesn't rewrite stay the same, and a lowered construct takes as many lines as it did. [`vidar dap`](#with-vidar-dap) goes further and translates positions, so a debugger session never shows generated code.

## Building with debug info

```bash
vidar build <dir|file.vidar> -debug [-o <out>] [-- odin flags]
```

This does three things:

1. transpiles into `<out>` (default `out/<name>`);
2. writes `vidar.map.json`;
3. runs `odin build <out> -debug -out:<out>/<name>`.

`-debug` implies `-bin`. See the `-bin`, `-lib` and `-dll` flags in [Command line](../cli.md) for building without debug info. The generated `.odin` files stay next to the binary, which is where the debug info points.

## From the command line

```bash
lldb out/game/game        # then: b main.odin:42
gdb out/game/game
```

To find the generated line for a `.vidar` line, look it up in `vidar.map.json`, or use *Show Generated Odin* (below).

## In VS Code

The extension adds a `vidar` debug configuration. It runs `vidar build -debug` (the CLI bundled in the extension, or `vidar.cliPath`), then starts [CodeLLDB](https://marketplace.visualstudio.com/items?itemName=vadimcn.vscode-lldb) on the binary, or gdb through the C/C++ extension with `"debugger": "gdb"`.

```json
{ "type": "vidar", "request": "launch", "name": "Debug game", "program": "${workspaceFolder}/examples/cyclic", "args": [] }
```

- **Other attributes:** `outDir` (default `out/<name>-debug`), `opt`, `odinFlags`, `cwd`, `env`, `stopOnEntry` and `debuggerPath`.
- **Without a `launch.json`,** F5 on a `.vidar` file debugs its package.

### Setting breakpoints

*Vidar: Show Generated Odin* opens at the line matching the cursor's `.vidar` line.

| State | What it opens |
|---|---|
| a debug build exists that is still current with the file (saved, and not changed since) | the real generated file from that build, where breakpoints bind |
| otherwise | the program's generated Odin in an unsaved editor, for reading |

## With `vidar dap`

```bash
vidar dap [--backend <lldb-dap>]
```

A [debug adapter](https://microsoft.github.io/debug-adapter-protocol/) on stdin and stdout, for any editor that speaks DAP. It runs `lldb-dap` underneath (from `PATH`, Xcode's command line tools or LLVM; `--backend` or `VIDAR_DAP_BACKEND` name one) and rewrites what passes through, using `vidar.map.json`:

- **Launch.** `program` is a `.vidar` file or package directory. The adapter builds it with `vidar build -debug` and starts the binary. `args`, `cwd`, `env` and `stopOnEntry` go to lldb-dap; `opt`, `odinFlags` and `outDir` (default `out/<name>-debug`) control the build. A failed build is reported with its errors on `.vidar` lines.
- **Breakpoints** set on `.vidar` lines bind to the generated line. A line that produced no code is reported unverified.
- **Stack frames** are on `.vidar` files and lines, including the bodies of closures. A closure frame is named `closure`. A frame in generated code with no source line (a closure's setup, say) is shown dimmed, as the debugger gave it.
- **Stepping** goes on past generated lines that have no source line. With `justMyCode` (the default), stepping into Odin's own code (`core`, `base`) steps back out; set `"justMyCode": false` to follow calls into it.
- **Variables.** A closure's `__env` and `__env_raw` are replaced by the variables it captured. Watch and hover expressions can name a captured variable directly (`n`, `n + x`). A pointer capture (`&x`) shows as the pointer.
- **Output.** Generated `.odin` locations in the program's output, such as a panic's, are rewritten to `.vidar` ones.

In VS Code, set `"debugger": "dap"` in the `vidar` debug configuration (`debuggerPath` then names `lldb-dap`):

```json
{ "type": "vidar", "request": "launch", "name": "Debug game", "program": "${workspaceFolder}/examples/cyclic", "debugger": "dap" }
```

## What generated names mean

Generated names start with `__`.

| Name | What it is |
|---|---|
| `__env` | a closure's captures: `__env.n`, or `__env.f^` for a pointer capture (`&f`) |
| `__closure_N` | a closure body, as a proc |
| `{data, __vtable}` | an interface value |
