"""`python -m harness <setup|run|agree|pin>`, run from engine/ with the engine's Python.

  pin     print the sha256 of this FFmpeg/ffprobe and the current commit, for a person to pin
  setup   check the pins, write out the reference engine, generate the corpus, render references
  run     setup, then replay every session --runs times (after one untimed warm-up) and check
          every distinct output; writes report.json and report.md under the work folder
  agree   do two run reports agree within config.agreeWithinPct on the session wait?
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

from . import corpus, replay
from .engines import Engine, Refusal, check_pins, engine_env, extract_reference, sha256_file

HERE = Path(__file__).resolve().parent
ENGINE_DIR = HERE.parent
REPO = ENGINE_DIR.parent


def load_config(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _tool(arg, env: str, name: str) -> Path:
    p = arg or os.environ.get(env) or shutil.which(name)
    if not p or not Path(p).is_file():
        raise Refusal(f"no {name}: pass --{name} or set {env}")
    return Path(p).resolve()


def load_sample() -> dict:
    """Machine load when a run starts and ends, so a reader can tell whether it was quiet."""
    if hasattr(os, "getloadavg"):
        return {"loadavg": [round(x, 2) for x in os.getloadavg()], "cpus": os.cpu_count()}
    try:
        out = subprocess.run(["typeperf", r"\Processor(_Total)\% Processor Time", "-sc", "1"],
                             capture_output=True, text=True, timeout=30).stdout
        vals = re.findall(r'"([0-9.]+)"\s*$', out, re.M)
        return {"cpuPct": round(float(vals[-1]), 1) if vals else None, "cpus": os.cpu_count()}
    except (OSError, subprocess.SubprocessError):
        return {"cpuPct": None, "cpus": os.cpu_count()}


def ffmpeg_version(ffmpeg: Path) -> str:
    out = subprocess.run([str(ffmpeg), "-hide_banner", "-version"], capture_output=True, text=True).stdout
    return out.splitlines()[0] if out else "?"


def git_head() -> dict:
    head = subprocess.run(["git", "-C", str(REPO), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    dirty = bool(subprocess.run(["git", "-C", str(REPO), "status", "--porcelain", "--", "engine"],
                                capture_output=True, text=True).stdout.strip())
    return {"commit": head, "engineDirty": dirty}


class Ctx:
    def __init__(self, a):
        self.cfg = load_config(Path(a.config) if a.config else HERE / "config.json")
        self.work = Path(a.work).resolve() if a.work else REPO / "testdata" / "harness"
        self.ffmpeg = _tool(a.ffmpeg, "REELENGINE_FFMPEG", "ffmpeg")
        self.ffprobe = _tool(a.ffprobe, "REELENGINE_FFPROBE", "ffprobe")
        self.python = a.python or sys.executable
        self.pins = check_pins(self.cfg, sys.platform, self.ffmpeg, self.ffprobe, REPO)
        self.root = self.work / "root"
        self.scratch = self.work / "scratch"
        self.scratch.mkdir(parents=True, exist_ok=True)
        commit = self.cfg["reference"]["engineCommit"]
        ref_dir = extract_reference(REPO, commit, self.work / "reference" / commit)
        self.ref = Engine(ref_dir, self.python, self.env(self.work / "cache-ref"))
        self.ref.check_import()

    def env(self, run_cache: Path) -> dict:
        return engine_env(self.ffmpeg, self.ffprobe, self.root, self.work / "machine-cache", run_cache)

    def take_dir(self, entry: dict) -> Path:
        if "takeDir" in entry:
            base = os.environ.get("REELENGINE_TEST_TAKES")
            if not base:
                raise Refusal(f"take {entry['id']} is real footage: set REELENGINE_TEST_TAKES")
            return Path(base) / entry["takeDir"]
        return self.work / "corpus" / entry["id"]


def setup(c: Ctx, ids=None) -> dict:
    song = corpus.ensure_song(c.root)
    made, takes, sizes = {}, {}, {}
    for entry in c.cfg["corpus"]:
        if ids is not None and entry["id"] not in ids:
            continue
        d = c.take_dir(entry)
        spec = entry.get("synthetic")
        if spec is not None and corpus.needs_build(spec, d):
            shutil.rmtree(d, ignore_errors=True)
            made[entry["id"]] = corpus.build_synthetic(str(c.ffmpeg), c.ref, spec, d, c.root)
        try:
            corpus.validate(spec, d)
        except RuntimeError as e:
            raise Refusal(str(e))
        take = replay.Take(entry["id"], d)
        sizes[entry["id"]] = corpus.take_bytes(d)
        takes[entry["id"]] = (take, replay.build_references(take, c.ref, c.work / "refs", c.scratch, c.pins, c.root))
    return {"takes": takes, "made": made, "mediaBytes": sizes, "songBytes": song.stat().st_size}


def split_ids(cfg: dict, split: str, only) -> list:
    held = set(cfg["heldOut"])
    ids = [e["id"] for e in cfg["corpus"]]
    if split == "loop":
        ids = [i for i in ids if i not in held]
    elif split == "held-out":
        ids = [i for i in ids if i in held]
    if only is not None:
        ids = [i for i in ids if i in only]
    return ids


def cmd_pin(a) -> int:
    ffmpeg = _tool(a.ffmpeg, "REELENGINE_FFMPEG", "ffmpeg")
    ffprobe = _tool(a.ffprobe, "REELENGINE_FFPROBE", "ffprobe")
    print(json.dumps({"platform": sys.platform, "ffmpeg": {"path": str(ffmpeg), "sha256": sha256_file(ffmpeg),
                                                           "version": ffmpeg_version(ffmpeg)},
                      "ffprobe": {"path": str(ffprobe), "sha256": sha256_file(ffprobe)}, "head": git_head()},
                     indent=2))
    return 0


def cmd_setup(a) -> int:
    c = Ctx(a)
    ids = split_ids(c.cfg, "all", a.takes.split(",") if a.takes is not None else None)
    if not ids:
        raise Refusal(f"no takes selected for setup (requested {a.takes!r})")
    s = setup(c, ids)
    print(json.dumps({"made": s["made"], "mediaBytes": s["mediaBytes"], "songBytes": s["songBytes"],
                      "totalBytes": sum(s["mediaBytes"].values()) + s["songBytes"]}, indent=2))
    return 0


def cmd_run(a) -> int:
    c = Ctx(a)
    ids = split_ids(c.cfg, a.split, a.takes.split(",") if a.takes is not None else None)
    if not ids:
        raise Refusal(f"no takes selected in split {a.split!r} (requested {a.takes!r})")
    s = setup(c, ids)
    runs = a.runs or c.cfg["runs"]
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out_dir = c.work / "runs" / stamp
    cand = Engine(ENGINE_DIR, c.python, c.env(c.scratch / "cache-warmup"))
    cand.check_import()
    report = {"startedAt": stamp, "candidate": git_head(), "pins": c.pins, "ffmpegVersion": ffmpeg_version(c.ffmpeg),
              "python": c.python, "platform": sys.platform, "split": a.split, "runs": runs,
              "thresholds": c.cfg["thresholds"], "mediaBytes": s["mediaBytes"], "load": [load_sample()], "takes": {}}
    if not a.no_warmup:        # reads every source once and probes the GPU encoder, untimed
        for tid in ids:
            take, refs = s["takes"][tid]
            proj = c.scratch / f"warm-{tid}"
            replay.copy_project(take.project, proj)
            replay.write_state(proj, take.state(take.session[0]))
            cand.run("render", ["--project", proj, "--draft"])
            shutil.rmtree(proj, ignore_errors=True)
    results = {tid: [] for tid in ids}
    for r in range(runs):
        for tid in ids:
            take, refs = s["takes"][tid]
            cache = c.scratch / "cache-run"
            shutil.rmtree(cache, ignore_errors=True)
            cand.env = c.env(cache)
            keep = out_dir / "outputs" / tid / f"run{r + 1}"
            results[tid].append(replay.replay(take, cand, refs, c.scratch, keep, str(c.ffprobe)))
        report["load"].append(load_sample())
    th = c.cfg["thresholds"]
    for tid in ids:
        take, refs = s["takes"][tid]
        rs = results[tid]
        checked = replay.check_take(take, refs, rs, str(c.ffmpeg), str(c.ffprobe), th, c.pins, c.cfg["sizes"])
        replay.prune_duplicates(rs)
        steps = []
        for k, step in enumerate(take.session):
            steps.append({"note": step["note"], "moment": refs[k]["moment"], "window": refs[k]["window"],
                          "stills": refs[k]["stills"],
                          "seconds": {n: replay.stats([run["seconds"][n][k] for run in rs]) for n in replay.STEPS},
                          # runs may differ in which stills they made; check_take fails that
                          "distinctOutputs": {n: len({run["files"][k][n]["sha256"] for run in rs if n in run["files"][k]})
                                              for n in sorted({n for run in rs for n in run["files"][k]})},
                          "checks": checked["steps"][k]})
        report["takes"][tid] = {"steps": steps, "final": {"seconds": replay.stats([run["final"] for run in rs]),
                                                          "distinctOutputs": len({run["finalFile"]["final"]["sha256"] for run in rs}),
                                                          "check": checked["final"]},
                                "wait": replay.stats([replay.session_wait(run) for run in rs])}
    report["wait"] = replay.stats([sum(replay.session_wait(results[tid][r]) for tid in ids) for r in range(runs)])
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "report.json").write_text(json.dumps(report, indent=1), encoding="utf-8")
    md = render_markdown(report)
    (out_dir / "report.md").write_text(md, encoding="utf-8")
    print(md)
    print(f"\nreport: {out_dir / 'report.json'}")
    for take in report["takes"].values():
        if _status(take["final"]["check"]) == "fail" or any(
                _status(chk) == "fail" for step in take["steps"] for chk in step["checks"].values()):
            return 1
    return 0


def _status(chk) -> str:
    if isinstance(chk, list):
        st = [x["status"] for x in chk]
        return "fail" if "fail" in st else ("unset" if "unset" in st else "pass")
    return chk["status"]


def _sec(s: dict) -> str:
    return f"{s['median']:.2f} ({s['spreadPct']:.0f}%)"


def render_markdown(r: dict) -> str:
    lines = [f"Candidate {r['candidate']['commit'][:10]}{' (engine changed)' if r['candidate']['engineDirty'] else ''}, "
             f"reference {r['pins']['engineCommit'][:10]}, {r['ffmpegVersion']}, {r['runs']} runs, split {r['split']}.",
             "Seconds are the median of the runs, with (max - min) / median in brackets. "
             "Checks are against the reference final of the same state; unset = no threshold configured.", "",
             "| Take | Note | Draft s | Still s | Window s | Draft | Still | Window |",
             "|---|---|---|---|---|---|---|---|"]
    for tid, t in r["takes"].items():
        for s in t["steps"]:
            sec, ch = s["seconds"], s["checks"]
            lines.append(f"| {tid} | {s['note']} | {_sec(sec['draft'])} | {_sec(sec['still'])} | {_sec(sec['window'])} | "
                         f"{_status(ch['draft'])} | {_status(ch['still'])} | {_status(ch['window'])} |")
        lines.append(f"| {tid} | final export | {_sec(t['final']['seconds'])} | | | {_status(t['final']['check'])} | | |")
    lines += ["", f"Session wait (all takes): {_sec(r['wait'])} s. Per take: "
              + ", ".join(f"{tid} {_sec(t['wait'])}" for tid, t in r["takes"].items()) + "."]
    lines.append("Load samples: " + json.dumps(r["load"]))
    fails = []
    for tid, t in r["takes"].items():
        for k, s in enumerate(t["steps"]):
            for n, chk in s["checks"].items():
                fails += [(tid, k, n, x) for x in (chk if isinstance(chk, list) else [chk]) if x["status"] == "fail"]
        if t["final"]["check"]["status"] == "fail":
            fails.append((tid, len(t["steps"]) - 1, "final", t["final"]["check"]))
    if fails:
        lines += ["", "Failed checks:"]
        for tid, k, n, c in fails:
            bad = {m: v for m, v in c["metrics"].items() if v["status"] == "fail"}
            lines.append(f"- {tid} note {k} {n}: {json.dumps(bad)} {'; '.join(c['failures'])}")
    return "\n".join(lines)


def cmd_agree(a) -> int:
    cfg = load_config(Path(a.config) if a.config else HERE / "config.json")
    within = a.within if a.within is not None else cfg["agreeWithinPct"]
    r1, r2 = (json.loads(Path(p).read_text(encoding="utf-8")) for p in (a.a, a.b))
    if set(r1["takes"]) != set(r2["takes"]):
        raise Refusal(f"report take sets differ: only in first {sorted(set(r1['takes']) - set(r2['takes']))}, "
                      f"only in second {sorted(set(r2['takes']) - set(r1['takes']))}")
    fields = [("split", r1.get("split"), r2.get("split")),
              ("flow", r1.get("flow", "drafts"), r2.get("flow", "drafts")),
              ("proxy", r1.get("proxy", False), r2.get("proxy", False))]
    for key in ("engineCommit", "ffmpeg", "ffprobe"):
        v1, v2 = r1.get("pins", {}).get(key), r2.get("pins", {}).get(key)
        if key != "engineCommit":
            v1, v2 = (v1 or {}).get("sha256"), (v2 or {}).get("sha256")
        fields.append((f"pins.{key}" + (".sha256" if key != "engineCommit" else ""), v1, v2))
    for name, v1, v2 in fields:
        if v1 is None or v2 is None:
            raise Refusal(f"reports must record {name}: first {v1!r}, second {v2!r}")
        if v1 != v2:
            raise Refusal(f"report {name} differs: first {v1!r}, second {v2!r}")
    rows = [("all takes", r1["wait"]["median"], r2["wait"]["median"])]
    rows += [(tid, r1["takes"][tid]["wait"]["median"], r2["takes"][tid]["wait"]["median"])
             for tid in r1["takes"]]
    ok = True
    for name, m1, m2 in rows:
        diff = 100.0 * abs(m1 - m2) / min(m1, m2)
        ok &= diff <= within if name == "all takes" else True
        print(f"{name}: {m1:.2f} s vs {m2:.2f} s, {diff:.1f}% apart")
    print(f"{'agree' if ok else 'DO NOT agree'} within {within}% on the session wait of all takes")
    return 0 if ok else 1


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="harness", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    for name in ("pin", "setup", "run"):
        sp = sub.add_parser(name)
        sp.add_argument("--ffmpeg")
        sp.add_argument("--ffprobe")
        sp.add_argument("--python", help="interpreter for the engine (default: this one)")
        sp.add_argument("--work", help="work folder (default <repo>/testdata/harness, git-ignored)")
        sp.add_argument("--config")
        sp.add_argument("--takes", help="comma-separated take ids (default: all in the split)")
    run = sub.choices["run"]
    run.add_argument("--runs", type=int)
    run.add_argument("--split", choices=["loop", "held-out", "all"], default="loop")
    run.add_argument("--no-warmup", action="store_true")
    ag = sub.add_parser("agree")
    ag.add_argument("a")
    ag.add_argument("b")
    ag.add_argument("--within", type=float)
    ag.add_argument("--config")
    a = p.parse_args(argv)
    try:
        return {"pin": cmd_pin, "setup": cmd_setup, "run": cmd_run, "agree": cmd_agree}[a.cmd](a)
    except Refusal as e:
        print(f"harness refused: {e}", file=sys.stderr)
        return 2
