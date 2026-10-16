# A First Vidar Program: A Grade Book

Let's jump into Vidar by working through a small project together. This chapter introduces several of Vidar's features by using them in a real program: closures, interfaces, error handling, destructors and anonymous struct literals. You'll learn about each of them in detail in later chapters; here, you'll just see them at work.

We'll write a grade book. It reads a list of students and their scores, skips the lines it can't read, counts how many students passed, gives letter grades in two different ways, and prints a summary. To keep the program self-contained, the input is a string in the program rather than a file; [Chapter 13](ch13-00-project.md) reads real files.

## Setting Up a New Project

Make a new project with `vidar new`:

```console
$ vidar new gradebook
$ cd gradebook
```

All the code in this chapter goes in `main.vidar`.

## Reading the Scores

Each line of input holds a name and a score, separated by spaces. Some lines are broken. Listing 3-1 reads the lines into a dynamic array and reports the ones it skips.

```vidar,project=gradebook,file=main.vidar
package main

import "core:fmt"
import "core:strconv"
import "core:strings"

Student :: struct {
	name:  string,
	score: int,
}

Parse_Error :: enum { None, Missing_Score, Bad_Score }

parse_line :: proc(line: string) -> (s: Student, err: Parse_Error) {
	fields := strings.fields(line, context.temp_allocator)
	if len(fields) != 2 do return {}, .Missing_Score
	score := strconv.parse_int(fields[1]) or_return .Bad_Score
	return Student{fields[0], score}, .None
}

INPUT :: `ada 93
bob 78
cy eighty
dee 85
eve 61`

main :: proc() {
	students: [dynamic]Student
	defer delete(students)
	for line in strings.split_lines(INPUT, context.temp_allocator) {
		s := parse_line(line) catch err {
			fmt.printfln("skipping %q: %v", line, err)
			continue
		}
		append(&students, s)
	}
	fmt.println(len(students), "students")
}
```

<span class="caption">Listing 3-1: Reading each line into a `Student`, skipping the lines that can't be read</span>

Run it with `vidar run .`:

```output
skipping "cy eighty": Bad_Score
4 students
```

Most of this is plain Odin: a struct, an enum of errors, and a procedure that returns a `Student` along with a `Parse_Error`. Two lines use Vidar.

The first is in `parse_line`:

```vidar,ignore
score := strconv.parse_int(fields[1]) or_return .Bad_Score
```

`strconv.parse_int` returns the number and a `bool` that says whether it worked. Odin's `or_return` would return that failure as it is, but `parse_line` returns a `Parse_Error`, not a `bool`. Vidar lets you write the error to return after `or_return`: if the parse fails, `parse_line` returns `.Bad_Score`, along with a zero `Student`.

The second is in `main`:

```vidar,ignore
s := parse_line(line) catch err {
	fmt.printfln("skipping %q: %v", line, err)
	continue
}
```

`catch` handles a failure right where the call is. If `parse_line` fails, the block runs with the error in `err`; here it prints a message and moves on to the next line with `continue`. If it succeeds, `s` holds the student. The block has to leave the scope, with `continue`, `break`, `return` or a panic, because otherwise `s` would be used without a value. [Chapter 6](ch06-00-error-handling.md) covers `or_return` with a value, `catch` and their companion `errdefer`.

## Counting with a Closure

Next, let's count how many students passed. We could write a loop, but a procedure that counts anything is more useful: `count_if` takes the students and a test, and counts the students that pass the test.

```vidar,project=gradebook,file=main.vidar
# package main
#
# import "core:fmt"
# import "core:strconv"
# import "core:strings"
#
# Student :: struct {
# 	name:  string,
# 	score: int,
# }
#
# Parse_Error :: enum { None, Missing_Score, Bad_Score }
#
# parse_line :: proc(line: string) -> (s: Student, err: Parse_Error) {
# 	fields := strings.fields(line, context.temp_allocator)
# 	if len(fields) != 2 do return {}, .Missing_Score
# 	score := strconv.parse_int(fields[1]) or_return .Bad_Score
# 	return Student{fields[0], score}, .None
# }
#
# INPUT :: `ada 93
# bob 78
# cy eighty
# dee 85
# eve 61`

// --snip--
count_if :: proc(students: []Student, keep: closure(Student) -> bool) -> (n: int) {
	for s in students do if keep(s) do n += 1
	return
}

