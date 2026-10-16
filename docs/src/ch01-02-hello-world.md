# Hello, World!

Now that Vidar is installed, it's time to write a first program. It's traditional to write a program that prints `Hello, world!`, so we'll do that, and then make it do something Odin alone can't.

## Creating a Project

`vidar new` starts a program in a new directory. Open a terminal and run:

```console
$ vidar new hello
created program hello in hello: main.vidar, .gitignore, .vscode/launch.json, README.md
next: vidar run hello
```

That made a directory, `hello`, with four files in it:

- `main.vidar`, the program;
- `.gitignore`, which leaves out `out/`, where builds go;
- `.vscode/launch.json`, so that F5 in VS Code debugs the program;
- `README.md`, a short note on how to build it.

A directory is a *package* in Odin, and so it is in Vidar: every `.vidar` file in `hello/` belongs to the same program.

## Writing the Program

Open `main.vidar` and replace what `vidar new` put there with Listing 1-2.

<span class="filename">Filename: main.vidar</span>

```vidar
package main

import "core:fmt"

main :: proc() {
	fmt.println("Hello, world!")
}
```

<span class="caption">Listing 1-2: A program that prints `Hello, world!`</span>

Save the file, then run it:

```console
$ vidar run hello
Hello, world!
```

```output
Hello, world!
```

If you see `Hello, world!`, congratulations: you've written a Vidar program!

You may have noticed that there's nothing Vidar-specific in Listing 1-2. It's an ordinary Odin program, and that's the point: every Odin program is a Vidar program. Let's look at its parts anyway, since every program in this book has them.

- `package main` names the package the file belongs to. Every file in a directory has to name the same package.
- `import "core:fmt"` brings in Odin's formatting package, which has `println`.
- `main :: proc() { ... }` declares a procedure called `main`: the program starts there. In Odin, `name :: value` declares a constant, and a procedure is a constant whose value is a `proc`.
- `fmt.println("Hello, world!")` calls `println` from the `fmt` package, which prints its arguments and a newline.

## Adding a Closure

Now let's change the program to do something Odin can't. Replace `main.vidar` with Listing 1-3.

<span class="filename">Filename: main.vidar</span>

```vidar
package main

import "core:fmt"

main :: proc() {
	name := "world"
	greet := proc[name](greeting: string) {
		fmt.printfln("%s, %s!", greeting, name)
	}
	greet("Hello")
	greet("Goodbye")
}
```

<span class="caption">Listing 1-3: A closure that remembers `name`</span>

```output
Hello, world!
Goodbye, world!
```

`proc[name](greeting: string) { ... }` is a *closure*: a procedure that captured the local variable `name` and can use it when it is called later. The square brackets after `proc` list what it captures. Without them it would be an ordinary Odin procedure, which can't see `name` at all, and the compiler would tell you so. [Chapter 4](ch04-00-closures.md) is all about closures.

## Building Without Running

`vidar run` builds the program into a temporary directory and runs it. Two other commands are useful while you work:

- `vidar check hello` builds the program without running it, and reports any errors. It's faster than `run`.
- `vidar build hello -bin` writes the generated Odin to `out/hello/` and builds an executable next to it, `out/hello/hello`.

The next section explains what that generated Odin is.
