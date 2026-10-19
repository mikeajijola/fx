from __future__ import annotations

import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

from scripts.pgso.pipeline import ARGUMENT_CLEANUP_FLAGS, ARGUMENT_CLEANUP_ROUNDS, _require_bitcode_header
from scripts.pgso.toolchain import IR_SIZE_SCRIPT

LLVM_BIN = pathlib.Path(os.environ.get("FX_PGSO_LLVM_BIN", "/opt/homebrew/opt/llvm@22/bin"))
LIBLLVM = (LLVM_BIN.parent / "lib" / "libLLVM.dylib").resolve()
AVAILABLE = (LLVM_BIN / "llvm-as").is_file() and LIBLLVM.is_file()

# The production module layout; alignment decisions depend on it.
TARGET = (
    'target datalayout = "e-m:o-p270:32:32-p271:32:32-p272:64:64-i64:64-i128:128-n32:64-S128-Fn32"\n'
    'target triple = "aarch64-apple-macosx15.0.0-unknown"\n'
)
MEMCPY = "declare void @llvm.memcpy.p0.p0.i64(ptr, ptr, i64, i1)\n"
ERROR_UNION = (
    "%Payload = type { [64 x i8] }\n"
    "@error_return = internal unnamed_addr constant { %Payload, i16, [6 x i8] } "
    "{ %Payload undef, i16 653, [6 x i8] undef }, align 8\n"
)


