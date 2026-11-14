"""The cards an editor uses every day (title, panel, logo row, phones, circle callout, a borrowed
clip in its own framing, receipt, crop and blur boxes, a card that joins another) and the rules
every card keeps: at least 2 s on screen, hard cuts, off the eyes-to-chin zone and the captions
(a phone demo excepted), inside the safe area, and no cut to another shot in a clip's first second."""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

import fixtures as fx
from reelengine import broll, placement, render

W, H = 1080, 1920


@pytest.fixture(scope="module")
def media(tmp_path_factory):
    d = tmp_path_factory.mktemp("cards media")
    cut = d / "cut-clip.mp4"            # a borrowed clip that cuts to another shot 0.4 s in
    subprocess.run([fx.FFMPEG, "-y", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=1280x720:r=30:d=0.4",
                    "-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30:d=4",
                    "-filter_complex", "[0:v][1:v]concat=n=2:v=1[v]", "-map", "[v]", "-c:v", "libx264",
                    "-preset", "ultrafast", "-pix_fmt", "yuv420p", str(cut)], check=True)
    return {"video": fx.synth_video(d / "talk.mp4", dur=24.0), "clip": fx.synth_clip(d / "clip.mp4"), "cut": cut,
            **fx.synth_images(d / "img")}


def _ctx(tmp_path, media):
    pdir = tmp_path / "proj"
    fx.make_project(pdir, media["video"], keep=((1.0, 20.0),))
    return fx.make_ctx(pdir)


def _item(ctx, i, t0, t1, treatment, asset=None, **params):
    return {"id": f"b{i}", "anchor": {"from": fx.word_near(ctx, t0), "to": fx.word_near(ctx, t1)},
            "leadIn": 0.13, "treatment": treatment, "asset": None if asset is None else str(asset), "params": params}


def _build(ctx, *items):
    fx.set_project(ctx, broll=list(items))
    layers = broll.build_layers(ctx)
    recs = json.loads((ctx.work / "layers" / "layers.json").read_text(encoding="utf-8"))["items"]
    return layers, {r["id"]: r for r in recs}


def _keeps_the_rules(ctx, layers, recs):
    for r in recs.values():
        assert "skipped" not in r, r
        assert r["t1"] - r["t0"] >= broll.MIN_HOLD - 0.01, r                     # read before it goes
        if not r["faceHiding"]:                                                  # the card itself (not its
            x0, y0, x1, y1 = r["bbox"]                                           # shadow) in the safe area
            assert y0 >= placement.TOP_CHROME * H - 1 and placement.SIDE_MARGIN * W - 1 <= x0 < x1 <= W * (1 - placement.SIDE_MARGIN) + 1, r
    for L in layers:
        assert Path(L.path).exists()
        assert L.fade_in == 0 and L.fade_out == 0                                # hard cuts
        assert 0 <= L.x and 0 <= L.y and L.x + L.w <= W + 1 and L.y + L.h <= H + 1, L
    assert broll.check_layers(ctx) == []                                         # off the face and captions


