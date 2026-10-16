# Writing Tests

Tests are procedures that check that other code does what it should. Vidar uses Odin's testing framework as it is: a test is a procedure marked `@(test)` that takes a `^testing.T`, and `vidar test` runs them with `odin test`. What Vidar adds is that a failing test is reported at the line of your `.vidar` file, closures, interfaces and macros included.

- [How to Write Tests](ch12-01-writing-tests.md)
- [Running Tests](ch12-02-running-tests.md)
