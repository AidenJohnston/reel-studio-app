"""moments.changed: the output seconds an edit changed, for each kind of edit, and the stills and
window drawn for them. Pure: projects and words in memory, no ffmpeg. Where a span is expected, it is
read from the renderer's own timing (broll.plan_windows, zoom.windows, captions.build_cues,
cut.build_timeline) for the NEW project, because the claim is that the diff names the seconds the
render draws differently."""
from __future__ import annotations

import copy
import io
import json

import pytest

from conftest import sentence_words
from reelengine import broll, captions, cli, moments, project as projmod, proto, zoom

TEXT = ("so here is the thing about short videos everyone makes them and nobody watches until the very end "
        "because the start never earns the next second of attention from anyone scrolling past at night")
WORDS = sentence_words(TEXT, 0.4)
FPS = 30


def base_project(keep=(("w0", "w31"),), captions_on=True) -> dict:
    p = projmod.new_project("t")
    p["sources"] = [{"id": "s1", "path": "media/a.mp4", "duration": 13.0, "fps": FPS, "width": 1080,
                     "height": 1920, "rotation": 0}]
    p["cut"]["keep"] = [{"from": a, "to": b} for a, b in keep]
    p["captions"]["enabled"] = captions_on
    return p


def card(bid, a, b, **params) -> dict:
    return {"id": bid, "anchor": {"from": a, "to": b}, "leadIn": 0.13, "treatment": "text-pop",
            "asset": None, "params": {"text": bid, **params}}


def diff(tmp_path, old, new, **kw):
    return moments.changed(old, new, WORDS, tmp_path, **kw)


def timeline(tmp_path, proj):
    return projmod.timeline(tmp_path, proj, WORDS)


def ctx(tmp_path, proj):
    return moments._plan_ctx(proj, timeline(tmp_path, proj), tmp_path, None)


def span_of(tmp_path, proj, bid) -> list:
    p = next(p for p in broll.plan_windows(ctx(tmp_path, proj)) if p["id"] == bid)
    return [p["t0"], p["t1"]]


def approx(spans):
    return pytest.approx([pytest.approx(s, abs=1e-6) for s in spans])


# --- which seconds ------------------------------------------------------------------------------

def test_an_added_card_is_its_drawn_span_and_nothing_else(tmp_path):
    old = base_project(captions_on=False)
    new = copy.deepcopy(old)
    new["broll"] = [card("b1", "w10", "w11")]
    found = diff(tmp_path, old, new)
    want = span_of(tmp_path, new, "b1")
    # the drawn span: lead-in before the first word, held past the last (not the words' own seconds)
    tl = timeline(tmp_path, new)
    assert want[0] < tl.word_out_time("w10") and want[1] > tl.word_out_end("w11")
    assert found["intervals"] == approx([want])
    assert [c["kind"] for c in found["changes"]] == ["broll"]


def test_a_moved_card_shows_where_it_was_and_where_it_is(tmp_path):
    old = base_project(captions_on=False)
    old["broll"] = [card("b1", "w2", "w3")]
    new = copy.deepcopy(old)
    new["broll"] = [card("b1", "w20", "w21")]
    found = diff(tmp_path, old, new)
    assert found["intervals"] == approx([span_of(tmp_path, old, "b1"), span_of(tmp_path, new, "b1")])
    # the still goes where the card is now
    still = moments.pick_stills(found)[0]
    assert span_of(tmp_path, new, "b1")[0] <= still < span_of(tmp_path, new, "b1")[1]


def test_a_card_cut_short_by_a_new_neighbour_is_redrawn_over_its_whole_span(tmp_path):
    old = base_project(captions_on=False)
    old["broll"] = [card("b1", "w4", "w4", fade=0.3)]  # one word, held to the 2 s minimum; its fade-out moves
    new = copy.deepcopy(old)
    new["broll"].append(card("b2", "w7", "w8"))        # starts inside b1's hold: b1 hands over to it
    a_old, a_new = span_of(tmp_path, old, "b1"), span_of(tmp_path, new, "b1")
    b2 = span_of(tmp_path, new, "b2")
    assert a_new[1] < a_old[1] and a_new[0] == a_old[0]
    found = diff(tmp_path, old, new)
    assert found["intervals"] == approx([[a_old[0], max(a_old[1], b2[1])]])
    # the still is of the new card, the cause, not of the one it cut short
    assert b2[0] <= moments.pick_stills(found)[0] < b2[1]


