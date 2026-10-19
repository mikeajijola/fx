"""Size comparisons against retained inputs; never release evidence."""
import argparse
import json
import os
import pathlib
import shutil
import sys

from scripts.pgso import pipeline as p
from scripts.pgso.model import sha256_file
from scripts.pgso.runner import run_checked
from scripts.pgso.toolchain import Toolchain


def main():
    parser = argparse.ArgumentParser()
    for name in ["seed", "retained", "output"]:
        parser.add_argument("--" + name, type=pathlib.Path, required=True)
    parser.add_argument("--llvm-bin", required=True)
    parser.add_argument("--mode", choices=["rounds", "helpers", "backend", "os", "oz", "baseline", "generic", "namespace", "cleanup", "promote"], required=True)
    parser.add_argument("--prepared", type=pathlib.Path)
    args = parser.parse_args()
    seed = json.loads((args.seed / "manifest.json").read_text())
    identity = seed["evidence"]["identity"]
    assert identity["source_sha"] == "b6d78488dd1939475f91b3d31e4b8c9b61d98f21"
    bitcode = args.seed / "ir/pgso/fx.bc"
    profile = args.retained / "profiles/merged.profdata"
    assert sha256_file(bitcode) == identity["bitcode_sha256"]
    assert sha256_file(profile) == "aa9986e895cb9c8c988586067b6ce3c2b746d9a7e002551f76d044418dd650e3"
    toolchain = Toolchain.discover("zig", args.llvm_bin, identity["target"])
    assert toolchain.llvm_version == identity["llvm_version"]
    paths = p.PipelinePaths.create(args.output)
    for path in [paths.bitcode, paths.control_binary, paths.merged_profile]:
        path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(bitcode, paths.bitcode)
    shutil.copy2(args.seed / "control/bin/fx", paths.control_binary)
    shutil.copy2(profile, paths.merged_profile)
    assert sha256_file(paths.control_binary) == seed["evidence"]["control"]["sha256"]
    report = dict(comparison_only=True, eligible_for_release=False,
                  baseline_source=identity["source_sha"], mode=args.mode,
                  input_bitcode_sha256=identity["bitcode_sha256"],
                  profile_sha256=sha256_file(profile), results=[])

    def command(argv, name, timeout=900):
        return run_checked(tuple(map(str, argv)), cwd=paths.root, env=os.environ.copy(),
                           timeout_s=timeout, log_path=paths.logs / (name + ".json"),
                           require_empty_stderr=True)

    def measure(name):
        # Each link extracts into a fresh generated directory, as production
        # does. Keep its nonempty-directory safety check intact.
        runtime = paths.candidate_binary.parent / "compiler-runtime"
        if runtime.exists():
            shutil.rmtree(runtime)
        p.link_candidate(toolchain, paths)
        command([paths.candidate_binary, "--version"], name + "-version", 30)
        destination = paths.root / (name + "-fx")
        shutil.copy2(paths.candidate_binary, destination)
        shutil.copy2(paths.logs / "candidate-link.map", paths.logs / (name + "-link.map"))
        item = dict(name=name, bytes=destination.stat().st_size, sha256=sha256_file(destination),
                    backend_flags=list(p.FX_MACHINE_OUTLINER_FLAGS))
        report["results"].append(item)
        (paths.root / "comparison.json").write_text(json.dumps(report, indent=2))
        print(json.dumps(item), flush=True)

    if args.mode in ("cleanup", "promote"):
        prepared = json.loads((args.prepared / "comparison.json").read_text())
        assert prepared["baseline_source"] == identity["source_sha"]
        assert prepared["input_bitcode_sha256"] == identity["bitcode_sha256"]
        assert prepared["profile_sha256"] == report["profile_sha256"]
        first = args.prepared / "first-pass.bc"
        assert sha256_file(first) == "6cd1d7f8741ccef7fb9ea217ab7a77647a0b178f5bd579e5e17014b06955d8ba"
        report["prepared_ir_sha256"] = sha256_file(first)
        before = p._defined_external_symbols(toolchain, first, paths.logs / "cleanup-symbols-before.json")
        passes = "ipsccp,deadargelim,globalopt,function(sroa,early-cse,instcombine<no-verify-fixpoint>,simplifycfg,memcpyopt,dse,adce),globaldce,mergefunc,verify"
        if args.mode == "promote":
            passes = "cgscc(argpromotion)," + passes
        report["cleanup_passes"] = passes
        command([toolchain.opt, "-passes=" + passes, first, "-o", paths.profile_use_bitcode], "extra-cleanup")
        p.rewrite_sparse_constants(toolchain, paths)
        after = p._defined_external_symbols(toolchain, paths.profile_use_bitcode, paths.logs / "cleanup-symbols-after.json")
        assert before == after, "Comparison changed public symbols"
        shutil.copy2(paths.profile_use_bitcode, paths.root / "first-pass.bc")
        measure(args.mode)
        return

    if args.mode in ("baseline", "generic", "namespace"):
        if args.mode != "baseline":
            script = pathlib.Path(__file__).with_name("partition_experiment.py")
            mapping = paths.root / "routing.json"
            p.split_ir_argv = lambda tc, ps: (sys.executable, str(script), "split", str(tc.libllvm), str(tc.llvm_split), str(ps.profile_use_base_bitcode), str(ps.outline_split_prefix), str(mapping), args.mode)
            p.cleanup_outlined_ir_argv = lambda tc, ps: (sys.executable, str(script), "cleanup", str(tc.libllvm), str(tc.opt), str(ps.linked_outlined_bitcode), str(ps.profile_use_bitcode), str(mapping), args.mode)
        p.apply_profile(toolchain, paths, identity["bitcode_sha256"])
        shutil.copy2(paths.profile_use_bitcode, paths.root / "first-pass.bc")
        measure(args.mode)
        return

    if args.mode in ("os", "oz"):
        level = "Os" if args.mode == "os" else "Oz"
        p.USE_FLAGS = tuple(flag.replace("default<O2>", "default<" + level + ">") for flag in p.USE_FLAGS)
        report["profile_use_flags"] = list(p.USE_FLAGS)
        # Keep normal profile mismatch, IR verification, and public-symbol
        # validation. A comparison must fail if these profiles cannot apply.
        p.apply_profile(toolchain, paths, identity["bitcode_sha256"])
        measure(args.mode)
        return

    if args.mode == "backend":
        prepared = json.loads((args.prepared / "comparison.json").read_text())
        assert prepared["baseline_source"] == identity["source_sha"]
        assert prepared["input_bitcode_sha256"] == identity["bitcode_sha256"]
        assert prepared["profile_sha256"] == report["profile_sha256"]
        first = args.prepared / "first-pass.bc"
        report["prepared_ir_sha256"] = sha256_file(first)
        shutil.copy2(first, paths.profile_use_bitcode)
        base = ("-machine-outliner-reruns=1",)
        for name, flags in [
            ("backend-baseline", ()),
            ("tail-merge", ("-enable-tail-merge",)),
            ("tail-wide", ("-enable-tail-merge", "-tail-merge-threshold=1000")),
            ("tail-short", ("-enable-tail-merge", "-tail-merge-threshold=1000", "-tail-merge-size=2")),
            ("compact-tails", ("-enable-tail-merge", "-tail-merge-threshold=1000", "-tail-merge-size=2", "-disable-early-taildup", "-disable-tail-duplicate", "-tail-dup-placement=false")),
            ("all-profitable", ("-enable-tail-merge", "-tail-merge-threshold=1000", "-enable-machine-outliner=always")),
        ]:
            p.FX_MACHINE_OUTLINER_FLAGS = base + flags
            measure(name)
        return

    if args.mode == "helpers":
        from scripts.pgso import ir_size
        # This is a changed comparison input. Final qualification must retrain
        # with any chosen helper pass running before instrumentation.
        ir_size.OUT_OF_LINE_HELPERS += (
            r"Io\.Writer\.writeByte",
            r"json\.Stringify\.(?:beginArray|beginObject|endArray|endObject|objectField|stringValue|valueStart|valueDone|objectFieldStart|indent|outputSpecialEscape)",
        )
        transformed = paths.bitcode.with_name("helpers.bc")
        report["helper_pass"] = ir_size.outline_helpers(ir_size.Llvm(toolchain.libllvm), paths.bitcode, transformed)
        shutil.move(transformed, paths.bitcode)
        report["transformed_bitcode_sha256"] = sha256_file(paths.bitcode)
        p.apply_profile(toolchain, paths, sha256_file(paths.bitcode))
        measure("helpers")
        return

    p.apply_profile(toolchain, paths, identity["bitcode_sha256"])
    first = paths.root / "first-pass.bc"
    shutil.copy2(paths.profile_use_bitcode, first)
    measure("baseline")
    p.FX_MACHINE_OUTLINER_FLAGS = ("-machine-outliner-reruns=3",)
    measure("machine-three")
    p.FX_MACHINE_OUTLINER_FLAGS = ("-machine-outliner-reruns=1",)
    before = p._defined_external_symbols(toolchain, first, paths.logs / "round-two-symbols-before.json")
    prefix = paths.root / "round-two-part."
    command([toolchain.llvm_split, "-j", "2", "--round-robin", "-o", prefix, first], "round-two-split", 300)
    outlined = []
    for index in range(2):
        target = paths.root / ("round-two-outlined-" + str(index) + ".bc")
        command(p.outline_ir_argv(toolchain, pathlib.Path(str(prefix) + str(index)), target), "round-two-outline-" + str(index))
        outlined.append(target)
    joined = paths.root / "round-two-linked.bc"
    command([toolchain.llvm_link, *outlined, "-o", joined], "round-two-link", 300)
    command([toolchain.opt, *p.OUTLINE_CLEANUP_FLAGS, joined, "-o", paths.profile_use_bitcode], "round-two-cleanup", 300)
    p.rewrite_sparse_constants(toolchain, paths)
    after = p._defined_external_symbols(toolchain, paths.profile_use_bitcode, paths.logs / "round-two-symbols-after.json")
    assert before == after, "Comparison changed public symbols"
    measure("round-two")
    p.FX_MACHINE_OUTLINER_FLAGS = ("-machine-outliner-reruns=3",)
    measure("round-two-machine-three")


if __name__ == "__main__":
    main()
