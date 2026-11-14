"""An HDR take keeps its colours in a split view's speaker half (broll._split_video through reframe_vf)."""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pytest

import fixtures as fx
from reelengine import render, tools

W, H = 360, 640


def _hlg_take(path: Path, dur: float = 8.0) -> Path:
    """One flat colour as a 10-bit HLG take, tagged as a phone tags it, with a tone for speech."""
    path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run([fx.FFMPEG, "-y", "-v", "error", "-f", "lavfi", "-i", f"color=c=0x8a5ac0:s={W}x{H}:r=30:d={dur}",
                    "-f", "lavfi", "-i", f"sine=f=220:d={dur}:sample_rate=48000", "-c:v", "libx264", "-preset", "ultrafast",
                    "-pix_fmt", "yuv420p10le", "-bsf:v",
                    "h264_metadata=colour_primaries=9:transfer_characteristics=18:matrix_coefficients=9",
                    "-c:a", "aac", "-shortest", str(path)], check=True)
    return path


def _rgb(video: Path, t: float) -> np.ndarray:
    raw = subprocess.run([fx.FFMPEG, "-v", "error", "-ss", f"{t:.3f}", "-i", str(video), "-frames:v", "1",
                          "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(H, W, 3).astype(float)


@pytest.mark.skipif("zscale" not in tools.filters(), reason="this FFmpeg has no zscale: HDR takes are not tone-mapped")
def test_a_split_views_speaker_half_has_the_colours_of_the_speaker_outside_it(tmp_path):
    # Fails if the speaker half of a split view reads the HDR take without the final's tone mapping: during the
    # card the speaker changes colour (Astra engine review 4).
    pdir = tmp_path / "p"
    fx.make_project(pdir, _hlg_take(tmp_path / "media" / "hlg.mp4"), keep=((0.2, 7.8),))
    shot = pdir / "work" / "assets" / "shot.png"
    shot.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(fx.synth_images(tmp_path / "img")["screenshot"], shot)
    pf = pdir / "project.json"
    proj = json.loads(pf.read_text(encoding="utf-8"))
    proj["format"] = {"width": W, "height": H, "fps": 30}
    proj["sources"][0].update(width=W, height=H, fps=30, hdr=True)
    proj["captions"]["enabled"] = False
    words = json.loads((pdir / "work" / "transcript.json").read_text(encoding="utf-8"))["words"]
    near = lambda t: min(words, key=lambda w: abs(w["s"] - t))["id"]     # noqa: E731
    proj["broll"] = [{"id": "b1", "anchor": {"from": near(4.0), "to": near(6.0)}, "leadIn": 0.13,
                      "treatment": "split-top", "asset": "work/assets/shot.png", "params": {}}]
    pf.write_text(json.dumps(proj, indent=1), encoding="utf-8")
    res = render.run(pdir, root=tmp_path, verify=False, cover=False, chunked=False)
    rec = next(r for r in json.loads((Path(res["versionDir"]) / "layers.json").read_text(encoding="utf-8"))["items"]
               if r["id"] == "b1")
    assert not rec.get("skipped"), rec
    band = slice(int(H * 0.86), int(H * 0.94))                    # the speaker half, under the card
    before = _rgb(Path(res["file"]), 1.0)[band].mean(axis=(0, 1))
    during = _rgb(Path(res["file"]), (rec["t0"] + rec["t1"]) / 2)[band].mean(axis=(0, 1))
    assert np.abs(before - during).max() <= 6, (before, during)
