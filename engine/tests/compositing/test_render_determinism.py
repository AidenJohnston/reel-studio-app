"""The same project.json gives the same video: two full renders of one unchanged project have equal
video frames (framemd5).

The take is small, untagged (no colour matrix) and upscaled, the case that broke it on FFmpeg 8: the
final's lanczos scale also converts the take's matrix to the BT.709 the output is tagged with, and
that conversion, run on several threads, came out different on every render."""
import shutil
import subprocess
from pathlib import Path

import pytest

import fixtures as fx
from reelengine import render

has_ffmpeg = pytest.mark.skipif(shutil.which(fx.FFMPEG) is None and not Path(fx.FFMPEG).exists(),
                                reason="no ffmpeg")


def _video_md5(path: Path) -> list:
    out = subprocess.run([fx.FFMPEG, "-v", "error", "-i", str(path), "-map", "0:v", "-f", "framemd5", "-"],
                         capture_output=True, text=True, check=True).stdout
    return [ln for ln in out.splitlines() if not ln.startswith("#")]


def test_final_reframe_scales_on_one_thread():
    src = {"width": 360, "height": 640}
    assert "threads=1" in render.reframe_filter(src, 1080, 1920, None, draft=False)
    assert "threads=1" not in render.reframe_filter(src, 540, 960, None, draft=True)


@has_ffmpeg
def test_two_final_renders_have_equal_frames(tmp_path):
    take = tmp_path / "take.mp4"
    subprocess.run([fx.FFMPEG, "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=360x640:r=30:d=3",
                    "-f", "lavfi", "-i", "sine=f=220:d=3:sample_rate=48000",
                    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
                    str(take)], check=True)
    pdir = tmp_path / "proj"
    fx.make_project(pdir, take, keep=((0.1, 2.6),))
    ctx = fx.make_ctx(pdir)
    ctx.project["sources"][0].update(width=360, height=640)
    fx.set_project(ctx, cover={"atSourceTime": 1.0, "source": "s1", "text": None})
    md5s = []
    for i in range(2):
        res = render.run(pdir, draft=False, root=tmp_path / "root", verify=False, cover=False)
        assert res["encoder"] == "libx264"
        out = Path(res["file"])
        md5s.append(_video_md5(out))
        out.unlink()
    assert len(md5s[0]) >= 60
    assert md5s[0] == md5s[1]
