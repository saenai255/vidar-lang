# Packages

As a program grows, you split it into packages. Vidar's packages are Odin's, with two additions: packages may import each other in a cycle, and a `vidar.toml` file can map an import prefix to a directory, which is all a package manager needs.

- [Packages and Imports](ch09-01-packages-and-imports.md): how a program is laid out, and what a build includes.
- [Cyclic Imports](ch09-02-cyclic-imports.md): packages that import each other.
- [Collections and `vidar.toml`](ch09-03-collections.md): importing packages from elsewhere by name.
