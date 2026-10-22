"""Tests for A2's compositing modules: placement, broll, zoom, music, cover, assets.

Fast tests use generated media only. Tests marked `real` read real raw takes / music in
place (never copied) and skip when they are not on this machine. Network tests run only with
REELENGINE_NET_TESTS=1.
"""
from __future__ import annotations

import http.server
import json
import math
import os
import shutil
import subprocess
import threading
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

import fixtures as fx
from reelengine import assets, broll, cover, music, placement, zoom
from reelengine.compose_util import EngineError, word_start

W, H = 1080, 1920


# --- shared fixtures ---------------------------------------------------------------------------

@pytest.fixture(scope="session")
def media(tmp_path_factory):
    d = tmp_path_factory.mktemp("media dir ü")          # spaces + non-ASCII on purpose
    return {"video": fx.synth_video(d / "talk.mp4", dur=24.0), "clip": fx.synth_clip(d / "clip.mp4"),
            "song": fx.synth_tone_song(d / "song.wav"), **fx.synth_images(d / "img")}


def _ctx(tmp_path, video, keep=((1.0, 9.0), (12.0, 20.0)), **fields):
    pdir = tmp_path / "proj"
    fx.make_project(pdir, video, keep=keep)
    ctx = fx.make_ctx(pdir)
    if fields:
        fx.set_project(ctx, **fields)
    return ctx


def _item(ctx, i, t0, t1, treatment, asset=None, **params):
    return {"id": f"b{i}", "anchor": {"from": fx.word_near(ctx, t0), "to": fx.word_near(ctx, t1)},
            "leadIn": 0.13, "treatment": treatment, "asset": None if asset is None else str(asset),
            "params": params}


# --- placement ---------------------------------------------------------------------------------

def test_caption_band_and_zones_avoid_face():
    track = {"width": W, "height": H, "samples": [{"t": 0.0, "box": [330, 700, 420, 520]}]}
    frame = {"width": W, "height": H, "captionPosition": 0.70, "captionSize": 76}
    band = placement.caption_band(frame)
    assert band[0] < 0.70 * H < band[1]
    zones = placement.safe_boxes(track, 0.0, frame)
    names = {z["zone"] for z in zones}
    assert "above-face" in names
    cx, cy, cw, ch = placement.core_from_box([330, 700, 420, 520])      # eyes-to-chin (protected)
    core = (cx, cy, cx + cw, cy + ch)
    for z in zones:
        bb = (z["x"], z["y"], z["x"] + z["w"], z["y"] + z["h"])
        assert "face" not in placement.violates(bb, core, band), z
        assert "captions" not in placement.violates(bb, core, band), z
        assert z["y"] >= placement.TOP_CHROME * H - 1
    # cards may now cover the forehead: the top band reaches below the face box's top edge
    above = placement.zone(zones, "above-face")
    assert above["y"] + above["h"] > 700 + 0.12 * 520


def test_eyes_to_chin_zone_from_landmarks_and_box():
    box = [300.0, 600.0, 480.0, 700.0]
    # YuNet order: right eye, left eye, nose, right mouth, left mouth (x, y pairs)
    lm = [420, 850, 645, 850, 532, 975, 445, 1100, 620, 1100]
    c = placement.core_from_landmarks(box, lm)
    iod = 225
    assert c[1] == pytest.approx(850 - 0.5 * iod)                 # just above the brows
    assert c[1] > box[1] and c[1] + c[3] == pytest.approx(1300)   # forehead free; chin = box bottom
    assert c[0] == pytest.approx(420 - 0.4 * iod) and c[0] + c[2] == pytest.approx(645 + 0.4 * iod)
    f = placement.core_from_box(box)                              # no landmarks: proportions
    assert abs(f[1] - c[1]) < 0.06 * box[3] and abs(f[0] - c[0]) < 0.06 * box[2]
    tr = {"width": W, "height": H, "samples": [{"t": 0.0, "box": box}]}   # an old track (no "core")
    assert placement.face_at(tr, 0.0, "core") == pytest.approx(f)


