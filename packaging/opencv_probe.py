#!/usr/bin/env python3
"""What the engine gets from an OpenCV build, as JSON, so two builds can be compared.

    <python> packaging/opencv_probe.py [CV2_DIR]           # probe the cv2 in CV2_DIR (else the one installed)
    python packaging/opencv_probe.py --compare A.json B.json

The OpenCV for macOS workflow probes the FFmpeg-free build (build_opencv_mac.py) and PyPI's wheel on the same
machine and compares them: same version, FFmpeg off only in ours, and the same faces from the engine's own detector
(reelengine.placement) in committed screenshots of the app, which show a cartoon presenter.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
IMAGES = ["docs/images/reel.png", "docs/images/drawer-cover.png", "docs/images/home.png", "docs/images/drawer-subtitles.png"]
# reel.png's presenter as PyPI's 5.0.0.93 wheel finds it (x, y, w, h), so a build that finds nothing fails
REEL_FACE = (367.1, 275.5, 115.4, 130.8)
PX, SCORE = 1.0, 0.01  # allowed difference between builds


def probe(cv2_dir: str) -> dict:
    if cv2_dir:
        sys.path.insert(0, cv2_dir)
    sys.path.insert(0, str(REPO / "engine"))
    import cv2
    import numpy as np
    from PIL import Image
    from reelengine import placement

    info = cv2.getBuildInformation()
    m = re.search(r"^\s*FFMPEG:\s*(\S+)", info, re.M)
    out = {"cv2": cv2.__version__, "cv2_file": cv2.__file__, "ffmpeg": m.group(1) if m else "absent",
           "video_io": re.search(r"Video I/O:\n((?:\s{4,}.*\n)*)", info).group(1).splitlines() if "Video I/O:" in info else [],
           "faces": {}}
    model = str(placement.YUNET_MODEL)
    for rel in IMAGES:
        bgr = np.ascontiguousarray(np.asarray(Image.open(REPO / rel).convert("RGB"))[:, :, ::-1])
        primary = placement.detect_in_frame(bgr)
        h, w = bgr.shape[:2]
        _, faces = cv2.FaceDetectorYN.create(model, "", (w, h), 0.6, 0.3, 5000).detect(bgr)
        out["faces"][rel] = {
            "detector": primary and primary["detector"],
            "primary": primary and [round(v, 2) for v in primary["box"]] + [round(primary["score"], 4)],
            "all": [] if faces is None else [[round(float(v), 2) for v in f[:4]] + [round(float(f[14]), 4)] for f in faces],
        }
    return out


def close(a, b) -> bool:
    return len(a) == len(b) and all(abs(x - y) <= PX for x, y in zip(a[:4], b[:4])) and abs(a[4] - b[4]) <= SCORE


def compare(ours: dict, pypi: dict) -> list:
    problems = []
    if ours["cv2"] != pypi["cv2"]:
        problems.append("versions differ: %s vs %s" % (ours["cv2"], pypi["cv2"]))
    if ours["ffmpeg"] not in ("NO", "absent"):
        problems.append("our build has FFmpeg: %s" % ours["ffmpeg"])
    for rel in IMAGES:
        a, b = ours["faces"][rel], pypi["faces"][rel]
        if a["detector"] != "yunet" and a["primary"] is not None:
            problems.append("%s: our build fell back to %s" % (rel, a["detector"]))
        if (a["primary"] is None) != (b["primary"] is None) or (a["primary"] and not close(a["primary"], b["primary"])):
            problems.append("%s: primary face %s vs PyPI %s" % (rel, a["primary"], b["primary"]))
        if len(a["all"]) != len(b["all"]) or not all(close(x, y) for x, y in zip(sorted(a["all"]), sorted(b["all"]))):
            problems.append("%s: faces %s vs PyPI %s" % (rel, a["all"], b["all"]))
    reel = ours["faces"]["docs/images/reel.png"]["primary"]
    if not reel or not close(reel[:4] + [0], list(REEL_FACE) + [0]):
        problems.append("reel.png: expected the presenter at %s, got %s" % (REEL_FACE, reel))
    return problems


def main() -> None:
    if sys.argv[1:2] == ["--compare"]:
        ours, pypi = (json.loads(Path(p).read_text(encoding="utf-8")) for p in sys.argv[2:4])
        problems = compare(ours, pypi)
        print("\n".join(problems) if problems else "same faces from both builds; FFmpeg %s in ours, %s in PyPI's"
              % (ours["ffmpeg"], pypi["ffmpeg"]))
        sys.exit(1 if problems else 0)
    print(json.dumps(probe(sys.argv[1] if len(sys.argv) > 1 else ""), indent=2))


if __name__ == "__main__":
    main()
