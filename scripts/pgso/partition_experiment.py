"""Temporary name routing for isolated size comparisons, never release proof."""
import argparse
import ctypes as C
import hashlib
import json
import pathlib
import re
import subprocess
import sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
from collections import defaultdict
from scripts.pgso.ir_size import Llvm, P, INTERNAL_LINKAGE, PRIVATE_LINKAGE


def family(name, mode):
    # Parameter lists can contain arbitrary dotted type names. Keep only the
    # declaration path when identifying its owning namespace.
    clean = []
    depth = 0
    for c in name:
        if c == '(':
            depth += 1
        elif c == ')':
            depth -= 1
        elif depth == 0:
            clean.append(c)
    name = re.sub(r'__func_\d+|\.\d+$', '', ''.join(clean))
    if mode == 'generic':
        return name
    return name.rsplit('.', 1)[0] if '.' in name else name


def api(library):
    llvm = Llvm(pathlib.Path(library))
    llvm.SetName = llvm._fn('LLVMSetValueName2', None, P, C.c_char_p, C.c_size_t)
    llvm.GetComdat = llvm._fn('LLVMGetComdat', P, P)
    llvm.FirstBB = llvm._fn('LLVMGetFirstBasicBlock', P, P)
    llvm.NextBB = llvm._fn('LLVMGetNextBasicBlock', P, P)
    llvm.FirstInst = llvm._fn('LLVMGetFirstInstruction', P, P)
    llvm.NextInst = llvm._fn('LLVMGetNextInstruction', P, P)
    return llvm


def functions(llvm, mod):
    fn = llvm.FirstFunction(mod)
    while fn:
        yield fn
        fn = llvm.NextFunction(fn)


def partition(name):
    return int.from_bytes(hashlib.md5(name.encode()).digest()[:2], 'little') % 2


def route(llvm, source, output, mapping, mode):
    _, mod = llvm.load(source)
    groups = defaultdict(list)
    used = {llvm.name(fn) for fn in functions(llvm, mod)}
    loads = [0, 0]
    for fn in functions(llvm, mod):
        if llvm.IsDeclaration(fn):
            continue
        name = llvm.name(fn)
        size = 0
        bb = llvm.FirstBB(fn)
        while bb:
            inst = llvm.FirstInst(bb)
            while inst:
                size += 1
                inst = llvm.NextInst(inst)
            bb = llvm.NextBB(bb)
        if llvm.GetLinkage(fn) not in (INTERNAL_LINKAGE, PRIVATE_LINKAGE) or llvm.GetComdat(fn):
            loads[partition(name)] += size
            continue
        assert name, 'Unnamed internal function'
        groups[family(name, mode)].append((fn, name, size))
    names = {}
    largest = []
    for key, members in sorted(groups.items(), key=lambda item: (-sum(x[2] for x in item[1]), item[0])):
        side = min(range(2), key=lambda i: (loads[i], i))
        weight = sum(x[2] for x in members)
        largest.append((key, weight, side))
        for fn, old, size in members:
            n = 0
            while True:
                new = f'__omos_partition_{side}_{len(names)}_{n}'
                if new not in used and partition(new) == side:
                    break
                n += 1
            raw = new.encode()
            llvm.SetName(fn, raw, len(raw))
            assert llvm.name(fn) == new
            names[new] = old
            used.add(new)
        loads[side] += weight
    llvm.save(mod, output)
    mapping.write_text(json.dumps(dict(names=names, loads=loads, largest=largest[:30]), indent=2))


def restore(llvm, source, output, mapping):
    _, mod = llvm.load(source)
    names = json.loads(mapping.read_text())['names']
    seen = set()
    existing = {llvm.name(fn) for fn in functions(llvm, mod)}
    for fn in functions(llvm, mod):
        name = llvm.name(fn)
        if name in names:
            old = names[name]
            assert old not in existing, f'Name collision: {old}'
            raw = old.encode()
            llvm.SetName(fn, raw, len(raw))
            assert llvm.name(fn) == old
            seen.add(name)
    assert seen == names.keys(), f'Missing routed functions: {names.keys() - seen}'
    llvm.save(mod, output)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('operation', choices=['split', 'cleanup'])
    parser.add_argument('library')
    parser.add_argument('tool')
    parser.add_argument('source', type=pathlib.Path)
    parser.add_argument('output', type=pathlib.Path)
    parser.add_argument('mapping', type=pathlib.Path)
    parser.add_argument('mode', choices=['generic', 'namespace'])
    args = parser.parse_args()
    llvm = api(args.library)
    temporary = args.source.with_suffix('.routed.bc' if args.operation == 'split' else '.restored.bc')
    if args.operation == 'split':
        route(llvm, args.source, temporary, args.mapping, args.mode)
        command = [args.tool, '-j', '2', '-o', str(args.output), str(temporary)]
    else:
        restore(llvm, args.source, temporary, args.mapping)
        from scripts.pgso.pipeline import OUTLINE_CLEANUP_FLAGS
        command = [args.tool, *OUTLINE_CLEANUP_FLAGS, str(temporary), '-o', str(args.output)]
    subprocess.run(command, check=True)


if __name__ == '__main__':
    main()
