# Compile-Time Code

Odin has a little compile-time code: `when` picks a branch, `#config` reads a flag, `#assert` checks a constant, and polymorphic procedures are instantiated per type. What it doesn't have is a way to run your own code while compiling: to generate a lookup table, build a string, or write repetitive code for you.

Vidar does, in two ways:

- **Macros** are procedures declared with `proc!`. They run inside the compiler, take code as arguments, and return code that replaces the call: `swap!(a, b)`, `show!(Point, p)`.
- **Compile-time evaluation** runs an ordinary procedure, or a whole block, while compiling, and puts its result into the program as a constant: `fib!(20)` becomes `6765`.

Both run in the same interpreter, inside `vidar`, and neither reaches the generated Odin: only what they produce does. The [built-in macros](ch10-00-builtin-macros.md) are written with exactly these tools.

- [Writing Macros](ch11-01-writing-macros.md): `proc!`, `quote` and splicing.
- [Macro Parameters and Reflection](ch11-02-macro-parameters.md): the kinds of arguments a macro takes, and how it inspects them.
- [Running Code at Compile Time](ch11-03-compile-time-evaluation.md): `name!(...)` on any procedure, and `comptime! { ... }`.
