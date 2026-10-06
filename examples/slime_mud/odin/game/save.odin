package game

import "core:fmt"
import "core:hash"
import "core:strconv"
import "core:strings"

// Save files are `key=value` lines, sealed with a `crc=` line over everything before it.

SAVE_FORMAT_VERSION :: 1

Save_Error :: enum { None, Io, Corrupt, Too_New, Unknown_Field, Bad_Value }

NEW_PLAYER :: "hp=30\nmax_hp=30\nlevel=1\n"

write_record :: proc(r: ^Record, b: ^strings.Builder) {
	fmt.sbprintf(b, "version=%d\n", SAVE_FORMAT_VERSION)
	fmt.sbprintf(b, "name=%s\n", r.name)
	fmt.sbprintf(b, "x=%d\ny=%d\n", r.x, r.y)
	fmt.sbprintf(b, "hp=%d\nmax_hp=%d\n", r.hp, r.max_hp)
	fmt.sbprintf(b, "level=%d\nxp=%d\n", r.level, r.xp)
	fmt.sbprintf(b, "gold=%d\nkills=%d\ndeaths=%d\n", r.gold, r.kills, r.deaths)
}

// Serializes the record and seals it; the result is allocated with `allocator`.
seal_record :: proc(r: ^Record, allocator := context.allocator) -> string {
	b := strings.builder_make(allocator)
	write_record(r, &b)
	fmt.sbprintf(&b, "crc=%x\n", hash.crc32(b.buf[:]))
	return strings.to_string(b)
}

fresh_record :: proc(name: string) -> Record {
	rec, err := parse_fields(NEW_PLAYER)
	assert(err == .None)
	rec.name = strings.clone(name)
	return rec
}

parse_fields :: proc(text: string) -> (rec: Record, err: Save_Error) {
	defer if err != .None do delete(rec.name)
	text := text
	for line in strings.split_lines_iterator(&text) {
		if line == "" do continue
		key, _, value := strings.partition(line, "=")
		field: ^int
		switch key {
		case "name":
			delete(rec.name)
			rec.name = strings.clone(value)
			continue
		case "version":
			v, ok := strconv.parse_int(value)
			if !ok do return rec, .Bad_Value
			if v > SAVE_FORMAT_VERSION do return rec, .Too_New
			continue
		case "x":      field = &rec.x
		case "y":      field = &rec.y
		case "hp":     field = &rec.hp
		case "max_hp": field = &rec.max_hp
		case "level":  field = &rec.level
		case "xp":     field = &rec.xp
		case "gold":   field = &rec.gold
		case "kills":  field = &rec.kills
		case "deaths": field = &rec.deaths
		case:          return rec, .Unknown_Field
		}
		n, ok := strconv.parse_int(value)
		if !ok do return rec, .Bad_Value
		field^ = n
	}
	return rec, .None
}

parse_record :: proc(text: string) -> (rec: Record, err: Save_Error) {
	text := strings.trim_right(text, "\n")
	at := strings.last_index(text, "\ncrc=")
	if at < 0 do return {}, .Corrupt
	want, ok := strconv.parse_u64_of_base(text[at + 5:], 16)
	if !ok do return {}, .Corrupt
	body := text[:at + 1]
	if u64(hash.crc32(transmute([]byte)body)) != want do return {}, .Corrupt
	rec = parse_fields(body) or_return
	if rec.name == "" do return rec, .Corrupt
	return rec, .None
}
