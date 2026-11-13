"""The preview copy (reelengine/proxy.py): drafts read it only when it is finished and matches the
take as it is now, and a draft from it shows the same frame at every moment as a draft from the
original. The takes here are small, so the copies are built with a smaller short side than 1080."""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import numpy as np
import pytest

import fixtures as fx
from reelengine import project as projmod, proxy, render


def _project(tmp: Path, video: Path, w: int, h: int, keep) -> Path:
    pdir = tmp / "proj"
    fx.make_project(pdir, video, keep=keep, extra={"captions": {"enabled": False}})
    proj = json.loads((pdir / "project.json").read_text(encoding="utf-8"))
    proj["sources"][0].update(width=w, height=h)
    (pdir / "project.json").write_text(json.dumps(proj, indent=1), encoding="utf-8")
    return pdir


@pytest.fixture(autouse=True)
def _software_previews(monkeypatch):
    """Software decode and encode, so a preview never takes the hardware retry (which reads the
    originals) and the two drafts compared are made the same way."""
    monkeypatch.setenv("REELENGINE_HWACCEL", "0")
    monkeypatch.setenv("REELENGINE_DRAFT_ENCODER", "libx264")


def _draft(pdir: Path) -> dict:
    return render.run(pdir, draft=True, root=pdir, verify=False, cover=False)