def test_a_zoom_under_a_card_redraws_the_whole_card(tmp_path):
    old = base_project(captions_on=False)
    old["broll"] = [card("b1", "w10", "w16")]
    new = copy.deepcopy(old)
    new["zooms"] = [{"anchor": {"from": "w12", "to": "w13"}, "scale": 1.2}]   # cards are placed around the zoom
    card_span = span_of(tmp_path, new, "b1")
    (_, z0, z1), = zoom.windows(ctx(tmp_path, new))
    assert card_span[0] < z0 and z1 < card_span[1]
    assert diff(tmp_path, old, new)["intervals"] == approx([card_span])


def test_a_card_removed_past_the_new_end_is_still_drawn(tmp_path):
    old = base_project(keep=(("w0", "w31"),), captions_on=False)
    old["broll"] = [card("b1", "w24", "w30")]
    new = base_project(keep=(("w0", "w26"),), captions_on=False)   # the end cut off, the card removed
    assert span_of(tmp_path, old, "b1")[1] > timeline(tmp_path, new).duration
    found = diff(tmp_path, old, new)
    dur = timeline(tmp_path, new).duration
    assert found["intervals"] == approx([[span_of(tmp_path, old, "b1")[0], dur]])
    [still] = moments.pick_stills(found)
    assert span_of(tmp_path, old, "b1")[0] <= still < dur


def test_a_card_redraws_every_caption_line_it_covers(tmp_path):
    old = base_project()
    new = copy.deepcopy(old)
    new["broll"] = [card("b1", "w10", "w11")]          # a split view moves the lines it mostly covers
    a, b = span_of(tmp_path, new, "b1")
    tl = timeline(tmp_path, new)
    lines = [(c["s"], c["e"]) for c in captions.build_cues(tl.words_out, new["captions"], set())
             if c["s"] < b and a < c["e"]]
    assert lines and min(s for s, _ in lines) < a       # a line starts before the card does
    assert diff(tmp_path, old, new)["intervals"] == approx([[min(a, *(s for s, _ in lines)), max(b, *(e for _, e in lines))]])


def test_a_card_running_across_the_cut_is_redrawn_whole(tmp_path):
    old = base_project(keep=(("w0", "w9"), ("w12", "w31")), captions_on=False)
    old["broll"] = [card("b1", "w8", "w8")]             # held 2 s, past the splice after w9
    new = copy.deepcopy(old)
    new["cut"]["keep"][1]["from"] = "w14"
    a, b = span_of(tmp_path, new, "b1")
    assert span_of(tmp_path, old, "b1") == [a, b]       # the card itself did not change
    x = timeline(tmp_path, new).segments[1].out_start
    assert a < x < b                                    # but its face is framed across new footage
    assert diff(tmp_path, old, new)["intervals"] == approx([[a, timeline(tmp_path, new).duration]])


def test_a_card_running_across_the_cut_also_redraws_the_caption_line_it_covers(tmp_path):
    old = base_project(keep=(("w0", "w9"), ("w12", "w31")))
    old["broll"] = [card("b1", "w8", "w8")]             # held 2 s, past the splice after w9
    new = copy.deepcopy(old)
    new["cut"]["keep"][1]["from"] = "w14"
    a, _b = span_of(tmp_path, new, "b1")
    tl = timeline(tmp_path, new)
    line = next(c for c in captions.build_cues(tl.words_out, new["captions"], set())
                if "w8" in [i for ids in c["wids"] for i in ids])
    assert line["s"] < a < line["e"]                    # the line under the card starts before it
    assert diff(tmp_path, old, new)["intervals"] == approx([[line["s"], tl.duration]])


