package game

import "core:fmt"
import "core:strconv"
import "core:strings"

Command_Error :: enum { None, Unknown, Missing_Arg, Bad_Number, Bad_Direction, Blocked, No_Target, Not_Enough_Gold }

ERROR_TEXT := [Command_Error]string{
	.None            = "",
	.Unknown         = "Huh? Type 'help'.",
	.Missing_Arg     = "That needs an argument.",
	.Bad_Number      = "That's not a number.",
	.Bad_Direction   = "Which way is that?",
	.Blocked         = "You can't go that way.",
	.No_Target       = "There's nothing like that here.",
	.Not_Enough_Gold = "You don't have that much gold.",
}

HELP_TEXT :: "Commands: look go attack say stats who bet save quit help\nDirections: n s e w\n"

// Saves p, or returns false when saving is off.
Saver :: #type proc(data: rawptr, p: ^Player) -> bool

Ctx :: struct {
	w:          ^World,
	p:          ^Player,
	arg:        string,
	out:        ^strings.Builder,
	saver:      Saver,
	saver_data: rawptr,
}

run_command :: proc(c: ^Ctx, line: string) -> Command_Error {
	line := strings.trim_space(line)
	if line == "" do return .None
	verb, _, arg := strings.partition(line, " ")
	c.arg = strings.trim_space(arg)
	switch verb {
	case "look", "l":
		look(c.w, c.p, c.out)
	case "go":
		if c.arg == "" do return .Missing_Arg
		d := parse_dir(c.arg) or_return
		return go(c, d)
	case "n": return go(c, .North)
	case "s": return go(c, .South)
	case "e": return go(c, .East)
	case "w": return go(c, .West)
	case "attack", "a":
		return attack(c)
	case "say":
		if c.arg == "" do return .Missing_Arg
		fmt.sbprintf(c.out, "You say: %s\n", c.arg)
		announce(c.w, c.p, fmt.tprintf("* %s says: %s\n", c.p.name, c.arg))
	case "stats":
		p := c.p
		fmt.sbprintf(c.out, "%s | level %d | hp %d/%d | xp %d/%d | gold %d | kills %d | deaths %d\n",
			p.name, p.level, p.hp, p.max_hp, p.xp, xp_table[p.level - 1], p.gold, p.kills, p.deaths)
	case "who":
		fmt.sbprintf(c.out, "%d online:", len(c.w.players))
		for p, i in c.w.players do fmt.sbprintf(c.out, "%s%s", " " if i == 0 else ", ", p.name)
		strings.write_byte(c.out, '\n')
	case "bet":
		return bet(c)
	case "save":
		saved := c.saver != nil && c.saver(c.saver_data, c.p)
		strings.write_string(c.out, "Saved.\n" if saved else "Saving is off.\n")
	case "quit":
		fmt.sbprintf(c.out, "Bye, %s!\n", c.p.name)
	case "help", "?":
		strings.write_string(c.out, HELP_TEXT)
	case:
		return .Unknown
	}
	return .None
}

// Runs one line of input and returns the reply, prompt included, on the temp allocator.
handle_line :: proc(c: ^Ctx, line: string) -> string {
	b := strings.builder_make(context.temp_allocator)
	c.out = &b
	if err := run_command(c, line); err != .None {
		fmt.sbprintln(&b, ERROR_TEXT[err])
	}
	strings.write_string(&b, "> ")
	return strings.to_string(b)
}

parse_dir :: proc(s: string) -> (Dir, Command_Error) {
	for d in Dir {
		if s == DIR_NAME[d] || s == DIR_SHORT[d] do return d, .None
	}
	return .North, .Bad_Direction
}

// Case-insensitive substring match, without allocating.
matches :: proc(name, query: string) -> bool {
	lower :: proc(c: byte) -> byte { return c + 32 if c >= 'A' && c <= 'Z' else c }
	outer: for i in 0..=len(name) - len(query) {
		for j in 0..<len(query) {
			if lower(name[i + j]) != lower(query[j]) do continue outer
		}
		return true
	}
	return false
}

go :: proc(c: ^Ctx, d: Dir) -> Command_Error {
	p := c.p
	to := Pos{p.x, p.y} + DIR_DELTA[d]
	if !in_bounds(to) do return .Blocked
	announce(c.w, p, fmt.tprintf("* %s leaves %s.\n", p.name, DIR_NAME[d]))
	move_player(c.w, p, to)
	announce(c.w, p, fmt.tprintf("* %s arrives.\n", p.name))
	look(c.w, p, c.out)
	if king := &c.w.monsters[c.w.king]; king.alive && king.at == to {
		fmt.sbprintln(c.out, "The Slime King roars: BLORP!")
	}
	return .None
}

attack :: proc(c: ^Ctx) -> Command_Error {
	if c.arg == "" do return .Missing_Arg
	target: ^Monster
	for id in room_at(c.w, {c.p.x, c.p.y}).monsters {
		m := &c.w.monsters[id]
		if m.alive && matches(MONSTER_STATS[m.kind].name, c.arg) {
			target = m
			break
		}
	}
	if target == nil do return .No_Target

	name := MONSTER_STATS[target.kind].name
	dmg := 1 + roll(&c.w.rng, c.p.level + 3)
	killed := hurt_monster(c.w, target, dmg)
	fmt.sbprintf(c.out, "You hit the %s for %d.\n", name, dmg)
	if !killed do return .None
	loot := monster_loot(c.w, target)
	c.p.gold += loot.gold
	c.p.kills += 1
	fmt.sbprintf(c.out, "You slay the %s! (+%d xp, +%d gold)\n", name, loot.xp, loot.gold)
	gain_xp(c.p, loot.xp, c.out)
	return .None
}

bet :: proc(c: ^Ctx) -> Command_Error {
	if c.arg == "" do return .Missing_Arg
	amount, ok := strconv.parse_int(c.arg)
	if !ok || amount <= 0 do return .Bad_Number
	if amount > c.p.gold do return .Not_Enough_Gold
	if roll(&c.w.rng, 2) == 0 {
		c.p.gold += amount
		fmt.sbprintf(c.out, "You win %d gold!\n", amount)
	} else {
		c.p.gold -= amount
		fmt.sbprintf(c.out, "You lose %d gold.\n", amount)
	}
	return .None
}
