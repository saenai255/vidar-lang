# Reading the Log

Start a project, and put a sample log in it:

```console
$ vidar new logsum
$ cd logsum
```

```text,project=logsum,file=sample.log
09:00:01 INFO  api     request served in 12ms
09:00:02 WARN  db      slow query took 840ms
09:00:02 INFO  api     request served in 9ms
09:00:03 ERROR auth    token expired for user 42
garbage line
09:00:04 INFO  worker  job 7 finished
09:00:05 ERROR db      connection reset
09:00:06 DEBUG api     cache hit
09:00:07 LOUD  api     what is this level
```

Each line has a time, a level, the service that wrote it, and a message. Two lines are broken on purpose: one is too short, and one has a level we don't know.

## Reading the File

Our program takes the path of the log as its first argument, and falls back to `sample.log` without one. Odin puts the command-line arguments in `os.args`, with the program's own name first. `os.read_entire_file` reads a whole file into memory, and returns the bytes and an error.

```vidar,project=logsum,file=main.vidar
package main

import "core:fmt"
import "core:os"
import "core:strings"

main :: proc() {
	path := os.args[1] if len(os.args) > 1 else "sample.log"
	data := os.read_entire_file(path, context.allocator) catch err {
		fmt.eprintfln("can't read %s: %v", path, err)
		os.exit(1)
	}
	defer delete(data)

	count := 0
	for line in strings.split_lines(string(data), context.temp_allocator) {
		if line != "" do count += 1
	}
	fmt.println(count, "lines")
}
```

<span class="caption">Listing 13-1: Reading the file named on the command line, and counting its lines</span>

```output
9 lines
```

To pass arguments through `vidar run`, put them after `--`: `vidar run . -- sample.log`.

Reading a file can fail, so the call is followed by `catch`: if the file can't be read, we print why to stderr and exit with a failure status. `os.exit` never returns, so it counts as leaving the block. The error is `os.Error`, which prints as its name:

```console
$ vidar run . -- missing.log
can't read missing.log: Not_Exist
```

`data` is ours to free, so `defer delete(data)` follows. The lines are slices into `data`, allocated with the temp allocator; we don't need to free those one by one.