def _lumas(video: str) -> np.ndarray:
    """Mean brightness of each frame."""
    raw = subprocess.run([fx.FFMPEG, "-v", "error", "-i", video, "-vf", "scale=16:16,format=gray",
                          "-f", "rawvideo", "-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, 256).mean(axis=1)


def _counting_take(path: Path, offset: float) -> Path:
    """A frame's brightness counts its index (step 7), its times are off the 30 fps grid (VFR), and
    the video starts `offset` s after the sound, as in phone files whose audio leads the picture."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name("video-only.mp4")
    vf = ("color=c=black:s=64x36:r=30:d=7,format=yuv420p,geq=lum='16+mod(N*7\\,200)':cb=128:cr=128,"
          "scale=1280:720:flags=neighbor,settb=1/600,setpts='(N+0.4*mod(N\\,3))/30/TB'")
    subprocess.run([fx.FFMPEG, "-y", "-v", "error", "-f", "lavfi", "-i", vf, "-fps_mode", "passthrough",
                    "-enc_time_base", "1:600", "-c:v", "libx264", "-preset", "ultrafast", "-qp", "4",
                    str(tmp)], check=True)
    subprocess.run([fx.FFMPEG, "-y", "-v", "error", "-itsoffset", str(offset), "-i", str(tmp), "-f", "lavfi",
                    "-i", f"sine=f=220:d={7.5 + offset}:sample_rate=48000", "-map", "0:v", "-map", "1:a", "-c:v", "copy",
                    "-c:a", "aac", str(path)], check=True)
    return path


# The cut decides how the take is opened (render.plan_lanes, 3 s preroll), which is checked first.
@pytest.mark.parametrize("offset,keep,opened", [
    (0.5, ((1.0, 3.0), (4.0, 6.0)), "from its start"),
    (1.0, ((3.45, 5.0), (5.5, 6.5)), "seeked to a time before its picture starts"),
    (0.5, ((3.85, 6.5),), "seeked past its picture's start"),
    (4.0, ((8.05, 10.0),), "seeked past a picture start later than the preroll"),
])
def test_a_draft_from_the_copy_shows_the_frames_a_draft_from_the_take_shows(tmp_path, offset, keep, opened):
    take = _counting_take(tmp_path / "media-src" / "take.mp4", offset)
    got_offset, times = proxy.frame_times(fx.FFPROBE, take)
    assert abs(got_offset - offset) < 0.05                               # the take is what it says
    assert len({round(b - a, 4) for a, b in zip(times, times[1:])}) > 1
    pdir = _project(tmp_path, take, 1280, 720, keep=keep)
    proj = projmod.load(pdir)
    seek = render.plan_lanes(projmod.timeline(pdir, proj).segments)[0]["seek"]
    assert {"from its start": seek == 0, "seeked to a time before its picture starts": 0 < seek < offset,
            "seeked past its picture's start": offset < seek < offset + render.SEEK_PREROLL,
            "seeked past a picture start later than the preroll": seek > offset > render.SEEK_PREROLL}[opened], seek
    from_take = _draft(pdir)
    assert from_take["videoFrom"] == {"s1": "original"}
    want = _lumas(from_take["file"])

    built = proxy.run(pdir, short_side=360)["sources"]["s1"]
    assert built["status"] == "built" and built["size"] == [640, 360]
    from_copy = _draft(pdir)
    assert from_copy["videoFrom"] == {"s1": "proxy"}
    got = _lumas(from_copy["file"])
    assert len(got) == len(want)
    # a frame early or late is 7 levels off; encoder noise on flat frames is well under 3
    assert np.abs(got - want).max() < 3, np.round(got - want, 1).tolist()


def test_a_preview_reads_the_take_unless_its_copy_is_finished_and_current(tmp_path):
    take = fx.synth_video(tmp_path / "media-src" / "take.mp4", dur=6.0)
    pdir = _project(tmp_path, take, 1080, 1920, keep=((1.0, 4.0),))
    assert _draft(pdir)["videoFrom"] == {"s1": "original"}          # no copy yet

    built = proxy.run(pdir, short_side=540)["sources"]["s1"]
    copy, sidecar = Path(built["file"]), Path(built["file"]).with_suffix(".json")
    assert _draft(pdir)["videoFrom"] == {"s1": "proxy"}
    assert render.run(pdir, draft=False, root=pdir, verify=False)["videoFrom"] == {"s1": "original"}
    assert proxy.run(pdir, short_side=540)["sources"]["s1"] == {"status": "ready"}

    data = copy.read_bytes()
    copy.write_bytes(data[: len(data) // 2])                              # cut short
    assert _draft(pdir)["videoFrom"] == {"s1": "original"}
    copy.write_bytes(data)
    side = sidecar.read_text(encoding="utf-8")
    sidecar.unlink()                                                     # copy written, sidecar not yet
    assert _draft(pdir)["videoFrom"] == {"s1": "original"}
    sidecar.write_text(side, encoding="utf-8")
    assert _draft(pdir)["videoFrom"] == {"s1": "proxy"}

    media = pdir / "media" / take.name                                   # the take is replaced
    media.unlink()
    fx.synth_video(tmp_path / "other" / "take.mp4", dur=6.5)
    os.link(tmp_path / "other" / "take.mp4", media)
    assert _draft(pdir)["videoFrom"] == {"s1": "original"}
    rebuilt = proxy.run(pdir, short_side=540)["sources"]["s1"]
    assert rebuilt["status"] == "built" and rebuilt["file"] != built["file"]
    assert not copy.exists() and not sidecar.exists()                    # the old copy is gone
    assert _draft(pdir)["videoFrom"] == {"s1": "proxy"}


def test_a_draft_whose_copy_fails_never_marks_its_encoder_failed(tmp_path, monkeypatch):
    """A preview from a damaged copy is made again from the take with the same encoder first. The
    retry used to switch encoder and input together, then save the GPU encoder as failed for days
    although only the copy was broken."""
    take = fx.synth_video(tmp_path / "media-src" / "take.mp4", dur=4.0)
    pdir = _project(tmp_path, take, 1080, 1920, keep=((0.5, 3.0),))
    copy = Path(proxy.run(pdir, short_side=540)["sources"]["s1"]["file"])
    monkeypatch.setattr(render.tools, "draft_encoder", lambda: "h264_nvenc")
    marked, runs = [], []
    monkeypatch.setattr(render.tools, "mark_encoder_failed", marked.append)

    def encode(cmd, dur, on_pct, **_):            # the copy can't be decoded; NVENC works
        from_copy = any(isinstance(a, str) and Path(a).name == copy.name for a in cmd)
        runs.append((cmd[cmd.index("-c:v") + 1], from_copy))
        if from_copy:
            raise render.EngineError("FFMPEG_FAILED", "Invalid data found when processing input", "x")
        Path(cmd[-1]).write_bytes(b"")
        return ""
    monkeypatch.setattr(render.tools, "ffmpeg_progress", encode)
    r = _draft(pdir)
    assert runs == [("h264_nvenc", True), ("h264_nvenc", False)]
    assert marked == [] and r["videoFrom"] == {"s1": "original"}


def test_a_take_is_copied_by_one_build_at_a_time(tmp_path):
    take = fx.synth_video(tmp_path / "media-src" / "take.mp4", dur=3.0)
    pdir = _project(tmp_path, take, 1080, 1920, keep=((0.5, 2.0),))
    lock = pdir / "work" / "proxy" / "s1.lock"
    lock.parent.mkdir(parents=True)
    other = proxy._take_lock(lock)                        # another build of this take is running
    assert proxy.run(pdir, short_side=540)["sources"]["s1"]["status"] == "busy"
    proxy._release_lock(other)                            # it finished or was killed
    assert proxy.run(pdir, short_side=540)["sources"]["s1"]["status"] == "built"


@pytest.mark.parametrize("rotation", [0, 90])
def test_the_face_moves_with_the_copy(rotation, monkeypatch):
    src = {"id": "s1", "width": 3840, "height": 2160, "rotation": rotation}
    disp_w, disp_h = (2160, 3840) if rotation else (3840, 2160)
    face = (disp_w * 0.25, disp_h * 0.5)
    meta, _, faces, used = proxy.for_preview(Path("."), {"s1": src}, {"s1": Path("take.mov")}, {"s1": face})
    assert used == {"s1": "original"} and faces["s1"] == face          # no copy: untouched
    monkeypatch.setattr(proxy, "lookup", lambda *_: {"file": Path("c.mp4"), "width": 1920, "height": 1080, "offset": 0.0})
    meta, _, faces, used = proxy.for_preview(Path("."), {"s1": src}, {"s1": Path("take.mov")}, {"s1": face})
    cw, ch = (1080, 1920) if rotation else (1920, 1080)
    assert used == {"s1": "proxy"} and faces["s1"] == pytest.approx((cw * 0.25, ch * 0.5))
    # the crop the draft makes from the copy is the crop it makes from the take, scaled
    full = render.reframe_plan(src, 540, 960, face)
    small = render.reframe_plan(meta["s1"], 540, 960, faces["s1"])
    k = 1920 / 3840
    assert abs(small["rx"] - full["rx"] * k) <= 2 and abs(small["ry"] - full["ry"] * k) <= 2
