# Installation

Vidar turns your program into Odin and then runs the Odin compiler on it, so you need two things: the `odin` compiler, and the `vidar` command.

## Installing Odin

Follow the [Odin install guide](https://odin-lang.org/docs/install/) for your platform, and make sure `odin` is on your `PATH`:

```console
$ odin version
odin version dev-2026-07-nightly
```

Vidar is tested with Odin `dev-2026-07`. A newer Odin usually works, but if the generated code fails to compile, try that release first.

On Linux on x86-64 (amd64), programs that use goroutines also need [`nasm`](https://www.nasm.us/) on your `PATH`, because the scheduler has a small assembly file. Every other program, and every other platform, does without it.

## Installing Vidar

### From a release

Each release on the [releases page](https://github.com/saenai255/vidar-lang/releases) has a standalone build of `vidar` and `vidar-lsp` (the language server) for macOS on Apple silicon (`darwin-arm64`) and Linux (`linux-x64`, `linux-arm64`). They don't need Node.js. Download the archive for your platform and put both files somewhere on your `PATH`:

```console
$ tar -xzf vidar-<version>-linux-x64.tar.gz
$ mv vidar vidar-lsp ~/.local/bin/
```

### From source

Building from source needs [Node.js](https://nodejs.org) 20:

```console
$ git clone https://github.com/saenai255/vidar-lang
$ cd vidar-lang
$ npm install
$ npm run build
$ npm link
```

`npm link` puts `vidar` and `vidar-lsp` on your `PATH`. To build standalone binaries like the released ones instead, run `npm run build:binaries`; see [Standalone binaries](ch16-01-command-line.md#standalone-binaries).

### Checking the installation

```console
$ vidar --version
vidar 0.1.0-dev
```

If that prints a version, you're ready. If your shell says it can't find `vidar`, check that the directory you put it in is on your `PATH`.

## Platforms

Vidar itself runs anywhere Node.js does, and the code it generates is plain Odin, so it builds wherever Odin does. Only macOS on Apple silicon is tested regularly, and Linux on x86-64 and arm64 runs the test suite in CI. Goroutines need a small piece of assembly per platform, and have it for darwin/arm64, linux/arm64, linux/amd64 and windows/amd64.

## Editor Support

Vidar comes with a language server, `vidar-lsp`, that works in any editor that speaks the Language Server Protocol, and an extension for Visual Studio Code. They give you errors as you type, hover, go to definition, rename, completion and more. [Editors and the Language Server](ch16-03-language-server.md) shows how to set them up; you can do that now or come back to it later.

## Local Documentation

This book is part of the Vidar repository. To read it offline, install [mdBook](https://rust-lang.github.io/mdBook/) and run `npm run docs:serve` in the repository; it opens at `http://localhost:3000`.