def test_card_readable_floor():
    assert not broll.readable(0.50 * W, 300, W, H, iconic=False, params={})
    assert broll.readable(0.56 * W, 300, W, H, iconic=False, params={})
    assert broll.readable(0.25 * W, 0.25 * W, W, H, iconic=True, params={})        # a logo reads smaller
    assert broll.readable(0.30 * W, 200, W, H, iconic=False, params={"minWidth": 0.3})


def test_safe_boxes_without_face_is_nonempty():
    zones = placement.safe_boxes(None, 1.0, {"width": W, "height": H})
    assert zones and all(z["w"] > 0 and z["h"] > 0 for z in zones)


def test_face_track_interpolates():
    tr = {"width": W, "height": H, "samples": [{"t": 0.0, "box": [0, 0, 100, 100]},
                                               {"t": 1.0, "box": [100, 0, 100, 100]}]}
    assert placement.face_at(tr, 0.5)[0] == pytest.approx(50)
    u = placement.face_union(tr, 0.0, 1.0)
    assert u[0] == 0 and u[2] == pytest.approx(200)


@pytest.mark.real
def test_detect_faces_real_take(tmp_path):
    take = fx.real_take()
    if take is None:
        pytest.skip("real takes not on this machine")
    tr = placement.detect_faces(take, tmp_path / "face.json")
    assert tr["found"] >= 0.9
    assert tr["detector"] in ("yunet", "haar")
    x, y, w, h = tr["median"]
    assert 0 <= x < W and 0 < w < W and 0 < h < H
    assert json.loads((tmp_path / "face.json").read_text())["samples"]


# --- b-roll timing -----------------------------------------------------------------------------

def test_plan_windows_lead_hold_handoff(tmp_path, media):
    ctx = _ctx(tmp_path, media["video"])
    items = [_item(ctx, 1, 2.0, 2.4, "card-above-head", media["screenshot"]),     # short: held to 2 s
             _item(ctx, 2, 3.0, 5.0, "card-above-head", media["screenshot"]),     # starts inside b1
             _item(ctx, 3, 5.2, 6.0, "text-pop", text="hi")]                       # gap < 0.22 s
    fx.set_project(ctx, broll=items)
    plans = broll.plan_windows(ctx)
    assert [p["id"] for p in plans] == ["b1", "b2", "b3"]
    s1 = word_start(ctx, items[0]["anchor"]["from"])
    assert plans[0]["t0"] == pytest.approx(s1 - 0.13, abs=1e-6)
    assert plans[0]["t1"] == pytest.approx(plans[1]["t0"])                         # hard-cut handoff
    assert plans[1]["t1"] == pytest.approx(plans[2]["t0"])                         # gap closed
    assert all(p["t1"] <= ctx.duration + 1e-6 for p in plans)


def test_anchor_outside_cut_is_skipped(tmp_path, media):
    ctx = _ctx(tmp_path, media["video"])
    cut_word = next(w["id"] for w in ctx.words if 10.0 < w["s"] < 11.0)          # removed by the cut
    fx.set_project(ctx, broll=[{"id": "bx", "anchor": {"from": cut_word, "to": cut_word},
                                "treatment": "text-pop", "params": {"text": "x"}}])
    assert broll.plan_windows(ctx) == []
    assert broll.build_layers(ctx) == []


# --- b-roll treatments -------------------------------------------------------------------------

TREATMENTS = [
    ("card-above-head", "screenshot", {}),
    ("card-above-head", "clip", {}),
    ("full-frame", "clip", {}),
    ("full-frame", "portrait", {}),
    ("phone-card", "portrait", {}),
    ("side-card", "screenshot", {}),
    ("text-pop", None, {"text": "twenty bucks a week"}),
    ("post-wall", "posts", {}),
    ("icon-wall", None, {"items": ["logo-red", "logo-dark", "logo-green"]}),
    ("split-top", "screenshot", {}),
    ("split-top", "clip", {}),
]