def test_a_caption_style_change_is_the_whole_video(tmp_path):
    old = base_project()
    new = copy.deepcopy(old)
    new["captions"]["style"]["size"] = 90
    found = diff(tmp_path, old, new)
    assert found["intervals"] == approx([[0.0, timeline(tmp_path, new).duration]])
    assert found["changes"][0]["kind"] == "all"


def test_a_cut_change_is_everything_after_the_first_moved_segment(tmp_path):
    old = base_project(keep=(("w0", "w9"), ("w12", "w31")), captions_on=False)
    new = base_project(keep=(("w0", "w9"), ("w16", "w31")), captions_on=False)
    tl_old, tl_new = timeline(tmp_path, old), timeline(tmp_path, new)
    first = next(i for i, (a, b) in enumerate(zip(tl_old.segments, tl_new.segments))
                 if (a.source, a.src_start, a.src_end) != (b.source, b.src_start, b.src_end))
    x = tl_new.segments[first].out_start
    assert x > 0
    found = diff(tmp_path, old, new)
    assert found["intervals"] == approx([[x, tl_new.duration]])
    # the new splice is the still: the first frame after it
    assert x - 1e-6 <= moments.pick_stills(found)[0] < x + 1 / FPS


def test_a_segment_that_only_ends_sooner_keeps_its_first_frames(tmp_path):
    old = base_project(keep=(("w0", "w9"), ("w14", "w31")), captions_on=False)
    new = base_project(keep=(("w0", "w7"), ("w14", "w31")), captions_on=False)
    tl_new = timeline(tmp_path, new)
    found = diff(tmp_path, old, new)
    assert found["intervals"] == approx([[tl_new.segments[0].out_end, tl_new.duration]])


def test_cutting_off_the_end_changes_no_frame_left_in_the_video(tmp_path):
    old = base_project(keep=(("w0", "w31"),), captions_on=False)
    new = base_project(keep=(("w0", "w25"),), captions_on=False)
    found = diff(tmp_path, old, new)
    assert found["intervals"] == [] and moments.pick_stills(found) == []


def test_a_caption_correction_is_the_line_that_shows_it(tmp_path):
    old = base_project()
    new = copy.deepcopy(old)
    new["captions"]["corrections"] = [{"from": "videos", "to": "reels", "at": "w7"}]
    tl = timeline(tmp_path, new)
    line = next(c for c in captions.build_cues(tl.words_out, new["captions"], set()) if "w7" in [i for ids in c["wids"] for i in ids])
    found = diff(tmp_path, old, new)
    assert found["intervals"] == approx([[line["s"], line["e"]]])
    assert line["s"] <= moments.pick_stills(found)[0] < line["e"]


def test_an_added_zoom_is_its_span_on_screen(tmp_path):
    old = base_project()
    new = copy.deepcopy(old)
    new["zooms"] = [{"anchor": {"from": "w12", "to": "w15"}, "scale": 1.2}]
    (_, t0, t1), = zoom.windows(ctx(tmp_path, new))
    assert diff(tmp_path, old, new)["intervals"] == approx([[t0, t1]])


def test_a_remade_animation_is_its_span_though_project_json_is_the_same(tmp_path):
    proj = base_project(captions_on=False)
    proj["broll"] = [dict(card("b1", "w5", "w6"), treatment="animation", asset="anim-1")]
    found = diff(tmp_path, proj, copy.deepcopy(proj), old_anims={"anim-1.mov": [10, 1]},
                 new_anims={"anim-1.mov": [12, 2]})
    assert found["intervals"] == approx([span_of(tmp_path, proj, "b1")])
    untouched = diff(tmp_path, proj, copy.deepcopy(proj), old_anims={"other.mov": [10, 1]},
                     new_anims={"other.mov": [12, 2]})
    assert untouched["intervals"] == []


