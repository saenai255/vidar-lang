# Promises the Compiler Checks

Two attributes don't change the code at all. They state a promise about a procedure, and the compiler holds you to it.

## `@(no_alloc)`

`@(no_alloc)` makes it a compile error for the procedure, or anything it calls, to allocate. The message names the allocation and the chain of calls that reached it:

```vidar,compile_fail
World :: struct { ids: [dynamic]int }

push :: proc(w: ^World, id: int) { append(&w.ids, id) }
spawn :: proc(w: ^World) { push(w, len(w.ids)) }

@(no_alloc)
step :: proc(w: ^World) {
	if len(w.ids) < 10 do spawn(w)
}

main :: proc() {
	w: World
	step(&w)
}
```

<span class="caption">Listing 15-7: An allocation three calls deep</span>

```error
error: @(no_alloc) 'step' can allocate: append, reached through step -> spawn -> push
```

It follows calls into procedures with bodies, in any package, proc groups, and interface methods whose implementations are all known. It stops, with an error, at:

- `make`, `new`, `new_clone`, `append`, `reserve`, `resize` and the other allocating built-ins;
- map inserts, and `[dynamic]` and `map` literals;
- allocating `core:` procedures: `fmt.aprintf`, `fmt.tprintf`, `strings.clone`, `strings.builder_make`, ...

A call it can't follow is an error too: a call through a closure or procedure value, an interface whose implementations aren't all known, or a `core:` procedure that isn't on its list of ones known not to allocate (`fmt.println`, `fmt.bprintf`, `core:math`, `strings.has_prefix`, ...).

As a backstop, in builds below `-o:size` the procedure's `context.allocator` and `context.temp_allocator` panic, so an allocation the analysis missed fails loudly in tests.

## `@(hot)`

`@(hot)` marks a procedure whose speed matters. With `-opt`, every decision *against* something inside it becomes a warning, on the command line and in the editor:

- an index that keeps its bounds check inside a loop (`no bounds proof`);
- a call through a closure value (`no direct call`), or a closure literal that wasn't inlined;
- an interface call through the vtable;
- an allocation inside a loop.

```console
$ vidar check . -opt
main.vidar:12: warning: @(hot) 'blur': no bounds proof: an index here isn't proven in bounds by its loop
```

Without `-opt` it does nothing.
