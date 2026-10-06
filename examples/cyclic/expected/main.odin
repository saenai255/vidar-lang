package main; import __vidar "vidar_runtime"

import "core:fmt"
import game "game_ui"

main :: proc() {
	w := game.game__make_world()
	{ // game.spawn(&w, "player") catch unreachable — main.vidar:8
		__err1 := game.game__spawn(&w, "player")
		if __vidar.failed(__err1) do __vidar.unexpected(__err1)
	}
	{ // game.spawn(&w, "") catch err { ... } — main.vidar:9
		__err2 := game.game__spawn(&w, "")
		if __vidar.failed(__err2) { err := __err2; fmt.println("[main] spawn rejected:", err) }
	}
	fmt.println(game.game__run(&w, 3))
}
