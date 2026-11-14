"""Animations follow a re-cut (anim_timing): an animation's beats are anchored to its words, so a cut
that moves those words asks for the clip re-rendered with the beats on the same words (cached by
spec + timing), and the same cut never asks twice."""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

import fixtures as fx
from reelengine import anim_timing, broll

WORDS = [{"w": "Done", "t": 0.13, "e": 0.4}, {"w": "is", "t": 0.45, "e": 0.55}, {"w": "better", "t": 0.6, "e": 0.9},
         {"w": "than", "t": 0.95, "e": 1.1}, {"w": "perfect.", "t": 1.2, "e": 1.6}]


def test_word_matching_is_the_editors():
    # the same cases as ai/test/animations.test.ts: an unchanged cut must resolve to the same beats
    assert anim_timing.align_word_times("Done is better than perfect", WORDS) == [0.13, 0.45, 0.6, 0.95, 1.2]
    wt = anim_timing.align_word_times("Done is WAY better than perfect", WORDS)
    assert len(wt) == 6 and 0.45 < wt[2] < 0.6 and wt == sorted(wt)
    split = [{"w": "has", "t": 0.1}, {"w": "3", "t": 0.4}, {"w": ",000", "t": 0.6}, {"w": "users", "t": 0.9}]
    assert anim_timing.align_word_times("has 3,000 users", split) == [0.1, 0.4, 0.9]
    assert anim_timing.item_times(["Better", "Perfect"], WORDS) == [0.6, 1.2]
    assert anim_timing.phrase_time("than ever", WORDS) == 0.95
    assert anim_timing.beats("typing-terminal", {"text": "perfect code"}, WORDS) == {"typeAt": 1.2}
    assert anim_timing.beats("price-tag", {"value": "$5"}, WORDS) == {}


@pytest.fixture(scope="module")
def video(tmp_path_factory):
    return fx.synth_video(tmp_path_factory.mktemp("media") / "take.mp4", dur=12.0)


def _render_stand_in(path: Path, template: str, params: dict, dur: float = 6.0) -> Path:
    """What the app's template renderer writes: a 1080x1920 qtrle .mov + its .anim.json sidecar."""
    path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run([fx.FFMPEG, "-y", "-v", "error", "-f", "lavfi", "-i", f"color=c=black@0.0:s=1080x1920:r=30:d={dur}",
                    "-vf", "format=argb", "-c:v", "qtrle", "-pix_fmt", "argb", str(path)], check=True)
    path.with_suffix(".anim.json").write_text(json.dumps(
        {"kind": broll.ANIM_KIND, "template": template, "params": params, "duration": dur,
         "layout": params.get("layout", "top"), "transparent": True}), encoding="utf-8")
    return path


def _quote_item(ctx, a: str, b: str, asset: str) -> dict:
    return {"id": "b1", "anchor": {"from": a, "to": b}, "leadIn": 0.13, "treatment": "animation",
            "asset": asset, "params": {}}


def _made_on(ctx, a: str, b: str) -> tuple[dict, str]:
    """An animation made the way make_animation makes it, on this cut: (item, its quote text)."""
    text = " ".join(broll._word_text(ctx, w) for w in broll.word_ids_between(ctx, a, b))
    item = _quote_item(ctx, a, b, "work/assets/anim-big-quote-1.mov")
    params = anim_timing.resolve(ctx, item, {"template": "big-quote", "params": {"text": text}})
    _render_stand_in(ctx.project_dir / item["asset"], "big-quote", params)
    return item, text


def test_an_unchanged_cut_plays_the_animation_as_made(tmp_path, video):
    pdir = tmp_path / "p"
    fx.make_project(pdir, video, keep=((1.0, 11.0),))
    ctx = fx.make_ctx(pdir)
    item, _ = _made_on(ctx, fx.word_near(ctx, 2.0), fx.word_near(ctx, 4.5))
    fx.set_project(ctx, broll=[item])
    assert anim_timing.jobs(ctx) == []
    broll.build_layers(ctx)
    rec = json.loads((ctx.work / "layers" / "layers.json").read_text(encoding="utf-8"))["items"][0]
    assert "retime" not in rec


def test_a_recut_inside_the_animation_re_times_its_beats(tmp_path, video):
    pdir = tmp_path / "p"
    fx.make_project(pdir, video, keep=((1.0, 11.0),))
    ctx = fx.make_ctx(pdir)
    a, b = fx.word_near(ctx, 2.0), fx.word_near(ctx, 4.5)
    item, text = _made_on(ctx, a, b)
    made = json.loads((pdir / "work" / "assets" / "anim-big-quote-1.anim.json").read_text(encoding="utf-8"))["params"]

    # a nitpick elsewhere in the line: a second and a half cut out of the middle of the quote
    fx.make_project(pdir, video, keep=((1.0, 3.0), (4.6, 11.0)))
    ctx = fx.make_ctx(pdir)
    fx.set_project(ctx, broll=[item])
    jobs = anim_timing.jobs(ctx)
    assert len(jobs) == 1
    job = jobs[0]
    assert job["id"] == "b1" and job["template"] == "big-quote" and job["params"]["text"] == text
    # every word still kept lands on itself: the words after the cut come earlier, by the cut's length
    kept = broll.word_ids_between(ctx, a, b)
    t0 = broll.word_start(ctx, a) - 0.13
    first = broll.word_start(ctx, kept[0]) - t0
    assert job["params"]["wordTimes"][0] == pytest.approx(first, abs=0.002)
    assert job["params"]["wordTimes"][-1] < made["wordTimes"][-1] - 1.0
    assert Path(job["out"]) == anim_timing.retimed_path(ctx, "big-quote", job["params"])

    # not rendered yet: the old clip plays, and the record says so
    broll.build_layers(ctx)
    rec = json.loads((ctx.work / "layers" / "layers.json").read_text(encoding="utf-8"))
    assert rec["items"][0]["retime"] == "pending"
    assert Path(rec["layers"][0]["path"]).name == "anim-big-quote-1.mov"

    # once the app has rendered it, that clip plays and nothing is asked again
    _render_stand_in(Path(job["out"]), job["template"], job["params"])
    assert anim_timing.jobs(ctx) == []
    layers = broll.build_layers(ctx)
    rec = json.loads((ctx.work / "layers" / "layers.json").read_text(encoding="utf-8"))["items"][0]
    assert rec["retime"] == "retimed" and Path(layers[0].path) == Path(job["out"])