main :: proc() {
	// --snip--

# 	students: [dynamic]Student
# 	defer delete(students)
# 	for line in strings.split_lines(INPUT, context.temp_allocator) {
# 		s := parse_line(line) catch err {
# 			fmt.printfln("skipping %q: %v", line, err)
# 			continue
# 		}
# 		append(&students, s)
# 	}

	pass_mark := 70
	passed := count_if(students[:], proc[pass_mark](s: Student) -> bool { return s.score >= pass_mark })
	fmt.println(passed, "of", len(students), "passed")
}
```

<span class="caption">Listing 3-2: Counting the students that pass a test given as a closure</span>

```output
skipping "cy eighty": Bad_Score
3 of 4 passed
```

The test is a *closure*:

```vidar,ignore
proc[pass_mark](s: Student) -> bool { return s.score >= pass_mark }
```

It looks like an ordinary procedure literal, except for `[pass_mark]` after `proc`. That's its *capture list*: the closure takes a copy of the local variable `pass_mark` along with it, so the code in its body can use it when `count_if` calls it. An ordinary Odin procedure can't see the locals of the procedure it's written in; a closure can see what it captures.

`count_if`'s parameter has the type `closure(Student) -> bool`: anything that can be called with a `Student` and returns a `bool`, closure or plain procedure. A closure is a plain value, a struct that holds the procedure and a copy of the captures, so passing one around allocates nothing. [Chapter 4](ch04-00-closures.md) covers closures.

## Two Ways to Grade with an Interface

Now let's give letter grades. Some teachers grade on a curve, adding a bonus to every score, and we want to support both kinds of grading without the report caring which one it gets. That's what an *interface* is for.

```vidar,project=gradebook,file=main.vidar
# package main
#
# import "core:fmt"
# import "core:strconv"
# import "core:strings"
#
# Student :: struct {
# 	name:  string,
# 	score: int,
# }
#
# Parse_Error :: enum { None, Missing_Score, Bad_Score }
#
# parse_line :: proc(line: string) -> (s: Student, err: Parse_Error) {
# 	fields := strings.fields(line, context.temp_allocator)
# 	if len(fields) != 2 do return {}, .Missing_Score
# 	score := strconv.parse_int(fields[1]) or_return .Bad_Score
# 	return Student{fields[0], score}, .None
# }
#
# INPUT :: `ada 93
# bob 78
# cy eighty
# dee 85
# eve 61`

#

# count_if :: proc(students: []Student, keep: closure(Student) -> bool) -> (n: int) {
# 	for s in students do if keep(s) do n += 1
# 	return
# }

// --snip--
Grader :: interface { letter }

letter :: proc(g: Grader, score: int) -> string ---

Strict :: struct {}
Curved :: struct { bonus: int }

strict_letter :: proc(_: ^Strict, score: int) -> string {
	return "A" if score >= 90 else "B" if score >= 80 else "C" if score >= 70 else "F"
}

curved_letter :: proc(c: ^Curved, score: int) -> string {
	return strict_letter(nil, score + c.bonus)
}

impl Grader for Strict { letter = strict_letter }
impl Grader for Curved { letter = curved_letter }

report :: proc(title: string, students: []Student, grader: Grader) {
	fmt.printf("%s:", title)
	for s in students do fmt.print("", s.name, letter(grader, s.score))
	fmt.println()
}

