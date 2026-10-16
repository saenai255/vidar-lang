# Owning the Data

`main` now has three `defer delete`s for three pieces of memory, and two of them are related in a way the code doesn't show: the entries point into `data`, so `data` must outlive them. Let's put the file's contents and the entries parsed from them together in one `Log`, which owns both and frees both. Loading becomes a procedure that returns a `Log`.

```vidar,project=logsum,file=main.vidar
# package main
#
# import "core:fmt"
# import "core:os"
# import "core:slice"
# import "core:strings"
#
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
// --snip--
Log :: struct {
	data:    []byte,
	entries: [dynamic]Entry,
	skipped: int,
}

log_destroy :: proc(l: ^Log) {
	delete(l.data)
	delete(l.entries)
}

impl Destroy for Log { destroy = log_destroy }

load :: proc(path: string) -> (l: Log, err: os.Error) {
	l.data = os.read_entire_file(path, context.allocator) or_return
	for line, i in strings.split_lines(string(l.data), context.temp_allocator) {
		if line == "" do continue
		e := parse_line(line) catch perr {
			fmt.eprintfln("line %d: %v", i + 1, perr)
			l.skipped += 1
			continue
		}
		append(&l.entries, e)
	}
	return
}
#
# Report :: interface { add, print }
#
# add   :: proc(r: Report, e: Entry) ---
# print :: proc(r: Report) ---
#
# Level_Counts :: struct { counts: [Level]int }
#
# level_counts_add :: proc(c: ^Level_Counts, e: Entry) { c.counts[e.level] += 1 }
# level_counts_print :: proc(c: ^Level_Counts) {
# 	for n, level in c.counts do fmt.printfln("%-6v %d", level, n)
# }
#
# impl Report for Level_Counts { add = level_counts_add, print = level_counts_print }
#
# By_Service :: struct { counts: map[string]int }
#
# by_service_add :: proc(s: ^By_Service, e: Entry) { s.counts[e.service] += 1 }
# by_service_print :: proc(s: ^By_Service) {
# 	names := make([dynamic]string, context.temp_allocator)
# 	for name in s.counts do append(&names, name)
# 	slice.sort(names[:])
# 	for name in names do fmt.printfln("%-8s %d", name, s.counts[name])
# }
#
# impl Report for By_Service { add = by_service_add, print = by_service_print }
#
# summarize :: proc(entries: []Entry, keep: closure(Entry) -> bool, reports: []Report) {
# 	for e in entries {
# 		if !keep(e) do continue
# 		for r in reports do add(r, e)
# 	}
# 	for r in reports do print(r)
# }
#
main :: proc() {
	path := os.args[1] if len(os.args) > 1 else "sample.log"
	log := load(path) catch err {
		fmt.eprintfln("can't read %s: %v", path, err)
		os.exit(1)
	}
	fmt.printfln("%d entries, %d skipped", len(log.entries), log.skipped)

	min_level := Level.Info
	if len(os.args) > 2 do min_level = parse_level(os.args[2]) or_else .Info

	levels: Level_Counts
	services: By_Service
	reports := []Report{Report(&levels), Report(&services)}
	keep := proc[min_level](e: Entry) -> bool { return e.level >= min_level }
	summarize(log.entries[:], keep, reports)
}
```

<span class="caption">Listing 13-4: A `Log` owns the file's data and the entries that point into it</span>

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

A few things changed:

- **`Log` has a destructor.** `log_destroy` frees the data and the entries together, so they can't outlive each other. `main` has no `defer delete` for them any more: `log` is destroyed at the end of `main`.
- **`load` returns its `Log`.** Returning a local moves it to the caller, so `load` doesn't destroy it. If reading fails, `or_return` returns the error with a zero `Log`, and destroying a zero `Log` is harmless, since `delete` ignores `nil`.
- **Errors use `or_return` again.** `load` returns an `os.Error` itself, so plain `or_return` passes the read error on unchanged; the per-line errors are still handled with `catch`, inside.

The map in `By_Service` gets the same treatment:

