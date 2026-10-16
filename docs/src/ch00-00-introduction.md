# Introduction

Welcome to *The Vidar Programming Language*, an introductory book about Vidar.

[Odin](https://odin-lang.org) is a small, fast systems language with manual memory management, a simple type system and a pleasant syntax. It leaves out, on purpose, a handful of features that larger languages have: there are no closures, no interfaces, no destructors and no macros, packages can't import each other in a cycle, and an error is just another return value.

Vidar adds those features back, without giving up what makes Odin Odin. A `.vidar` file is an Odin file that may also use:

- **closures** that capture variables, stored as plain values that never allocate;
- **interfaces** with static and dynamic dispatch;
- **error handling** helpers: `or_return` with a value, `catch` and `errdefer`;
- **destructors** (`impl Destroy`) that run when a value's owner goes out of scope, with moves, clones and shared values;
- **anonymous struct literals** whose type is inferred;
- **cyclic imports** between packages;
- **compile-time macros** written in Vidar itself, and compile-time evaluation of ordinary procs;
- **goroutines and channels** as a library;
- **optimizations** Odin can't do on its own, behind the `-opt` flag.

Vidar is a *transpiler*: the `vidar` command turns your program into plain Odin and hands it to the `odin` compiler. Code that is already Odin comes out unchanged, byte for byte, so an Odin project is a valid Vidar project on day one, and you can see exactly what every new construct turns into.

## Who This Book Is For

This book assumes that you have written code in some programming language and that you can read Odin. You don't need to be an Odin expert: [Chapter 2](ch02-00-odin-essentials.md) is a short tour of the Odin you'll see in this book, and links to the [Odin overview](https://odin-lang.org/docs/overview/) for the rest. If you already write Odin, skim that chapter and read [Coming from Odin](ch02-02-coming-from-odin.md), which lists what Vidar changes.

## How to Use This Book

The book is meant to be read front to back. Later chapters build on earlier ones, and features are introduced with an example before they're explained in detail.

There are two kinds of chapters. *Concept chapters* introduce one part of the language: closures in Chapter 4, interfaces in Chapter 5, and so on. *Project chapters* use what you've learned so far to build something small but complete: [Chapter 3](ch03-00-first-program.md) writes a first program, and [Chapter 13](ch13-00-project.md) builds a command-line tool.

- **Chapter 1** installs Vidar, runs a first program and explains what a build does.
- **Chapter 2** is a quick tour of Odin, and what Vidar changes about it.
- **Chapter 3** is a hands-on tour: a small program that uses several of Vidar's features before we explain them.
- **Chapters 4 to 8** cover the language: closures, interfaces, error handling, destructors and ownership, and anonymous struct literals.
- **Chapter 9** is about packages, cyclic imports and collections.
- **Chapters 10 and 11** cover macros: the built-in ones, then writing your own and running code at compile time.
- **Chapter 12** is about tests, and **Chapter 13** builds a command-line log summarizer with everything so far.
- **Chapter 14** covers goroutines and channels, which are experimental and disabled for now.
- **Chapter 15** is about `-opt` and the attributes that make code faster.
- **Chapter 16** covers the tools: the command line, the formatter, the editor support and the debugger.

At the end are a [library reference](reference-00.md), with a description and an example for every built-in procedure, type, macro and library procedure, and the [appendixes](appendix-00.md): keywords, a syntax cheat sheet, attributes, directives, build flags, every compile error with its fix, what each construct compiles to, the current limits, a FAQ and a glossary.

## Conventions

Code that you can put in a file and run is shown with its file name above it and a caption below it, as in Listing 1-1:

<span class="filename">Filename: main.vidar</span>

```vidar
package main

import "core:fmt"

main :: proc() {
	fmt.println("Hello, world!")
}
```

<span class="caption">Listing 1-1: A program that prints a greeting</span>

What a program prints is shown in a block of its own:

```output
Hello, world!
```

Shorter snippets leave out the `package` line, the imports and sometimes the `main` procedure around them. They are still complete enough to compile: the test suite fills in what they leave out.

Some programs are wrong on purpose, to show the error the compiler gives. They are marked *does not compile*, with the message underneath:

```vidar,compile_fail
main :: proc() {
	n := 0
	f := proc() -> int { return n }
	_ = f
}
```

```error
error: 'n' is a local of the enclosing procedure; nested procs cannot see it. Use a closure: proc[n](...) or proc[&n](...)
```

Programs that compile but stop with a panic when they run are marked *panics*.

## Source Code

The source of this book is in the [`docs/`](https://github.com/saenai255/vidar-lang/tree/main/docs) directory of the Vidar repository, and the larger example programs are in [`examples/`](https://github.com/saenai255/vidar-lang/tree/main/examples).