main :: proc() {
	// --snip--

# 	students: [dynamic]Student
# 	defer delete(students)
# 	for line in strings.split_lines(INPUT, context.temp_allocator) {
# 		s := parse_line(line) catch err {
# 			fmt.printfln("skipping %q: %v", line, err)
# 			continue
# 		}
# 		append(&students, s)
# 	}

# 	pass_mark := 70
# 	passed := count_if(students[:], proc[pass_mark](s: Student) -> bool { return s.score >= pass_mark })
# 	fmt.println(passed, "of", len(students), "passed")


	strict: Strict
	curved := Curved{bonus = 10}
	report("strict", students[:], &strict)
	report("curved", students[:], &curved)
}
```

<span class="caption">Listing 3-3: A `Grader` interface with two implementations</span>

```output
skipping "cy eighty": Bad_Score
3 of 4 passed
strict: ada A bob C dee B eve F
curved: ada A bob B dee A eve C
```

An interface has three parts:

1. `Grader :: interface { letter }` declares the interface and the names of its methods.
2. `letter :: proc(g: Grader, score: int) -> string ---` declares the method: a procedure with no body (`---`), whose first parameter is the interface.
3. `impl Grader for Strict { letter = strict_letter }` says that `Strict` implements `Grader`, and that its `letter` is `strict_letter`, an ordinary procedure that takes a `^Strict` first.

`report` takes any `Grader`. When `main` passes `&strict` or `&curved`, Vidar turns the pointer into a `Grader` value, and `letter(grader, s.score)` calls whichever procedure that value's type bound. Calling `letter(&strict, 90)` directly, with a pointer to the concrete type, would skip the interface and call `strict_letter`. [Chapter 5](ch05-00-interfaces.md) covers interfaces.

## Cleaning Up with a Destructor

So far `main` frees the students with `defer delete(students)`. That's fine for one array in one place, but it's easy to forget once the data lives in a struct and gets passed around. Vidar can call the cleanup for us. Let's put the students in a `Grades` struct and give it a *destructor*.

```vidar,project=gradebook,file=main.vidar
# package main
#
# import "core:fmt"
# import "core:strconv"
# import "core:strings"
#
# Student :: struct {
# 	name:  string,
# 	score: int,
# }
#
# Parse_Error :: enum { None, Missing_Score, Bad_Score }
#
# parse_line :: proc(line: string) -> (s: Student, err: Parse_Error) {
# 	fields := strings.fields(line, context.temp_allocator)
# 	if len(fields) != 2 do return {}, .Missing_Score
# 	score := strconv.parse_int(fields[1]) or_return .Bad_Score
# 	return Student{fields[0], score}, .None
# }
#
# INPUT :: `ada 93
# bob 78
# cy eighty
# dee 85
# eve 61`

#

# count_if :: proc(students: []Student, keep: closure(Student) -> bool) -> (n: int) {
# 	for s in students do if keep(s) do n += 1
# 	return
# }

#

# Grader :: interface { letter }
#
# letter :: proc(g: Grader, score: int) -> string ---
#
# Strict :: struct {}
# Curved :: struct { bonus: int }
#
# strict_letter :: proc(_: ^Strict, score: int) -> string {
# 	return "A" if score >= 90 else "B" if score >= 80 else "C" if score >= 70 else "F"
# }
#
# curved_letter :: proc(c: ^Curved, score: int) -> string {
# 	return strict_letter(nil, score + c.bonus)
# }
#
# impl Grader for Strict { letter = strict_letter }
# impl Grader for Curved { letter = curved_letter }
#
# report :: proc(title: string, students: []Student, grader: Grader) {
# 	fmt.printf("%s:", title)
# 	for s in students do fmt.print("", s.name, letter(grader, s.score))
# 	fmt.println()
# }

// --snip--
Grades :: struct {
	students: [dynamic]Student,
}

grades_destroy :: proc(g: ^Grades) {
	fmt.println("(freeing", len(g.students), "students)")
	delete(g.students)
}

impl Destroy for Grades { destroy = grades_destroy }

main :: proc() {
	g: Grades
	for line in strings.split_lines(INPUT, context.temp_allocator) {
		s := parse_line(line) catch err {
			fmt.printfln("skipping %q: %v", line, err)
			continue
		}
		append(&g.students, s)
	}
	// --snip--

# 	pass_mark := 70
# 	passed := count_if(g.students[:], proc[pass_mark](s: Student) -> bool { return s.score >= pass_mark })
# 	fmt.println(passed, "of", len(g.students), "passed")
#

# 	strict: Strict
# 	curved := Curved{bonus = 10}
# 	report("strict", g.students[:], &strict)
# 	report("curved", g.students[:], &curved)

}
```

<span class="caption">Listing 3-4: `Grades` frees its students when it goes out of scope</span>

```output
skipping "cy eighty": Bad_Score
3 of 4 passed
strict: ada A bob C dee B eve F
curved: ada A bob B dee A eve C
(freeing 4 students)
```

`impl Destroy for Grades { destroy = grades_destroy }` tells Vidar to call `grades_destroy` on every local `Grades` when its scope ends, on every path out of the scope, as if each one came with its own `defer`. The `defer delete(students)` is gone, and the message at the end of the output shows that the destructor ran.

Destructors bring rules with them. A `Grades` can't be copied any more, because then two variables would both free the same array: `h := g` is a compile error, which suggests borrowing with `&g` or moving with `move!(g)` instead. [Chapter 7](ch07-00-destructors.md) covers destructors and these ownership rules.

## A Summary with an Anonymous Struct

Finally, let's print the best student and the average score. We don't need a named type for a value we print once, so we'll let Vidar make one.

```vidar,project=gradebook,file=main.vidar
# package main
#
# import "core:fmt"
# import "core:strconv"
# import "core:strings"
#
# Student :: struct {
# 	name:  string,
# 	score: int,
# }
#
# Parse_Error :: enum { None, Missing_Score, Bad_Score }
#
# parse_line :: proc(line: string) -> (s: Student, err: Parse_Error) {
# 	fields := strings.fields(line, context.temp_allocator)
# 	if len(fields) != 2 do return {}, .Missing_Score
# 	score := strconv.parse_int(fields[1]) or_return .Bad_Score
# 	return Student{fields[0], score}, .None
# }
#
# INPUT :: `ada 93
# bob 78
# cy eighty
# dee 85
# eve 61`