@pytest.mark.parametrize("treatment,asset,params", TREATMENTS)
def test_treatment_layers(tmp_path, media, treatment, asset, params):
    ctx = _ctx(tmp_path, media["video"])
    if "items" in params:
        params = {"items": [str(media[k]) for k in params["items"]]}
    fx.set_project(ctx, broll=[_item(ctx, 1, 3.0, 5.0, treatment, media[asset] if asset else None, **params)])
    layers = broll.build_layers(ctx)
    assert layers, f"{treatment} produced no layers"
    rec = json.loads((ctx.work / "layers" / "layers.json").read_text())["items"][0]
    assert "skipped" not in rec, rec
    for L in layers:
        assert Path(L.path).exists()
        assert 0 <= L.x and 0 <= L.y and L.x + L.w <= W + 1 and L.y + L.h <= H + 1, L
        assert L.t1 > L.t0 and L.fade_in == 0 and L.fade_out == 0                 # hard cuts
        if L.kind == "image":
            assert Image.open(L.path).size == (L.w, L.h)
    assert broll.check_layers(ctx) == []                                          # off face + captions
    if treatment in ("card-above-head", "side-card", "text-pop") and rec.get("zone") not in ("split-top", "full"):
        x0, y0, x1, y1 = rec["bbox"]
        assert (x1 - x0) >= 0.25 * W, f"{treatment} too small to read: {rec['bbox']}"


def test_layers_are_cached(tmp_path, media):
    ctx = _ctx(tmp_path, media["video"])
    fx.set_project(ctx, broll=[_item(ctx, 1, 3.0, 5.0, "card-above-head", media["screenshot"])])
    a = broll.build_layers(ctx)
    m = Path(a[0].path).stat().st_mtime_ns
    b = broll.build_layers(fx.make_ctx(ctx.project_dir))
    assert a[0].path == b[0].path and Path(b[0].path).stat().st_mtime_ns == m


def test_missing_asset_is_skipped_with_user_message(tmp_path, media):
    ctx = _ctx(tmp_path, media["video"])
    fx.set_project(ctx, broll=[_item(ctx, 1, 3.0, 5.0, "card-above-head", tmp_path / "nope.png")])
    assert broll.build_layers(ctx) == []
    rec = json.loads((ctx.work / "layers" / "layers.json").read_text())["items"][0]
    assert "missing" in rec["skipped"].lower()


def test_post_wall_builds_one_tile_per_word(tmp_path, media):
    ctx = _ctx(tmp_path, media["video"])
    fx.set_project(ctx, broll=[_item(ctx, 1, 3.0, 6.0, "post-wall", media["posts"])])
    layers = broll.build_layers(ctx)
    tiles = [L for L in layers if L.w < W]
    assert len(tiles) == 6
    starts = [L.t0 for L in sorted(tiles, key=lambda L: L.z)]
    assert starts == sorted(starts) and len(set(starts)) == 6
    assert len({L.t1 for L in layers}) == 1                                       # all leave together


def test_treatment_templates_are_valid():
    specs = broll.list_treatments()
    assert {s["id"] for s in specs} == set(broll.TREATMENT_FNS)
    for s in specs:
        assert s.get("description") and isinstance(s.get("params"), dict)
        assert "—" not in s["description"]                                        # no em dashes in copy


# --- zoom --------------------------------------------------------------------------------------

