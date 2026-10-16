# An I/O Project: A Log Summarizer

This chapter is a recap of much of what you've learned so far, in one program. We'll build `logsum`, a command-line tool that reads a log file and prints a summary of it: how many entries there are at each level, and how many each service wrote. Along the way, it skips lines it can't read and says why.

```console
$ vidar run . -- sample.log
7 entries, 2 skipped
Debug  0
Info   3
Warn   1
Error  2
api      2
auth     1
db       2
worker   1
line 5: Too_Short
line 9: Unknown_Level
```

We'll use:

- `catch` and `or_return` with a value, to handle a missing file and malformed lines ([Chapter 6](ch06-00-error-handling.md));
- an interface for reports, so that adding a new kind of report doesn't change the code that feeds them ([Chapter 5](ch05-00-interfaces.md));
- a closure that decides which entries count ([Chapter 4](ch04-00-closures.md));
- destructors, so that the file's contents and everything parsed from them are freed in one place ([Chapter 7](ch07-00-destructors.md));
- tests ([Chapter 12](ch12-00-testing.md)).

We'll build it in stages, and every stage is a complete program you can run.
