"""Close-up b-roll, fewer split views (status/q3-split.md): text cards cropped to their words (never
through them), the readable floor following the crop, card-above-head trying the over-the-hair spot
before the split, a tall photo cover-cropped there, and the raw face samples in the protected zone."""
from __future__ import annotations

import json

import numpy as np
import pytest
from PIL import Image, ImageDraw

import fixtures as fx
from reelengine import broll, placement
from reelengine.compose_util import load_font

W, H = 1080, 1920


def _photo(w, h, seed=0):
    rng = np.random.default_rng(seed)
    low = Image.fromarray(rng.integers(0, 255, (9, 12, 3), dtype=np.uint8)).resize((w, h), Image.BICUBIC)
    a = np.asarray(low).astype(np.float32) + rng.normal(0, 7, (h, w, 3))
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))


def _post(block=(200, 120, 60), photo=False, size=(1080, 1080)):
    """A text post: a headline and a byline on the left, then a block (flat colour or a photo)."""
    w, h = size
    im = Image.new("RGB", size, (250, 250, 248))
    d = ImageDraw.Draw(im)
    d.text((50, 40), "THE MORNING POST", font=load_font(56), fill=(20, 20, 20))
    d.text((50, 160), "Students build", font=load_font(110), fill=(20, 20, 20))
    d.text((50, 290), "a new app", font=load_font(110), fill=(20, 20, 20))
    d.text((50, 460), "Published Oct 16, 2026 - 4 min read", font=load_font(44, "semibold"), fill=(20, 20, 20))
    if photo:
        im.paste(_photo(w - 100, h - 610, seed=4), (50, 560))
    else:
        d.rectangle([50, 560, w - 50, h - 50], fill=block)
    return im


def _ink_kept(img, box) -> bool:
    """Every dark (text) pixel of a light card lies inside the crop."""
    g = np.asarray(img.convert("L"))
    ys, xs = np.nonzero(g < 120)
    x0, y0, x1, y1 = box
    return bool(((xs >= x0) & (xs < x1) & (ys >= y0) & (ys < y1)).all())


# --- text crop ---------------------------------------------------------------------------------

def test_text_box_drops_a_flat_block_and_margins_but_keeps_every_word():
    img = _post()
    box = placement.text_box(img)
    assert box is not None
    x0, y0, x1, y1 = box
    assert y1 < 600 and x1 < 1000                   # the flat block and the right margin went
    assert _ink_kept(img, box)


def test_text_box_never_crops_a_photo_away():
    """A post whose lower half is a PHOTO keeps it: only plain strips are dropped."""
    box = placement.text_box(_post(photo=True))
    assert box is None or box[3] >= 1080 - 60


def test_text_box_never_cuts_through_a_shape():
    """A wide button running off to the right: the right edge would cut through it, so it stays."""
    im = Image.new("RGB", (1200, 500), (20, 20, 24))
    d = ImageDraw.Draw(im)
    d.text((40, 40), "profile name", font=load_font(60), fill="white")
    d.text((40, 140), "75 posts  5,000 followers", font=load_font(40), fill="white")
    d.rounded_rectangle([40, 330, 1180, 420], 20, fill=(60, 60, 66))
    d.text((80, 350), "Edit profile", font=load_font(40), fill="white")
    box = placement.text_box(im)
    assert box is None or box[2] >= 1180


def test_text_box_leaves_a_full_card_alone(tmp_path):
    synth = fx.synth_images(tmp_path / "img")
    img = Image.open(synth["screenshot"])
    box = placement.text_box(img)
    assert box is None or ((box[2] - box[0]) == img.width and _ink_kept(img, box))


def test_load_still_crops_text_and_records_the_scale(tmp_path):
    p = tmp_path / "post.png"
    _post().save(p)
    st = broll._load_still(None, p)
    assert st["content"] == "text" and st.get("crop") and 0.7 < broll.text_scale(st) < 1.0
    assert broll._content_rec(st)["textScale"] == st["textScale"]
    whole = broll._load_still(None, p, {"crop": False})
    assert "crop" not in whole and broll.text_scale(whole) == 1.0


# --- the floor follows the crop ----------------------------------------------------------------