def test_zoom_spans(tmp_path, media):
    ctx = _ctx(tmp_path, media["video"])
    fx.set_project(ctx, zooms=[{"anchor": {"from": fx.word_near(ctx, 2.0), "to": fx.word_near(ctx, 4.0)}, "scale": 1.2},
                               {"anchor": {"from": fx.word_near(ctx, 3.0), "to": fx.word_near(ctx, 5.0)}, "scale": 1.5},
                               {"anchor": {"from": fx.word_near(ctx, 7.0), "to": fx.word_near(ctx, 7.5)}, "scale": 9}])
    spans = zoom.build_zooms(ctx)
    assert len(spans) == 3
    assert spans[0].t1 == pytest.approx(spans[1].t0)                                # no overlap
    assert spans[2].scale == zoom.MAX_SCALE
    for s in spans:
        assert W / s.scale / 2 - 1e-6 <= s.cx <= W - W / s.scale / 2 + 1e-6
        assert H / s.scale / 2 - 1e-6 <= s.cy <= H - H / s.scale / 2 + 1e-6
    assert spans[0].t0 == pytest.approx(word_start(ctx, fx.word_near(ctx, 2.0)), abs=1 / 30)   # lands ON the word


def test_zoom_release_hides_under_full_frame(tmp_path, media):
    ctx = _ctx(tmp_path, media["video"])
    fx.set_project(ctx, zooms=[{"anchor": {"from": fx.word_near(ctx, 2.0), "to": fx.word_near(ctx, 3.0)}, "scale": 1.2}],
                   broll=[_item(ctx, 1, 3.0, 3.2, "full-frame", media["portrait"])])
    z = zoom.build_zooms(ctx)[0]
    p = broll.plan_windows(ctx)[0]
    assert z.t1 == pytest.approx(p["t1"])


@pytest.mark.parametrize("fps", [30, 24])
def test_snap_zoom_never_moves_across_a_cut(tmp_path, media, fps):
    """A snap zoom held over a cut keeps both eased ramps; one whose release would run across a cut
    releases on the cut instead, hidden by it. At 24 fps this cut and the zoom's end round to frames
    two apart."""
    ctx = _ctx(tmp_path, media["video"], keep=((0.0, 9.0), (10.0, 14.0), (15.0, 20.0)))
    ctx.fmt["fps"] = fps
    cut1, cut2 = (s.out_start for s in ctx.out_timeline[1:])
    fx.set_project(ctx, zooms=[
        {"anchor": {"from": fx.word_near(ctx, 2.0), "to": fx.word_near(ctx, cut1 - 0.3)}, "scale": 1.12, "style": "snap"},
        {"anchor": {"from": fx.word_near(ctx, cut2 - 2.0), "to": fx.word_near(ctx, cut2 + 1.5)}, "scale": 1.12,
         "style": "snap"}])
    ending, across = zoom.build_zooms(ctx)
    assert ending.t1 == pytest.approx(cut1, abs=0.5 / fps) and ending.ramp_out == 0 and ending.ramp_in > 0
    assert across.t0 < cut2 < across.t1 and across.ramp_in > 0 and across.ramp_out > 0
    assert across.t0 + across.ramp_in < cut2 < across.t1 - across.ramp_out


def test_snap_zoom_on_a_short_word_after_a_cut_still_shows(tmp_path, media):
    """The cut that starts a one-word line sits inside its release window: the zoom keeps its word
    and releases hard, as a default zoom does."""
    ctx = _ctx(tmp_path, media["video"], keep=((1.0, 9.0), (10.0, 14.0)))
    cut = ctx.out_timeline[1].out_start
    wid = fx.word_near(ctx, cut)
    tr = ctx.project_dir / "work" / "transcript.json"
    words = json.loads(tr.read_text())["words"]
    w = next(w for w in words if w["id"] == wid)
    w["e"] = round(w["s"] + 0.15, 3)
    tr.write_text(json.dumps({"words": words}))
    ctx = fx.make_ctx(ctx.project_dir)
    fx.set_project(ctx, zooms=[{"anchor": {"from": wid, "to": wid}, "scale": 1.12, "style": "snap"}])
    [z] = zoom.build_zooms(ctx)
    assert z.t0 == pytest.approx(cut, abs=0.5 / 30) and z.t1 == pytest.approx(cut + 0.2, abs=0.5 / 30)
    assert z.ramp_out == 0


