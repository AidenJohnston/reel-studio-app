"""Checkable My style rules (lint.py): the strict schema, and each checker on fixed render data with
one right answer. tests/compositing/test_lint_render.py runs them on a real render."""
import json
from pathlib import Path

import pytest

from reelengine import lint
from reelengine.proto import EngineError

FMT = (1080, 1920)
SHARED = json.loads((Path(__file__).parent / "rule_checks.json").read_text(encoding="utf-8"))


def cue(text, size=105, s=1.0, e=2.0):
    return {"s": s, "e": e, "text": text, "size": size, "box": [300, 1300, 480, 120]}


def rules_file(*checks, stop=()):
    return {"version": 1, "rules": [{"id": f"r{i}", "text": f"Rule {i}.", "check": c} for i, c in enumerate(checks)],
            **({"stopOn": list(stop)} if stop else {})}


def run(*checks, cues=(), mix=None, broll=(), fmt=FMT):
    rules, _ = lint.parse_rules(rules_file(*checks))
    return lint.lint(rules, cues=list(cues), fmt=fmt, mix={"music": None} if mix is None else mix,
                     broll=list(broll), duration=20.0)


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
    ({"kind": "captions.color", "value": "#fff"}, "unknown kind 'captions.color'; known kinds: broll.keepOut"),
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


def shown(i, bbox, hiding=False, treatment="card-above-head"):
    return {"id": f"b{i}", "treatment": treatment, "t0": 2.0, "t1": 4.0, "faceHiding": hiding,
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
