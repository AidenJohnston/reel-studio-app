"""Checkable My style rules (lint.py): the strict schema, and each checker on fixed render data with
one right answer. tests/compositing/test_lint_render.py runs them on a real render."""
import json
from pathlib import Path

import pytest

from reelengine import lint
from reelengine.proto import EngineError

FMT = (1080, 1920)
SHARED = json.loads((Path(__file__).parent / "rule_checks.json").read_text(encoding="utf-8"))


def cue(text, size=105, s=1.0, e=2.0, lines=1):
    return {"s": s, "e": e, "text": text, "size": size, "lines": lines, "box": [300, 1300, 480, 120]}


def rules_file(*checks, stop=()):
    return {"version": 1, "rules": [{"id": f"r{i}", "text": f"Rule {i}.", "check": c} for i, c in enumerate(checks)],
            **({"stopOn": list(stop)} if stop else {})}


def run(*checks, cues=(), mix=None, broll=(), fmt=FMT, zooms=(), items=(), duration=20.0):
    rules, _ = lint.parse_rules(rules_file(*checks))
    return lint.lint(rules, cues=list(cues), fmt=fmt, mix={"music": None} if mix is None else mix,
                     broll=list(broll), duration=duration, zooms=list(zooms), items=list(items))


# --- the schema: anything it does not know is an error, never skipped --------------------------

def test_the_engine_and_the_app_agree_on_every_saved_form():
    # these forms are saved in people's My style files and sent by the app: renaming a kind breaks their rules
    for c in SHARED["valid"]:
        assert lint.parse_check(c) == c
    for c in SHARED["invalid"]:
        with pytest.raises(EngineError) as e:
            lint.parse_check(c)
        assert e.value.code == "BAD_RULE" and e.value.user_message


@pytest.mark.parametrize("check,problem", [
    ({"kind": "captions.color", "value": "#fff"}, "unknown kind 'captions.color'; known kinds: broll.cardHold"),
    ({"kind": "captions.maxWords", "value": 2, "zone": "eyes"}, "unknown field(s) zone for captions.maxWords"),
    ({"kind": "captions.maxWords", "value": 9}, "rules[0].check.value: must be between 1 and 4"),
])
def test_a_refused_check_is_named_in_the_error(check, problem):
    with pytest.raises(EngineError) as e:
        lint.parse_rules(rules_file(check))
    assert problem in e.value.message


@pytest.mark.parametrize("raw", [
    "not json", [], {"rules": []}, {"version": 2, "rules": []},
    {"version": 1, "rules": [{"id": "r1", "check": {"kind": "captions.maxWords", "value": 2}}]},
    {**rules_file({"kind": "captions.maxWords", "value": 2}), "extra": 1},
    {**rules_file({"kind": "captions.maxWords", "value": 2}), "stopOn": ["not-a-rule"]},
    {**rules_file({"kind": "captions.maxWords", "value": 2}), "stopOn": [{}]},
])
def test_a_rules_file_of_the_wrong_shape_is_refused(raw):
    with pytest.raises(EngineError) as e:
        lint.parse_rules(raw if isinstance(raw, str) else json.dumps(raw))
    assert e.value.code == "BAD_RULE"


def test_stop_on_names_rules_from_the_file():
    rules, stop = lint.parse_rules(rules_file({"kind": "captions.maxWords", "value": 2},
                                              {"kind": "broll.keepOut", "zone": "face"}, stop=["r1"]))
    assert [r["id"] for r in rules] == ["r0", "r1"] and stop == {"r1"}


# --- the checkers ---------------------------------------------------------------------------------

def test_max_words_fails_on_the_cue_with_too_many_words():
    rep = run({"kind": "captions.maxWords", "value": 2}, cues=[cue("two words"), cue("now three words", s=4.0, e=5.2)])
    assert not rep["ok"]
    assert rep["failures"] == [{"id": "r0", "kind": "captions.maxWords", "count": 1,
                                "places": [{"t0": 4.0, "t1": 5.2, "text": "now three words", "words": 3}]}]


def test_caption_sizes_are_read_at_1080_wide():
    # a 720-wide video draws a 105 px caption at 70 px: still 105 in the rule's units
    small = [cue("hello there", size=70)]
    for check, ok in [({"kind": "captions.maxSize", "value": 105}, True), ({"kind": "captions.minSize", "value": 105}, True),
                      ({"kind": "captions.maxSize", "value": 100}, False), ({"kind": "captions.minSize", "value": 110}, False)]:
        assert run(check, cues=small, fmt=(720, 1280))["ok"] is ok, check
    assert run({"kind": "captions.minSize", "value": 110}, cues=small, fmt=(720, 1280))["failures"][0]["places"][0]["px"] == 105