# --- music -------------------------------------------------------------------------------------

def test_loudness_matches_ffmpeg(media):
    x = music.decode(media["song"])
    ours = music.integrated(x)
    ref = music.ffmpeg_measure(media["song"])["lufs"]
    assert ours == pytest.approx(ref, abs=0.3)


def _mix(tmp_path, media, level, automation=()):
    ctx = _ctx(tmp_path, media["video"])
    fx.set_project(ctx, music={"enabled": True, "track": str(media["song"]), "startAt": 1.0, "level": level,
                               "automation": list(automation), "fadeOut": 1.0})
    voice = fx.cut_voice(ctx, tmp_path / "voice.wav")
    out = music.build_audio(ctx, voice)
    return ctx, out, json.loads((ctx.work / "audio" / "mix.json").read_text())


@pytest.mark.parametrize("level,gap", [("under-voice", 19.0), ("quiet", 24.0), ("loud-intro", 19.0)])
def test_build_audio_levels(tmp_path, media, level, gap):
    ctx, out, rep = _mix(tmp_path, media, level)
    m = music.ffmpeg_measure(out)
    assert m["lufs"] == pytest.approx(-14.0, abs=1.0)
    assert m["truePeak"] <= -1.0
    assert not rep["clipped"]
    assert rep["music"]["measuredGapDb"] == pytest.approx(gap, abs=3.5)
    info = music.probe(out)
    assert info["duration"] == pytest.approx(ctx.duration, abs=0.1)


def test_build_audio_automation_lowers_music(tmp_path, media):
    _, _, base = _mix(tmp_path / "a", media, "under-voice")
    ctx = _ctx(tmp_path / "b", media["video"])
    auto = [{"fromWord": fx.word_near(ctx, 0.0), "toWord": fx.word_near(ctx, 19.0), "gainDb": -8}]
    _, _, low = _mix(tmp_path / "b", media, "under-voice", auto)
    assert low["music"]["measuredGapDb"] > base["music"]["measuredGapDb"] + 4


@pytest.mark.parametrize("extra", [2, -3])
def test_build_audio_music_off_by_samples(tmp_path, media, monkeypatch, extra):
    """The decoder can hand back a bed a few samples longer (or shorter) than the voice: the mix
    must still come out at the voice's exact length, with music in it."""
    real_decode = music.decode

    def decode(path, ctx=None, **kw):
        x = real_decode(path, ctx, **kw)
        if Path(path) == Path(media["song"]):
            x = np.pad(x, ((0, extra), (0, 0))) if extra > 0 else x[:extra]
        return x
    monkeypatch.setattr(music, "decode", decode)
    ctx, out, rep = _mix(tmp_path, media, "under-voice")
    voice = real_decode(tmp_path / "voice.wav")
    assert real_decode(out).shape[0] == voice.shape[0]
    assert rep["music"] and rep["music"]["measuredGapDb"] is not None


def test_fit_length():
    x = np.ones((10, 2), np.float32)
    assert music.fit_length(x, 8).shape == (8, 2)
    assert music.fit_length(x, 12).shape == (12, 2) and music.fit_length(x, 12)[-1].sum() == 0
    assert music.fit_length(np.ones(5), 7).shape == (7,)


def test_build_audio_voice_only(tmp_path, media):
    ctx = _ctx(tmp_path, media["video"])
    out = music.build_audio(ctx, fx.cut_voice(ctx, tmp_path / "voice.wav"))
    assert music.ffmpeg_measure(out)["lufs"] == pytest.approx(-14.0, abs=1.0)


def test_missing_song_is_a_user_error(tmp_path, media):
    ctx = _ctx(tmp_path, media["video"], music={"enabled": True, "track": "Library/Music/nope.mp3"})
    with pytest.raises(EngineError) as e:
        music.build_audio(ctx, fx.cut_voice(ctx, tmp_path / "voice.wav"))
    assert e.value.user_message


