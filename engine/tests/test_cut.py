import pytest

from conftest import mkwords
from reelengine import cut
from reelengine.proto import EngineError

SRC = {"s1": {"duration": 10.0, "fps": 30.0}, "s2": {"duration": 6.0, "fps": 25.0}}


def words_basic():
    return mkwords([(0.50, 0.80, "We"), (0.85, 1.20, "build"), (1.25, 1.70, "things."),
                    (3.70, 4.00, "Every"), (4.05, 4.50, "day."), (6.00, 6.30, "Again.")])


def test_gap_is_capped_and_words_never_cut():
    w = words_basic()
    tl = cut.build_timeline(w, [{"from": "w0", "to": "w4"}], SRC, gap_cap=0.25, min_saving=0.08)
    # 2.0 s of dead air between "things." and "Every" is cut down to ~0.25 s
    out = {x["id"]: x for x in tl.words_out}
    gap = out["w3"]["s"] - out["w2"]["e"]
    assert 0.20 <= gap <= 0.30, gap
    # every kept word keeps its full length
    for x in w[:5]:
        assert abs((out[x["id"]]["e"] - out[x["id"]]["s"]) - (x["e"] - x["s"])) < 0.035
    # the output duration is exactly the sum of segment lengths
    assert abs(tl.duration - sum(s.duration for s in tl.segments)) < 1e-6


def test_segments_on_frame_grid():
    tl = cut.build_timeline(words_basic(), [{"from": "w0", "to": "w4"}], SRC)
    for s in tl.segments:
        for t in (s.src_start, s.src_end):
            assert abs(t * 30 - round(t * 30)) < 1e-4


def test_anchor_mapping_matches_segments():
    """word_out_time must equal where the renderer actually places the word."""
    w = words_basic()
    keep = [{"from": "w3", "to": "w4"}, {"from": "w0", "to": "w2"}]      # reordered
    tl = cut.build_timeline(w, keep, SRC)
    for x in w[:5]:
        t_out = tl.word_out_time(x["id"])
        sid, t_src = tl.out_to_src(t_out + 1e-4)
        assert sid == "s1"
        assert abs(t_src - x["s"]) < 0.04, (x, t_out, t_src)
    # reordered: "Every" now comes first
    assert tl.word_out_time("w3") < tl.word_out_time("w0")


def test_recut_moves_anchors_with_the_words():
    w = words_basic()
    a = cut.build_timeline(w, [{"from": "w0", "to": "w4"}], SRC)
    b = cut.build_timeline(w, [{"from": "w2", "to": "w4"}], SRC)      # first two words cut
    # "day." is still preceded by exactly the same material after "things.", so its offset from
    # "things." is unchanged; and it starts earlier overall
    da = a.word_out_time("w4") - a.word_out_time("w2")
    db = b.word_out_time("w4") - b.word_out_time("w2")
    assert abs(da - db) < 0.035
    assert b.word_out_time("w4") < a.word_out_time("w4")


def test_cut_word_maps_to_next_kept_word():
    w = words_basic()
    tl = cut.build_timeline(w, [{"from": "w0", "to": "w1"}, {"from": "w3", "to": "w4"}], SRC)
    assert not tl.is_kept("w2")
    assert tl.word_out_time("w2") == tl.word_out_time("w3")
    assert tl.word_out_end("w2") == tl.word_out_end("w1")


def test_unknown_word_is_an_engine_error():
    with pytest.raises(EngineError) as e:
        cut.build_timeline(words_basic(), [{"from": "w0", "to": "w99"}], SRC)
    assert e.value.code == "BAD_CUT" and e.value.user_message


def test_inside_word_silence_removed():
    w = mkwords([(0.5, 2.5, "Hold"), (2.55, 3.0, "on.")])
    w[0]["gaps"] = [[0.8, 2.2]]
    tl = cut.build_timeline(w, [{"from": "w0", "to": "w1"}], SRC, gap_cap=0.25)
    # 0.4..3.35 without the inside cut is 2.95 s; 1.4 s of silence capped to 0.25 removes 1.15 s
    assert tl.duration < 2.95 - 1.0


def test_ranges_split_at_source_boundaries():
    w = mkwords([(0.5, 0.9, "one"), (1.0, 1.4, "two")]) + \
        mkwords([(0.3, 0.7, "three"), (0.8, 1.1, "four")], source="s2", start_id=2)
    tl = cut.build_timeline(w, [{"from": "w0", "to": "w3"}], SRC)
    assert [s.source for s in tl.segments] == ["s1", "s2"]
    # s2 is 25 fps: its cut points sit on the 25 fps grid
    for s in tl.segments[1:]:
        assert abs(s.src_start * 25 - round(s.src_start * 25)) < 1e-4


def test_window_segments():
    tl = cut.build_timeline(words_basic(), [{"from": "w0", "to": "w5"}], SRC)
    win = cut.window_segments(tl.segments, 0.5, 2.0)
    assert abs(sum(s.duration for s in win) - 1.5) < 1e-6
    assert win[0].out_start == 0


def test_keep_positions_roundtrip():
    w = words_basic()
    keep = cut.keep_from_positions(w, [0, 1, 2, 4, 5])
    assert keep == [{"from": "w0", "to": "w2"}, {"from": "w4", "to": "w5"}]
    assert cut.positions_from_keep(w, keep) == [0, 1, 2, 4, 5]


def test_remap_anchors_after_retranscription():
    from reelengine import project
    old = words_basic()
    new = [dict(w) for w in old if w["id"] != "w4"] + [{"id": "w9", "source": "s1", "s": 4.06, "e": 4.5, "w": "day."}]
    new.sort(key=lambda w: w["s"])
    p = project.new_project("t")
    p["cut"]["keep"] = [{"from": "w0", "to": "w4"}]
    p["zooms"] = [{"anchor": {"from": "w4", "to": "w4"}, "scale": 1.1}]
    moved = project.remap_anchors(p, old, new)
    assert moved == 3
    assert p["cut"]["keep"] == [{"from": "w0", "to": "w9"}]
    assert p["zooms"][0]["anchor"] == {"from": "w9", "to": "w9"}
