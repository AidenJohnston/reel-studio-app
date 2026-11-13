"""A window preview draws the captions the full video draws over the same moments."""
from __future__ import annotations

import json
import math
import subprocess
from pathlib import Path

import numpy as np

import fixtures as fx
from reelengine import render

FPS = 30
# Words of different lengths, so lines grouped differently look different.
TEXT = "so here is the short videos everyone makes and nobody really watches until the end".split()


def _gray_frames(path: Path) -> np.ndarray:
    w, h = (int(v) for v in subprocess.run(
        [fx.FFPROBE, "-v", "error", "-select_streams", "v", "-show_entries", "stream=width,height",
         "-of", "csv=p=0", str(path)], capture_output=True, text=True, check=True).stdout.strip().split(","))
    raw = subprocess.run([fx.FFMPEG, "-v", "error", "-i", str(path), "-f", "rawvideo", "-pix_fmt", "gray", "-"],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, h, w)


def _psnr(a: np.ndarray, b: np.ndarray) -> float:
    mse = float(np.mean((a.astype(np.float64) - b.astype(np.float64)) ** 2))
    return math.inf if mse == 0 else 10 * math.log10(255 * 255 / mse)


def test_window_starting_mid_line_shows_the_full_videos_lines(tmp_path, monkeypatch):
    """The window used to regroup only its own words into lines: starting inside the line "SO HERE IS"
    it showed "HERE IS THE", a line the full video never has."""
    monkeypatch.setenv("REELENGINE_DRAFT_ENCODER", "libx264")   # both previews through one encoder
    pdir = tmp_path / "p"
    fx.make_project(pdir, fx.synth_video(tmp_path / "media" / "take.mp4", dur=8.0), keep=((0.05, 6.05),))
    tfile = pdir / "work" / "transcript.json"
    words = json.loads(tfile.read_text(encoding="utf-8"))["words"]
    for i, w in enumerate(words):
        w["w"] = TEXT[i % len(TEXT)]
    tfile.write_text(json.dumps({"words": words}), encoding="utf-8")

    full = render.run(pdir, draft=True, root=tmp_path, verify=False)
    boxes = [c["box"] for c in json.loads((pdir / "work" / "captions.json").read_text(encoding="utf-8"))["cues"]]
    # Word k plays at output 0.05 + 0.4k s for 0.3 s, three words to a line: "SO HERE IS", "THE SHORT
    # VIDEOS", "EVERYONE MAKES AND". 0.6 s is inside "HERE" and 2.6 s inside "EVERYONE", so the window
    # starts and ends mid-line and mid-word, on the frame grid.
    a, b = 0.6, 2.6
    win = render.run(pdir, draft=True, window=f"{a}:{b}", root=tmp_path, verify=False)

    ref, got = _gray_frames(Path(full["file"])), _gray_frames(Path(win["file"]))
    scale = got.shape[2] / 1080
    y0 = int(min(y for _, y, _, _ in boxes) * scale) - 8
    y1 = int(max(y + h for _, y, _, h in boxes) * scale) + 8
    first = round(a * FPS)
    assert len(got) == round((b - a) * FPS)
    band_ref, band_got = ref[first:first + len(got), y0:y1], got[:, y0:y1]
    # not vacuous: the full video has caption text in the band on most of these frames
    assert sum(int((f > 200).sum()) > 200 for f in band_ref) >= len(got) // 2
    worst = min(_psnr(r, g) for r, g in zip(band_ref, band_got))
    assert worst >= 25.0, f"caption band of the window differs from the full video ({worst:.1f} dB)"