def test_analyze_track_tempo(media):
    r = music.analyze_track(media["song"])
    assert r["duration"] == pytest.approx(40.0, abs=0.2)
    bpm = r["bpm"]
    assert any(abs(bpm - k) / k < 0.04 for k in (60, 120, 240)), bpm
    gaps = np.diff(r["beats"])
    assert np.median(gaps) == pytest.approx(60 / bpm, rel=0.05)
    assert r["energy"] in ("calm", "medium", "energetic") and r["tags"]


@pytest.mark.real
def test_build_audio_real_take_and_song(tmp_path):
    take, song = fx.real_take(), fx.real_song()
    if take is None or song is None:
        pytest.skip("real media not on this machine")
    pdir = tmp_path / "p"
    fx.make_project(pdir, take, keep=((0.5, 30.0), (35.0, 60.0)))
    ctx = fx.make_ctx(pdir)
    fx.set_project(ctx, music={"enabled": True, "track": str(song), "startAt": 10.0, "level": "under-voice",
                               "automation": [], "fadeOut": 1.5})
    out = music.build_audio(ctx, fx.cut_voice(ctx, pdir / "voice.wav"))
    m = music.ffmpeg_measure(out)
    rep = json.loads((ctx.work / "audio" / "mix.json").read_text())
    assert m["lufs"] == pytest.approx(-14.0, abs=1.0)
    assert m["truePeak"] <= -1.0
    assert rep["music"]["measuredGapDb"] >= 16.0                                   # voice clearly on top


# --- cover -------------------------------------------------------------------------------------

def test_cover_synthetic(tmp_path, media):
    ctx = _ctx(tmp_path, media["video"], cover={"atSourceTime": 4.0, "source": "s1", "text": "Big words"})
    out = cover.render(ctx, tmp_path / "out" / "cover.png")
    im = Image.open(out)
    assert im.size == (W, H)
    info = json.loads((ctx.work / "cover.json").read_text())
    assert abs(info["chosen"] - 4.0) <= cover.SEARCH_HALF + 1e-6


@pytest.mark.real
def test_cover_real_take_picks_a_face(tmp_path):
    take = fx.real_take("2026-07-29_talkinghead_day-3-prompts.mp4")
    if take is None:
        pytest.skip("real takes not on this machine")
    pdir = tmp_path / "p"
    fx.make_project(pdir, take)
    ctx = fx.make_ctx(pdir)
    fx.set_project(ctx, cover={"atSourceTime": 12.0, "source": "s1", "text": None})
    cover.render(ctx, pdir / "cover.png")
    info = json.loads((ctx.work / "cover.json").read_text())
    assert info["best"]["det"] >= 0.8 and info["best"]["score"] > 0.5


# --- assets ------------------------------------------------------------------------------------

@pytest.fixture()
def http_dir(tmp_path):
    root = tmp_path / "srv"
    root.mkdir()
    Image.new("RGB", (64, 32), (200, 10, 10)).save(root / "a.webp")
    (root / "page.html").write_text("<!doctype html><html></html>")
    handler = lambda *a, **k: http.server.SimpleHTTPRequestHandler(*a, directory=str(root), **k)  # noqa: E731
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    th = threading.Thread(target=srv.serve_forever, daemon=True)
    th.start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()


def test_fetch_image_converts_webp(tmp_path, http_dir):
    out = assets.fetch_image(f"{http_dir}/a.webp", tmp_path / "dest ü")
    assert out.suffix == ".png" and Image.open(out).size == (64, 32)


def test_fetch_image_rejects_html(tmp_path, http_dir):
    with pytest.raises(EngineError) as e:
        assets.fetch_image(f"{http_dir}/page.html", tmp_path)
    assert e.value.code == "NOT_AN_IMAGE" and "picture" in e.value.user_message


