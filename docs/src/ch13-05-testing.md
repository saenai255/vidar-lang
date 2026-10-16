# Testing the Summarizer

Last, let's add tests, in a file of their own in the same package. They can call `parse_line` and the reports directly.

```vidar,test,project=logsum,file=tests.vidar
package main

import "core:testing"

@(test)
parses_a_line :: proc(t: ^testing.T) {
	e := parse_line("09:00:01 WARN db slow query") catch err {
		testing.expectf(t, false, "parse failed: %v", err)
		return
	}
	testing.expect_value(t, e.level, Level.Warn)
	testing.expect_value(t, e.service, "db")
	testing.expect_value(t, e.message, "slow query")
}

@(test)
rejects_bad_lines :: proc(t: ^testing.T) {
	_, short := parse_line("garbage line")
	testing.expect_value(t, short, Parse_Error.Too_Short)
	_, level := parse_line("09:00:01 LOUD db what")
	testing.expect_value(t, level, Parse_Error.Unknown_Level)
}

@(test)
counts_by_level :: proc(t: ^testing.T) {
	levels: Level_Counts
	entries := []Entry{{level = .Info}, {level = .Error}, {level = .Info}}
	summarize(entries, proc[](e: Entry) -> bool { return e.level != .Error }, {Report(&levels)})
	testing.expect_value(t, levels.counts[.Info], 2)
	testing.expect_value(t, levels.counts[.Error], 0)
}
```

<span class="caption">Listing 13-7: Tests for parsing and for a report</span>

```console
$ vidar test .
...
Finished 3 tests in 1.2ms. All tests were successful.
```

`counts_by_level` passes `summarize` a closure with no captures, and checks that only the entries it lets through are counted.

## Summary

This chapter used most of what the book has covered so far:

- `catch` handled a missing file and each broken line where it happened, and `or_return` with a value turned a `bool` failure into the program's own error;
- an interface let `summarize` feed reports it knows nothing about, and a closure decided which entries count;
- destructors gave the file's data and the parsed entries one owner, and freed a map without a `defer`;
- tests checked the parts.

The rest of the book goes further: goroutines and channels in Chapter 14, making code faster with `-opt` in Chapter 15, and the tools in Chapter 16.