def test_the_same_cut_always_names_the_same_clip(tmp_path, video):
    pdir = tmp_path / "p"
    fx.make_project(pdir, video, keep=((1.0, 11.0),))
    ctx = fx.make_ctx(pdir)
    item, _ = _made_on(ctx, fx.word_near(ctx, 2.0), fx.word_near(ctx, 4.5))
    fx.make_project(pdir, video, keep=((1.0, 3.0), (4.6, 11.0)))
    ctx = fx.make_ctx(pdir)
    fx.set_project(ctx, broll=[item, {**item, "id": "b2"}])
    first = anim_timing.jobs(ctx)
    assert len(first) == 1                                  # two items on one spec + timing: one clip
    assert anim_timing.jobs(fx.make_ctx(pdir)) == first      # deterministic: same project, same clip


def test_a_recut_clip_is_made_at_the_project_rate(tmp_path, video):
    # Fails if a 60 fps project's re-timed clip is asked for at another rate, or if one name serves both
    # rates: a draft runs at the preview rate (render.preview_fps), the clip must not follow it.
    pdir = tmp_path / "p"
    fx.make_project(pdir, video, keep=((1.0, 11.0),))
    ctx = fx.make_ctx(pdir)
    item, _ = _made_on(ctx, fx.word_near(ctx, 2.0), fx.word_near(ctx, 4.5))
    fx.make_project(pdir, video, keep=((1.0, 3.0), (4.6, 11.0)))
    named = {}
    for fps in (30, 60):
        ctx = fx.make_ctx(pdir)
        fx.set_project(ctx, broll=[item], format={**ctx.project["format"], "fps": fps})
        ctx.fmt["fps"] = 30                              # what a draft does to its context
        [job] = anim_timing.jobs(ctx)
        assert job["fps"] == fps
        named[fps] = job["out"]
    assert named[30] != named[60]


def test_readable_text_check_is_the_editors():
    # the same cases as ai/test/e2efix.test.ts (ai/src/readable.ts)
    assert anim_timing.hero_px("stat-count-up", {"value": "9", "text": "days"}, {"w": 1004, "h": 650}) > 250
    small = {"value": "9", "text": "people who signed up for the beta in the first week"}
    assert anim_timing.hero_px("stat-count-up", small, {"w": 300, "h": 160}) < anim_timing.min_hero_px("stat-count-up")
    assert not anim_timing.readable_above_face("stat-count-up", small, {"w": 300, "h": 160})
    assert anim_timing.readable_above_face("price-tag", {"value": "$5"}, {"w": 980, "h": 590})
    assert anim_timing.readable_above_face("not-a-template", {}, {"w": 10, "h": 10})


def test_a_recut_that_leaves_no_readable_room_above_the_face_goes_full_screen(tmp_path, video):
    pdir = tmp_path / "p"
    fx.make_project(pdir, video, keep=((1.0, 11.0),))
    ctx = fx.make_ctx(pdir)
    a, b = fx.word_near(ctx, 2.0), fx.word_near(ctx, 4.5)
    item = _quote_item(ctx, a, b, "work/assets/a.mov")
    essay = {"template": "big-quote", "params": {"text": "word " * 120}}
    params = anim_timing.resolve(ctx, item, essay)
    assert params["layout"] == "full" and "region" not in params
    pinned = anim_timing.resolve(ctx, item, {**essay, "params": {**essay["params"], "layout": "top"}})
    assert pinned["layout"] == "top" and "region" in pinned                  # the editor's choice stays


def test_a_clip_re_timed_after_a_version_was_saved_starts_a_new_version(tmp_path, video):
    from reelengine import render
    pdir = tmp_path / "p"
    proj = fx.make_project(pdir, video, keep=((1.0, 11.0),))
    before = render.asset_fingerprint(pdir, proj)
    _render_stand_in(pdir / "work" / "animations" / "big-quote-abc.mov", "big-quote", {"text": "x"})
    after = render.asset_fingerprint(pdir, proj)
    assert before != after and "work/animations/big-quote-abc.mov" in after


def test_an_editor_choice_of_full_screen_is_kept(tmp_path, video):
    pdir = tmp_path / "p"
    fx.make_project(pdir, video, keep=((1.0, 11.0),))
    ctx = fx.make_ctx(pdir)
    a, b = fx.word_near(ctx, 2.0), fx.word_near(ctx, 4.5)
    item = _quote_item(ctx, a, b, "work/assets/a.mov")
    params = anim_timing.resolve(ctx, item, {"template": "list-reveal",
                                             "params": {"items": ["word5 x", "word9 y"], "layout": "full"}})
    assert params["layout"] == "full" and "region" not in params and len(params["at"]) == 2
