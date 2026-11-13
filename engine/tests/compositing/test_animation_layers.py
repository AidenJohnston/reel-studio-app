"""Animation layers (templates/animations output): a full-frame transparent qtrle .mov with a
`.anim.json` sidecar is overlaid at 0,0 as rendered, never pushed through a card treatment; and the
engine hands the AI the free region above the face + word times for one."""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

import fixtures as fx
from reelengine import broll


@pytest.fixture(scope="module")
def video(tmp_path_factory):
    return fx.synth_video(tmp_path_factory.mktemp("media") / "take.mp4", dur=12.0)


def _anim(path: Path, dur: float = 1.0, layout: str = "top", region=None) -> Path:
    """A stand-in for a rendered template: 1080x1920 qtrle/argb, a half-transparent box up top."""
    path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run([fx.FFMPEG, "-y", "-v", "error", "-f", "lavfi", "-i", f"color=c=black@0.0:s=1080x1920:r=30:d={dur}",
                    "-f", "lavfi", "-i", f"color=c=red:s=600x300:r=30:d={dur}",
                    "-filter_complex", "[0:v]format=argb[b];[b][1:v]overlay=240:250:format=auto,format=argb",
                    "-c:v", "qtrle", "-pix_fmt", "argb", str(path)], check=True)
    params = {"text": "x"}
    if region:
        params["region"] = region
    path.with_suffix(".anim.json").write_text(json.dumps(
        {"kind": "reelstudio-animation", "template": "big-quote", "params": params, "duration": dur,
         "layout": layout, "transparent": True}), encoding="utf-8")
    return path


def test_animation_is_overlaid_full_frame_and_held(tmp_path, video):
    pdir = tmp_path / "p"
    fx.make_project(pdir, video, keep=((1.0, 11.0),))
    ctx = fx.make_ctx(pdir)
    w0, w1 = fx.word_near(ctx, 2.0), fx.word_near(ctx, 4.5)
    region = broll.anim_context(ctx, w0, w1, 1.0)["region"]          # what the AI renders it into
    _anim(pdir / "work" / "assets" / "anim-big-quote-1.mov", dur=1.0, region=region)
    # asked for a card on purpose: an animation must never be shrunk into one
    item = {"id": "b1", "anchor": {"from": w0, "to": w1}, "leadIn": 0.13,
            "treatment": "card-above-head", "asset": "work/assets/anim-big-quote-1.mov", "params": {}}
    fx.set_project(ctx, broll=[item])
    layers = broll.build_layers(ctx)
    assert len(layers) == 1
    L = layers[0]
    assert (L.x, L.y, L.w, L.h, L.rotate_deg) == (0, 0, 1080, 1920, 0.0)
    assert L.t1 - L.t0 > 2.0                                   # the words run longer: last frame holds
    held = subprocess.run([fx.FFPROBE, "-v", "error", "-show_entries", "stream=codec_name,pix_fmt:format=duration",
                           "-of", "json", str(L.path)], capture_output=True, text=True).stdout
    info = json.loads(held)
    assert info["streams"][0]["codec_name"] == "qtrle" and float(info["format"]["duration"]) >= L.t1 - L.t0 - 0.05
    rec = json.loads((ctx.work / "layers" / "layers.json").read_text(encoding="utf-8"))["items"][0]
    assert rec["treatment"] == "animation" and rec["requested"] == "card-above-head"
    assert rec["bbox"] == [region["x"], region["y"], region["x"] + region["w"], region["y"] + region["h"]]
    assert not rec["faceHiding"]
    assert broll.check_layers(ctx) == []
    # rendered without a region, the templates' default top box reaches this (high) face: flagged
    rec2 = {**rec, "bbox": [50, 130, 1030, 720]}
    assert any("eyes-to-chin" in e for e in broll.check_layers(ctx, [rec2]))


def test_animation_leaves_with_its_line(tmp_path, video):
    pdir = tmp_path / "p"
    fx.make_project(pdir, video, keep=((1.0, 11.0),))
    ctx = fx.make_ctx(pdir)
    _anim(pdir / "work" / "assets" / "a.mov", dur=3.0, layout="full")
    w = fx.word_near(ctx, 2.0)
    fx.set_project(ctx, broll=[{"id": "b1", "anchor": {"from": w, "to": w}, "treatment": "animation",
                                "asset": "work/assets/a.mov", "params": {}}])
    L = broll.build_layers(ctx)[0]
    # one short word: held the readable minimum, not the whole 3 s over the next line
    assert L.t1 - L.t0 == pytest.approx(broll.STILL_MIN_HOLD, abs=0.05)
    rec = json.loads((ctx.work / "layers" / "layers.json").read_text(encoding="utf-8"))["items"][0]
    assert rec["faceHiding"] and rec["zone"] == "full"


