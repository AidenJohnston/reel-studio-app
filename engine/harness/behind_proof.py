"""Frames of words behind the speaker on a real take, with and without a zoom (test code only).

    python -m harness.behind_proof <project folder> <out folder> [--at SECONDS] [--dur 2.4] [--text WORD] [--zoom 1.2]

Puts one text-behind item (and, unless --zoom 0, a zoom over the same words) on the kept words from
--at (output seconds; default a third of the way in), renders that window as a final, and writes:

  out/zoom-T.png, out/flat-T.png   the rendered frame at T s into the window, beside the matte that
                                   cut the speaker out (white = in front of the words)
  out/report.json                  the window, the words, how b-roll was shown (fallbacks), and per
                                   frame the share of the frame the matte calls the speaker

project.json is put back exactly as it was afterwards; the renders stay in the project's versions/.
"""
from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path

import numpy as np

from reelengine import project as projmod, render, tools
from reelengine.compose_util import ffmpeg_bin

TIMES = (0.15, 0.5, 0.9, 1.3, 1.7, 2.1)


def _frame(path: Path, t: float, w: int = 540) -> np.ndarray:
    raw = subprocess.run([ffmpeg_bin(), "-v", "error", "-nostdin", "-ss", f"{t:.3f}", "-i", str(path), "-frames:v", "1",
                          "-vf", f"scale={w}:-2", "-f", "rawvideo", "-pix_fmt", "bgr24", "-"], capture_output=True, timeout=120).stdout
    h = len(raw) // (w * 3)
    return np.frombuffer(raw[:w * h * 3], np.uint8).reshape(h, w, 3) if h else np.zeros((960, w, 3), np.uint8)


def main(argv=None) -> None:
    import cv2
    ap = argparse.ArgumentParser(prog="harness.behind_proof")
    ap.add_argument("project")
    ap.add_argument("out")
    ap.add_argument("--at", type=float, default=None)
    ap.add_argument("--dur", type=float, default=2.4)
    ap.add_argument("--text", default="WAIT")
    ap.add_argument("--zoom", type=float, default=1.2)
    a = ap.parse_args(argv)
    pdir, out = Path(a.project), Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    pfile = pdir / "project.json"
    original = pfile.read_bytes()
    report = {"text": a.text, "runs": {}}
    try:
        proj = projmod.load(pdir)
        tl = projmod.timeline(pdir, proj)
        ctx = render.make_ctx(pdir, proj, tl, False, tools.root_dir(None), pdir / "work" / "render")
        at = a.at if a.at is not None else round(ctx.duration / 3, 2)
        kept = [w for w in ctx.words if ctx.is_kept(w["id"]) and at <= ctx.word_out_time(w["id"]) < at + a.dur]
        if not kept:
            raise SystemExit(f"no kept words between {at} and {at + a.dur} s")
        anchor = {"from": kept[0]["id"], "to": kept[-1]["id"]}
        start = ctx.word_out_time(kept[0]["id"])
        report.update({"at": start, "words": [w["w"] for w in kept]})
        for name, zoom in (("zoom", a.zoom), ("flat", 0.0)):
            if name == "zoom" and zoom <= 1.0:
                continue
            p = projmod.load(pdir)
            p["broll"] = [{"id": "behind1", "anchor": anchor, "leadIn": 0.0, "treatment": "text-behind", "asset": None,
                           "params": {"text": a.text}}]
            p["zooms"] = [{"anchor": anchor, "scale": zoom, "focus": [0.5, 0.42]}] if zoom > 1.0 else []
            projmod.save(pdir, p)
            res = render.run(pdir, draft=False, window=f"{max(0.0, start - 0.3):.3f}:{start + a.dur:.3f}",
                             verify=False, cover=False)
            items = json.loads((pdir / "work" / "layers" / "layers.json").read_text(encoding="utf-8"))["items"]
            matte = next((pdir / "work" / "layers" / it["matte"] for it in items if it.get("matte")), None)
            rows = []
            for t in TIMES:
                img = _frame(Path(res["file"]), t)
                side = np.zeros_like(img)
                share = None
                if matte is not None:
                    m = _frame(matte, max(0.0, t - 0.3))
                    side = cv2.resize(m, (img.shape[1], img.shape[0]))
                    share = round(float((side[..., 0] > 128).mean()), 3)
                cv2.imwrite(str(out / f"{name}-{t:.2f}.png"), np.hstack([img, side]))
                rows.append({"t": t, "speakerShare": share})
            report["runs"][name] = {"file": res["file"], "broll": render.read_broll_report(items), "frames": rows,
                                    "warnings": res.get("warnings")}
    finally:
        pfile.write_bytes(original)
    (out / "report.json").write_text(json.dumps(report, indent=1), encoding="utf-8")
    print(json.dumps({k: v for k, v in report.items() if k != "runs"} | {"runs": list(report["runs"])}))


if __name__ == "__main__":
    main()