def test_no_captions_meet_every_caption_rule():
    assert run({"kind": "captions.maxWords", "value": 1}, {"kind": "captions.minSize", "value": 160}, cues=[])["ok"]


@pytest.mark.parametrize("mix,ok", [
    ({"music": {"measuredGapDb": 19.2}}, False),     # the under-voice level against a 22 dB rule
    ({"music": {"measuredGapDb": 21.1}}, True),      # within the 1 dB the mixer lands off its target
    ({"music": None}, True),                          # no music in this render
    ({"music": {"measuredGapDb": None}}, True),       # no speech found to sit over
    (None, False),                                    # the render could not say which mix it used
])
def test_music_under_voice_reads_the_measured_gap(mix, ok):
    rules, _ = lint.parse_rules(rules_file({"kind": "music.underVoiceDb", "value": 22}))
    rep = lint.lint(rules, cues=[], fmt=FMT, mix=mix, broll=[], duration=20.0)
    assert rep["ok"] is ok


FACE = [300.0, 500.0, 480.0, 600.0]        # x, y, w, h
EYES = [360.0, 650.0, 360.0, 380.0]


def shown(i, bbox=(0, 0, 1080, 400), hiding=False, treatment="card-above-head", t0=2.0, t1=4.0):
    return {"id": f"b{i}", "treatment": treatment, "t0": t0, "t1": t1, "faceHiding": hiding,
            "face": FACE, "protected": EYES, "bbox": list(bbox)}


def test_keep_out_eyes_allows_the_forehead_but_not_the_eyes():
    forehead = shown(1, (300, 300, 780, 600))      # ends at y 600: over the face box, above the eyes
    over_eyes = shown(2, (300, 300, 780, 700))
    [f] = run({"kind": "broll.keepOut", "zone": "eyes"}, broll=[forehead, over_eyes])["failures"]
    assert f["places"] == [{"t0": 2.0, "t1": 4.0, "item": "b2", "treatment": "card-above-head", "hides": False}]
    [f] = run({"kind": "broll.keepOut", "zone": "face"}, broll=[forehead])["failures"]
    assert f["places"][0]["item"] == "b1"


def test_keep_out_counts_a_full_frame_picture_and_skips_what_was_not_shown():
    check = {"kind": "broll.keepOut", "zone": "eyes"}
    [f] = run(check, broll=[shown(1, (0, 0, 1080, 1920), hiding=True, treatment="full-frame")])["failures"]
    assert f["places"][0]["hides"] is True
    assert run(check, broll=[{"id": "b2", "treatment": "side-card", "skipped": "no room"},
                             shown(3, (0, 1200, 300, 1500))])["ok"]


def test_the_report_names_every_rule_it_measured_including_ones_that_pass():
    rep = run({"kind": "captions.maxWords", "value": 2}, {"kind": "broll.keepOut", "zone": "face"}, cues=[cue("two words")])
    assert rep["ok"] and rep["checkedIds"] == ["r0", "r1"]


def test_a_failure_lists_at_most_five_places_and_the_full_count():
    cues = [cue("one two three", s=float(i), e=i + 0.5) for i in range(8)]
    [f] = run({"kind": "captions.maxWords", "value": 2}, cues=cues)["failures"]
    assert f["count"] == 8 and len(f["places"]) == 5


def test_the_measurements_describe_this_render_for_a_new_rule():
    forehead = shown(1, (300, 300, 780, 600))
    rep = run(cues=[cue("one two", size=70), cue("three", size=60)], fmt=(720, 1280),
              mix={"music": {"measuredGapDb": 23.4}}, broll=[forehead])
    assert rep["measured"] == {"captions.maxWords": 2, "captions.maxSize": 105.0, "captions.minSize": 90.0,
                               "music.underVoiceDb": 23.4, "broll.keepOut.face": 1, "broll.keepOut.eyes": 0}
    assert run()["measured"] == {"captions.maxWords": None, "captions.maxSize": None, "captions.minSize": None,
                                 "music.underVoiceDb": None, "broll.keepOut.face": 0, "broll.keepOut.eyes": 0}


# --- Reel Studio's default taste (ai/src/rules.ts DEFAULT_CHECKS) ---------------------------------

