# Destructors and Ownership

Every resource a program takes has to be given back: memory to the allocator, files and sockets to the operating system, locks to whoever waits on them. Odin's tool for that is `defer`, written next to each acquisition:

```vidar,ignore
buf := make([]byte, 4096)
defer delete(buf)
```

That works, and it's explicit. But it's also easy to forget, and it doesn't compose: when the buffer lives in a struct, every function that creates such a struct needs the right `defer`, every early `return` has to be thought through, and a value handed to someone else must not be freed by its creator.

Vidar adds *destructors*. You tell the compiler once how to destroy a value of a type, with `impl Destroy`, and it destroys every value of that type when its owner goes out of scope: at the end of the block, on `return`, on `break`, on every `or_return`. This is what C++ calls RAII and what Rust calls `Drop`.

To do that safely, the compiler needs to know who owns each value, so that nothing is destroyed twice and nothing is used after it's destroyed. That brings *ownership* rules: a value has one owner; copying it is an error unless the type says how to copy it (`impl Clone`); other code *borrows* it or has it *moved* to them. The rules only apply to types with a destructor. Every other type behaves exactly as in Odin, and a program without any `impl Destroy` is compiled exactly as before.

This chapter covers:

- [Destructors with `impl Destroy`](ch07-01-impl-destroy.md): declaring one, and when values are destroyed.
- [Owners, Borrows and Moves](ch07-02-ownership.md): why copies are errors, and what to do instead.
- [Copying with `impl Clone`](ch07-03-impl-clone.md): types that can be copied.
- [Containers Own Their Elements](ch07-04-containers.md): dynamic arrays and maps of destructible values.
- [Shared Values with `vidar:rc`](ch07-05-rc.md): values with several owners.
- [Destructors in Generic Code](ch07-06-generic-code.md): how polymorphic procedures handle them.
- [Patterns and Pitfalls](ch07-07-patterns-and-pitfalls.md): common designs, and what the compiler doesn't catch.