def test_text_floor_scales_with_the_crop_but_not_below_the_minimum():
    # cropped to 80% of its width: its words are as big at 44% as the whole card's at 55%
    assert broll.readable(0.445 * W, 300, W, H, iconic=False, params={}, tscale=0.8)
    assert not broll.readable(0.43 * W, 300, W, H, iconic=False, params={}, tscale=0.8)
    # a very narrow crop never goes below the minimum
    assert not broll.readable(0.25 * W, 300, W, H, iconic=False, params={}, tscale=0.3)
    assert broll.readable(broll.TEXT_MIN_WIDTH_FLOOR * W, 300, W, H, iconic=False, params={}, tscale=0.3)
    # an explicit minWidth wins
    assert not broll.readable(0.45 * W, 300, W, H, iconic=False, params={"minWidth": 0.5}, tscale=0.5)
    # uncropped text is unchanged: 55% above, 40% beside
    assert not broll.readable(0.54 * W, 300, W, H, iconic=False, params={})
    assert not broll.readable(0.39 * W, 300, W, H, iconic=False, params={}, min_width=broll.UPPER_SIDE_MIN_WIDTH)


def test_side_fit_text_floor_follows_the_crop():
    z = [{"zone": "left", "x": 38, "y": 326, "w": 420, "h": 892},
         {"zone": "above-face", "x": 38, "y": 180, "w": 1004, "h": 300}]
    assert not broll.side_card_fit(z, "left", 1.6, W, H, iconic=False)["ok"]
    assert broll.side_card_fit(z, "left", 1.6, W, H, iconic=False, tscale=0.85)["ok"]


# --- the protected zone takes the raw samples too -------------------------------------------------

def test_face_union_includes_raw_samples_of_the_same_face():
    core = [400.0, 600.0, 300.0, 400.0]
    raw = [400.0, 560.0, 300.0, 440.0]              # the head moved up; the median hasn't caught up
    far = [20.0, 20.0, 100.0, 100.0]                # a one-sample false detection elsewhere
    track = {"width": W, "height": H, "samples": [
        {"t": 0.0, "box": core, "core": core, "rawCore": raw},
        {"t": 0.33, "box": core, "core": core, "rawCore": far},
        {"t": 0.66, "box": core, "core": core}]}
    u = placement.face_union(track, 0.0, 0.66, "core")
    assert u[1] == 560.0                            # the raw brow line, higher than the median's
    assert u[0] == 400.0                            # the far false detection is ignored
    assert placement.face_union(track, 0.0, 0.66, "box")[1] == 600.0


def test_detect_faces_writes_raw_core(tmp_path):
    video = fx.synth_video(tmp_path / "take.mp4", dur=2.0)
    tr = placement.detect_faces(video)
    for s in tr["samples"]:
        assert "rawCore" not in s or len(s["rawCore"]) == 4


# --- end to end: a close-up that used to split ------------------------------------------------

@pytest.fixture(scope="module")
def video(tmp_path_factory):
    return fx.synth_video(tmp_path_factory.mktemp("media") / "take.mp4", dur=12.0)


