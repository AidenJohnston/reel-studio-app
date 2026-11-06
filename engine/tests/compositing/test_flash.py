"""A flash join dips the picture to white on its cut, in a draft and in a window around it."""
from __future__ import annotations

import subprocess
from pathlib import Path

import numpy as np
import pytest

import fixtures as fx
from reelengine import project, render


@pytest.fixture(scope="module")
def video(tmp_path_factory):
    return fx.synth_video(tmp_path_factory.mktemp("media") / "take.mp4", dur=12.0)


def brightness(video: Path, t: float) -> float:
    """Mean grey of the frame shown at t, 0..1."""
    raw = subprocess.run([fx.FFMPEG, "-v", "error", "-ss", f"{t:.3f}", "-i", str(video), "-frames:v", "1",
                          "-vf", "scale=32:56,format=gray", "-f", "rawvideo", "-"], capture_output=True, check=True).stdout
    return float(np.frombuffer(raw, np.uint8).mean()) / 255


@pytest.mark.needs_libass
def test_a_flash_join_whites_out_the_cut_and_nothing_else(tmp_path, video):
    """Fails if a flash join renders as a plain cut, lingers past its few frames, or a window draws it elsewhere."""
    pdir = tmp_path / "p"
    fx.make_project(pdir, video, keep=((1.0, 4.0), (7.0, 11.0)), extra={"captions": {"enabled": False}})
    p = project.load(pdir)
    p["cut"]["keep"][1]["join"] = {"transition": "flash", "frames": 0}
    project.save(pdir, p)
    tl = project.timeline(pdir, p)
    cut = tl.segments[1].out_start
    draft = render.run(pdir, draft=True, root=tmp_path, verify=False, cover=False)
    assert brightness(Path(draft["file"]), cut) > 0.9
    assert brightness(Path(draft["file"]), cut + 0.5) < 0.8
    assert brightness(Path(draft["file"]), cut - 0.5) < 0.8
    window = render.run(pdir, draft=True, window=f"{cut - 1:.3f}:{cut + 1:.3f}", root=tmp_path, verify=False, cover=False)
    assert brightness(Path(window["file"]), 1.0) > 0.9
    assert brightness(Path(window["file"]), 0.4) < 0.8
