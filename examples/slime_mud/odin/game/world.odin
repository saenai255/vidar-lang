package game

import "core:fmt"
import "core:strings"
import "core:sync/chan"

MAJOR :: 1
MINOR :: 0
VERSION :: "SlimeMUD v1.0"

WORLD_W :: 32
WORLD_H :: 32
MAX_LEVEL :: 40
START_HP :: 30
SLIME_RESPAWN :: 30
KING_RESPAWN :: 120
PLAYER_REGEN_EVERY :: 10
SLIME_REGEN_EVERY :: 5
RUMBLE_EVERY :: 250

#assert(WORLD_W * WORLD_H <= 4096, "the world is too big for one rooms table")
#assert(WORLD_W >= 2 && WORLD_H >= 2, "the king needs a room away from the spawn pool")

Pos :: [2]int

Dir :: enum { North, South, East, West }

DIR_NAME := [Dir]string{.North = "north", .South = "south", .East = "east", .West = "west"}
DIR_SHORT := [Dir]string{.North = "n", .South = "s", .East = "e", .West = "w"}
DIR_DELTA := [Dir]Pos{.North = {0, -1}, .South = {0, 1}, .East = {1, 0}, .West = {-1, 0}}

room_names: [WORLD_W * WORLD_H]string
// xp_table[l - 1] is the total xp needed to leave level l.
xp_table: [MAX_LEVEL]int

// Built once, by the first make_world.
init_tables :: proc() {
	adjectives := [8]string{"Damp", "Mossy", "Glowing", "Sticky", "Echoing", "Quiet", "Bubbling", "Sunken"}
	places := [6]string{"Cave", "Grotto", "Bog", "Tunnel", "Hollow", "Pool"}
	for y in 0..<WORLD_H {
		for x in 0..<WORLD_W {
			room_names[y * WORLD_W + x] = "Spawn Pool" if x == 0 && y == 0 else strings.concatenate({adjectives[(x * 7 + y * 3) % 8], " ", places[(x * 5 + y * 11) % 6]})
		}
	}
	total := 0
	for l in 1..=MAX_LEVEL {
		total += 10 * l * l + 15 * l
		xp_table[l - 1] = total
	}
}

Monster_Kind :: enum { Green_Slime, Blue_Slime, Red_Slime, Slime_King }

Monster_Stats :: struct {
	name:              string,
	hp, dmg, gold, xp: int,
}

MONSTER_STATS := [Monster_Kind]Monster_Stats{
	.Green_Slime = {"Green Slime", 6, 2, 1, 3},
	.Blue_Slime  = {"Blue Slime", 10, 3, 2, 5},
	.Red_Slime   = {"Red Slime", 16, 5, 4, 9},
	.Slime_King  = {"Slime King", 80, 8, 50, 100},
}

Monster :: struct {
	kind:       Monster_Kind,
	at:         Pos,
	hp:         int,
	alive:      bool,
	respawn_at: int,
}

Record :: struct {
	name:                string,
	x, y:                int,
	hp, max_hp:          int,
	level, xp:           int,
	gold, kills, deaths: int,
}

Player :: struct {
	using rec: Record,
	// nil for simulated players
	outbox:    chan.Chan(string),
}

Room :: struct {
	players:  [dynamic]^Player,
	monsters: [dynamic]int,
}

World :: struct {
	tick:     int,
	rng:      Rng,
	rooms:    []Room,
	monsters: [dynamic]Monster,
	king:     int,
	players:  [dynamic]^Player,
}

// xorshift64*: the same sequence on every platform, so runs are reproducible.
Rng :: struct { s: u64 }

make_rng :: proc(seed: u64) -> Rng {
	s := seed ~ 0x9E3779B97F4A7C15
	return {s if s != 0 else 1}
}

roll :: proc(r: ^Rng, n: int) -> int {
	x := r.s
	x ~= x >> 12
	x ~= x << 25
	x ~= x >> 27
	r.s = x
	return int((x * 0x2545F4914F6CDD1D) % u64(n))
}

