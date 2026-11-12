"""Beat sync: the stored grid, and cuts, zooms and b-roll landing on it."""
from types import SimpleNamespace

import pytest

from conftest import mkwords
from reelengine import beats, broll, cut, zoom

FPS = 30.0
SRC = {"s1": {"duration": 12.0, "fps": FPS}}


def proj_with(grid_frames, start_at=0.0, on_beat=("cuts", "zooms", "broll")):
    return {"format": {"width": 1080, "height": 1920, "fps": FPS},
            "music": {"enabled": True, "track": "Library/Music/song.mp3", "startAt": start_at,
                      "beats": {"fps": FPS, "frames": list(grid_frames)}, "onBeat": list(on_beat)}}


def test_grid_is_whole_frames_of_song_time_and_moves_with_the_start_point():
    g = beats.quantise([0.497, 0.995, 1.496, 0.995, -0.01], FPS)
    assert g == {"fps": FPS, "frames": [15, 30, 45]}
    # the song starts 0.4 s in: its beat at 0.5 s plays 0.1 s into the video, on the output frame grid
    assert beats.output_grid(proj_with(g["frames"], start_at=0.4)) == pytest.approx([0.1, 0.6, 1.1])
    # nothing to land on without a song, or when that kind isn't asked for
    off = proj_with(g["frames"])
    off["music"]["enabled"] = False
    assert beats.output_grid(off) == []
    assert beats.synced(proj_with(g["frames"], on_beat=("zooms",)), "cuts") == []


def test_snap_reaches_only_as_far_as_allowed():
    grid = [1.0, 1.5, 2.0]
    assert beats.snap(1.10, grid, early=0.15, late=0.06) == 1.0     # the beat 0.1 s before
    assert beats.snap(1.42, grid, early=0.15, late=0.06) == 1.42    # 0.08 s later is too late
    assert beats.snap(1.46, grid, early=0.15, late=0.06) == 1.5
    assert beats.snap(1.25, grid, early=0.15, late=0.15) == 1.25    # nothing in reach
    assert beats.next_beat(1.01, grid, within=0.6) == 1.5
    assert beats.next_beat(1.01, grid, within=0.3) is None


def words_two_takes():
    # two sentences with a long pause between them, so the cut joins two ranges
    return mkwords([(0.50, 0.80, "We"), (0.85, 1.20, "build"), (1.25, 1.70, "things."),
                    (3.70, 4.00, "Every"), (4.05, 4.50, "day."), (6.00, 6.30, "Again."), (6.35, 6.80, "Now.")])


KEEP = [{"from": "w0", "to": "w2"}, {"from": "w5", "to": "w6"}]


def cut_time(tl):
    return tl.segments[-1].out_start


def test_a_jump_cut_lands_on_a_reachable_beat_without_touching_a_word():
    w = words_two_takes()
    plain = cut.build_timeline(w, KEEP, SRC)
    t = cut_time(plain)
    for beat in (t + 0.1, t - 0.033):            # one later, one earlier than the cut falls
        beat = round(beat * FPS) / FPS
        tl = cut.build_timeline(w, KEEP, SRC, beats=[beat - 2.0, beat, beat + 2.0])
        assert cut_time(tl) == pytest.approx(beat, abs=1e-6)
        out = {x["id"]: x for x in tl.words_out}
        # only the air after "things." moved: its words are where they were, and it isn't clipped
        assert out["w2"] == {x["id"]: x for x in plain.words_out}["w2"]
        assert tl.segments[0].src_end >= w[2]["e"] + cut.WORD_CLEAR - 1e-6
        assert tl.segments[0].src_end <= w[3]["s"] - cut.WORD_CLEAR + 1e-6
        # everything after the cut moves with it
        assert out["w5"]["s"] - plain.first_pos["w5"][0] == pytest.approx(beat - t, abs=1e-3)   # word times: 4 places
        assert tl.duration - plain.duration == pytest.approx(beat - t, abs=1e-6)


def test_a_cut_that_cannot_reach_a_beat_stays_put():
    w = words_two_takes()
    plain = cut.build_timeline(w, KEEP, SRC)
    t = cut_time(plain)
    # 0.2 s later is past BEAT_REACH; earlier than the word's end would clip "things."
    for beat in (t + 0.2, plain.first_pos["w2"][1]):
        tl = cut.build_timeline(w, KEEP, SRC, beats=[round(beat * FPS) / FPS])
        assert [(s.src_start, s.src_end, s.out_start) for s in tl.segments] == \
            [(s.src_start, s.src_end, s.out_start) for s in plain.segments]


def ctx_for(proj, words):
    tl = cut.build_timeline(words, KEEP, SRC)
    return SimpleNamespace(project=proj, fmt=proj["format"], duration=tl.duration, words=words,
                           word_out_time=tl.word_out_time, word_out_end=tl.word_out_end, is_kept=tl.is_kept,
                           out_timeline=tl.segments, work="."), tl


def test_zoom_and_broll_entrances_land_on_the_beat():
    w = words_two_takes()
    _, tl = ctx_for(proj_with([]), w)
    word = tl.word_out_time("w1")
    beat = round((word - 0.1) * FPS) / FPS        # a beat a few frames before the word
    proj = proj_with([round(beat * FPS)])
    proj["zooms"] = [{"anchor": {"from": "w1", "to": "w2"}, "scale": 1.2, "focus": [0.5, 0.4]}]
    proj["broll"] = [{"id": "b1", "anchor": {"from": "w1", "to": "w2"}, "treatment": "text-pop",
                      "leadIn": 0.0, "params": {"text": "x"}}]
    ctx, _ = ctx_for(proj, w)
    assert zoom.build_zooms(ctx, with_broll=False)[0].t0 == pytest.approx(beat)
    assert broll.plan_windows(ctx)[0]["t0"] == pytest.approx(beat)
    # without onBeat they land on the word, as before
    proj["music"]["onBeat"] = []
    assert zoom.build_zooms(ctx, with_broll=False)[0].t0 == pytest.approx(round(word * FPS) / FPS)
    assert broll.plan_windows(ctx)[0]["t0"] == pytest.approx(word)
