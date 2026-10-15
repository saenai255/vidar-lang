package main; import __vidar "vidar_runtime"

import "core:fmt"
import files "files"

// a File from another package is destroyed with that package's proc
first :: proc(name: string) -> (n: int, err: files.Error) {
	f := __vidar.drop_failed(files.open(name)) or_return; defer files.file_destroy(&f) // on the error path, the defer isn't reached yet
	fmt.println("opened", f.name)
	return len(f.name), .None
}

main :: proc() {
	n, err := first("one")
	fmt.println(n, err)
	n, err = first("missing")
	fmt.println(n, err)
	g, gerr := files.open_named("named"); defer files.file_destroy(&g)
	fmt.println(g.name, gerr)
}
