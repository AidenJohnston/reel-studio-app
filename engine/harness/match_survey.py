"""Frames of the joins match.py would accept and refuse, on a real take (test code only).

    python -m harness.match_survey <project folder> <out folder> [--every N]

The project must already be transcribed and analysed (`reelengine transcribe`, `reelengine analyze`),
so it has words and a face track. The survey keeps every Nth phrase of the take (default every other
one), which makes a jump cut at each join, asks match.py about every join, and writes:

  out/joins.json      one row per join: the planned pair's LOOK and MOVE (the plain cut), the best
                      pair's, and the verdict
  out/join-KK.jpg     the frame before and after the cut, planned (top) and chosen (bottom), with the
                      scores printed on them

It changes nothing in the project except the match cache in work/.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

from reelengine import analyze, match, project as projmod
from reelengine.render import display_crop, source_faces


def _frame(path: Path, k: int, fps: float, crop: tuple, disp: tuple):
    """Source frame k (shown from k/fps), cropped as the output crops it, 180 x 320 BGR."""
    import subprocess
    import cv2
    from reelengine.compose_util import ffmpeg_bin
    w = 360
    h = max(2, int(round(disp[1] * w / disp[0])) // 2 * 2)
    raw = subprocess.run([ffmpeg_bin(), "-v", "error", "-nostdin", "-ss", f"{max(0.0, (k - 0.5) / fps):.6f}", "-i", str(path),
                          "-frames:v", "1", "-an", "-vf", f"scale={w}:{h}:flags=area", "-f", "rawvideo", "-pix_fmt", "bgr24", "-"],
                         capture_output=True, timeout=120).stdout
    if len(raw) < w * h * 3:
        return np.zeros((320, 180, 3), np.uint8)
    bgr = np.frombuffer(raw[:w * h * 3], np.uint8).reshape(h, w, 3)
    kx, ky = w / float(disp[0]), h / float(disp[1])
    x, y, cw, ch = crop
    part = bgr[int(round(y * ky)):int(round((y + ch) * ky)), int(round(x * kx)):int(round((x + cw) * kx))]
    return cv2.resize(part, (180, 320), interpolation=cv2.INTER_AREA)


def _label(img, text: str):
    import cv2
    out = img.copy()
    cv2.rectangle(out, (0, 0), (out.shape[1], 22), (0, 0, 0), -1)
    cv2.putText(out, text, (4, 15), cv2.FONT_HERSHEY_SIMPLEX, 0.38, (255, 255, 255), 1, cv2.LINE_AA)
    return out


def main(argv=None) -> None:
    import cv2
    ap = argparse.ArgumentParser(prog="harness.match_survey")
    ap.add_argument("project")
    ap.add_argument("out")
    ap.add_argument("--every", type=int, default=2)
    a = ap.parse_args(argv)
    pdir, out = Path(a.project), Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    proj = projmod.load(pdir)
    words = projmod.load_transcript(pdir, proj)["words"]
    phrases = analyze.split_phrases(words)
    kept = phrases[::max(1, a.every)]
    proj["cut"]["keep"] = [{"from": ph[0]["id"], "to": ph[-1]["id"]} for ph in kept if ph]
    for item in proj["cut"]["keep"][1:]:
        item["join"] = {"transition": "match", "frames": 0}
    base = projmod.cutmod.build_timeline(words, proj["cut"]["keep"], projmod.source_meta(proj), join_fps=float(proj["format"]["fps"]))
    verdicts = match.plan(pdir, proj, base)
    tl = projmod.timeline(pdir, proj, words)
    fmt = proj["format"]
    faces = source_faces(pdir, proj)
    by_id = {s["id"]: s for s in proj["sources"]}
    rows = []
    for m in base.match_joins:
        if m.get("played") == "none":
            rows.append({"keep": m["keep"], "played": "none"})
            continue
        o, i = base.segments[m["out"]], base.segments[m["in"]]
        so, si = by_id[o.source], by_id[i.source]
        po, pi = projmod.source_path(pdir, so), projmod.source_path(pdir, si)
        disp_o, disp_i = (int(so["width"]), int(so["height"])), (int(si["width"]), int(si["height"]))
        co = display_crop(disp_o, fmt["width"], fmt["height"], faces.get(o.source))
        ci = display_crop(disp_i, fmt["width"], fmt["height"], faces.get(i.source))
        fps_o, fps_i = float(so.get("fps") or 30), float(si.get("fps") or 30)
        v = verdicts.get(m["keep"]) or {}
        planned = [_frame(po, round(o.src_end * fps_o) - 1, fps_o, co, disp_o), _frame(pi, round(i.src_start * fps_i), fps_i, ci, disp_i)]
        dp = [match.describe(cv2.cvtColor(f, cv2.COLOR_BGR2GRAY)) for f in planned]
        row = {"keep": m["keep"], "at": round(i.out_start, 3), "planned": {"look": round(match.look(*dp), 4), "move": round(match.move(*dp), 4)},
               "verdict": v, "played": next((x["played"] for x in tl.match_joins if x["keep"] == m["keep"]), None)}
        rows.append(row)
        top = np.hstack([_label(planned[0], f"planned out {o.src_end:.2f}"), _label(planned[1], f"in {i.src_start:.2f}")])
        if "outEnd" in v:
            chosen = [_frame(po, round(v["outEnd"] * fps_o) - 1, fps_o, co, disp_o), _frame(pi, round(v["inStart"] * fps_i), fps_i, ci, disp_i)]
            tag = "MATCH" if v.get("matched") else "no match"
            bottom = np.hstack([_label(chosen[0], f"{tag} look {v['look']:.2f}"), _label(chosen[1], f"move {v['move']:.3f}")])
        else:
            bottom = np.hstack([_label(np.zeros_like(planned[0]), v.get("why", "")[:30]), np.zeros_like(planned[1])])
        cv2.imwrite(str(out / f"join-{m['keep']:02d}.jpg"), np.vstack([top, bottom]))
    (out / "joins.json").write_text(json.dumps({"lookMin": match.LOOK_MIN, "moveMax": match.MOVE_MAX, "joins": rows}, indent=1), encoding="utf-8")
    matched = sum(1 for r in rows if r.get("played") == "match")
    print(json.dumps({"joins": len(rows), "matched": matched, "out": str(out)}))


if __name__ == "__main__":
    main()