def test_title_card_fills_its_label_and_the_opening_hook_is_square(tmp_path, media):
    ctx = _ctx(tmp_path, media)
    hook = _item(ctx, 1, 0.0, 1.5, "title-card", text="I quit my job to do this")
    later = _item(ctx, 2, 6.0, 7.0, "title-card", text="Step two")
    layers, recs = _build(ctx, hook, later)
    _keeps_the_rules(ctx, layers, recs)
    assert recs["b1"]["hook"] is True and recs["b2"]["hook"] is False
    square, tilted = (np.asarray(Image.open(L.path).getchannel("A")) for L in layers)
    mid = square.shape[0] // 2
    assert square[mid, 1] > 0 and square[mid, -2] > 0 and square[1, square.shape[1] // 2] > 0   # square: edge to edge
    assert tilted[0, 0] == 0                                            # tilted: a rotated label's corner
    x0, _, x1, _ = recs["b1"]["bbox"]
    assert x1 - x0 >= 0.6 * W                                           # big enough to read at a glance


def test_panel_card_frames_a_screenshot_or_sets_words(tmp_path, media):
    ctx = _ctx(tmp_path, media)
    layers, recs = _build(ctx, _item(ctx, 1, 2.0, 3.0, "panel-card", media["screenshot"]),
                          _item(ctx, 2, 8.0, 9.0, "panel-card", text="Most people quit in the first week. "
                                                                    "The ones who stay do one thing."))
    _keeps_the_rules(ctx, layers, recs)
    img = np.asarray(Image.open(layers[0].path).convert("RGBA"))
    x0, y0, x1, y1 = (v - o for v, o in zip(recs["b1"]["bbox"], (layers[0].x, layers[0].y) * 2))
    assert (img[y0 + 4, (x0 + x1) // 2, :3] > 240).all()                 # the white frame round the screenshot
    assert "fontPx" in recs["b2"] and recs["b2"]["fontPx"] >= 0.03 * W


def test_logo_row_shows_logos_bare_and_a_lone_logo_with_its_name(tmp_path, media):
    ctx = _ctx(tmp_path, media)
    row = _item(ctx, 1, 2.0, 4.0, "logo-row", items=[str(media[k]) for k in ("logo-red", "logo-blue", "logo-green")])
    lone = _item(ctx, 2, 9.0, 10.0, "logo-row", items=[str(media["logo-gold"])], text="Gold")
    layers, recs = _build(ctx, row, lone)
    _keeps_the_rules(ctx, layers, recs)
    logos = [L for L in layers if L.z < 20]
    assert len(logos) == 3 and len({L.h for L in logos}) == 1           # one row, one height
    assert [L.t0 for L in logos] == sorted(L.t0 for L in logos) and logos[0].t0 < logos[-1].t0   # one per word
    assert np.asarray(Image.open(logos[0].path).getchannel("A"))[0, 0] == 0                   # no tile behind it
    assert recs["b2"]["name"] == "Gold" and recs["b2"]["layers"] == 2   # the lone logo has company


def test_phone_row_puts_phones_side_by_side_above_the_captions(tmp_path, media):
    ctx = _ctx(tmp_path, media)
    items = [str(media["portrait"]), str(media["clip"]), str(media["screenshot"])]
    layers, recs = _build(ctx, _item(ctx, 1, 2.0, 5.0, "phone-row", items=items))
    _keeps_the_rules(ctx, layers, recs)
    assert [L.kind for L in layers] == ["image", "video", "image"]
    assert recs["b1"]["faceHiding"]                                     # a phone demo may cover the face
    band = placement.caption_band(broll._frame(ctx))
    assert all(L.y + L.h <= band[0] and L.y >= placement.SAFE_TOP * H - 1 for L in layers)
    assert layers[0].x + layers[0].w < layers[1].x < layers[2].x        # side by side, left to right


def test_circle_callout_draws_its_loop_on_the_word_and_the_card_holds_still(tmp_path, media):
    ctx = _ctx(tmp_path, media)
    item = _item(ctx, 1, 2.0, 4.0, "circle-callout", media["screenshot"], circle=[0.02, 0.36, 0.64, 0.24],
                 circleAt=fx.word_near(ctx, 3.0))
    layers, recs = _build(ctx, item)
    _keeps_the_rules(ctx, layers, recs)
    bare, circled = layers
    assert (bare.x, bare.y, bare.w, bare.h) == (circled.x, circled.y, circled.w, circled.h)   # never jumps
    assert bare.t1 == circled.t0 == pytest.approx(broll.word_start(ctx, item["params"]["circleAt"]), abs=0.01)

    def red(path):
        a = np.asarray(Image.open(path).convert("RGB")).astype(int)
        return int(((a[..., 0] > 220) & (a[..., 1] < 90) & (a[..., 2] < 90)).sum())
    assert red(circled.path) > red(bare.path) + 2000


def test_wide_clip_keeps_its_framing_over_a_blur_and_skips_a_cut_in_its_first_second(tmp_path, media):
    ctx = _ctx(tmp_path, media)
    layers, recs = _build(ctx, _item(ctx, 1, 2.0, 4.0, "wide-clip", media["cut"]))
    _keeps_the_rules(ctx, layers, recs)
    rec = recs["b1"]
    assert rec["faceHiding"] and rec["in"] == pytest.approx(0.4, abs=0.1)   # starts after the cut to the test card
    fx_, fy, fw, fh = rec["clip"]
    band = placement.caption_band(broll._frame(ctx))
    assert fw == W and fy >= placement.SAFE_TOP * H - 1 and fy + fh <= band[0]
    frame = subprocess.run([fx.FFMPEG, "-v", "error", "-ss", "0.5", "-i", str(layers[0].path), "-frames:v", "1",
                            "-f", "rawvideo", "-pix_fmt", "gray", "-"], capture_output=True, check=True).stdout
    g = np.frombuffer(frame, np.uint8).reshape(H, W).astype(float)
    sharp, blurred = np.abs(np.diff(g[fy + 10:fy + fh - 10], axis=1)).mean(), np.abs(np.diff(g[50:fy - 50], axis=1)).mean()
    assert sharp > 4 * blurred and g[50:fy - 50].std() > 3               # a blurred copy of itself, not a flat colour


def test_receipt_carries_a_small_label_naming_its_source(tmp_path, media):
    ctx = _ctx(tmp_path, media)
    layers, recs = _build(ctx, _item(ctx, 1, 2.0, 4.0, "receipt", media["screenshot"], text="Example News"))
    _keeps_the_rules(ctx, layers, recs)
    card, label = layers
    assert recs["b1"]["label"] == "Example News"
    assert label.h < 0.1 * card.h * 2 and label.w < card.w                # small
    assert card.y <= label.y + label.h and label.y < card.y + 0.2 * card.h   # on the card's top edge
    assert (label.t0, label.t1) == (card.t0, card.t1)


def test_crop_and_blur_boxes_hide_what_the_editor_marked(tmp_path, media):
    ctx = _ctx(tmp_path, media)
    blur = [0.0, 0.18, 0.7, 0.2]                       # the "Premium plan" line
    src = broll._prepared_still(ctx, media["screenshot"], {"blurBoxes": [blur], "cropBox": [0.0, 0.1, 1.0, 0.6]})
    img = np.asarray(Image.open(src).convert("L")).astype(float)
    assert Image.open(src).size == (1600, 540)
    orig = np.asarray(Image.open(media["screenshot"]).convert("L")).astype(float)
    y0, y1 = int(0.18 * 900), int(0.38 * 900)
    region = img[y0 - 90:y1 - 90, :int(0.7 * 1600)]
    assert np.abs(np.diff(region, axis=1)).mean() < 0.25 * np.abs(np.diff(orig[y0:y1, :int(0.7 * 1600)], axis=1)).mean()
    layers, recs = _build(ctx, _item(ctx, 1, 2.0, 4.0, "card-above-head", media["screenshot"], blurBoxes=[blur]))
    _keeps_the_rules(ctx, layers, recs)
    assert broll._prepared_still(ctx, media["screenshot"], {}) == media["screenshot"]     # nothing marked: as is


def test_a_card_that_joins_stacks_on_the_first_and_they_leave_together(tmp_path, media):
    ctx = _ctx(tmp_path, media)
    first = _item(ctx, 1, 2.0, 3.0, "card-above-head", media["logo-red"])
    second = _item(ctx, 2, 3.0, 4.5, "card-above-head", media["logo-blue"], join=True)
    layers, recs = _build(ctx, first, second)
    _keeps_the_rules(ctx, layers, recs)
    a, b = recs["b1"], recs["b2"]
    assert b["joined"] == "b1" and a["t1"] == pytest.approx(b["t1"]) and a["t0"] < b["t0"] < a["t1"]
    assert b["bbox"] != a["bbox"] and (b["bbox"][2] - b["bbox"][0]) < (a["bbox"][2] - a["bbox"][0])  # smaller, offset


def test_a_card_never_cuts_the_one_on_screen_short(tmp_path, media):
    ctx = _ctx(tmp_path, media)
    layers, recs = _build(ctx, _item(ctx, 1, 2.0, 2.4, "card-above-head", media["screenshot"]),
                          _item(ctx, 2, 3.0, 3.4, "text-pop", text="next", fade=0.3))
    _keeps_the_rules(ctx, layers, recs)                 # params.fade is not honoured either: hard cuts
    assert recs["b2"]["t0"] == pytest.approx(recs["b1"]["t0"] + broll.MIN_HOLD, abs=0.01)
    assert recs["b1"]["t1"] == pytest.approx(recs["b2"]["t0"])


def test_every_new_card_renders_into_the_video(tmp_path, media):
    """One draft render with every new card in turn: each changes the picture while it is up."""
    ctx = _ctx(tmp_path, media)
    assets = ctx.project_dir / "work" / "assets"          # a render takes project paths only
    assets.mkdir(parents=True, exist_ok=True)

    def asset(k):
        shutil.copy2(media[k], assets / media[k].name)
        return f"work/assets/{media[k].name}"
    cards = [("title-card", None, {"text": "Three apps I use daily"}), ("panel-card", asset("screenshot"), {}),
             ("logo-row", None, {"items": [asset("logo-red"), asset("logo-green")]}),
             ("phone-row", None, {"items": [asset("portrait"), asset("portrait")]}),
             ("circle-callout", asset("screenshot"), {"circle": [0.02, 0.36, 0.64, 0.24]}),
             ("wide-clip", asset("clip"), {}), ("receipt", asset("screenshot"), {"text": "Example News"})]
    items = [_item(ctx, k + 1, 0.3 + 2.5 * k, 0.8 + 2.5 * k, t, a, **p) for k, (t, a, p) in enumerate(cards)]
    fx.set_project(ctx, broll=items)
    out = render.run(ctx.project_dir, draft=True)
    video = Path(out["file"]) if isinstance(out, dict) and out.get("file") else next(ctx.project_dir.glob("versions/*/export.mp4"))
    recs = {r["id"]: r for r in json.loads((ctx.work / "layers" / "layers.json").read_text(encoding="utf-8"))["items"]}

    def frame(t):
        raw = subprocess.run([fx.FFMPEG, "-v", "error", "-ss", f"{t:.2f}", "-i", str(video), "-frames:v", "1",
                              "-vf", "scale=270:480", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                             capture_output=True, check=True).stdout
        return np.frombuffer(raw, np.uint8).reshape(480, 270, 3).astype(int)
    bare = frame(recs["b1"]["t0"] - 0.2) if recs["b1"]["t0"] > 0.3 else frame(ctx.duration - 0.3)
    for k, (t, _a, _p) in enumerate(cards):
        r = recs[f"b{k + 1}"]
        assert "skipped" not in r, r
        diff = np.abs(frame((r["t0"] + r["t1"]) / 2) - bare).mean()
        assert diff > 3, f"{t} does not show in the render ({diff:.1f})"


def test_a_joined_group_leaves_together_and_the_next_card_waits_for_all_of_it(tmp_path, media):
    ctx = _ctx(tmp_path, media)
    long_first = _item(ctx, 1, 2.0, 8.0, "card-above-head", media["logo-red"])
    joined = _item(ctx, 2, 3.0, 4.0, "card-above-head", media["logo-blue"], join=True)
    after = _item(ctx, 3, 5.0, 6.0, "text-pop", text="next")
    plans = {p["id"]: p for p in broll.plan_windows(_set(ctx, long_first, joined, after))}
    a, b, c = plans["b1"], plans["b2"], plans["b3"]
    assert a["t1"] == b["t1"] == pytest.approx(c["t0"])                  # leave together, on the next card
    assert c["t0"] >= b["t0"] + broll.MIN_HOLD - 1e-6                    # ...once the joined card has been read


def _set(ctx, *items):
    fx.set_project(ctx, broll=list(items))
    return ctx


def test_short_clips_hold_their_last_frame_for_two_seconds(tmp_path, media):
    ctx = _ctx(tmp_path, media)
    short = fx.synth_clip(tmp_path / "short.mp4", dur=1.0)
    layers, recs = _build(ctx, _item(ctx, 1, 2.0, 2.4, "card-above-head", short))
    _keeps_the_rules(ctx, layers, recs)
    L = layers[0]
    assert L.t1 - L.t0 == pytest.approx(broll.MIN_HOLD, abs=0.01)
    held = subprocess.run([fx.FFPROBE, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(L.path)],
                          capture_output=True, text=True).stdout
    assert float(held) >= broll.MIN_HOLD - 0.05


def test_an_export_never_reuses_a_drafts_short_clip_card(tmp_path, media):
    ctx = _ctx(tmp_path, media)
    short = fx.synth_clip(tmp_path / "short.mp4", dur=1.0)
    item = _item(ctx, 1, 2.0, 2.4, "card-above-head", short)
    draft = broll.build_layers(_set(ctx, item))[0]
    final = broll.build_layers(fx.make_ctx(ctx.project_dir, draft=False))[0]
    assert draft.path != final.path                                     # full quality in the final


def test_item_pictures_get_the_blur_boxes_too(tmp_path, media):
    ctx = _ctx(tmp_path, media)
    item = _item(ctx, 1, 2.0, 4.0, "phone-row", items=[str(media["screenshot"]), str(media["portrait"])],
                 blurBoxes=[[0.0, 0.0, 1.0, 0.3]])
    paths = broll._items(ctx, broll.plan_windows(_set(ctx, item))[0], item["params"])
    assert all(p.name.startswith("still-") for p in paths)             # blurred copies, never the originals


def test_cards_that_cannot_read_say_so_instead_of_spilling(tmp_path, media):
    ctx = _ctx(tmp_path, media)
    essay = _item(ctx, 1, 2.0, 3.0, "panel-card", text="word " * 400)
    logos = _item(ctx, 2, 9.0, 10.0, "logo-row", items=[str(media[k]) for k in
                                                         ("logo-red", "logo-blue", "logo-green", "logo-gold", "logo-dark",
                                                          "logo-purple", "logo-red", "logo-blue", "logo-green")])
    layers, recs = _build(ctx, essay, logos)
    assert "fewer words" in recs["b1"]["skipped"]
    assert recs["b2"]["fallbackTreatment"] == "icon-wall"
    assert broll._unit_box([1.0, 0.0, 0.5, 0.5]) is None and broll._unit_box([0.9, 0.9, 0.5, 0.5]) is not None
