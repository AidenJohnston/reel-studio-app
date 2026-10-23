"""Snap zooms (`zooms[].style: "snap"`), measured on rendered frames. Most tests use a take whose only
detail is one light box centred in the frame, so the zoom's scale is the box's width over its
unzoomed width. The face-drift test uses a take with a fine-grained patch where the face is."""
from __future__ import annotations

import json
import math
import subprocess

import numpy as np
import pytest
from PIL import Image

import fixtures as fx
from reelengine import render

W, H, FPS = 1080, 1920, 30
BOX_X, BOX_W = 324, 432
ROW = H // 2


@pytest.fixture(scope="module")
def renders(tmp_path_factory):
    d = tmp_path_factory.mktemp("snap zoom")
    take = d / "box.mp4"
    subprocess.run([fx.FFMPEG, "-y", "-v", "error", "-f", "lavfi", "-i",
                    f"color=c=0x404040:s={W}x{H}:r={FPS}:d=6,"
                    f"drawbox=x={BOX_X}:y={H // 2 - 288}:w={BOX_W}:h=576:color=0xe0e0e0:t=fill",
                    "-f", "lavfi", "-i", "sine=f=220:d=6:sample_rate=48000",
                    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
                    str(take)], check=True)
    out = {}
    for style in ("snap", None):
        pdir = d / (style or "default")
        fx.make_project(pdir, take, keep=((0.5, 5.5),))
        ctx = fx.make_ctx(pdir)
        z = {"anchor": {"from": fx.word_near(ctx, 1.0), "to": fx.word_near(ctx, 3.0)}, "scale": 1.12,
             "focus": [0.5, 0.5]}
        if style:
            z["style"] = style
        fx.set_project(ctx, zooms=[z], captions={"enabled": False})
        res = render.run(pdir, draft=False, root=d, verify=False, cover=False)
        frames = subprocess.run([fx.FFMPEG, "-v", "error", "-i", res["file"], "-vf", f"crop={W}:2:0:{ROW}",
                                 "-f", "rawvideo", "-pix_fmt", "gray", "-"], capture_output=True, check=True).stdout
        out[style] = {"rows": np.frombuffer(frames, np.uint8).reshape(-1, 2, W)[:, 0].astype(float),
                      "graph": (pdir / "work" / "render" / "graph_export.txt").read_text(encoding="utf-8")}
    return out


def _zoomed(rows):
    """(first, end) frames of the hard zoom: its line on the render's own clock."""
    on = [k for k, row in enumerate(rows) if _scale(row) > 1.05]
    return on[0], on[-1] + 1