def test_edits_nobody_sees_change_nothing_on_screen(tmp_path):
    old = base_project()
    old["broll"] = [card("b1", "w10", "w11")]
    new = copy.deepcopy(old)
    new["music"].update(enabled=True, track="Library/Music/song.mp3", level="quiet")
    new["post"]["caption"] = "new words"
    new["notes"] = [{"version": 2, "text": "louder", "applied": ["music"], "at": "2026-11-05T00:00:00Z"}]
    new.update(title="other", cover={"atSourceTime": 3.0, "source": "s1", "text": "hi"}, version=4)
    new["cut"]["source"] = "autocut"
    found = diff(tmp_path, old, new)
    assert found["intervals"] == [] and found["changes"] == []


def test_a_field_it_does_not_know_redraws_the_whole_video(tmp_path):
    old = base_project()
    new = dict(copy.deepcopy(old), look={"grade": "warm"})
    assert diff(tmp_path, old, new)["changes"][0]["why"].startswith("look changed")
    new = copy.deepcopy(old)
    new["captions"]["animation"] = "pop"
    assert diff(tmp_path, old, new)["changes"][0]["kind"] == "all"


@pytest.mark.parametrize("old", [None, base_project(keep=())], ids=["no base", "empty cut"])
def test_with_nothing_shown_before_all_of_it_is_new(tmp_path, old):
    new = base_project()
    found = diff(tmp_path, old, new)
    assert found["intervals"] == approx([[0.0, timeline(tmp_path, new).duration]])


# --- what to draw -------------------------------------------------------------------------------

def test_stills_take_edited_cards_before_cuts_and_stop_at_three(tmp_path):
    old = base_project(keep=(("w0", "w9"), ("w12", "w31")))
    new = base_project(keep=(("w0", "w9"), ("w13", "w31")))
    new["broll"] = [card("b1", "w2", "w3"), card("b2", "w5", "w5"), card("b3", "w20", "w21")]
    found = diff(tmp_path, old, new)
    stills = moments.pick_stills(found)
    assert len(stills) == 3
    for s, bid in zip(stills, ("b1", "b2", "b3")):
        a, b = span_of(tmp_path, new, bid)
        assert a <= s < b
    for s in stills:
        assert abs(s * FPS - round(s * FPS)) < 1e-4                  # on the frame grid (times have 6 decimals)
        assert any(a <= s < b for a, b in found["intervals"])


def test_the_window_is_two_seconds_on_the_frame_grid_inside_the_video():
    assert moments.window_around(0.1, 10.0, 30) == [0.0, 2.0]
    assert moments.window_around(9.95, 10.0, 30) == [8.0, 10.0]
    a, b = moments.window_around(5.017, 10.0, 30)
    assert b - a == pytest.approx(2.0) and a <= 5.017 < b
    assert abs(a * 30 - round(a * 30)) < 1e-6 and abs(b * 30 - round(b * 30)) < 1e-6
    assert moments.window_around(0.5, 1.8, 30) is None              # the draft is the window
    a, b = moments.window_around(10.0, 10.02, 30)                     # 301 frames: the last starts at 10.0
    assert a <= 10.0 < b


# --- the command --------------------------------------------------------------------------------

def run_cli(argv):
    buf = io.StringIO()
    proto.set_stream(buf)
    try:
        code = cli.main(argv)
    finally:
        proto.set_stream(None)
    return code, [json.loads(line) for line in buf.getvalue().splitlines() if line.strip()]


def test_an_edit_nobody_sees_draws_nothing_and_moves_the_base(tmp_path):
    proj = base_project()
    (tmp_path / "work").mkdir()
    (tmp_path / "work" / "transcript.json").write_text(json.dumps({"words": WORDS}), encoding="utf-8")
    projmod.save(tmp_path, proj)
    code, lines = run_cli(["moments", "--project", str(tmp_path), "--mark"])
    assert code == 0
    proj["music"]["level"] = "quiet"
    projmod.save(tmp_path, proj)
    code, lines = run_cli(["moments", "--project", str(tmp_path)])
    assert code == 0, lines
    result = lines[-1]["result"]
    assert result["intervals"] == [] and result["stills"] == [] and result["draft"] is None
    assert not any("ready" in line for line in lines)
    base = json.loads((tmp_path / "work" / "moments" / "base.json").read_text(encoding="utf-8"))
    assert base["project"]["music"]["level"] == "quiet"
