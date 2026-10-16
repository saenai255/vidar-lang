# Parsing with Error Handling

Next, we'll turn each line into an `Entry`. A line can be broken in two ways, too short or with an unknown level, so parsing returns an error alongside the entry.

```vidar,project=logsum,file=main.vidar
# package main
#
# import "core:fmt"
# import "core:os"
# import "core:strings"
#
Level :: enum { Debug, Info, Warn, Error }

Entry :: struct {
	time:    string,
	level:   Level,
	service: string,
	message: string,
}

Parse_Error :: enum { None, Too_Short, Unknown_Level }

parse_level :: proc(word: string) -> (Level, bool) {
	switch word {
	case "DEBUG": return .Debug, true
	case "INFO":  return .Info, true
	case "WARN":  return .Warn, true
	case "ERROR": return .Error, true
	}
	return {}, false
}

parse_line :: proc(line: string) -> (e: Entry, err: Parse_Error) {
	fields := strings.fields(line, context.temp_allocator)
	if len(fields) < 4 do return {}, .Too_Short
	level := parse_level(fields[1]) or_return .Unknown_Level
	start := strings.index(line, fields[3])
	return Entry{fields[0], level, fields[2], line[start:]}, .None
}

main :: proc() {
	// --snip--
# 	path := os.args[1] if len(os.args) > 1 else "sample.log"
# 	data := os.read_entire_file(path, context.allocator) catch err {
# 		fmt.eprintfln("can't read %s: %v", path, err)
# 		os.exit(1)
# 	}
# 	defer delete(data)
	entries: [dynamic]Entry
	defer delete(entries)
	skipped := 0
	for line, i in strings.split_lines(string(data), context.temp_allocator) {
		if line == "" do continue
		e := parse_line(line) catch err {
			fmt.eprintfln("line %d: %v", i + 1, err)
			skipped += 1
			continue
		}
		append(&entries, e)
	}
	fmt.printfln("%d entries, %d skipped", len(entries), skipped)
}
```

<span class="caption">Listing 13-2: Parsing each line into an `Entry`, skipping the ones that don't parse</span>

```output
7 entries, 2 skipped
```

On stderr, the program also says which lines it skipped:

```text
line 5: Too_Short
line 9: Unknown_Level
```

Let's look at the two error-handling lines.

In `parse_line`, `parse_level` reports failure with a `bool`, the way Odin's `core` procedures often do, but `parse_line` reports a `Parse_Error`. `or_return .Unknown_Level` bridges the two: if `parse_level` fails, `parse_line` returns `.Unknown_Level`, and the zero `Entry` with it.

In `main`, `catch err` handles each failure where it happens: it prints the line number and the error, counts the line as skipped, and moves on with `continue`. Because the `catch` follows a declaration, its block has to leave the scope, and `continue` does.

The entry's strings, `time`, `service` and `message`, are slices of the line, which is a slice of `data`. Nothing is copied, so they're valid as long as `data` is. We'll come back to that when we tidy up ownership.
