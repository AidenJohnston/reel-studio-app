"""A project that keeps a 60 fps source: drafts and window previews render at 30 fps or under, so editing
is as fast as at 30, and only the final export keeps the source rate (render.preview_fps)."""
from __future__ import annotations

import json
import subprocess
from fractions import Fraction
from pathlib import Path

import pytest

import fixtures as fx
from reelengine import render, verify

W, H = 540, 960


def _rate(video: Path) -> Fraction:
    out = subprocess.run([fx.FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_entries",
                          "stream=avg_frame_rate", "-of", "csv=p=0", str(video)],
                         capture_output=True, text=True, check=True).stdout.strip()
    return Fraction(out)


@pytest.fixture(scope="module")
def take60(tmp_path_factory):
    path = tmp_path_factory.mktemp("fps60") / "take.mp4"
    subprocess.run([fx.FFMPEG, "-y", "-v", "error", "-f", "lavfi", "-i", f"testsrc2=size={W}x{H}:rate=60:duration=4",
                    "-f", "lavfi", "-i", "sine=f=220:d=4:sample_rate=48000", "-c:v", "libx264", "-preset", "ultrafast",
                    "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(path)], check=True)
    return path


def _timing(rep: dict) -> dict:
    return {c["name"]: c["status"] for c in rep["checks"] if c["name"] in ("frame rate", "frame count", "duration")}


def _project(tmp_path: Path, video: Path) -> Path:
    pdir = tmp_path / "reel"
    fx.make_project(pdir, video, keep=((0.2, 3.5),), extra={"captions": {"enabled": False}})
    p = json.loads((pdir / "project.json").read_text(encoding="utf-8"))
    p["format"] = {"width": W, "height": H, "fps": 60}
    p["sources"][0].update(fps=60, width=W, height=H)
    (pdir / "project.json").write_text(json.dumps(p, indent=1), encoding="utf-8")
    return pdir


@pytest.mark.parametrize("fps, preview", [(60, 30), (60000 / 1001, 30000 / 1001), (50, 25), (48, 24), (40, 30),
                                          (30, 30), (30000 / 1001, 30000 / 1001), (25, 25), (24, 24)])
def test_previews_take_every_other_frame_from_48_fps_up_and_never_exceed_30(fps, preview):
    assert render.preview_fps(fps) == pytest.approx(preview)


def test_drafts_and_window_previews_render_at_30_and_the_final_at_the_project_rate(tmp_path, take60):
    pdir = _project(tmp_path, take60)
    draft = render.run(pdir, draft=True, root=tmp_path, cover=False, verify=False)
    assert _rate(Path(draft["file"])) == 30
    # the verify command checks a draft against the rate it was made at, not the project's
    assert set(_timing(verify.run(Path(draft["file"]))).values()) == {"PASS"}
    window = render.run(pdir, window="0.5:2.5", root=tmp_path, cover=False, verify=False)
    assert _rate(Path(window["file"])) == 30
    final = render.run(pdir, root=tmp_path, cover=False, verify=False)
    assert _rate(Path(final["file"])) == 60
    assert set(_timing(verify.run(Path(final["file"]))).values()) == {"PASS"}
