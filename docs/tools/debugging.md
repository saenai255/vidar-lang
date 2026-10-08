# Debugging

Odin has no `#line` directive, so a debugger steps through the generated Odin rather than the `.vidar` source. Vidar keeps that code close to the source: lines it doesn't rewrite stay the same, and a lowered construct takes as many lines as it did.

- `vidar build <dir|file.vidar> -debug [-o <out>] [-- odin flags]` transpiles into `<out>` (default `out/<name>`), writes `vidar.map.json`, and runs `odin build <out> -debug -out:<out>/<name>` (`-debug` implies `-bin`; see the `-bin`, `-lib` and `-dll` flags in [Command line](../cli.md) for building without debug info). The generated `.odin` files stay next to the binary, which is where the debug info points.
- Debug it from the command line: `lldb out/game/game`, then `b main.odin:42`, or `gdb out/game/game`. To find the generated line for a `.vidar` line, look it up in `vidar.map.json`, or use *Show Generated Odin* below.
- **VS Code:** the extension adds a `vidar` debug configuration. It runs `vidar build -debug` (the CLI bundled in the extension, or `vidar.cliPath`), then starts [CodeLLDB](https://marketplace.visualstudio.com/items?itemName=vadimcn.vscode-lldb) on the binary, or gdb through the C/C++ extension with `"debugger": "gdb"`:

  ```json
  { "type": "vidar", "request": "launch", "name": "Debug game", "program": "${workspaceFolder}/examples/cyclic", "args": [] }
  ```

  Other attributes: `outDir` (default `out/<name>-debug`), `opt`, `odinFlags`, `cwd`, `env`, `stopOnEntry` and `debuggerPath`. Without a `launch.json`, F5 on a `.vidar` file debugs its package.
- **Setting breakpoints in VS Code:** *Vidar: Show Generated Odin* opens at the line matching the cursor's `.vidar` line. After a debug build that is still current with the file (saved, and not changed since), it opens the real generated file from that build, where breakpoints bind; otherwise it shows the program's generated Odin in an unsaved editor, for reading.
- Generated names start with `__`: a closure's captures are in `__env` (`__env.n`, or `__env.f^` for a by-reference capture), and closure bodies are procs named `__closure_N`. Interface values are `{data, __vtable}`.
