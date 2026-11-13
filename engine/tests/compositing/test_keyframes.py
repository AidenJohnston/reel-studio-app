"""The player seeks by decoding from the keyframe before the target, so a final export keeps one at least
every second."""
from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

import fixtures as fx
from reelengine import render


@pytest.fixture(scope="module")
def take(tmp_path_factory):
    return fx.synth_video(tmp_path_factory.mktemp("keyframes media") / "take.mp4", dur=8.0)


def _probe(entries: str, mp4: Path) -> list:
    out = subprocess.run([fx.FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_entries", entries,
                          "-of", "csv=p=0", str(mp4)], capture_output=True, text=True, check=True).stdout
    return [line.split(",") for line in out.split()]


def test_final_export_has_a_keyframe_every_second(tmp_path, take):
    pdir = tmp_path / "p"
    fx.make_project(pdir, take, keep=((0.5, 7.5),))
    mp4 = Path(render.run(pdir, root=tmp_path, verify=False, cover=False)["file"])
    keys = [float(t) for t, flags in _probe("packet=pts_time,flags", mp4) if "K" in flags]
    end = float(_probe("stream=duration", mp4)[0][0])
    assert end > 5
    gaps = [b - a for a, b in zip(keys, keys[1:] + [end])]
    assert max(gaps) <= 1.0 + 1e-3
