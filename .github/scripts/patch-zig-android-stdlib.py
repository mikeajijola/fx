#!/usr/bin/env python3
import pathlib
import sys


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: patch-zig-android-stdlib.py ZIG_LIB_DIR")

    path = pathlib.Path(sys.argv[1]) / "std/Io/Threaded.zig"
    source = path.read_text()
    old = "    if (native_os == .linux or is_windows) {"
    new = "    if ((native_os == .linux and builtin.abi != .android) or is_windows) {"

    if new in source:
        return
    if source.count(old) != 1:
        raise SystemExit(f"unexpected Zig stdlib DNS implementation in {path}")
    path.write_text(source.replace(old, new))


if __name__ == "__main__":
    main()
