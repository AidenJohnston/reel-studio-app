"""A range set to another camera of the same recording shows that camera, at the right moment, with the
main take's sound. Both cameras are made from one take: the other is its centre half, enlarged, starting
1 s later, with no sound."""
from __future__ import annotations

import shutil
import subprocess

import numpy as np

import fixtures as fx
from reelengine import project, render

W, H, FPS = 1080, 1920, 30
OFFSET = -1.0                          # the other camera started 1 s after the main one


def bar_at(t: float) -> float:         # the main take's bar: a white column sweeping right
    return 100 + 100 * t


def test_a_range_on_the_other_camera_shows_it_in_sync_and_keeps_the_main_sound(tmp_path):
    """Fails if the other camera is shown at the wrong moment (the offset's sign or size), the main
    camera is shown instead, or the sound switches to the other camera's (silent) track."""
    main = tmp_path / "main.mp4"
    subprocess.run([fx.FFMPEG, "-y", "-v", "error", "-f", "lavfi", "-i",
                    f"color=c=0x202020:s={W}x{H}:r={FPS}:d=8,drawbox=x='100+100*t':y=0:w=20:h={H}:color=white:t=fill",
                    "-f", "lavfi", "-i", "sine=f=220:d=8:sample_rate=48000",
                    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(main)],
                   check=True)
    other = tmp_path / "other.mp4"
    subprocess.run([fx.FFMPEG, "-y", "-v", "error", "-ss", f"{-OFFSET}", "-i", str(main), "-an",
                    "-vf", f"crop={W // 2}:{H // 2}:{W // 4}:{H // 4},scale={W}:{H}",
                    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", str(other)], check=True)
    pdir = tmp_path / "p"
    fx.make_project(pdir, main, keep=((0.5, 2.5), (4.0, 6.0)), extra={"captions": {"enabled": False}})
    shutil.copy2(other, pdir / "media" / "other.mp4")
    p = project.load(pdir)
    p["sources"].append({"id": "s2", "path": "media/other.mp4", "duration": 7.0, "fps": FPS, "width": W, "height": H,
                         "rotation": 0, "angleOf": {"source": "s1", "offset": OFFSET}})
    p["cut"]["keep"][1]["angle"] = "s2"
    project.save(pdir, p)
    res = render.run(pdir, draft=False, root=tmp_path, verify=False, cover=False)
    assert res["angles"][1]["angle"] == "s2" and res["angles"][0]["angle"] == "s1"
    seg = project.timeline(pdir, project.load(pdir)).segments[1]
    t = seg.out_start + 0.5
    raw = subprocess.run([fx.FFMPEG, "-v", "error", "-ss", f"{t:.3f}", "-i", res["file"], "-frames:v", "1",
                          "-vf", f"crop={W}:1:0:{H // 2},format=gray", "-f", "rawvideo", "-"], capture_output=True, check=True).stdout
    row = np.frombuffer(raw[:W], np.uint8)
    lit = np.flatnonzero(row > 180)
    main_t = seg.src_start + 0.5
    expect = (bar_at(main_t) - W / 4) * 2          # the main take's bar, in the other camera's enlarged centre
    assert lit.size >= 30, "the bar is not enlarged: the main camera is shown"
    assert abs(lit.min() - expect) <= 8, f"bar at {lit.min()}, the other camera at that moment has it at {expect:.0f}"
    pcm = subprocess.run([fx.FFMPEG, "-v", "error", "-ss", f"{t:.3f}", "-t", "0.3", "-i", res["file"], "-vn", "-ac", "1",
                          "-f", "f32le", "-"], capture_output=True, check=True).stdout
    assert np.sqrt(np.mean(np.frombuffer(pcm, np.float32) ** 2)) > 0.01, "the sound went silent with the other camera"
