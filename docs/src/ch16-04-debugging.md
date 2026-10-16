# Debugging

Odin has no `#line` directive, so a plain debugger steps through the generated Odin rather than your `.vidar` source. Vidar keeps that code close to the source: lines it doesn't rewrite stay the same, and a rewritten line stays where it was. `vidar dap` goes further and translates positions, so a debugging session never shows generated code at all.

## `vidar dap`

```console
$ vidar dap
```

`vidar dap` is a [debug adapter](https://microsoft.github.io/debug-adapter-protocol/) for any editor that speaks the Debug Adapter Protocol. It runs `lldb-dap` underneath (from `PATH`, Xcode's command-line tools or LLVM; `--backend` or `VIDAR_DAP_BACKEND` names another) and rewrites everything that passes through:

- **Launch.** `program` is a `.vidar` file or a package directory. The adapter builds it with `vidar build -debug` and starts it, reporting a failed build with its errors at `.vidar` lines. `args`, `cwd`, `env` and `stopOnEntry` work as usual; `opt`, `odinFlags` and `outDir` control the build.
- **Breakpoints** on `.vidar` lines bind to the generated line. A line that produced no code is reported unverified.
- **Stack frames** are shown at `.vidar` files and lines, including the bodies of closures, which appear as `closure`.
- **Stepping** skips generated lines that have no source line, and with `justMyCode` (the default) steps back out of Odin's own `core` and `base` code.
- **Variables.** A closure's captures are shown as the variables it captured, and watch expressions can name them directly. A pointer capture (`&x`) shows as the pointer.

In VS Code, the extension's `vidar` debug configuration uses it by default, and F5 on a `.vidar` file with no `launch.json` debugs its package:

```json
{ "type": "vidar", "request": "launch", "name": "Debug game", "program": "${workspaceFolder}/examples/cyclic" }
```

## Building with Debug Info

To use a debugger directly, build with `-debug`:

```console
$ vidar build . -debug
$ lldb out/game/game        # then: b main.odin:42
$ gdb out/game/game
```

That transpiles into `out/<name>`, writes `vidar.map.json`, and runs `odin build` with `-debug`. The generated `.odin` files stay next to the binary, which is where the debug info points, so breakpoints go on generated lines. Find the line for a `.vidar` line in `vidar.map.json`, or with *Vidar: Show Generated Odin* in VS Code. With `"debugger": "lldb"` or `"gdb"` in a `vidar` launch configuration, VS Code uses CodeLLDB or gdb on such a build instead of `vidar dap`.

## What Generated Names Mean

| Name | What it is |
|---|---|
| `__env` | a closure's captures: `__env.n`, or `__env.f^` for a pointer capture |
| `__closure_N` | a closure's body, as a procedure |
| `{data, __vtable}` | an interface value |
| `__vidar` | the generated runtime package |

## Mapping a Crash

A crash in a binary you built yourself reports generated locations. `vidar map` rewrites them using `vidar.map.json`:

```console
$ ./out/game/game 2>&1 | vidar map out/game
$ vidar map out/game < crash.log
```

## Summary

That's the toolbox: `vidar` to build, test and format; `vidar-lsp` for editors; and `vidar dap` or a plain debugger for when things go wrong. The rest of the book is reference material: the [library reference](reference-00.md), and appendixes on keywords, syntax, attributes, flags, errors, generated code, limits and more.
