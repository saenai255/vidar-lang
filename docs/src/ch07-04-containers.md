# Containers Own Their Elements

A dynamic array or a map *owns* what it holds. A `[dynamic]File` is destroyed like any other type holding a `File`: each element is destroyed, last first, and then the array's memory is freed. A map destroys its values the same way. A struct with such a field destroys it along with its other fields.

```vidar
# File :: struct { name: string }
# open :: proc(name: string) -> File { fmt.println("open", name); return File{name} }
# file_close :: proc(f: ^File) {
# 	if f.name == "" do return
# 	fmt.println("close", f.name)
# }
# impl Destroy for File { destroy = file_close }
#
main :: proc() {
	files: [dynamic]File
	append(&files, open("a"))        // a new value moves in
	f := open("b")
	append(&files, move!(f))         // so does a moved one
	files[0] = open("c")             // destroys the old element
	for file in files do fmt.println("have", file.name)   // borrows each
}                                    // each File is closed, then the array freed
```

<span class="caption">Listing 7-10: A dynamic array of files</span>

```output
open a
open b
open c
close a
have c
have b
close b
close c
```

There's no `defer delete(files)` any more: the array is destroyed with its elements at the end of the scope. (An existing `defer delete(files)` stays correct, as you'll see below.)

## Procedures That Drop Elements

Core's procedures that remove elements from a dynamic array or map destroy what they remove first. Vidar replaces each call with a version that does:

- `clear`, `resize`, `ordered_remove`, `unordered_remove` and `remove_range`;
- `pop`, `pop_front` and `delete_key`, when their result is thrown away. When you keep the result, it has an owner, and nothing is destroyed: `last := pop(&files)` gives you the last file.

```vidar
# File :: struct { name: string }
# open :: proc(name: string) -> File { fmt.println("open", name); return File{name} }
# file_close :: proc(f: ^File) {
# 	if f.name == "" do return
# 	fmt.println("close", f.name)
# }
# impl Destroy for File { destroy = file_close }
#
main :: proc() {
	files: [dynamic]File
	for name in ([]string{"a", "b", "c", "d"}) do append(&files, open(name))
	ordered_remove(&files, 0)       // closes a
	last := pop(&files)             // last owns d now
	pop(&files)                     // closes c
	fmt.println("left:", len(files), "kept:", last.name)
	clear(&files)                   // closes b
	fmt.println("cleared")
}
```

<span class="caption">Listing 7-11: Removing elements destroys them, unless you keep them</span>

```output
open a
open b
open c
open d
close a
close c
left: 1 kept: d
close b
cleared
close d
```

`delete(files)` destroys the elements, frees the memory and leaves `files` empty, so the array's own destroy afterwards does nothing. It takes the variable or field holding the array, not a by-value parameter, which is borrowed.

Maps work the same way: `m[k] = v` destroys the value it replaces, `delete_key(&m, k)` as a statement destroys the value it removes, and the map's own destroy destroys every value. Reading a value out of a map with `v, ok := m[k]` would copy it; take a pointer instead, with `if p, ok := &m[k]; ok { ... }`.

## Procedures That Would Copy

A few core procedures overwrite or copy elements without destroying the old ones, so with destructible elements they're errors, and the message says what to write instead: `assign_at`, `map_insert`, `map_upsert`, `map_entry`, `non_zero_resize`, `copy`, and `append(&a, ..xs)`.

## Copying a Container

A dynamic array of a type with `impl Clone` is cloned element by element, into new memory from the same allocator. A map can't be cloned, so copying one is an error; move it with `move!`. A map's keys can't be destructible.

## Slices Are Views

A slice, `[]File`, doesn't own its elements: it's a view into an array someone else owns, and it's never destroyed. `files[:]` borrows the array's elements. That means a slice can't be the *only* place destructible values live, so making one that would own them is an error: `make([]File, n)`, a slice literal `[]File{...}`, and `delete` of a `[]File`. Use a dynamic array instead.

## What Can't Hold a `File`

Some containers can't hold destructible values yet, because their procedures copy and drop values without destroying them, or because Vidar can't tell which elements are live:

- Odin packages' container types, such as `queue.Queue(File)` or `small_array.Small_Array(4, File)`;
- `#soa` arrays and fixed-capacity dynamic arrays (`[dynamic; N]File`);
- `distinct` types over a destructible type, map keys, and package-level variables.

Each of these is a compile error rather than a silent leak. Hold pointers in them instead, or use a dynamic array.

## Summary

- Dynamic arrays and maps own their elements: destroyed with the container.
- `append` moves values in; `clear`, `pop`, `ordered_remove`, `delete_key` and the rest destroy what they drop.
- `delete(xs)` destroys the elements too, and leaves the array empty.
- Slices are views and never own elements.
