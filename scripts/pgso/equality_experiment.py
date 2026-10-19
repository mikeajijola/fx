"""Isolated call-site sharing comparison; never release evidence."""
import argparse
import ctypes as C
import json
import pathlib
import re
import sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
from scripts.pgso.ir_size import Llvm, P, FUNCTION_INDEX, PassError

SCOPES = (
    "json.", "core.agent.", "core.workspace.", "core.session.",
    "core.config.", "core.cli.", "core.tooling.", "core.permissions.",
    "core.shell_command.", "core.mcp.", "core.mcp_host.", "gateway.", "tools.",
)


def functions(llvm, module):
    fn = llvm.FirstFunction(module)
    while fn:
        yield fn
        fn = llvm.NextFunction(fn)


def calls(llvm, fn):
    block = llvm.FirstBlock(fn)
    while block:
        inst = llvm.FirstInstruction(block)
        while inst:
            if llvm.IsACallInst(inst):
                yield inst
            inst = llvm.NextInstruction(inst)
        block = llvm.NextBlock(block)


def outline(llvm, source, output):
    f = llvm._fn
    llvm.FirstBlock = f("LLVMGetFirstBasicBlock", P, P)
    llvm.NextBlock = f("LLVMGetNextBasicBlock", P, P)
    llvm.FirstInstruction = f("LLVMGetFirstInstruction", P, P)
    llvm.NextInstruction = f("LLVMGetNextInstruction", P, P)
    add = f("LLVMAddCallSiteAttribute", None, P, C.c_uint, P)
    context, module = llvm.load(source)
    # Discover the actual byte-comparison instantiation used for JSON keys.
    # Numeric Zig instantiation suffixes are not assumed to remain stable.
    targets = set()
    for fn in functions(llvm, module):
        if not llvm.name(fn).startswith("json.static."):
            continue
        for call in calls(llvm, fn):
            callee = llvm.CalledValue(call)
            if re.fullmatch(r"mem\.eql__func_\d+", llvm.name(callee)):
                targets.add(callee)
    if len(targets) != 1:
        raise PassError("expected one JSON byte-comparison instantiation")
    always = llvm.kind("alwaysinline")
    for target in targets:
        if llvm.GetEnumAttrAt(target, FUNCTION_INDEX, always):
            raise PassError("byte comparison is alwaysinline")
    attribute = llvm.CreateEnumAttr(context, llvm.kind("noinline"), 0)
    counts = {}
    for fn in functions(llvm, module):
        name = llvm.name(fn)
        if not name.startswith(SCOPES):
            continue
        for call in calls(llvm, fn):
            if llvm.CalledValue(call) not in targets:
                continue
            if llvm.CallSiteEnumAttr(call, FUNCTION_INDEX, always):
                raise PassError("comparison call site is alwaysinline")
            add(call, FUNCTION_INDEX, attribute)
            scope = ".".join(name.split(".")[:2])
            counts[scope] = counts.get(scope, 0) + 1
    if not counts:
        raise PassError("no scoped comparison calls matched")
    llvm.save(module, output)
    return dict(pass_name="outline-control-equality", call_sites=sum(counts.values()),
                targets=sorted(llvm.name(t) for t in targets), scopes=counts)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--libllvm", required=True, type=pathlib.Path)
    parser.add_argument("source", type=pathlib.Path)
    parser.add_argument("output", type=pathlib.Path)
    args = parser.parse_args()
    print(json.dumps(outline(Llvm(args.libllvm), args.source, args.output)))


if __name__ == "__main__":
    main()
