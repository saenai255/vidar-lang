## VIDAR_CLOSURE_ENV

```bash
vidar run . -define:VIDAR_CLOSURE_ENV=256    # closures that capture up to 256 bytes
```

Every closure value grows with it, so arrays and channels of closures do too. See [How Big a Closure Is](ch04-03-closure-types.md#how-big-a-closure-is).

## VIDAR_FILES_ON_WORKERS

```bash
vidar run . -define:VIDAR_FILES_ON_WORKERS=true   # on Linux: files through workers, not io_uring
```

## VIDAR_RACE

```bash
vidar run . -define:VIDAR_RACE=true -define:VIDAR_THREADS=4
```

Give it to `vidar` itself (`run`, `build`, `check`), not only to `odin`: Vidar marks the writes to watch when it sees the define. See [Race Check](ch14-06-debugging.md#race-check).

## VIDAR_RACE_TABLE

```bash
vidar run . -define:VIDAR_RACE=true -define:VIDAR_RACE_TABLE=262144
```

## VIDAR_SCHED_DEBUG

```bash
vidar build . -bin -define:VIDAR_SCHED_DEBUG=true -- -o:speed   # keep the goroutine dump in a fast build
```

## VIDAR_SCHED_TRACE

```bash
VIDAR_TRACE_FILE=/tmp/trace.json vidar run . -define:VIDAR_SCHED_TRACE=true
```

Open the file in [Perfetto](https://ui.perfetto.dev). See [The Scheduler Trace](ch14-06-debugging.md#the-scheduler-trace).

## VIDAR_STACK_SIZE

```bash
vidar run . -define:VIDAR_STACK_SIZE=1048576    # 1 MB per goroutine
```

## VIDAR_THREADS

```bash
vidar run . -define:VIDAR_THREADS=4
```

See [Running on Several Threads](ch14-05-threads.md).

## VIDAR_TRACE_EVENTS

```bash
vidar run . -define:VIDAR_SCHED_TRACE=true -define:VIDAR_TRACE_EVENTS=1048576
```

## VIDAR_WORKERS

```bash
vidar run . -define:VIDAR_WORKERS=16     # more threads for sched.blocking and DNS
```
