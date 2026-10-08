package greeter

import shout "../shout"

hello :: proc(name: string) -> string {
	return shout.loud(name)
}
