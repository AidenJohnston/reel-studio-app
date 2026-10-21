#!/usr/bin/env python3
"""Check the recorded source and TLC results without retaining state databases."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
JAR = ROOT / "tools/tla2tools.jar"
JAR_SHA = "5bd7b64db99ae4c6c35f290de5e809c0ee41af43f8699cf696099ffb6452b1e2"
JAR_URL = "https://github.com/tlaplus/tlaplus/releases/download/v1.8.0/tla2tools.jar"


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def source_check():
    coverage = json.loads((HERE / "coverage.json").read_text())
    changed = [name for name, digest in coverage["files"].items()
               if not (ROOT / name).is_file() or sha(ROOT / name) != digest]
    if changed:
        raise RuntimeError("Source/model review required since " + coverage["syncCommit"]
                           + ":\n" + "\n".join(changed)
                           + "\nFollow verification/note-staging/README.md.")
    return coverage["syncCommit"]


def ensure_jar():
    if not JAR.exists():
        JAR.parent.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="tlc-download-") as temp:
            downloaded = Path(temp) / "tla2tools.jar"
            urllib.request.urlretrieve(JAR_URL, downloaded)
            if sha(downloaded) != JAR_SHA:
                raise RuntimeError("Downloaded tla2tools.jar checksum mismatch")
            shutil.copyfile(downloaded, JAR)
    if sha(JAR) != JAR_SHA:
        raise RuntimeError("tools/tla2tools.jar checksum mismatch; refusing to execute it")


def check_case(java, case, results):
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="note-staging-tlc-") as temp:
        command = [java, "-XX:+UseParallelGC", "-Xmx1g", "-cp", str(JAR), "tlc2.TLC",
                   "-workers", "1", "-fp", "0", "-seed", "1", "-noGenerateSpecTE",
                   "-metadir", temp, "-config", str(HERE / (case["name"] + ".cfg")),
                   str(HERE / (case.get("module", "NoteStaging") + ".tla"))]
        result = subprocess.run(command, cwd=ROOT, text=True,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    log = result.stdout
    (results / (case["name"] + ".log")).write_text(log)
    violation = re.search(r"Error: Invariant (\w+) is violated", log)
    found = violation.group(1) if violation else None
    if case["expect"] == "pass":
        correct = result.returncode == 0 and "Model checking completed. No error" in log
    else:
        correct = result.returncode == 12 and found == case["invariant"]
    stats = re.search(r"(\d+) states generated, (\d+) distinct states found", log)
    summary = {"case": case["name"], "kind": case["expect"], "matched": correct,
               "violation": found, "exit": result.returncode,
               "seconds": round(time.monotonic() - started, 2),
               "generated": int(stats[1]) if stats else None,
               "distinct": int(stats[2]) if stats else None}
    print(json.dumps(summary), flush=True)
    if not correct:
        print(log[-8000:], file=sys.stderr)
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case", help="Run one named case from suite.json")
    parser.add_argument("--self-test", action="store_true",
                        help="Compatibility alias for the default expectation-checking behavior")
    parser.add_argument("--source-only", action="store_true")
    args = parser.parse_args()
    os.environ.pop("CLIPROXY_API_KEY", None)
    commit = source_check()
    print("Source/model sync: " + commit, flush=True)
    if args.source_only:
        return 0
    ensure_jar()
    java = os.environ.get("TLC_JAVA", "/opt/homebrew/opt/openjdk/bin/java")
    if not Path(java).is_file():
        java = shutil.which("java")
    if not java:
        raise RuntimeError("Java is required; set TLC_JAVA to its executable")
    cases = json.loads((HERE / "suite.json").read_text())
    if args.case:
        cases = [case for case in cases if case["name"] == args.case]
        if not cases:
            raise RuntimeError("Unknown case: " + args.case)
    results = HERE / "results"
    results.mkdir(exist_ok=True)
    if not args.case:
        probe = subprocess.run(["node", str(HERE / "source-probes.cjs")], cwd=ROOT,
                               text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        (results / "source-probes.log").write_text(probe.stdout)
        print(probe.stdout, end="", flush=True)
        if probe.returncode:
            raise RuntimeError("Source rehearsal failed; install repository dependencies with npm ci if TypeScript is missing")
    summaries = [check_case(java, case, results) for case in cases]
    (results / "summary.json").write_text(json.dumps(summaries, indent=2) + "\n")
    if not all(summary["matched"] for summary in summaries):
        print("RESULT: ERROR, a check did not match its recorded result.")
        return 2
    print("RESULT: PASS, all recorded outcomes matched.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (RuntimeError, OSError, ValueError) as error:
        print("ERROR: " + str(error), file=sys.stderr)
        sys.exit(2)