in_bounds :: proc(p: Pos) -> bool {
	return p.x >= 0 && p.x < WORLD_W && p.y >= 0 && p.y < WORLD_H
}

make_world :: proc(seed: u64, slimes: int) -> ^World {
	if room_names[0] == "" do init_tables()
	w := new(World)
	w.rng = make_rng(seed)
	w.rooms = make([]Room, WORLD_W * WORLD_H)
	for _ in 0..<slimes {
		r := roll(&w.rng, 100)
		kind := Monster_Kind.Green_Slime if r < 50 else .Blue_Slime if r < 85 else .Red_Slime
		at := Pos{roll(&w.rng, WORLD_W), roll(&w.rng, WORLD_H)}
		add_monster(w, kind, at)
	}
	w.king = add_monster(w, .Slime_King, {WORLD_W - 1, WORLD_H - 1})
	return w
}

room_at :: proc(w: ^World, p: Pos) -> ^Room {
	return &w.rooms[p.y * WORLD_W + p.x]
}

add_monster :: proc(w: ^World, kind: Monster_Kind, at: Pos) -> int {
	id := len(w.monsters)
	append(&w.monsters, Monster{kind = kind, at = at, hp = MONSTER_STATS[kind].hp, alive = true})
	append(&room_at(w, at).monsters, id)
	return id
}

move_monster :: proc(w: ^World, id: int, to: Pos) {
	m := &w.monsters[id]
	list := &room_at(w, m.at).monsters
	for other, i in list {
		if other == id {
			ordered_remove(list, i)
			break
		}
	}
	m.at = to
	append(&room_at(w, to).monsters, id)
}

move_player :: proc(w: ^World, p: ^Player, to: Pos) {
	list := &room_at(w, {p.x, p.y}).players
	for other, i in list {
		if other == p {
			ordered_remove(list, i)
			break
		}
	}
	p.x, p.y = to.x, to.y
	append(&room_at(w, to).players, p)
}

// Queues a copy of msg for the player's connection; drops it if the client is too far behind.
tell :: proc(p: ^Player, msg: string) {
	if p.outbox.impl == nil do return
	owned := strings.clone(msg)
	if !chan.try_send(p.outbox, owned) do delete(owned)
}

// Tells everyone else in p's room.
announce :: proc(w: ^World, p: ^Player, msg: string) {
	for other in room_at(w, {p.x, p.y}).players {
		if other != p do tell(other, msg)
	}
}

join :: proc(w: ^World, rec: Record, outbox: chan.Chan(string)) -> (^Player, bool) {
	for other in w.players {
		if other.name == rec.name do return nil, false
	}
	p := new_clone(Player{rec = rec, outbox = outbox})
	if !in_bounds({p.x, p.y}) do p.x, p.y = 0, 0
	append(&w.players, p)
	append(&room_at(w, {p.x, p.y}).players, p)
	announce(w, p, fmt.tprintf("* %s arrives.\n", p.name))
	return p, true
}

leave :: proc(w: ^World, p: ^Player) {
	announce(w, p, fmt.tprintf("* %s leaves the game.\n", p.name))
	list := &room_at(w, {p.x, p.y}).players
	for other, i in list {
		if other == p {
			ordered_remove(list, i)
			break
		}
	}
	for other, i in w.players {
		if other == p {
			ordered_remove(&w.players, i)
			break
		}
	}
}

free_player :: proc(p: ^Player) {
	delete(p.name)
	free(p)
}

tick :: proc(w: ^World) {
	w.tick += 1
	for &m, id in w.monsters do monster_act(w, &m, id)
	for p in w.players {
		if w.tick % PLAYER_REGEN_EVERY == 0 && p.hp < p.max_hp do p.hp += 1
	}
	if w.tick % RUMBLE_EVERY == 0 {
		for p in w.players do tell(p, "* A distant BLORP echoes through the caves.\n")
	}
}

