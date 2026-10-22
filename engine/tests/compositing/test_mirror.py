"""A mirrored take (`sources[].mirror`): the face picture is flipped left to right, last in its
chain, and every reader of the face box in OUTPUT pixels mirrors x to match. Captions, b-roll and
zooms are drawn on top and are never flipped."""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

import fixtures as fx
from reelengine import broll, cover, placement, project as projmod, render, tools, zoom
from reelengine.compose_util import map_box_rect, mirror_box, reframe_rect, reframe_vf

W, H = 1080, 1920
FACE = [120.0, 420.0, 300.0, 380.0]          # source px: well left of centre


def two_tone(path: Path, dur: float = 8.0) -> Path:
    """Grey frame; the TOP half is red on the left and blue on the right (so a flip is visible),
    the caption band is plain grey (so captions can be compared between flipped and unflipped)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        vf = (f"color=c=0x808080:s={W}x{H}:r=30:d={dur},"
              f"drawbox=x=0:y=0:w={W // 2}:h={H // 2}:color=0xd02020:t=fill,"
              f"drawbox=x={W // 2}:y=0:w={W // 2}:h={H // 2}:color=0x2020d0:t=fill")
        af = f"sine=f=220:d={dur}:sample_rate=48000"
        subprocess.run([fx.FFMPEG, "-y", "-v", "error", "-f", "lavfi", "-i", vf, "-f", "lavfi", "-i", af,
                        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
                        str(path)], check=True)
    return path


@pytest.fixture(scope="module")
def take(tmp_path_factory):
    return two_tone(tmp_path_factory.mktemp("mirror media") / "take.mp4")


def _project(tmp_path, video, mirror: bool | None, keep=((0.5, 6.5),), **extra):
    pdir = tmp_path / ("on" if mirror else "off")
    fx.make_project(pdir, video, keep=keep, extra=extra or None)
    p = json.loads((pdir / "project.json").read_text(encoding="utf-8"))
    if mirror is not None:
        p["sources"][0]["mirror"] = mirror
    (pdir / "project.json").write_text(json.dumps(p, indent=1), encoding="utf-8")
    # an off-centre face track (no detector run): the box sits on the LEFT of the source
    samples = [{"t": t / 2, "box": FACE, "core": [FACE[0] + 40, FACE[1] + 90, FACE[2] - 80, FACE[3] - 120]}
               for t in range(0, 17)]
    (pdir / "work" / "face-s1.json").write_text(json.dumps(
        {"width": W, "height": H, "detector": "test", "samples": samples}), encoding="utf-8")
    return pdir


def _rgb(png: Path, x: float, y: float) -> tuple:
    im = Image.open(png).convert("RGB")
    return im.getpixel((int(x * im.width), int(y * im.height)))


def _frame(mp4: Path, t: float, out: Path) -> Path:
    subprocess.run([fx.FFMPEG, "-y", "-v", "error", "-ss", f"{t:.3f}", "-i", str(mp4), "-frames:v", "1", str(out)],
                   check=True)
    return out


def _reddish(c) -> bool:
    return c[0] > 150 and c[2] < 100


def _bluish(c) -> bool:
    return c[2] > 150 and c[0] < 100


# --- the filter chains --------------------------------------------------------------------------

@pytest.mark.parametrize("src", [
    {"width": 1920, "height": 1080, "rotation": 0},
    {"width": 1920, "height": 1080, "rotation": 90},
    {"width": 1080, "height": 1920, "rotation": 0},
    {"width": 1440, "height": 1920, "rotation": 180},
])
@pytest.mark.parametrize("draft", [True, False])
def test_software_chain_flips_last_and_only_when_asked(src, draft):
    face = (700.0, 500.0)
    plain = render.reframe_filter(src, 540, 960, face, draft)
    assert "hflip" not in plain.replace("hflip,vflip", "")            # 180 turn only
    assert render.reframe_filter({**src, "mirror": False}, 540, 960, face, draft) == plain
    flipped = render.reframe_filter({**src, "mirror": True}, 540, 960, face, draft)
    assert flipped == plain + ",hflip"                                 # same crop, flip after the turn


@pytest.mark.parametrize("src", [{"width": 1920, "height": 1080, "rotation": 0},
                                 {"width": 1080, "height": 1920, "rotation": 90}])
def test_cuda_chain_flips_last_and_only_when_asked(src):
    pre, seg = render.gpu_reframe(src, 540, 960, None)
    assert "hflip" not in seg and seg.endswith("format=yuv420p")
    pre2, seg2 = render.gpu_reframe({**src, "mirror": True}, 540, 960, None)
    assert pre2 == pre                                                 # the GPU pre-chain is untouched
    assert seg2 == seg[: -len("format=yuv420p")] + "hflip,format=yuv420p"


def test_only_a_real_true_counts():
    for v in (None, False, 0, "yes", 1):
        assert not render.is_mirrored({"mirror": v})
    assert render.is_mirrored({"mirror": True})
    assert not render.is_mirrored({})


def test_schema_accepts_the_flag_and_old_projects(tmp_path, take):
    pdir = _project(tmp_path, take, None)
    proj = projmod.load(pdir)
    assert "mirror" not in proj["sources"][0] and not projmod.validate(proj)
    proj["sources"][0]["mirror"] = True
    assert not projmod.validate(proj)
    proj["sources"][0]["mirror"] = "yes"
    assert any("mirror" in p for p in projmod.validate(proj))


def test_mirror_changes_the_edit_signature(tmp_path, take):
    """A flip is a different video: it must get a new version number, never overwrite one."""
    a = projmod.load(_project(tmp_path, take, False))
    b = json.loads(json.dumps(a))
    b["sources"][0]["mirror"] = True
    assert projmod.edit_signature(a) != projmod.edit_signature(b)


# --- face box in output pixels -------------------------------------------------------------------

def test_map_box_rect_mirrors_x_after_the_crop():
    rect = (420, 0, 1080, 1920)                       # a landscape source cropped to 9:16
    box = (500.0, 300.0, 200.0, 260.0)
    x, y, w, h = map_box_rect(box, rect, W, H)
    mx, my, mw, mh = map_box_rect(box, rect, W, H, mirror=True)
    assert (my, mw, mh) == (y, w, h)
    assert mx == pytest.approx(W - x - w)
    assert mirror_box(mirror_box((x, y, w, h), W), W) == pytest.approx((x, y, w, h))


def test_output_face_and_zones_follow_the_flip(tmp_path, take):
    off = fx.make_ctx(_project(tmp_path, take, False))
    on = fx.make_ctx(_project(tmp_path, take, True))
    f0, c0 = broll.output_faces(off, 1.0, 2.0)
    f1, c1 = broll.output_faces(on, 1.0, 2.0)
    assert f0[0] + f0[2] / 2 < W / 2 < f1[0] + f1[2] / 2             # left of centre -> right of centre
    for a, b in ((f0, f1), (c0, c1)):
        assert b[0] == pytest.approx(W - a[0] - a[2]) and b[1:] == pytest.approx(a[1:])
    # the roomy side of the frame swaps with it
    z0, _, _ = broll.zones_for(off, 1.0, 2.0)
    z1, _, _ = broll.zones_for(on, 1.0, 2.0)
    side = lambda zs, n: (placement.zone(zs, n) or {}).get("w", 0)
    assert side(z0, "right") > side(z0, "left")
    assert side(z1, "left") == side(z0, "right") and side(z1, "right") == side(z0, "left")


def test_side_card_goes_to_the_open_side_of_the_flipped_picture(tmp_path, take, media_logo):
    item = lambda ctx: {"id": "b1", "anchor": {"from": fx.word_near(ctx, 1.0), "to": fx.word_near(ctx, 3.0)},
                        "leadIn": 0.13, "treatment": "side-card", "asset": str(media_logo), "params": {}}
    xs = []
    for mirror in (False, True):
        ctx = fx.make_ctx(_project(tmp_path, take, mirror))
        fx.set_project(ctx, broll=[item(ctx)])
        layers = broll.build_layers(ctx)
        assert layers
        xs.append(layers[0].x + layers[0].w / 2)
    assert xs[0] > W / 2 > xs[1]          # face on the left -> card right; flipped -> card left


@pytest.fixture(scope="module")
def media_logo(tmp_path_factory):
    return fx.synth_images(tmp_path_factory.mktemp("mirror img"))["logo-red"]


def test_zoom_centre_follows_the_flip(tmp_path, take):
    spans = []
    for mirror in (False, True):
        ctx = fx.make_ctx(_project(tmp_path, take, mirror))
        fx.set_project(ctx, zooms=[{"anchor": {"from": fx.word_near(ctx, 1.0), "to": fx.word_near(ctx, 2.0)}, "scale": 1.3}])
        spans.append(zoom.build_zooms(ctx)[0])
    assert spans[1].cx == pytest.approx(W - spans[0].cx, abs=0.2) and spans[1].cy == pytest.approx(spans[0].cy)


def test_split_view_speaker_half_is_flipped_and_not_reused(tmp_path, take):
    ctx = fx.make_ctx(_project(tmp_path, take, True))
    assert reframe_vf(ctx, "s1").endswith(",hflip")
    ctx_off = fx.make_ctx(_project(tmp_path, take, False))
    assert "hflip" not in reframe_vf(ctx_off, "s1")
    assert reframe_rect(ctx, "s1") == reframe_rect(ctx_off, "s1")    # same window, flipped after


# --- cover ---------------------------------------------------------------------------------------

def test_cover_and_its_candidates_are_flipped_like_the_video(tmp_path, take):
    for mirror, left in ((False, _reddish), (True, _bluish)):
        ctx = fx.make_ctx(_project(tmp_path, take, mirror))
        png = cover.render(ctx, tmp_path / f"cover-{mirror}.png")
        assert left(_rgb(png, 0.1, 0.2)), (mirror, _rgb(png, 0.1, 0.2))
        cands = cover.candidates(ctx, "s1", [2.0], tmp_path / f"cands-{mirror}")
        for c in cands:      # the synthetic frame has no face: candidates may be empty, never unflipped
            assert left(_rgb(Path(c["file"]), 0.1, 0.2))
        fb = render.fallback_cover(ctx, ctx.project, projmod.timeline(ctx.project_dir, ctx.project),
                                   {"s1": ctx.project["sources"][0]},
                                   {"s1": projmod.source_path(ctx.project_dir, ctx.project["sources"][0])},
                                   {}, tmp_path / f"fallback-{mirror}.png")
        assert left(_rgb(fb, 0.1, 0.2))


# --- the real render: picture flipped, captions not ----------------------------------------------

@pytest.mark.parametrize("hw", ["software", "cuda"])
def test_render_flips_the_picture_but_not_the_captions(tmp_path, take, monkeypatch, hw):
    if hw == "cuda":
        if tools.hwaccel() != "cuda" or "scale_cuda" not in tools.filters():
            pytest.skip("no CUDA on this machine")
    else:
        monkeypatch.setattr(tools, "hwaccel", lambda: None)
    frames = {}
    for mirror in (False, True):
        pdir = _project(tmp_path / hw, take, mirror)
        res = render.run(pdir, draft=True, root=tmp_path, verify=False, cover=False)
        graph = (pdir / "work" / "render" / "graph_draft.txt").read_text(encoding="utf-8")
        assert ("scale_cuda" in graph) is (hw == "cuda")                            # the path under test
        assert ("hflip" in graph.replace("hflip,vflip", "")) is mirror
        frames[mirror] = np.asarray(Image.open(_frame(Path(res["file"]), 1.5, tmp_path / f"{hw}-{mirror}.png")).convert("RGB"),
                                    dtype=np.int16)
    off, on = frames[False], frames[True]
    h, w = off.shape[:2]
    assert _reddish(off[h // 5, w // 10]) and _bluish(off[h // 5, w - w // 10])
    assert _bluish(on[h // 5, w // 10]) and _reddish(on[h // 5, w - w // 10])        # the picture flipped
    band = slice(int(h * 0.60), int(h * 0.80))
    cap_off, cap_on = off[band], on[band]
    text = np.abs(cap_off - 128).max(axis=2) > 60
    assert text.mean() > 0.005                                                      # there IS a caption
    assert np.abs(cap_on - cap_off).mean() < 2.0                                   # ...drawn the same way
    assert np.abs(cap_off[:, ::-1] - cap_off).mean() > 4.0                         # ...and it is not symmetric