def test_clip_length_checks_footage_only_and_both_ends():
    check = {"kind": "broll.clipLength", "min": 0.5, "max": 1.5}
    items = [{"id": "b1", "asset": "Library/broll/run.mp4"}, {"id": "b2", "asset": "Library/broll/rain.MOV"},
             {"id": "b3", "asset": "Library/broll/ok.mp4"}, {"id": "b4", "asset": "Library/images/still.jpg"},
             {"id": "b5", "asset": "work/animations/count.mov"}]
    broll = [shown(1, t0=1.0, t1=3.0), shown(2, t0=4.0, t1=4.3), shown(3, t0=6.0, t1=7.48),
             shown(4, t0=8.0, t1=11.0), shown(5, treatment="animation", t0=12.0, t1=15.0)]
    [f] = run(check, broll=broll, items=items)["failures"]
    # a 2 s and a 0.3 s clip fail; 1.48 s rounds within a frame; a still and an animation are not clips
    assert [(p["item"], p["seconds"]) for p in f["places"]] == [("b1", 2.0), ("b2", 0.3)]


def test_card_hold_checks_every_visual_that_is_not_footage():
    check = {"kind": "broll.cardHold", "value": 2}
    items = [{"id": "b1", "asset": "Library/images/a.png"}, {"id": "b2"}, {"id": "b3", "asset": "Library/broll/c.mp4"},
             {"id": "b4", "asset": "Library/images/d.png"}]
    broll = [shown(1, t0=1.0, t1=2.2), shown(2, treatment="text-pop", t0=3.0, t1=4.97),
             shown(3, t0=6.0, t1=7.0), shown(4, t0=8.0, t1=10.5)]
    [f] = run(check, broll=broll, items=items)["failures"]
    # a card cut short at 1.2 s fails; 1.97 s is within a frame; a 1 s clip is footage, not a card
    assert f["places"] == [{"t0": 1.0, "t1": 2.2, "item": "b1", "seconds": 1.2}]


def test_unique_names_each_repeat_of_an_asset_but_not_text_cards():
    items = [{"id": "b1", "asset": "Library/images/a.png"}, {"id": "b2", "asset": "Library/images/a.png"},
             {"id": "b3"}, {"id": "b4"}, {"id": "b5", "asset": "Library/images/a.png"}]
    broll = [shown(1, t0=1.0, t1=3.0), shown(2, t0=6.0, t1=8.0), shown(3, treatment="text-pop", t0=9.0, t1=11.0),
             shown(4, treatment="text-pop", t0=12.0, t1=14.0), {"id": "b5", "skipped": "no room"}]
    [f] = run({"kind": "broll.unique"}, broll=broll, items=items)["failures"]
    assert f["places"] == [{"t0": 6.0, "t1": 8.0, "item": "b2", "asset": "Library/images/a.png"}]


def test_unique_counts_the_pictures_a_wall_draws():
    items = [{"id": "b1", "treatment": "icon-wall", "params": {"items": ["Library/images/a.png", "Library/images/b.png"]}},
             {"id": "b2", "asset": "Library/images/b.png"},
             {"id": "b3", "treatment": "post-wall", "params": {"items": ["Library/images/c.png", "Library/images/c.png"]}},
             {"id": "b4", "treatment": "post-wall", "params": {"items": "not a list"}}]
    broll = [shown(1, treatment="icon-wall", t0=1.0, t1=3.0), shown(2, t0=4.0, t1=6.0),
             shown(3, treatment="post-wall", t0=7.0, t1=9.0), shown(4, treatment="post-wall", t0=10.0, t1=12.0)]
    [f] = run({"kind": "broll.unique"}, broll=broll, items=items)["failures"]
    # b2 repeats a picture the wall showed; b3 shows one picture twice; a malformed list is no pictures
    assert [(p["item"], p["asset"]) for p in f["places"]] == [("b2", "Library/images/b.png"), ("b3", "Library/images/c.png")]


def test_unique_skips_a_wall_asset_the_wall_does_not_draw():
    # a wall with pictures listed draws those, not its own file asset; a folder asset is drawn as well
    items = [{"id": "b1", "treatment": "post-wall", "asset": "Library/images/cover.png", "params": {"items": ["Library/images/a.png"]}},
             {"id": "b2", "asset": "Library/images/cover.png"},
             {"id": "b3", "treatment": "icon-wall", "asset": "Library/images/logos", "params": {"items": ["Library/images/b.png"]}},
             {"id": "b4", "treatment": "icon-wall", "asset": "Library/images/logos"},
             {"id": "b5", "treatment": "post-wall", "asset": "Library/images/d.png"},
             {"id": "b6", "asset": "Library/images/d.png"}]
    broll = [shown(1, treatment="post-wall", t0=1.0, t1=3.0), shown(2, t0=4.0, t1=6.0), shown(3, treatment="icon-wall", t0=7.0, t1=9.0),
             shown(4, treatment="icon-wall", t0=10.0, t1=12.0), shown(5, treatment="post-wall", t0=13.0, t1=15.0), shown(6, t0=16.0, t1=18.0)]
    [f] = run({"kind": "broll.unique"}, broll=broll, items=items)["failures"]
    assert [(p["item"], p["asset"]) for p in f["places"]] == [("b4", "Library/images/logos"), ("b6", "Library/images/d.png")]


