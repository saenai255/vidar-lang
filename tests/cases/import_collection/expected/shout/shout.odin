package shout

import "core:strings"

loud :: proc(s: string) -> string {
	return strings.to_upper(s)
}
