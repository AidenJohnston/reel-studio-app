"""`score --project dir --version N`: the mechanical checks one saved version passes, read from what its render
left beside it (versions/vN: project.json, captions.json, verify.json, render.json, check.json).

This measures craft that has one right answer, not whether the reel is good: no pause the cut should have
removed, every kept word subtitled, subtitles clear of Instagram's buttons, loudness at the platform's target,
a video file that plays as expected, the My style rules it was checked against, and the "Double-check each edit"
verdict when that ran. It comes from the October eval harness (fork branch eval-harness, scripts/eval/quality.py),
cut down to the checks a person can act on. Nothing is rendered or decoded, so it costs a few JSON reads.

Each check is {id, ok, ...numbers}; a check with nothing to measure (no subtitles, no rules, no double-check) is
left out rather than passed. The app writes every sentence (shared/edit-score.ts).
"""
from __future__ import annotations

import json
from pathlib import Path

from . import captions as capmod, project as projmod, verify as verifymod
from .proto import EngineError


def _read(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def dead_air(tl, proj: dict) -> dict:
    """Pauses longer than the cut keeps (gapCap) plus what it would not bother cutting (minSaving), with two frames
    of slack for frame-grid rounding, between words this version keeps."""
    cut = proj.get("cut") or {}
    fps = min([float(s.get("fps") or 30) for s in proj.get("sources") or []] or [30.0])
    allowed = float(cut.get("gapCap", 0.25)) + float(cut.get("minSaving", 0.08)) + 2 / fps + 0.002
    gaps = [max(0.0, b["s"] - a["e"]) for a, b in zip(tl.words_out, tl.words_out[1:])]
    long = [g for g in gaps if g > allowed]
    return {"id": "deadAir", "ok": not long, "count": len(long), "longest": round(max(gaps, default=0.0), 2),
            "allowed": round(allowed, 2)}


def coverage(tl, proj: dict, cues: list) -> dict:
    """Every word the cut keeps and the subtitles don't hide on purpose is in a subtitle this render drew."""
    cap = proj.get("captions") or {}
    hidden = capmod.hidden_set(tl, cap)
    expected = {wid for c in capmod.build_cues(tl.words_out, cap, hidden) for wid in c.get("ids", [])}
    drawn = {wid for c in cues for wid in c.get("ids", [])}
    missing = len(expected - drawn)
    return {"id": "subtitleCoverage", "ok": not missing, "count": missing, "words": len(expected)}


def safe_band(cues: list, fmt: tuple) -> dict:
    """Subtitles clear of Instagram's top bar, caption and buttons (verify.py's margins)."""
    W, H = fmt
    unsafe = [c for c in cues if len(c.get("box") or []) != 4
              or c["box"][1] < H * verifymod.IG_TOP_FRAC or c["box"][1] + c["box"][3] > H * (1 - verifymod.IG_BOTTOM_FRAC)
              or c["box"][0] + c["box"][2] > W * (1 - verifymod.IG_RIGHT_FRAC) + 40]
    return {"id": "subtitleSafeZone", "ok": not unsafe, "count": len(unsafe), "subtitles": len(cues)}


def from_verify(rep: dict) -> list:
    checks = rep.get("checks") if isinstance(rep, dict) else None
    if not isinstance(checks, list):
        return []
    loud = next((c for c in checks if c.get("name") == "loudness"), None)
    rest = [c for c in checks if c.get("name") != "loudness"]
    out = []
    if loud is not None:
        out.append({"id": "loudness", "ok": loud.get("status") != "FAIL", "lufs": rep.get("lufs"), "target": verifymod.TARGET_LUFS})
    failed = [c.get("name") for c in rest if c.get("status") == "FAIL"]
    out.append({"id": "videoFile", "ok": not failed, "count": len(failed), "failed": failed[:5]})
    return out


def run(project_dir: Path, version: int) -> dict:
    project_dir = Path(project_dir).resolve()
    vdir = project_dir / "versions" / f"v{version}"
    snap = vdir / "project.json"
    if type(version) is not int or version < 1 or not snap.is_file():
        raise EngineError("NOT_FOUND", f"no saved version {version}", "That version isn't saved any more.")
    proj = projmod.load(project_dir, file=snap)
    fmt = (int(proj["format"]["width"]), int(proj["format"]["height"]))
    checks = []
    try:
        tl = projmod.timeline(project_dir, proj)
    except EngineError:
        tl = None                      # the transcript is gone: nothing about words can be measured
    report = _read(vdir / "captions.json")
    cues = report.get("cues") if isinstance(report, dict) and isinstance(report.get("cues"), list) else None
    if tl is not None:
        checks.append(dead_air(tl, proj))
    if (proj.get("captions") or {}).get("enabled", True) and cues is not None:
        if tl is not None:
            checks.append(coverage(tl, proj, cues))
        checks.append(safe_band(cues, fmt))
    checks += from_verify(_read(vdir / "verify.json"))
    render = _read(vdir / "render.json")
    rules = render.get("ruleChecks") if isinstance(render, dict) else None
    if isinstance(rules, dict) and rules.get("checked"):
        failing = len(rules.get("failures") or [])
        checks.append({"id": "myStyle", "ok": not failing, "count": failing, "rules": int(rules["checked"])})
    review = _read(vdir / "check.json")
    if isinstance(review, dict) and review.get("verdict") in ("pass", "unresolved"):
        checks.append({"id": "doubleCheck", "ok": review["verdict"] == "pass", "repairs": int(review.get("repairs") or 0)})
    return {"version": version, "checks": checks, "passed": sum(1 for c in checks if c["ok"]), "measured": len(checks)}
