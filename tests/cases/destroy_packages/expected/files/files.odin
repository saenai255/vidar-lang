package files

import "core:fmt"

File :: struct { name: string }
Error :: enum { None, Missing }

file_destroy :: proc(f: ^File) {
	if f.name == "" do return
	fmt.println("close", f.name)
}



open :: proc(name: string) -> (File, Error) {
	if name == "missing" do return {}, .Missing
	return File{name}, .None
}

open_named :: proc(name: string) -> (f: File, err: Error) {
	{ __vidar_new: type_of(f) = File{name}; __vidar_old := f; f = __vidar_new; file_destroy(&__vidar_old) }
	return
}