@unittest.skipUnless(AVAILABLE, "pinned LLVM 21 with libLLVM is not installed")
class IrSizeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory(prefix="fx-pgso-ir-size-")
        self.root = pathlib.Path(self.temporary_directory.name)

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def assemble(self, name: str, ir: str) -> pathlib.Path:
        source = self.root / f"{name}.ll"
        source.write_text(TARGET + ir)
        output = self.root / f"{name}.bc"
        subprocess.run([str(LLVM_BIN / "llvm-as"), str(source), "-o", str(output)], check=True)
        return output

    def run_pass(self, command: str, source: pathlib.Path) -> tuple[subprocess.CompletedProcess, pathlib.Path]:
        output = self.root / f"{source.stem}.{command}.bc"
        result = subprocess.run(
            [sys.executable, str(IR_SIZE_SCRIPT), "--libllvm", str(LIBLLVM), command, str(source), str(output)],
            capture_output=True,
            text=True,
        )
        return result, output

    def cleaned_ir(self, bitcode: pathlib.Path) -> str:
        cleaned = self.root / f"{bitcode.stem}.clean.bc"
        subprocess.run(
            [str(LLVM_BIN / "opt"), "-passes=globaldce,verify", str(bitcode), "-o", str(cleaned)],
            check=True,
        )
        return subprocess.run(
            [str(LLVM_BIN / "llvm-dis"), str(cleaned), "-o", "-"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout

    def test_error_union_return_copy_becomes_one_code_store(self) -> None:
        source = self.assemble(
            "error_union",
            ERROR_UNION + MEMCPY + "define void @fail(ptr align 8 %out) {\n"
            "  call void @llvm.memcpy.p0.p0.i64(ptr align 8 %out, ptr align 8 @error_return, i64 72, i1 false)\n"
            "  ret void\n}\n",
        )
        result, output = self.run_pass("sparse-constants", source)

        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual("", result.stderr)
        self.assertIn('"rewritten_copies": 1', result.stdout)
        ir = self.cleaned_ir(output)
        self.assertNotIn("llvm.memcpy.p0.p0.i64(ptr", ir.split("declare")[0])
        self.assertNotIn("@error_return", ir)
        self.assertIn("getelementptr inbounds i8, ptr %out, i64 64", ir)
        self.assertIn("store i16 653, ptr", ir)
        self.assertTrue(ir.split("store i16 653")[1].splitlines()[0].endswith("align 2"))

    def test_defined_zero_bytes_are_still_stored(self) -> None:
        source = self.assemble(
            "zeros",
            "@state = internal unnamed_addr constant { i64, [56 x i8] } { i64 0, [56 x i8] undef }\n"
            + MEMCPY
            + "define void @init(ptr align 8 %out) {\n"
            "  call void @llvm.memcpy.p0.p0.i64(ptr align 8 %out, ptr align 8 @state, i64 64, i1 false)\n"
            "  ret void\n}\n",
        )
        result, output = self.run_pass("sparse-constants", source)

        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn("store i64 0, ptr %out, align 8", self.cleaned_ir(output))

    def test_constants_with_other_uses_or_unsafe_copies_are_untouched(self) -> None:
        cases = {
            "loaded": "  %v = load i16, ptr getelementptr inbounds (i8, ptr @error_return, i64 64)\n"
            "  call void @llvm.memcpy.p0.p0.i64(ptr align 8 %out, ptr align 8 @error_return, i64 72, i1 false)\n",
            "volatile": "  call void @llvm.memcpy.p0.p0.i64(ptr align 8 %out, ptr align 8 @error_return, i64 72, i1 true)\n",
            "split_leaf": "  call void @llvm.memcpy.p0.p0.i64(ptr align 8 %out, ptr align 8 @error_return, i64 65, i1 false)\n",
            "variable": "  call void @llvm.memcpy.p0.p0.i64(ptr align 8 %out, ptr align 8 @error_return, i64 %n, i1 false)\n",
        }
        for name, body in cases.items():
            with self.subTest(case=name):
                source = self.assemble(
                    name,
                    ERROR_UNION + MEMCPY + f"define void @f(ptr align 8 %out, i64 %n) {{\n{body}  ret void\n}}\n",
                )
                result, output = self.run_pass("sparse-constants", source)
                self.assertEqual(0, result.returncode, result.stderr)
                self.assertIn('"rewritten_copies": 0', result.stdout)
                self.assertIn("@error_return", self.cleaned_ir(output))

    def test_shared_std_helpers_become_noinline(self) -> None:
        names = (
            "mem.Allocator.free__func_12",
            "mem.Allocator.free",
            "mem.Allocator.remap__func_7",
            "Io.Writer.writeAll",
            '"array_list.Aligned(u8,null).deinit"',
            "mem.Allocator.dupe",
            '"array_list.Aligned(u16,null).deinit"',
        )
        body = "".join(f"define internal void @{name}(ptr %p) {{\n  ret void\n}}\n" for name in names)
        calls = "".join(f"  call void @{name}(ptr %p)\n" for name in names)
        source = self.assemble("helpers", body + f"define void @use(ptr %p) {{\n{calls}  ret void\n}}\n")
        result, output = self.run_pass("outline-helpers", source)

        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn('"marked_functions": 5', result.stdout)
        # The pipeline validates this output before it records the identity.
        _require_bitcode_header(output)
        ir = subprocess.run(
            [str(LLVM_BIN / "llvm-dis"), str(output), "-o", "-"], check=True, capture_output=True, text=True
        ).stdout
        attributes = {
            line.split("=", 1)[0].strip(): line for line in ir.splitlines() if line.startswith("attributes #")
        }
        for name, expected in (
            ("mem.Allocator.free__func_12", True),
            ("mem.Allocator.free", True),
            ("mem.Allocator.remap__func_7", True),
            ("Io.Writer.writeAll", True),
            ('"array_list.Aligned(u8,null).deinit"', True),
            ("mem.Allocator.dupe", False),
            ('"array_list.Aligned(u16,null).deinit"', False),
        ):
            definition = next(line for line in ir.splitlines() if line.startswith("define") and f"@{name}(" in line)
            group = definition.rsplit("#", 1)[1].split()[0] if "#" in definition else None
            marked = group is not None and "noinline" in attributes.get(f"attributes #{group}", "")
            self.assertEqual(expected, marked, definition)

    def test_helper_pass_rejects_conflicting_alwaysinline_attributes(self) -> None:
        source = self.assemble(
            "inline_conflict",
            "define internal void @mem.Allocator.free__func_1(ptr %p) {\n  ret void\n}\n"
            "define internal void @mem.Allocator.remap__func_3(ptr %p) alwaysinline {\n  ret void\n}\n"
            "define void @use(ptr %p) {\n"
            "  call void @mem.Allocator.free__func_1(ptr %p)\n"
            "  call void @mem.Allocator.remap__func_3(ptr %p)\n  ret void\n}\n",
        )
        result, output = self.run_pass("outline-helpers", source)
        self.assertEqual(1, result.returncode)
        self.assertIn("helper is alwaysinline: mem.Allocator.remap__func_3", result.stderr)
        self.assertFalse(output.exists())

    def test_helper_pass_fails_closed_without_the_allocator_free_helper(self) -> None:
        source = self.assemble(
            "no_free",
            "define internal void @Io.Writer.writeAll(ptr %p) {\n  ret void\n}\n"
            "define void @main(ptr %p) {\n  call void @Io.Writer.writeAll(ptr %p)\n  ret void\n}\n",
        )
        result, output = self.run_pass("outline-helpers", source)

        self.assertEqual(1, result.returncode)
        self.assertIn("no out-of-line helper matched", result.stderr)
        self.assertFalse(output.exists())


    def test_argument_cleanup_preserves_checked_math_nullable_reads_and_writes(self) -> None:
        source = self.assemble("argument_cleanup", """
            declare { i32, i1 } @llvm.sadd.with.overflow.i32(i32, i32)
            define internal i32 @checked_pair(ptr %pair) noinline {
              %first = load i32, ptr %pair
              %secondp = getelementptr i32, ptr %pair, i64 1
              %second = load i32, ptr %secondp
              %checked = call { i32, i1 } @llvm.sadd.with.overflow.i32(i32 %first, i32 %second)
              %result = extractvalue { i32, i1 } %checked, 0
              %overflow = extractvalue { i32, i1 } %checked, 1
              %value = select i1 %overflow, i32 -1, i32 %result
              ret i32 %value
            }
            define i32 @main(i32 %argc, ptr %argv) {
              %pair = alloca [2 x i32], align 4
              store i32 %argc, ptr %pair
              %secondp = getelementptr i32, ptr %pair, i64 1
              store i32 2, ptr %secondp
              %result = call i32 @checked_pair(ptr %pair)
              ret i32 %result
            }
            define internal i32 @conditional_read(ptr %p, i1 %enabled) noinline {
            entry:
              br i1 %enabled, label %read, label %done
            read:
              %value = load i32, ptr %p
              br label %done
            done:
              %result = phi i32 [ %value, %read ], [ 0, %entry ]
              ret i32 %result
            }
            define i32 @use_nullable(ptr %p, i1 %enabled) {
              %value = call i32 @conditional_read(ptr %p, i1 %enabled)
              ret i32 %value
            }
            define internal void @write_output(ptr %p, i32 %value) noinline {
              store i32 %value, ptr %p
              ret void
            }
            define void @write_public(ptr %p, i32 %value) {
              call void @write_output(ptr %p, i32 %value)
              ret void
            }
            """)
        current = source
        for index in range(ARGUMENT_CLEANUP_ROUNDS):
            output = self.root / f"argument-cleanup-{index}.bc"
            result = subprocess.run(
                [str(LLVM_BIN / "opt"), *ARGUMENT_CLEANUP_FLAGS, str(current), "-o", str(output)],
                capture_output=True, text=True,
            )
            self.assertEqual(0, result.returncode, result.stderr)
            self.assertEqual("", result.stderr)
            current = output
        ir = subprocess.run(
            [str(LLVM_BIN / "llvm-dis"), str(current), "-o", "-"],
            check=True, capture_output=True, text=True,
        ).stdout
        self.assertIn("@checked_pair(i32 ", ir)
        self.assertNotIn("@checked_pair(ptr ", ir)
        self.assertNotIn("alloca", ir)
        self.assertIn("call { i32, i1 } @llvm.sadd.with.overflow.i32", ir)
        self.assertIn("select i1 %overflow, i32 -1, i32 %result", ir)
        self.assertIn("@conditional_read(ptr ", ir)
        self.assertIn("br i1 %enabled", ir)
        self.assertIn("@write_output(ptr ", ir)
        self.assertIn("store i32 %value, ptr %p", ir)
        def exports(path: pathlib.Path) -> list[str]:
            result = subprocess.run(
                [str(LLVM_BIN / "llvm-nm"), "--extern-only", "--defined-only", "--format=posix", str(path)],
                check=True, capture_output=True, text=True,
            )
            return sorted(" ".join(line.split()[:2]) for line in result.stdout.splitlines() if line.strip())
        self.assertEqual(exports(source), exports(current))


if __name__ == "__main__":
    unittest.main()
