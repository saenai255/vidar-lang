package main

import "core:flags"
import "core:fmt"
import "core:mem/virtual"
import "core:os"
import "core:time"
import "game"
import "server"

// What a simulated player types on tick t.
bot_line :: proc(w: ^game.World, p: ^game.Player, rng: ^game.Rng, t: int) -> string {
	if t % 17 == 0 do return "say hello"
	if t % 13 == 0 do return "look"
	if t % 11 == 0 do return "stats"
	if t % 29 == 0 && p.gold > 0 do return fmt.tprintf("bet %d", p.gold / 2 + 1)
	for id in game.room_at(w, {p.x, p.y}).monsters {
		if w.monsters[id].alive do return "attack slime"
	}
	return game.DIR_SHORT[game.Dir(game.roll(rng, 4))]
}

simulate :: proc(cfg: server.Config) {
	arena: virtual.Arena
	defer virtual.arena_destroy(&arena)
	context.allocator = virtual.arena_allocator(&arena)

	w := game.make_world(cfg.seed, cfg.slimes)
	bots: [dynamic]^game.Player
	for i in 0..<cfg.sim_players {
		p, _ := game.join(w, game.fresh_record(fmt.tprintf("bot%d", i)), {})
		append(&bots, p)
	}
	rng := game.make_rng(cfg.seed + 1)
	start := time.tick_now()
	for t in 1..=cfg.sim {
		for p in bots {
			c := game.Ctx{w = w, p = p}
			game.handle_line(&c, bot_line(w, p, &rng, t))
		}
		game.tick(w)
		free_all(context.temp_allocator)
	}
	fmt.eprintfln("[timed] sim: %v", time.tick_since(start))

	xp, gold, kills, deaths, levels, alive: int
	for p in bots {
		xp += p.xp
		gold += p.gold
		kills += p.kills
		deaths += p.deaths
		levels += p.level
	}
	for m in w.monsters {
		if m.alive do alive += 1
	}
	fmt.printfln("sim ticks=%d players=%d slimes=%d", cfg.sim, len(bots), cfg.slimes)
	fmt.printfln("xp=%d gold=%d kills=%d deaths=%d levels=%d alive=%d rng=%x",
		xp, gold, kills, deaths, levels, alive, w.rng.s)
}

main :: proc() {
	cfg := server.DEFAULT_CONFIG
	flags.parse_or_exit(&cfg, os.args, .Unix)
	if cfg.sim > 0 {
		simulate(cfg)
		return
	}
	if !server.run(cfg) do os.exit(1)
}