def test_face_clear_allows_a_full_screen_cutaway_but_not_a_card_on_the_eyes():
    over_eyes = shown(1, (300, 300, 780, 700))
    cutaway = shown(2, (0, 0, 1080, 1920), hiding=True, treatment="full-frame", t0=6.0, t1=7.0)
    forehead = shown(3, (300, 300, 780, 600), t0=9.0, t1=11.0)
    [f] = run({"kind": "broll.faceClear"}, broll=[over_eyes, cutaway, forehead])["failures"]
    assert [p["item"] for p in f["places"]] == ["b1"]


def test_max_bare_finds_plain_face_stretches_counting_zooms_and_the_ends():
    check = {"kind": "face.maxBare", "value": 4}
    # face 0-1, card 1-3, zoom 2-5 (overlapping), face 5-10.2 (too long), card 10.2-12, face to the end at 16.4
    rep = run(check, broll=[shown(1, t0=1.0, t1=3.0), shown(2, t0=10.2, t1=12.0)], zooms=[(2.0, 5.0)], duration=16.4)
    [f] = rep["failures"]
    assert f["places"] == [{"t0": 5.0, "t1": 10.2, "seconds": 5.2}]   # 4.4 s at the end is "about 4"
    assert run(check, duration=4.5)["ok"] and not run(check, duration=4.6)["ok"]


def test_zooms_per_minute_allows_one_per_share_of_the_length_and_always_one():
    check = {"kind": "zooms.maxPerMinute", "value": 6}           # one per 10 s
    three = [(1.0, 2.0), (6.0, 7.0), (12.0, 13.0)]
    assert run(check, zooms=three, duration=25.0)["ok"]             # 2.5 rounds up to 3
    [f] = run(check, zooms=three, duration=18.0)["failures"]
    assert f["places"] == [{"t0": 0.0, "t1": 18.0, "zooms": 3, "allowed": 2}]
    assert run(check, zooms=[(1.0, 2.0)], duration=5.0)["ok"]
    [f] = run(check, zooms=[(1.0, 2.0), (3.0, 4.0)], duration=5.0)["failures"]
    assert f["places"] == [{"t0": 0.0, "t1": 5.0, "zooms": 2, "allowed": 1}]


def test_opening_calm_allows_one_thing_in_the_first_seconds():
    check = {"kind": "opening.calm", "seconds": 3}
    hook = shown(1, treatment="text-pop", t0=0.0, t1=2.8)
    assert run(check, broll=[hook, shown(2, t0=3.0, t1=5.0)])["ok"]
    [f] = run(check, broll=[hook, shown(2, t0=2.5, t1=5.0)], zooms=[(1.2, 2.4)])["failures"]
    assert [(p["item"], p["t0"]) for p in f["places"]] == [("b1", 0.0), ("zoom", 1.2), ("b2", 2.5)]


def test_one_line_and_uniform_size_find_the_caption_that_was_fitted():
    cues = [cue("one two", s=0.0, e=1.0), cue("three four", s=1.0, e=2.0), cue("extraordinarily long", size=88, s=2.0, e=3.0),
            cue("wrapped onto two", s=3.0, e=4.0, lines=2)]
    [f] = run({"kind": "captions.oneLine"}, cues=cues)["failures"]
    assert f["places"] == [{"t0": 3.0, "t1": 4.0, "text": "wrapped onto two", "lines": 2}]
    [f] = run({"kind": "captions.uniformSize"}, cues=cues)["failures"]
    assert f["places"] == [{"t0": 2.0, "t1": 3.0, "text": "extraordinarily long", "px": 88}]
    # sizes compare at 1080 wide: a 720-wide video at 70 px is uniform with itself
    assert run({"kind": "captions.uniformSize"}, cues=[cue("a b", size=70), cue("c d", size=70)], fmt=(720, 1280))["ok"]
