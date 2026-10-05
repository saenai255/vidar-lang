package main

import "core:fmt"

Pair :: struct { go, select: int }

select :: proc(a, b: int) -> int { return a if a > b else b }

main :: proc() {
	go := 3
	go += 1
	go = select(go, 2)
	p := Pair{go = go, select = 1}
	a, b := 1, 2
	if a<-b {
		fmt.println("no")
	}
	less := a<-b
	fmt.println(go, p.go, p.select, less, a < -b)
}