def test_download_rejects_non_links(tmp_path):
    with pytest.raises(EngineError) as e:
        assets.download_media("not a link", tmp_path)
    assert e.value.code == "BAD_LINK"


def test_ytdlp_errors_are_plain_english():
    assert assets._ytdlp_message("ERROR: Private video. Sign in")[0] == "LOGIN_REQUIRED"
    assert assets._ytdlp_message("Unsupported URL: x")[0] == "UNSUPPORTED_LINK"


def test_user_agent_is_generic():
    for ua in (assets.API_UA, assets.BROWSER_UA):
        assert "@" not in ua


@pytest.mark.skipif(os.environ.get("REELENGINE_NET_TESTS") != "1", reason="network tests off")
def test_search_images_network():
    res = assets.search_images("mountain lake", 3)
    assert 1 <= len(res) <= 3 and all(r["url"].startswith("http") for r in res)


@pytest.mark.parametrize("w,h", [(1920, 1080), (1080, 1920), (1440, 1920), (720, 1280)])
def test_reframe_mirror_matches_render(tmp_path, media, w, h):
    """compose_util.reframe_rect must crop exactly like render.reframe_plan (unrotated sources)."""
    render = pytest.importorskip("reelengine.render")
    from reelengine.compose_util import reframe_rect
    ctx = _ctx(tmp_path, media["video"])
    ctx.project["sources"][0].update(width=w, height=h, rotation=0)
    pl = render.reframe_plan(ctx.project["sources"][0], W, H, None)
    assert reframe_rect(ctx, "s1") == (pl["rx"], pl["ry"], pl["rcw"], pl["rch"])


def test_text_pop_label_style_is_a_white_box_as_written(tmp_path, media):
    # hook titles and picture labels: dark words on a white box, not the big outlined caps
    ctx = _ctx(tmp_path, media["video"])
    fx.set_project(ctx, broll=[_item(ctx, 1, 2.0, 3.0, "text-pop", text="Why every gym feels the same", style="label", tilt=0),
                               _item(ctx, 2, 5.0, 6.0, "text-pop", text="twenty bucks")])
    layers = broll.build_layers(ctx)
    recs = {r["id"]: r for r in json.loads((ctx.work / "layers" / "layers.json").read_text(encoding="utf-8"))["items"]}
    assert recs["b1"]["text"] == "Why every gym feels the same"          # as written, not upper-cased
    assert recs["b2"]["text"] == "TWENTY BUCKS"                          # the default look is unchanged
    assert recs["b1"]["fontPx"] < recs["b2"]["fontPx"]
    img = np.asarray(Image.open(layers[0].path).convert("RGBA"))
    h, w = img.shape[:2]
    corner = img[int(h * 0.1), int(w * 0.03)]                            # inside the box, left of the text
    assert corner[3] == 255 and corner[:3].min() > 240                    # opaque white box
    assert (img[..., :3].max(axis=2) < 60).sum() > 500                   # dark type on it


# --- a re-anchored clip gets a fresh layer (0.1.2: a meme widened from one word to five kept its 0.6 s cut) ---

@pytest.mark.parametrize("treatment", ["full-frame", "side-card", "split-top"])
def test_reanchored_clip_layer_matches_its_new_window(tmp_path, media, treatment):
    ctx = _ctx(tmp_path, media["video"])
    longest = 0.0
    for t1 in (2.1, 5.0):                     # one word first, then a longer span, same b-roll id
        fx.set_project(ctx, broll=[_item(ctx, 1, 2.0, t1, treatment, media["clip"])])
        vids = [l for l in broll.build_layers(ctx) if l.kind == "video"]
        assert vids, treatment
        lay = vids[0]
        got = float(subprocess.run([fx.FFPROBE, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0",
                                    str(lay.path)], capture_output=True, text=True, check=True).stdout)
        assert got == pytest.approx(lay.t1 - lay.t0, abs=0.1), (treatment, t1, got, lay.t0, lay.t1)
        longest = max(longest, got)
    assert longest > 2.0
