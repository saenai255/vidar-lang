# Formatting with `vidar fmt`

`vidar fmt` formats `.vidar` files:

```console
$ vidar fmt main.vidar          # print the formatted file
$ vidar fmt . --write           # rewrite every changed file under .
$ vidar fmt . --check           # list files that would change; exit 1 if any
```

Directories are searched for `.vidar` files. Editors get the same formatting through the language server.

## It Never Moves a Token to Another Line

`vidar fmt` only changes the whitespace *between* tokens on a line, and never joins, splits or reflows lines. So line numbers stay the same, which keeps errors, `dbg!` output and `call_site()` pointing where they did, and keeps diffs small.

## What It Changes

- **Indentation:** tabs, by bracket depth. A `case` sits at its `switch`'s level; a line that continues an expression goes one level deeper; brackets opened on the same line share one level.
- **Trailing whitespace**, and trailing blank lines at the end of the file. Blank lines elsewhere stay.
- **Spacing:** one space around binary and assignment operators (`a+b` becomes `a + b`, `x:=1` becomes `x := 1`); one space after commas and after the `:` of a declaration; none inside `(...)` and `[...]`, before a comma, around `.`, or between a name and its `(` or `[`.

## What It Leaves Alone

Spacing it can't be sure about stays as written: unary operators, `^`, ranges, `->` after a name, everything inside `@(...)` and the inside of `{ ... }`, runs of spaces that line things up, and the text of comments and strings (comments are reindented with their line).

## Guarantees

Formatting is idempotent. Before anything is written, the result is checked to have the same tokens on the same lines as the input; if it doesn't, `vidar fmt` fails rather than change the program.
