# Reports with Interfaces and Closures

Now let's summarize the entries. We want two reports, a count per level and a count per service, and we'd like to add more later without touching the code that feeds them. That's an interface: every report can take an entry, `add`, and print itself, `print`. We'd also like to choose which entries count, with a minimum level from the command line. That's a closure.

```vidar,project=logsum,file=main.vidar
package main

import "core:fmt"
import "core:os"
import "core:slice"
import "core:strings"

# Level :: enum { Debug, Info, Warn, Error }
#
# Entry :: struct {
# 	time:    string,
# 	level:   Level,
# 	service: string,
# 	message: string,
# }
#
# Parse_Error :: enum { None, Too_Short, Unknown_Level }
#
# parse_level :: proc(word: string) -> (Level, bool) {
# 	switch word {
# 	case "DEBUG": return .Debug, true
# 	case "INFO":  return .Info, true
# 	case "WARN":  return .Warn, true
# 	case "ERROR": return .Error, true
# 	}
# 	return {}, false
# }
#
# parse_line :: proc(line: string) -> (e: Entry, err: Parse_Error) {
# 	fields := strings.fields(line, context.temp_allocator)
# 	if len(fields) < 4 do return {}, .Too_Short
# 	level := parse_level(fields[1]) or_return .Unknown_Level
# 	start := strings.index(line, fields[3])
# 	return Entry{fields[0], level, fields[2], line[start:]}, .None
# }
#
Report :: interface { add, print }

add   :: proc(r: Report, e: Entry) ---
print :: proc(r: Report) ---

Level_Counts :: struct { counts: [Level]int }

level_counts_add :: proc(c: ^Level_Counts, e: Entry) { c.counts[e.level] += 1 }
level_counts_print :: proc(c: ^Level_Counts) {
	for n, level in c.counts do fmt.printfln("%-6v %d", level, n)
}

impl Report for Level_Counts { add = level_counts_add, print = level_counts_print }

By_Service :: struct { counts: map[string]int }

by_service_add :: proc(s: ^By_Service, e: Entry) { s.counts[e.service] += 1 }
by_service_print :: proc(s: ^By_Service) {
	names := make([dynamic]string, context.temp_allocator)
	for name in s.counts do append(&names, name)
	slice.sort(names[:])
	for name in names do fmt.printfln("%-8s %d", name, s.counts[name])
}

impl Report for By_Service { add = by_service_add, print = by_service_print }

summarize :: proc(entries: []Entry, keep: closure(Entry) -> bool, reports: []Report) {
	for e in entries {
		if !keep(e) do continue
		for r in reports do add(r, e)
	}
	for r in reports do print(r)
}

main :: proc() {
	// --snip--
# 	path := os.args[1] if len(os.args) > 1 else "sample.log"
# 	data := os.read_entire_file(path, context.allocator) catch err {
# 		fmt.eprintfln("can't read %s: %v", path, err)
# 		os.exit(1)
# 	}
# 	defer delete(data)
# 	entries: [dynamic]Entry
# 	defer delete(entries)
# 	skipped := 0
# 	for line, i in strings.split_lines(string(data), context.temp_allocator) {
# 		if line == "" do continue
# 		e := parse_line(line) catch err {
# 			fmt.eprintfln("line %d: %v", i + 1, err)
# 			skipped += 1
# 			continue
# 		}
# 		append(&entries, e)
# 	}
# 	fmt.printfln("%d entries, %d skipped", len(entries), skipped)
	min_level := Level.Info
	if len(os.args) > 2 do min_level = parse_level(os.args[2]) or_else .Info

	levels: Level_Counts
	services: By_Service
	defer delete(services.counts)
	reports := []Report{Report(&levels), Report(&services)}
	keep := proc[min_level](e: Entry) -> bool { return e.level >= min_level }
	summarize(entries[:], keep, reports)
}
```

<span class="caption">Listing 13-3: Two reports behind an interface, fed by entries a closure lets through</span>

```output
7 entries, 2 skipped
Debug  0
Info   3
Warn   1
Error  2
api      2
auth     1
db       2
worker   1
```

`summarize` doesn't know what reports it has. It calls `add` and `print` on each, and the interface dispatches each call to `level_counts_add` or `by_service_add`. A new report is a new type with an `impl Report`, and nothing else changes.

The closure is `proc[min_level](e: Entry) -> bool { return e.level >= min_level }`. It captures the minimum level, which `main` worked out from the arguments, so `summarize` can call it without knowing where the level came from. Run it with `-- sample.log WARN` and only warnings and errors are counted.

Notice how the reports go into the slice: `Report(&levels)`. Converting to an interface takes a pointer, and inside a slice literal the conversion has to be written out; in a call argument or an `append` it would be automatic.

`services.counts` is a map, so it has to be freed, hence `defer delete(services.counts)`. That's now the second `defer delete` in `main`, and there's a third for `entries`. The next section gives all of them an owner.
