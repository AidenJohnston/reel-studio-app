"""Close-up b-roll: photos read smaller than text, photos are cropped to their subject (and, when
that is what it takes to read, to the room's shape), text is never cropped through its words (only
its plain strips go: test_q3_split.py), and nothing placed covers the eyes-to-chin zone or the
captions. (status/issues-placement.md)"""
from __future__ import annotations

import json

import numpy as np
import pytest
from PIL import Image, ImageDraw

import fixtures as fx
from reelengine import broll, placement

W, H = 1080, 1920


def _photo(w, h, seed=0):
    """Continuous-tone stand-in for a photo: a smooth random colour field plus sensor noise."""
    rng = np.random.default_rng(seed)
    low = Image.fromarray(rng.integers(0, 255, (9, 12, 3), dtype=np.uint8)).resize((w, h), Image.BICUBIC)
    a = np.asarray(low).astype(np.float32) + rng.normal(0, 7, (h, w, 3))
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))


def _on_white(img, w, h):
    """A product shot: the subject in the middle of a big plain white ground."""
    bg = Image.new("RGB", (w, h), (255, 255, 255))
    bg.paste(img, ((w - img.width) // 2, (h - img.height) // 2))
    return bg


def _logo(w=800, h=800):
    im = Image.new("RGB", (w, h), (230, 40, 60))
    ImageDraw.Draw(im).ellipse([w // 4, h // 4, 3 * w // 4, 3 * h // 4], fill=(255, 240, 240))
    return im


@pytest.fixture(scope="module")
def synth(tmp_path_factory):
    return fx.synth_images(tmp_path_factory.mktemp("img"))


# --- what a still is ---------------------------------------------------------------------------

def test_content_kind_tells_text_logo_photo(synth):
    assert placement.content_kind(Image.open(synth["screenshot"])) == "text"
    assert placement.content_kind(_logo()) == "logo"
    assert placement.content_kind(_photo(1200, 800)) == "photo"


def test_iconic_param_pins_the_kind(tmp_path):
    p = tmp_path / "photo.png"
    _on_white(_photo(800, 600), 1000, 1000).save(p)
    assert broll._load_still(None, p)["content"] == "photo"
    as_text = broll._load_still(None, p, {"iconic": False})
    assert as_text["content"] == "text" and "crop" not in as_text and as_text["image"].size == (1000, 1000)
    assert broll._load_still(None, p, {"iconic": True})["content"] == "logo"


# --- the photo floor ---------------------------------------------------------------------------

def test_photo_floor_is_lower_than_text_floor():
    pf = placement.PHOTO_MIN_WIDTH
    assert 0.28 <= pf <= 0.35 < broll.UPPER_SIDE_MIN_WIDTH < broll.CARD_MIN_WIDTH
    assert broll.readable((pf + 0.01) * W, 300, W, H, iconic=False, params={}, photo=True)
    assert not broll.readable((pf - 0.02) * W, 300, W, H, iconic=False, params={}, photo=True)
    # text keeps 55% above the head / 40% beside the face
    assert not broll.readable(0.50 * W, 300, W, H, iconic=False, params={})
    assert not broll.readable(0.38 * W, 300, W, H, iconic=False, params={}, min_width=broll.UPPER_SIDE_MIN_WIDTH)
    # an explicit minWidth wins over the photo floor
    assert not broll.readable(0.40 * W, 300, W, H, iconic=False, params={"minWidth": 0.5}, photo=True)


def test_side_strip_reads_a_photo_but_not_a_text_card():
    z = [{"zone": "left", "x": 38, "y": 326, "w": 386, "h": 892},
         {"zone": "right", "x": 873, "y": 326, "w": 169, "h": 892},
         {"zone": "above-face", "x": 38, "y": 180, "w": 1004, "h": 300}]
    assert not broll.side_card_fit(z, "auto", 0.6, W, H, iconic=False)["ok"]
    assert broll.side_card_fit(z, "auto", 0.6, W, H, iconic=False, photo=True)["ok"]


# --- crop ----------------------------------------------------------------------------------------

def test_subject_crop_trims_a_plain_ground_around_a_photo():
    img = _on_white(_photo(400, 300), 1000, 1000)
    x0, y0, x1, y1 = placement.subject_box(img, "photo")
    assert 250 <= x0 <= 300 and 300 <= y0 <= 350 and 700 <= x1 <= 750 and 650 <= y1 <= 700


def test_a_small_subject_on_a_big_white_ground_is_a_logo_and_stays_whole():
    """A product shot / white app icon: judged on the whole image -> logo (icon floor), no crop."""
    img = _on_white(_photo(300, 240), 1000, 1000)
    assert placement.content_kind(img) == "logo"
    assert placement.subject_box(img, "logo") is None


def test_subject_crop_never_touches_text_or_logos_or_busy_photos(synth):
    img = _on_white(_photo(400, 300), 1000, 1000)
    assert placement.subject_box(img, "text") is None
    assert placement.subject_box(img, "logo") is None
    assert placement.subject_box(Image.open(synth["screenshot"]), "text") is None
    assert placement.subject_box(_photo(1200, 800), "photo") is None          # nothing empty to take


def test_load_still_crops_photos_only(tmp_path, synth):
    p = tmp_path / "product.png"
    _on_white(_photo(760, 560), 1000, 1000).save(p)
    st = broll._load_still(None, p)
    assert st["content"] == "photo" and st["crop"] and st["image"].width < 900
    assert "crop" not in broll._load_still(None, p, {"crop": False})
    txt = broll._load_still(None, synth["screenshot"])           # text: only its plain bottom strip goes
    assert txt["content"] == "text" and txt["image"].width == 1600 and txt["image"].height >= 700


def test_aspect_crop_moves_toward_the_room_and_keeps_most_of_the_photo():
    img = _photo(600, 1500)                                   # aspect 0.4, room wants 1.0
    x0, y0, x1, y1 = placement.aspect_crop(img, 1.0)
    assert (x1 - x0) == 600 and (y1 - y0) / 1500 >= 1 - placement.ASPECT_CROP_MAX_LOSS - 0.01
    assert (x1 - x0) / (y1 - y0) > 0.4
    assert placement.aspect_crop(_photo(800, 600), 800 / 600) is None


def test_aspect_crop_centres_on_the_detail():
    img = Image.new("RGB", (600, 1500), (128, 128, 128))
    img.paste(_photo(600, 300, seed=3), (0, 0))               # all the detail is at the top
    _x0, y0, _x1, _y1 = placement.aspect_crop(img, 1.0)
    assert y0 == 0


# --- end to end: placed and clear ----------------------------------------------------------------

@pytest.fixture(scope="module")
def video(tmp_path_factory):
    return fx.synth_video(tmp_path_factory.mktemp("media") / "take.mp4", dur=12.0)


def test_close_up_places_photos_and_keeps_eyes_and_captions_clear(tmp_path, video):
    """A close-up framed like day-16 (face off-centre, ~380 px left of the eyes-to-chin zone): a product shot and a
    tall photo used to split; now they place, readable, clear of the eyes-to-chin zone and the
    caption band. A square text post still splits (it can't read there)."""
    pdir = tmp_path / "p"
    fx.make_project(pdir, video, keep=((0.5, 11.5),))
    box = [400.0, 470.0, 360.0, 450.0]
    track = {"version": placement.TRACK_VERSION, "width": W, "height": H, "fps": 3.0, "detector": "test",
             "samples": [{"t": t / 3, "box": box, "core": placement.core_from_box(box), "score": 1.0}
                         for t in range(0, 36)], "median": box, "found": 1.0}
    (pdir / "work" / "face-s1.json").write_text(json.dumps(track), encoding="utf-8")
    media = pdir / "media"
    _on_white(_photo(1000, 720, seed=1), 1300, 1300).save(media / "product.png")
    _photo(420, 1050, seed=2).save(media / "tower.png")
    sq = Image.new("RGB", (1080, 1080), (30, 30, 36))
    d = ImageDraw.Draw(sq)
    from reelengine.compose_util import load_font
    for k in range(12):
        d.text((50, 60 + 80 * k), "Students build a new app, published today", font=load_font(44), fill="white")
    sq.save(media / "post.png")
    ctx = fx.make_ctx(pdir)
    items = []
    for k, (tname, name) in enumerate([("card-above-head", "product.png"), ("side-card", "tower.png"),
                                       ("card-above-head", "post.png")]):
        a, b = fx.word_near(ctx, 0.5 + 3.4 * k), fx.word_near(ctx, 2.6 + 3.4 * k)
        items.append({"id": f"b{k + 1}", "anchor": {"from": a, "to": b}, "treatment": tname,
                      "asset": f"media/{name}", "params": {}})
    fx.set_project(ctx, broll=items)
    broll.build_layers(ctx)
    recs = {r["id"]: r for r in json.loads((ctx.work / "layers" / "layers.json").read_text(encoding="utf-8"))["items"]}
    assert recs["b1"]["zone"] != "split-top" and recs["b1"]["content"] == "photo" and recs["b1"].get("crop")
    assert recs["b2"]["zone"] != "split-top" and recs["b2"]["content"] == "photo"
    for r in (recs["b1"], recs["b2"]):
        assert r["cardWidth"] >= placement.PHOTO_MIN_WIDTH - 0.005
    assert recs["b3"]["zone"] == "split-top"                  # text still needs its 55% / 40%
    assert broll.check_layers(ctx) == []                      # 0 eyes-to-chin, 0 caption overlaps