def test_close_up_places_text_and_tall_photos_over_the_hair(tmp_path, video):
    """A centred close-up (brows at ~800 px, ~320 px strips beside the eyes-to-chin zone): a square
    text post with a flat block, a 4:5 one, and a tall photo as a side card used to split. Now: the
    posts are cropped to their words and placed (centred or over the hair on one side, said in the
    record), the tower is cover-cropped over the hair, nothing covers the eyes-to-chin zone or the
    captions. A tall phone screenshot full of text still splits (its words can't read anywhere)."""
    pdir = tmp_path / "p"
    fx.make_project(pdir, video, keep=((0.5, 11.5),))
    box = [330.0, 700.0, 420.0, 500.0]
    track = {"version": placement.TRACK_VERSION, "width": W, "height": H, "fps": 3.0, "detector": "test",
             "samples": [{"t": t / 3, "box": box, "core": placement.core_from_box(box), "score": 1.0}
                         for t in range(0, 36)], "median": box, "found": 1.0}
    (pdir / "work" / "face-s1.json").write_text(json.dumps(track), encoding="utf-8")
    media = pdir / "media"
    _post().save(media / "square.png")
    _post(size=(1080, 1350), block=(230, 200, 160)).save(media / "post45.png")
    _photo(414, 1024, seed=2).save(media / "tower.png")
    phone = Image.new("RGB", (1170, 2532), (255, 255, 255))
    d = ImageDraw.Draw(phone)
    for k in range(40):
        d.text((40, 40 + 62 * k), "Set 3  135 lb x 5  rest 90 s  next", font=load_font(44), fill=(20, 20, 20))
    phone.save(media / "phone.png")
    ctx = fx.make_ctx(pdir)
    items = []
    for k, (tname, name) in enumerate([("card-above-head", "square.png"), ("card-above-head", "post45.png"),
                                       ("side-card", "tower.png"), ("card-above-head", "phone.png")]):
        a, b = fx.word_near(ctx, 0.5 + 2.6 * k), fx.word_near(ctx, 2.4 + 2.6 * k)
        items.append({"id": f"b{k + 1}", "anchor": {"from": a, "to": b}, "treatment": tname,
                      "asset": f"media/{name}", "params": {}})
    fx.set_project(ctx, broll=items)
    broll.build_layers(ctx)
    recs = {r["id"]: r for r in json.loads((ctx.work / "layers" / "layers.json").read_text(encoding="utf-8"))["items"]}
    for bid in ("b1", "b2"):
        r = recs[bid]
        assert r["zone"].startswith("above-face") and r["content"] == "text" and r.get("crop"), r
        floor = broll.CARD_MIN_WIDTH if r["zone"] == "above-face" else broll.UPPER_SIDE_MIN_WIDTH
        assert r["cardWidth"] >= max(broll.TEXT_MIN_WIDTH_FLOOR, floor * r["textScale"]) - 0.005
        if r["zone"] != "above-face":               # moved and smaller: the render result says so
            assert "over the hair" in r["fallback"] and "fallbackTreatment" not in r
    assert recs["b3"]["zone"].startswith("above-face-") and recs["b3"].get("aspectCrop")
    assert recs["b3"]["cardWidth"] >= placement.PHOTO_MIN_WIDTH - 0.005
    assert recs["b4"]["zone"] == "split-top" and recs["b4"]["fallbackTreatment"] == "split-top"
    assert broll.check_layers(ctx) == []                      # 0 eyes-to-chin, 0 caption overlaps


def test_face_high_close_up_puts_a_text_card_over_the_hair_and_says_so(tmp_path, video):
    """Face high in the frame (~270 px above the brows, like a real take that split every text card):
    a cropped article can't read centred at its floor, so it goes a little smaller over the hair on
    one side; the record carries a plain-words `fallback` (the render result shows it) and its words
    are still as big as the whole article's at the side floor."""
    pdir = tmp_path / "p"
    fx.make_project(pdir, video, keep=((0.5, 11.5),))
    box = [330.0, 370.0, 420.0, 500.0]
    track = {"version": placement.TRACK_VERSION, "width": W, "height": H, "fps": 3.0, "detector": "test",
             "samples": [{"t": t / 3, "box": box, "core": placement.core_from_box(box), "score": 1.0}
                         for t in range(0, 36)], "median": box, "found": 1.0}
    (pdir / "work" / "face-s1.json").write_text(json.dumps(track), encoding="utf-8")
    _post(size=(1200, 900)).save(pdir / "media" / "article.png")
    ctx = fx.make_ctx(pdir)
    a, b = fx.word_near(ctx, 1.0), fx.word_near(ctx, 3.0)
    fx.set_project(ctx, broll=[{"id": "b1", "anchor": {"from": a, "to": b}, "treatment": "card-above-head",
                                "asset": "media/article.png", "params": {}}])
    broll.build_layers(ctx)
    r = json.loads((ctx.work / "layers" / "layers.json").read_text(encoding="utf-8"))["items"][0]
    assert r["zone"] in ("above-face-left", "above-face-right"), r
    assert "over the hair" in r["fallback"] and "fallbackTreatment" not in r
    assert r["cardWidth"] >= max(broll.TEXT_MIN_WIDTH_FLOOR, broll.UPPER_SIDE_MIN_WIDTH * r["textScale"]) - 0.005
    assert broll.check_layers(ctx) == []