monster_act :: proc(w: ^World, m: ^Monster, id: int) {
	stats := MONSTER_STATS[m.kind]
	king := m.kind == .Slime_King
	if !m.alive {
		if w.tick >= m.respawn_at {
			m.hp = stats.hp
			m.alive = true
			// the king never wanders: he waits in his corner
			if !king do move_monster(w, id, {roll(&w.rng, WORLD_W), roll(&w.rng, WORLD_H)})
		}
		return
	}
	regen_every := 2 if king else SLIME_REGEN_EVERY
	if w.tick % regen_every == 0 && m.hp < stats.hp do m.hp += 1
	room := room_at(w, m.at)
	if len(room.players) > 0 && roll(&w.rng, 2 if king else 3) == 0 {
		target := room.players[roll(&w.rng, len(room.players))]
		hurt_player(w, target, 1 + roll(&w.rng, stats.dmg), stats.name)
		return
	}
	if !king && roll(&w.rng, 4) == 0 {
		to := m.at + DIR_DELTA[Dir(roll(&w.rng, 4))]
		if in_bounds(to) do move_monster(w, id, to)
	}
}

// Returns whether the hit killed the monster.
hurt_monster :: proc(w: ^World, m: ^Monster, dmg: int) -> bool {
	m.hp -= dmg
	if m.hp > 0 do return false
	m.hp = 0
	m.alive = false
	m.respawn_at = w.tick + (KING_RESPAWN if m.kind == .Slime_King else SLIME_RESPAWN)
	return true
}

Loot :: struct { gold, xp: int }

monster_loot :: proc(w: ^World, m: ^Monster) -> Loot {
	stats := MONSTER_STATS[m.kind]
	extra := roll(&w.rng, 50 if m.kind == .Slime_King else 3)
	return {gold = stats.gold + extra, xp = stats.xp}
}

hurt_player :: proc(w: ^World, p: ^Player, dmg: int, by: string) {
	p.hp -= dmg
	if p.hp > 0 {
		tell(p, fmt.tprintf("* The %s hits you for %d. (hp %d/%d)\n", by, dmg, p.hp, p.max_hp))
		return
	}
	p.deaths += 1
	p.gold /= 2
	p.hp = p.max_hp
	tell(p, fmt.tprintf("* The %s slays you! You wake up in the Spawn Pool.\n", by))
	move_player(w, p, {0, 0})
}

gain_xp :: proc(p: ^Player, xp: int, out: ^strings.Builder) {
	p.xp += xp
	for p.level < MAX_LEVEL && p.xp >= xp_table[p.level - 1] {
		p.level += 1
		p.max_hp += 5
		p.hp = p.max_hp
		fmt.sbprintf(out, "You reach level %d!\n", p.level)
	}
	assert(p.hp <= p.max_hp)
}

look :: proc(w: ^World, p: ^Player, b: ^strings.Builder) {
	here := Pos{p.x, p.y}
	room := room_at(w, here)
	fmt.sbprintf(b, "== %s (%d,%d) ==\nExits:", room_names[here.y * WORLD_W + here.x], here.x, here.y)
	for d in Dir {
		if in_bounds(here + DIR_DELTA[d]) do fmt.sbprintf(b, " %s", DIR_NAME[d])
	}
	strings.write_byte(b, '\n')
	n := 0
	for id in room.monsters {
		m := &w.monsters[id]
		if !m.alive do continue
		strings.write_string(b, "Here: " if n == 0 else ", ")
		fmt.sbprintf(b, "%s [%d/%d]", MONSTER_STATS[m.kind].name, m.hp, MONSTER_STATS[m.kind].hp)
		n += 1
	}
	if n > 0 do strings.write_byte(b, '\n')
	n = 0
	for other in room.players {
		if other == p do continue
		strings.write_string(b, "Players: " if n == 0 else ", ")
		strings.write_string(b, other.name)
		n += 1
	}
	if n > 0 do strings.write_byte(b, '\n')
}