def test_animation_runs_to_the_end_of_a_long_line(tmp_path, video):
    pdir = tmp_path / "p"
    fx.make_project(pdir, video, keep=((1.0, 11.0),))
    ctx = fx.make_ctx(pdir)
    _anim(pdir / "work" / "assets" / "a.mov", dur=3.0, layout="full")
    a, b = fx.word_near(ctx, 2.0), fx.word_near(ctx, 4.4)
    fx.set_project(ctx, broll=[{"id": "b1", "anchor": {"from": a, "to": b}, "treatment": "animation",
                                "asset": "work/assets/a.mov", "params": {}}])
    plan = broll.plan_windows(ctx)[0]
    L = broll.build_layers(ctx)[0]
    assert plan["t1"] > plan["t0"] + broll.STILL_MIN_HOLD          # the line is longer than 2 s
    assert L.t1 - L.t0 == pytest.approx(plan["t1"] - plan["t0"], abs=0.05)   # longer than 3 s: last frame holds
    assert plan["t1"] == pytest.approx(broll.word_end(ctx, b) + broll.ANIM_TAIL, abs=0.01)


def test_anim_context_gives_region_above_the_brows_and_word_times(tmp_path, video):
    pdir = tmp_path / "p"
    fx.make_project(pdir, video, keep=((1.0, 11.0),))
    ctx = fx.make_ctx(pdir)
    a, b = fx.word_near(ctx, 2.0), fx.word_near(ctx, 3.2)
    r = broll.anim_context(ctx, a, b)
    assert r["layout"] in ("top", "full")
    reg = r["region"]
    assert reg["y"] >= 0 and reg["y"] + reg["h"] <= 1920 and reg["w"] > 500
    _zones, face, frame = broll.zones_for(ctx, r["t0"], r["t1"])
    assert reg["y"] + reg["h"] <= frame["core"][1] + 1                     # ends above the eyes-to-chin zone
    assert r["words"][0]["id"] == a and r["words"][0]["t"] == pytest.approx(0.13, abs=0.01)
    assert [w["t"] for w in r["words"]] == sorted(w["t"] for w in r["words"])


def test_animation_treatment_without_an_animation_is_skipped(tmp_path, video):
    pdir = tmp_path / "p"
    fx.make_project(pdir, video, keep=((1.0, 11.0),))
    ctx = fx.make_ctx(pdir)
    img = fx.synth_images(tmp_path / "img")["screenshot"]
    w = fx.word_near(ctx, 2.0)
    fx.set_project(ctx, broll=[{"id": "b1", "anchor": {"from": w, "to": w}, "treatment": "animation",
                                "asset": str(img), "params": {}}])
    assert broll.build_layers(ctx) == []
    rec = json.loads((ctx.work / "layers" / "layers.json").read_text(encoding="utf-8"))["items"][0]
    assert "animation" in rec["skipped"]


def test_animation_the_cut_moved_onto_the_face_asks_for_a_remake(tmp_path, video):
    """Known issue: an animation's box is fixed when it is made; re-cutting can put it on the face.
    The engine must say so in a way the AI can act on: layers.json and the render result's `broll`
    rows carry `remake` (plain words) + `clash`, and an animation that still fits carries neither."""
    from reelengine import render
    pdir = tmp_path / "p"
    fx.make_project(pdir, video, keep=((1.0, 11.0),))
    ctx = fx.make_ctx(pdir)
    w0, w1 = fx.word_near(ctx, 2.0), fx.word_near(ctx, 4.5)
    fits = broll.anim_context(ctx, w0, w1, 1.0)["region"]
    _anim(pdir / "work" / "assets" / "anim-ok.mov", dur=1.0, region=fits)
    # made for a framing where the free space was lower: after the re-cut it lands on the face
    _anim(pdir / "work" / "assets" / "anim-stale.mov", dur=1.0, region={"x": 50, "y": 700, "w": 980, "h": 420})
    w2, w3 = fx.word_near(ctx, 6.5), fx.word_near(ctx, 8.5)
    fx.set_project(ctx, broll=[
        {"id": "ok", "anchor": {"from": w0, "to": w1}, "treatment": "animation", "asset": "work/assets/anim-ok.mov", "params": {}},
        {"id": "stale", "anchor": {"from": w2, "to": w3}, "treatment": "animation", "asset": "work/assets/anim-stale.mov", "params": {}},
    ])
    broll.build_layers(ctx)
    recs = {r["id"]: r for r in json.loads((ctx.work / "layers" / "layers.json").read_text(encoding="utf-8"))["items"]}
    assert "remake" not in recs["ok"] and "clash" not in recs["ok"]
    assert "face" in recs["stale"]["clash"] and "your face" in recs["stale"]["remake"]
    rows = {r["id"]: r for r in render.read_broll_report(list(recs.values()))}
    assert rows["stale"]["remake"] and "face" in rows["stale"]["clash"]
    assert "remake" not in rows["ok"]
    # check_layers (the verify-side check) agrees with the flag
    errs = broll.check_layers(ctx)
    assert len(errs) == 1 and errs[0].startswith("stale")