def _edges(row):
    """(left, right) x where the row crosses halfway between background and box, to a fraction of a pixel."""
    mid = (row[:40].mean() + row[W // 2 - 20:W // 2 + 20].mean()) / 2
    above = np.flatnonzero(row > mid)
    a, b = above[0], above[-1]
    left = a - 1 + (mid - row[a - 1]) / (row[a] - row[a - 1])
    right = b + (row[b] - mid) / (row[b] - row[b + 1])
    return left, right


def _scale(row):
    left, right = _edges(row)
    return (right - left) / BOX_W


def _edge_width(row):
    """Pixels the left edge takes to climb from 10% to 90% of the way to the box."""
    lo, hi = row[:40].mean(), row[W // 2 - 20:W // 2 + 20].mean()
    seg = row[:W // 2]
    return np.argmax(seg > lo + 0.9 * (hi - lo)) - np.argmax(seg > lo + 0.1 * (hi - lo))


def test_snap_zoom_follows_its_curve(renders):
    rows = renders["snap"]["rows"]
    k0, k1 = _zoomed(renders[None]["rows"])
    s_end = W / (round(W / 1.12 / 2) * 2)

    # the shutter of frame k is centred a quarter frame in
    def punch(k):           # ease-out quart over 7 frames (0.22 s at 30 fps)
        return 1 - (1 - (k + 0.25) / 7) ** 4

    def release(k):         # critically damped spring, stiffness 7, over 9 frames (0.3 s)
        u = (k + 0.25) / 9
        return (1 - (1 + 7 * u) * math.exp(-7 * u)) / (1 - 8 * math.exp(-7))

    for k in (1, 2, 4):
        assert _scale(rows[k0 + k]) == pytest.approx(1 + (s_end - 1) * punch(k), abs=0.004), k
    for k in (1, 3):
        assert _scale(rows[k1 - 9 + k]) == pytest.approx(s_end - (s_end - 1) * release(k), abs=0.004), k
    assert _scale(rows[k0 - 1]) == pytest.approx(1.0, abs=0.002)
    assert _scale(rows[k1]) == pytest.approx(1.0, abs=0.002)


def test_snap_zoom_blurs_only_while_moving(renders):
    snap, hard = renders["snap"]["rows"], renders[None]["rows"]
    k0, _ = _zoomed(hard)
    sharp = _edge_width(hard[k0 + 20])
    assert _edge_width(snap[k0]) >= sharp + 3
    for k in (k0 + 8, k0 + 20, k0 + 40):
        assert _scale(snap[k]) == pytest.approx(_scale(hard[k]), abs=0.002)
        assert _edge_width(snap[k]) <= sharp + 1


def test_default_zoom_render_is_unchanged(renders):
    """The filters a zoom without `style` renders through, as on main before snap zooms."""
    zoom_chains = [c for c in renders[None]["graph"].split(";\n") if "zs0" in c or "zz0" in c]
    assert zoom_chains == [
        "[base0]split=2[zm0][zs0]",
        "[zs0]trim=start=0.933333:end=3.666667,setpts=PTS-STARTPTS,crop=964:1714:58:103,"
        "scale=1080:1920:flags=lanczos,setsar=1,fps=30.0,tpad=start=28[zz0]",
        "[zm0][zz0]overlay=0:0:eof_action=pass:repeatlast=0:enable='between(t,0.933333,3.666667)'[zb0]",
    ]


# The face box of the real take the snap zoom was checked on: left of centre, its eyes (EYE_BIAS above
# the box's middle) at (480, 960).
FACE = [380.0, 960 + 0.12 * 260 - 130, 200.0, 260.0]
ROI = (180, 780, 520, 600)          # x, y, w: every place the patch reaches during both zooms


@pytest.fixture(scope="module")
def face_render(tmp_path_factory):
    """One render of a take with a fine random patch on the face, and two snap zooms at scale 1.15 placed
    like the real-footage check: fixed point on the right edge (the eyes travel about 90 px, read as a
    quick dolly-in), then in the top-right corner (about 170 px, streaked the eyes)."""
    d = tmp_path_factory.mktemp("snap face")
    frame = np.full((H, W), 64, np.uint8)
    x, y, w, h = (int(round(v)) for v in FACE)
    blocks = np.random.default_rng(7).integers(40, 220, (h // 4 + 1, w // 4 + 1), dtype=np.uint8)
    frame[y:y + h, x:x + w] = np.kron(blocks, np.ones((4, 4), np.uint8))[:h, :w]
    Image.fromarray(frame).convert("RGB").save(d / "face.png")
    take = d / "face.mp4"
    subprocess.run([fx.FFMPEG, "-y", "-v", "error", "-loop", "1", "-framerate", str(FPS), "-i", str(d / "face.png"),
                    "-f", "lavfi", "-i", "sine=f=220:d=8:sample_rate=48000", "-t", "8",
                    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "8", "-pix_fmt", "yuv420p", "-c:a", "aac",
                    str(take)], check=True)
    pdir = d / "p"
    fx.make_project(pdir, take, keep=((0.5, 7.5),))
    samples = [{"t": t / 2, "box": FACE} for t in range(17)]
    (pdir / "work" / "face-s1.json").write_text(json.dumps(
        {"width": W, "height": H, "detector": "test", "samples": samples, "median": FACE}), encoding="utf-8")
    ctx = fx.make_ctx(pdir)
    zooms = [{"anchor": {"from": fx.word_near(ctx, a), "to": fx.word_near(ctx, b)}, "scale": 1.15,
              "focus": focus, "style": "snap"}
             for a, b, focus in ((1.0, 2.6, [1.0, 0.5]), (4.0, 5.6, [1.0, 0.0]))]
    fx.set_project(ctx, zooms=zooms, captions={"enabled": False})
    res = render.run(pdir, draft=False, root=d, verify=False, cover=False)
    rx, ry, rw, rh = ROI
    raw = subprocess.run([fx.FFMPEG, "-v", "error", "-i", res["file"], "-vf", f"crop={rw}:{rh}:{rx}:{ry}",
                          "-f", "rawvideo", "-pix_fmt", "gray", "-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, rh, rw).astype(float)


def _detail(img):
    """Mean step between neighbouring pixels: the patch's fine grain, which motion blur averages away."""
    return np.abs(np.diff(img, axis=1)).mean() + np.abs(np.diff(img, axis=0)).mean()


def test_snap_zoom_never_sweeps_the_face_from_a_corner(face_render):
    frames = face_render
    moved = [np.abs(f - frames[0]).mean() > 2 for f in frames]
    starts = [k for k in range(1, len(frames)) if moved[k] and not moved[k - 1]]
    assert len(starts) == 2, starts
    side, corner = starts

    # an off-centre face with the fixed point on the frame's side still snaps: its first frame is blurred
    assert _detail(frames[side]) < 0.6 * _detail(frames[side + 15])

    # with the fixed point in the corner it punches in hard: the face is already where the hold has it,
    # as sharp as the hold, from the zoom's first frame
    held = frames[corner + 15]
    for k in range(corner, corner + 8):
        assert _detail(frames[k]) > 0.9 * _detail(held), k
        assert np.abs(frames[k] - held).mean() < 1.5, k