```vidar,project=logsum,file=main.vidar
# package main
#
# import "core:fmt"
# import "core:os"
# import "core:slice"
# import "core:strings"
#
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
# Log :: struct {
# 	data:    []byte,
# 	entries: [dynamic]Entry,
# 	skipped: int,
# }
#
# log_destroy :: proc(l: ^Log) {
# 	delete(l.data)
# 	delete(l.entries)
# }
#
# impl Destroy for Log { destroy = log_destroy }
#
# load :: proc(path: string) -> (l: Log, err: os.Error) {
# 	l.data = os.read_entire_file(path, context.allocator) or_return
# 	for line, i in strings.split_lines(string(l.data), context.temp_allocator) {
# 		if line == "" do continue
# 		e := parse_line(line) catch perr {
# 			fmt.eprintfln("line %d: %v", i + 1, perr)
# 			l.skipped += 1
# 			continue
# 		}
# 		append(&l.entries, e)
# 	}
# 	return
# }
#
# Report :: interface { add, print }
#
# add   :: proc(r: Report, e: Entry) ---
# print :: proc(r: Report) ---
#
# Level_Counts :: struct { counts: [Level]int }
#
# level_counts_add :: proc(c: ^Level_Counts, e: Entry) { c.counts[e.level] += 1 }
# level_counts_print :: proc(c: ^Level_Counts) {
# 	for n, level in c.counts do fmt.printfln("%-6v %d", level, n)
# }
#
# impl Report for Level_Counts { add = level_counts_add, print = level_counts_print }
#
By_Service :: struct { counts: map[string]int }
#
by_service_destroy :: proc(s: ^By_Service) { delete(s.counts) }
impl Destroy for By_Service { destroy = by_service_destroy }
#
# by_service_add :: proc(s: ^By_Service, e: Entry) { s.counts[e.service] += 1 }
# by_service_print :: proc(s: ^By_Service) {
# 	names := make([dynamic]string, context.temp_allocator)
# 	for name in s.counts do append(&names, name)
# 	slice.sort(names[:])
# 	for name in names do fmt.printfln("%-8s %d", name, s.counts[name])
# }
#
# impl Report for By_Service { add = by_service_add, print = by_service_print }
#
# summarize :: proc(entries: []Entry, keep: closure(Entry) -> bool, reports: []Report) {
# 	for e in entries {
# 		if !keep(e) do continue
# 		for r in reports do add(r, e)
# 	}
# 	for r in reports do print(r)
# }
#
# main :: proc() {
# 	path := os.args[1] if len(os.args) > 1 else "sample.log"
# 	log := load(path) catch err {
# 		fmt.eprintfln("can't read %s: %v", path, err)
# 		os.exit(1)
# 	}
# 	fmt.printfln("%d entries, %d skipped", len(log.entries), log.skipped)
#
# 	min_level := Level.Info
# 	if len(os.args) > 2 do min_level = parse_level(os.args[2]) or_else .Info
#
# 	levels: Level_Counts
# 	services: By_Service
# 	reports := []Report{Report(&levels), Report(&services)}
# 	keep := proc[min_level](e: Entry) -> bool { return e.level >= min_level }
# 	summarize(log.entries[:], keep, reports)
# }
```

<span class="caption">Listing 13-5: `By_Service` frees its map when it goes out of scope</span>

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

Now `main` has no cleanup code at all, yet everything is freed on every path out of it. Here's the whole program:

```vidar,project=logsum,file=main.vidar
package main

import "core:fmt"
import "core:os"
import "core:slice"
import "core:strings"

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

Log :: struct {
	data:    []byte,
	entries: [dynamic]Entry,
	skipped: int,
}

log_destroy :: proc(l: ^Log) {
	delete(l.data)
	delete(l.entries)
}

impl Destroy for Log { destroy = log_destroy }

load :: proc(path: string) -> (l: Log, err: os.Error) {
	l.data = os.read_entire_file(path, context.allocator) or_return
	for line, i in strings.split_lines(string(l.data), context.temp_allocator) {
		if line == "" do continue
		e := parse_line(line) catch perr {
			fmt.eprintfln("line %d: %v", i + 1, perr)
			l.skipped += 1
			continue
		}
		append(&l.entries, e)
	}
	return
}

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

by_service_destroy :: proc(s: ^By_Service) { delete(s.counts) }
impl Destroy for By_Service { destroy = by_service_destroy }

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
	path := os.args[1] if len(os.args) > 1 else "sample.log"
	log := load(path) catch err {
		fmt.eprintfln("can't read %s: %v", path, err)
		os.exit(1)
	}
	fmt.printfln("%d entries, %d skipped", len(log.entries), log.skipped)

	min_level := Level.Info
	if len(os.args) > 2 do min_level = parse_level(os.args[2]) or_else .Info

	levels: Level_Counts
	services: By_Service
	reports := []Report{Report(&levels), Report(&services)}
	keep := proc[min_level](e: Entry) -> bool { return e.level >= min_level }
	summarize(log.entries[:], keep, reports)
}
```

<span class="caption">Listing 13-6: The finished `main.vidar`</span>

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
