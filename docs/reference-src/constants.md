## ODIN_ARCH

```vidar
when ODIN_ARCH == .amd64 || ODIN_ARCH == .arm64 {
	fmt.println("64-bit target")
}
```

```output
64-bit target
```

## ODIN_ARCH_STRING

```vidar
fmt.println(len(ODIN_ARCH_STRING) > 0)
```

```output
true
```

`ODIN_ARCH_STRING` is `"amd64"`, `"arm64"` and so on.

## ODIN_BUILD_MODE

```vidar
fmt.println(ODIN_BUILD_MODE)
```

```output
Executable
```

## ODIN_DEBUG

```vidar
when ODIN_DEBUG {
	fmt.println("debug build")
} else {
	fmt.println("release build")
}
```

```output
release build
```

## ODIN_DISABLE_ASSERT

```vidar
fmt.println("asserts on:", !ODIN_DISABLE_ASSERT)
```

```output
asserts on: true
```

## ODIN_ENDIAN

```vidar
fmt.println(ODIN_ENDIAN)
```

```output
Little
```

## ODIN_OPTIMIZATION_MODE

```vidar
fmt.println(ODIN_OPTIMIZATION_MODE)
```

```output
Minimal
```

`vidar run` builds at Odin's default level; `-- -o:speed` changes it.

## ODIN_OS

```vidar
when ODIN_OS == .Windows {
	SEPARATOR :: '\\'
} else {
	SEPARATOR :: '/'
}

main :: proc() {
	fmt.println(SEPARATOR)
}
```

```output
/
```

## ODIN_OS_STRING

```vidar
fmt.println(ODIN_OS_STRING == "linux" || ODIN_OS_STRING == "darwin")
```

```output
true
```

## ODIN_ROOT

```vidar
fmt.println(len(ODIN_ROOT) > 0)
```

```output
true
```

## ODIN_VERSION

```vidar
fmt.println(len(ODIN_VERSION) > 0)
```

```output
true
```
