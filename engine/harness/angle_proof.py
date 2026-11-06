"""Two cameras made from one real take, lined up by sound and cut between (test code only).

    python -m harness.angle_proof <project folder> <out folder> [--offset 0.8] [--crop 0.6]

The project must be transcribed (or have harness.grid_words' stand-in words). The second "camera" is the
take's centre-upper part (--crop of each side), enlarged back to full size, starting --offset seconds later,
through a duller mic. The harness lines it up with angles.sync_offset, turns on `cut.angles: "auto"`, renders
a draft and writes:

  out/report.json     the true and measured offset, the sync confidence, each segment's camera, the render's
                      warnings
  out/seg-KK.png      the frame in the middle of each segment (first 16), labelled with its camera

project.json is put back as it was; the made camera stays in media/ and its face track in work/.
This is two angles of ONE camera: real multi-camera footage (other lenses, mics, clock drift) is untested.
"""
from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path

import numpy as np

from reelengine import analyze, angles, project as projmod, render
from reelengine.compose_util import ffmpeg_bin, probe


def main(argv=None) -> None:
    import cv2
    ap = argparse.ArgumentParser(prog="harness.angle_proof")
    ap.add_argument("project")
    ap.add_argument("out")
    ap.add_argument("--offset", type=float, default=0.8)
    ap.add_argument("--crop", type=float, default=0.6)
    a = ap.parse_args(argv)
    pdir, out = Path(a.project), Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    pfile = pdir / "project.json"
    original = pfile.read_bytes()
    proj = projmod.load(pdir)
    main_src = proj["sources"][0]
    main_path = projmod.source_path(pdir, main_src)
    made = pdir / "media" / "angle-proof.mp4"
    c = a.crop
    subprocess.run([ffmpeg_bin(), "-y", "-v", "error", "-nostdin", "-ss", f"{a.offset}", "-i", str(main_path),
                    "-vf", f"crop=iw*{c}:ih*{c}:(iw-iw*{c})/2:(ih-ih*{c})*0.3,scale=trunc(iw/{c}/2)*2:trunc(ih/{c}/2)*2",
                    "-af", "lowpass=f=3000,volume=0.6", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
                    "-pix_fmt", "yuv420p", "-c:a", "aac", str(made)], check=True)
    info = probe(made)
    report = {"offsetTrue": -a.offset, "crop": c}
    try:
        sid = f"s{max(int(s['id'][1:]) for s in proj['sources']) + 1}"
        synced = angles.sync_offset(ffmpeg_bin(), main_path, made)
        report.update({"offsetMeasured": synced["offset"], "confidence": synced["confidence"],
                       "offsetErrorMs": round(1000 * abs(synced["offset"] + a.offset), 2)})
        proj["sources"].append({"id": sid, "path": f"media/{made.name}", "duration": info.get("duration"),
                                "fps": info.get("fps"), "width": info.get("width"), "height": info.get("height"),
                                "rotation": 0, "angleOf": {"source": main_src["id"], **synced}})
        proj["cut"]["angles"] = "auto"
        projmod.save(pdir, proj)
        analyze.detect_faces(pdir, projmod.load(pdir), 0, 100)
        res = render.run(pdir, draft=True, verify=False, cover=False)
        rows = res.get("angles") or []
        report.update({"angles": rows, "switches": sum(1 for x, y in zip(rows, rows[1:]) if x["angle"] != y["angle"]),
                       "warnings": res.get("warnings"), "file": res["file"]})
        tl = projmod.timeline(pdir, projmod.load(pdir))
        for k, (seg, row) in enumerate(zip(tl.segments[:16], rows[:16])):
            t = seg.out_start + (seg.src_end - seg.src_start) / 2
            raw = subprocess.run([ffmpeg_bin(), "-v", "error", "-nostdin", "-ss", f"{t:.3f}", "-i", res["file"], "-frames:v", "1",
                                  "-vf", "scale=270:480", "-f", "rawvideo", "-pix_fmt", "bgr24", "-"], capture_output=True).stdout
            if len(raw) < 270 * 480 * 3:
                continue
            img = np.frombuffer(raw[:270 * 480 * 3], np.uint8).reshape(480, 270, 3).copy()
            cv2.rectangle(img, (0, 0), (270, 22), (0, 0, 0), -1)
            cv2.putText(img, f"{t:.1f}s {row['angle']}{' (made)' if row['angle'] == sid else ''}", (4, 15),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.42, (255, 255, 255), 1, cv2.LINE_AA)
            cv2.imwrite(str(out / f"seg-{k:02d}.png"), img)
    finally:
        pfile.write_bytes(original)
        (out / "report.json").write_text(json.dumps(report, indent=1), encoding="utf-8")
    print(json.dumps({k: v for k, v in report.items() if k != "angles"}))


if __name__ == "__main__":
    main()
