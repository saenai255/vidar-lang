package a_b_c; import __vidar "../vidar_runtime"

import "core:fmt"


// a different `Node` than a.Node
b__Node :: struct { id: int }

// a closure type whose result is a cycle member's type
b__Maker :: __vidar.Closure(proc(__vidar.Env, int) -> b__Node)

b__helper :: proc() -> string { return "b.helper" }

b__describe :: proc(id: int) -> string {
	make_node: b__Maker = __vidar.Closure(proc(__vidar.Env, int) -> b__Node){call = proc(__env_raw: __vidar.Env, id: int) -> b__Node { return b__Node{id} }}
	n := make_node.call(make_node.env, id)
	return fmt.tprintf("b(%d) -> %s", n.id, c__describe())
}