#

# count_if :: proc(students: []Student, keep: closure(Student) -> bool) -> (n: int) {
# 	for s in students do if keep(s) do n += 1
# 	return
# }

#

# Grader :: interface { letter }
#
# letter :: proc(g: Grader, score: int) -> string ---
#
# Strict :: struct {}
# Curved :: struct { bonus: int }
#
# strict_letter :: proc(_: ^Strict, score: int) -> string {
# 	return "A" if score >= 90 else "B" if score >= 80 else "C" if score >= 70 else "F"
# }
#
# curved_letter :: proc(c: ^Curved, score: int) -> string {
# 	return strict_letter(nil, score + c.bonus)
# }
#
# impl Grader for Strict { letter = strict_letter }
# impl Grader for Curved { letter = curved_letter }
#
# report :: proc(title: string, students: []Student, grader: Grader) {
# 	fmt.printf("%s:", title)
# 	for s in students do fmt.print("", s.name, letter(grader, s.score))
# 	fmt.println()
# }

#
# Grades :: struct {
# 	students: [dynamic]Student,
# }
#
# grades_destroy :: proc(g: ^Grades) {
# 	fmt.println("(freeing", len(g.students), "students)")
# 	delete(g.students)
# }
#
# impl Destroy for Grades { destroy = grades_destroy }
#
main :: proc() {
	// --snip--
# 	g: Grades
# 	for line in strings.split_lines(INPUT, context.temp_allocator) {
# 		s := parse_line(line) catch err {
# 			fmt.printfln("skipping %q: %v", line, err)
# 			continue
# 		}
# 		append(&g.students, s)
# 	}

# 	pass_mark := 70
# 	passed := count_if(g.students[:], proc[pass_mark](s: Student) -> bool { return s.score >= pass_mark })
# 	fmt.println(passed, "of", len(g.students), "passed")
#

# 	strict: Strict
# 	curved := Curved{bonus = 10}
# 	report("strict", g.students[:], &strict)
# 	report("curved", g.students[:], &curved)


	best := g.students[0]
	total := 0
	for s in g.students {
		total += s.score
		if s.score > best.score do best = s
	}
	summary := { best = best.name, average = f64(total) / f64(len(g.students)) }
	fmt.println(summary)
}
```

<span class="caption">Listing 3-5: A summary as an anonymous struct literal</span>

```output
skipping "cy eighty": Bad_Score
3 of 4 passed
strict: ada A bob C dee B eve F
curved: ada A bob B dee A eve C
{best = "ada", average = 79.25}
(freeing 4 students)
```

`{ best = best.name, average = ... }` with nothing before the brace is an *anonymous struct literal*. Odin would need a type there; Vidar makes one from the fields, `struct { best: string, average: f64 }`, with each field's type taken from its value. [Chapter 8](ch08-00-anonymous-structs.md) covers them.

## Summary

This project was a hands-on way to meet five of Vidar's features:

- `or_return` with a value and `catch`, for errors;
- a closure that captures a local, passed as a `closure(...)` value;
- an interface with two implementations, and a call through it;
- a destructor that frees a struct's memory when it goes out of scope;
- an anonymous struct literal.

Everything else in the program was plain Odin, and stays that way in the code Vidar generates. Run `vidar emit .` to see that code: every line you didn't write with a Vidar feature is exactly as you wrote it.

The next chapters go through each feature in turn, starting with closures.
