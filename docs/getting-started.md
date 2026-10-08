# Getting started

## Requirements

- Node 20.
- [`odin`](https://odin-lang.org) on your PATH.
- `nasm` on linux/amd64, if the program uses goroutines.

Only darwin/arm64 is tested.

## Install

```bash
npm install && npm run build
```

Or build [standalone binaries](cli.md#standalone-binaries) that need no Node at runtime.

## Hello world

```bash
node dist/cli.js new hello
node dist/cli.js run hello
```

`vidar new` writes `main.vidar`, a `.gitignore`, a VS Code debug configuration and a README stub. Add a closure to `main.vidar`:

```odin
package main

import "core:fmt"

main :: proc() {
	step := 10
	add := proc[step](x: int) -> int { return x + step }
	fmt.println(add(1))   // 11
}
```

## What a build does

`vidar run` transpiles the package, and every package it imports by relative path, into a temporary directory of plain Odin, then runs `odin run` on it. Errors and panics are reported at `.vidar` lines. `vidar build <dir> -o out/game` keeps the generated Odin, and `vidar emit <dir>` prints it. Everything that is already Odin passes through byte for byte unless you ask for `-opt`.

## Where next

- [Command line](cli.md): every command and flag.
- [Closures](language/closures.md), [Interfaces](language/interfaces.md), [Error handling](language/error-handling.md): the core additions.
- [examples/](../examples): one runnable program per feature.
