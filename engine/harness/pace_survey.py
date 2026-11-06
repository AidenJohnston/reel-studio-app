"""What each pace (cutStyle preset) does to a real take, measured on its draft (test code only).

    python -m harness.pace_survey <project folder> <out folder> [--seed N] [--zoom-every N]

The project must be transcribed and analysed. The survey keeps the project's cut (or the default cut
when it has none), adds a zoom-in on every Nth phrase (default 4) so the paces have accents to work
with, as an AI edit would, and makes one draft per pace: none, clean, standard, hyper, punchline. For
each it reports:

  meter     what the render's visual-change meter counted (render.py visualChanges): per minute,
            and in the first 5 seconds
  seen      changes counted from the draft's frames: a frame that differs from the one before by
            more than SEEN_JUMP (mean absolute grey difference, 0..1) after a quiet stretch
  band      the preset's seconds per visual change, as changes per minute

and writes out/pace.json. Drafts are written under the project's work/pace-survey/.
"""
from __future__ import annotations

import argparse
import copy
import json
import subprocess
import sys
from pathlib import Path

import numpy as np

from reelengine import analyze, project as projmod
from reelengine.cut_style import CUT_STYLES

PRESETS = [None, "clean", "standard", "hyper", "punchline"]
SEEN_FPS = 15
# A cut or a framing switch moves most of the picture at once; a talking head between frames moves a
# few pixels. Proposed from the synthetic steps in tests; the survey prints the raw spikes so this
# can be checked on real frames.
SEEN_JUMP = 0.035
SEEN_QUIET = 0.25   # seconds a change must be apart from the one before to count separately


def seen_changes(video: Path, duration: float) -> dict:
    from reelengine.compose_util import decode_frames
    prev, t_last, times, jumps = None, -1.0, [], []
    for t, bgr in decode_frames(video, SEEN_FPS, 64):
        grey = bgr.mean(axis=2) / 255.0
        if prev is not None:
            d = float(np.abs((grey - grey.mean()) - (prev - prev.mean())).mean())
            jumps.append(round(d, 4))
            if d > SEEN_JUMP and t - t_last >= SEEN_QUIET:
                times.append(round(t, 3))
                t_last = t
        prev = grey
    minutes = max(duration, 1e-6) / 60
    return {"times": times, "perMinute": round(len(times) / minutes, 2), "first5": sum(1 for t in times if t < 5),
            "jumpP50": float(np.median(jumps)) if jumps else 0.0, "jumpP95": float(np.percentile(jumps, 95)) if jumps else 0.0}


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(prog="harness.pace_survey")
    ap.add_argument("project")
    ap.add_argument("out")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--zoom-every", type=int, default=4)
    a = ap.parse_args(argv)
    pdir, out = Path(a.project).resolve(), Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    base = projmod.load(pdir)
    words = projmod.load_transcript(pdir, base)["words"]
    if not (base.get("cut") or {}).get("keep"):
        subprocess.run([sys.executable, "-m", "reelengine", "autocut", "--project", str(pdir)], check=True, capture_output=True)
        base = projmod.load(pdir)
    kept = set(projmod.timeline(pdir, base, words).first_pos)
    phrases = [ph for ph in analyze.split_phrases(words) if ph and ph[0]["id"] in kept and ph[-1]["id"] in kept]
    base["zooms"] = [{"anchor": {"from": ph[0]["id"], "to": ph[-1]["id"]}, "kind": "snap"} for ph in phrases[1::max(1, a.zoom_every)]]
    rows = []
    work = pdir / "work" / "pace-survey"
    work.mkdir(parents=True, exist_ok=True)
    for preset in PRESETS:
        p = copy.deepcopy(base)
        if preset:
            p["cutStyle"] = {"preset": preset, "seed": a.seed}
        else:
            p.pop("cutStyle", None)
        name = preset or "none"
        rel = f"work/pace-survey/{name}.json"
        projmod.write_json(pdir / rel, p)
        r = subprocess.run([sys.executable, "-m", "reelengine", "render", "--project", str(pdir), "--project-file", rel,
                            "--draft", "--no-cover", "--no-verify", "--out", f"work/pace-survey/{name}"],
                           capture_output=True, text=True)
        done = next((json.loads(line) for line in reversed(r.stdout.splitlines()) if line.startswith("{") and '"done"' in line), None)
        if not done:
            rows.append({"preset": name, "error": (r.stdout + r.stderr)[-2000:]})
            continue
        res = done["result"]
        band = CUT_STYLES[preset]["secondsPerVisualChange"] if preset else None
        rows.append({"preset": name, "duration": res["duration"],
                     "meter": {k: res["visualChanges"][k] for k in ("overall", "first5")},
                     "seen": seen_changes(Path(res["file"]), res["duration"]),
                     "band": None if not band else {"perMinute": [round(60 / band[1], 2), round(60 / band[0], 2)]},
                     "issues": [i["rule"] for i in res.get("issues", [])],
                     "framing": len((res.get("variation") or {}).get("framing") or [])})
        print(json.dumps({k: rows[-1].get(k) for k in ("preset", "band")} | {"meter/min": rows[-1]["meter"]["overall"]["perMinute"], "seen/min": rows[-1]["seen"]["perMinute"], "seenFirst5": rows[-1]["seen"]["first5"]}))
    (out / "pace.json").write_text(json.dumps({"seenJump": SEEN_JUMP, "zoomEvery": a.zoom_every, "seed": a.seed, "rows": rows}, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
