# Error Handling

Odin has no exceptions. A procedure that can fail says so in its signature, returning an error value, or a `bool`, as its last result, and the caller decides what to do about it. Vidar keeps that model exactly. What it adds are three small tools for the cases where Odin's own are awkward:

| Form | Meaning |
|---|---|
| `x := f() or_return value` | if `f` fails, return with `value` as the error |
| `x := f() catch err { ... }` | if `f` fails, run the block, with the error in `err` |
| `x := f() catch unreachable` | if `f` fails, panic at this line |
| `errdefer stmt` | a `defer` that runs only when the procedure returns a failure |

None of them changes how errors are represented, and procedures that use them are called the same way as any other, from Vidar or from Odin.

This chapter starts with a recap of what Odin already does, then covers each addition:

- [Failures in Odin](ch06-01-failures-in-odin.md)
- [Returning a Different Error](ch06-02-or-return-value.md)
- [Handling a Failure in Place with `catch`](ch06-03-catch.md)
- [Cleaning Up After a Failure with `errdefer`](ch06-04-errdefer.md)
