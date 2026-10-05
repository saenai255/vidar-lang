package main; import __vidar "vidar_runtime"

import "core:fmt"
import "core:mem"
import "core:strings"

// scoped! is built into Vidar (no import, no definition needed):
//   scoped! { ... }             the block gets its own temp allocator, freed when the block ends
//   scoped!(allocator) { ... }  same, but the arena's memory comes from `allocator`

main :: proc() {
	// track every heap allocation, so we can see the block's arena come and go
	track: mem.Tracking_Allocator
	mem.tracking_allocator_init(&track, context.allocator)
	context.allocator = mem.tracking_allocator(&track)
	live :: proc(t: ^mem.Tracking_Allocator) -> int { return len(t.allocation_map) }

	outer := fmt.tprintf("allocated before the block") // lives in the normal temp allocator
	before := live(&track)
	outer_temp := context.temp_allocator

	{ arena__1: __vidar.Temp_Arena; context.temp_allocator = __vidar.temp_arena_begin(&arena__1, context.allocator); defer __vidar.temp_arena_end(&arena__1); {
		words: [dynamic] string;
		words.allocator = context.temp_allocator;
		for i in 0..<1000 {
			append(&words, fmt.tprintf("word-%d", i)); // all of this goes to the block's arena
		};
		joined := strings.join(words[:], ",", context.temp_allocator);
		fmt.println("inside: own temp allocator:", context.temp_allocator.data != outer_temp.data);
		fmt.println("inside:", len(words), "words,", len(joined), "bytes joined");
		fmt.println("inside: arena blocks on the heap:", live(&track) > before);

		{ arena__2: __vidar.Temp_Arena; context.temp_allocator = __vidar.temp_arena_begin(&arena__2, context.allocator); defer __vidar.temp_arena_end(&arena__2); {
			fmt.println("nested: separate arena again:", context.temp_allocator.data != outer_temp.data);
			_ = fmt.tprintf("%s", joined); // the outer block's data is still valid here
		}; };
	}; }

	fmt.println("after: arena freed:", live(&track) == before)
	fmt.println("after: temp allocator restored:", context.temp_allocator.data == outer_temp.data)
	fmt.println("after: earlier temp data still valid:", outer)

	// with an explicit backing allocator: here a second tracker, to show where the memory comes from
	other: mem.Tracking_Allocator
	mem.tracking_allocator_init(&other, context.allocator)
	{ arena__3: __vidar.Temp_Arena; context.temp_allocator = __vidar.temp_arena_begin(&arena__3, mem.tracking_allocator(&other)); defer __vidar.temp_arena_end(&arena__3); {
		_ = fmt.tprintf("%d", 12345);
		fmt.println("custom backing: arena allocated from it:", len(other.allocation_map) > 0);
	}; }
	fmt.println("custom backing: returned to it:", len(other.allocation_map) == 0)
}
