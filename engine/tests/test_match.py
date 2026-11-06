"""Match cuts: the frame scores, the search windows, and the bounds a matched join plays with."""
import subprocess

import numpy as np
import pytest

from conftest import mkwords
from reelengine import compose_util, cut, match, project

W, H = 108, 192


def room(seed=0):
    """A still background with shapes in it: what a locked-off camera sees behind the speaker."""
    rng = np.random.default_rng(seed)
    img = np.tile(np.linspace(40, 120, W, dtype=np.float32), (H, 1))
    for _ in range(6):
        x, y = rng.integers(0, W - 20), rng.integers(0, H - 30)
        img[y:y + 30, x:x + 20] = rng.integers(0, 255)
    return img


def head(img, x, y=0.35, r=0.2, value=230.0):
    """The speaker: a bright disc centred at (x, y), fractions of the frame."""
    yy, xx = np.mgrid[0:H, 0:W]
    out = img.copy()
    out[(xx - x * W) ** 2 + (yy - y * H) ** 2 <= (r * W) ** 2] = value
    return out


def d(img):
    return match.describe(np.clip(img, 0, 255).astype(np.uint8))


def test_same_frame_lines_up():
    a = d(head(room(), 0.5))
    assert match.look(a, a) == pytest.approx(1.0, abs=1e-4)
    assert match.move(a, a, None) == pytest.approx(0.0, abs=1e-6)


# the head box around both head positions below
BOTH = (0.1, 0.2, 0.9, 0.5)


def test_head_moving_in_the_same_room_passes_look_but_fails_move():
    """On a locked-off take the room never changes, so only MOVE can tell a match from a jump cut."""
    a, b = d(head(room(), 0.35)), d(head(room(), 0.65))
    assert match.look(a, b, BOTH) >= match.LOOK_MIN
    assert match.move(a, b, BOTH) > match.MOVE_MAX
    verdict = match.best_pair([(1.0, a)], [(2.0, b)], BOTH, (1.0, 2.0))
    assert verdict["matched"] is False
    assert "moves too much" in verdict["why"]


def test_a_different_room_fails_look():
    a, b = d(head(room(0), 0.5)), d(head(room(7)[::-1, ::-1].copy(), 0.5))
    assert match.look(a, b, BOTH) < match.LOOK_MIN
    verdict = match.best_pair([(1.0, a)], [(2.0, b)], BOTH, (1.0, 2.0))
    assert verdict["matched"] is False
    assert "same shot" in verdict["why"]


def test_a_small_exposure_change_still_lines_up():
    a, b = d(head(room(), 0.5)), d(head(room(), 0.5) + 12)
    verdict = match.best_pair([(1.0, a)], [(2.0, b)], None, (1.0, 2.0))
    assert verdict["matched"] is True


def test_flat_frames_never_match():
    flat = d(np.full((H, W), 90.0, np.float32))
    assert match.look(flat, flat) == 0
    assert match.best_pair([(1.0, flat)], [(2.0, flat)], None, (1.0, 2.0))["matched"] is False


def test_move_is_measured_inside_the_head_box_and_look_outside_it():
    """A change outside the head box (a hand at the frame's edge) doesn't stop a match; a head moving
    inside it doesn't make the room look different."""
    a = head(room(), 0.5)
    b = a.copy()
    b[150:190, 0:30] = 255
    box = (0.2, 0.1, 0.8, 0.6)
    assert match.move(d(a), d(b), box) == pytest.approx(0.0, abs=0.01)
    assert match.move(d(a), d(b)) > match.move(d(a), d(b), box)
    moved = d(head(room(), 0.35)), d(head(room(), 0.65))
    assert match.look(*moved, BOTH) > match.look(*moved)


def test_best_pair_picks_the_frames_that_line_up_and_prefers_the_planned_bounds_on_a_tie():
    still = room()
    out = [(0.9, d(head(still, 0.5))), (1.0, d(head(still, 0.5)))]
    inc = [(2.0, d(head(still, 0.7))), (2.1, d(head(still, 0.5))), (2.2, d(head(still, 0.5)))]
    verdict = match.best_pair(out, inc, None, (1.0, 2.0))
    assert verdict["matched"] is True
    assert (verdict["outEnd"], verdict["inStart"]) == (1.0, 2.1)


def test_frame_grid_is_inclusive_and_on_frames():
    assert match.frame_grid(1.0, 1.1, 30) == [1.0, 1.033333, 1.066667, 1.1]
    assert match.frame_grid(1.01, 1.02, 30) == []


def words_one_take():
    return mkwords([(0.2, 0.8, "One."), (1.2, 1.8, "Gone."), (2.3, 2.9, "Two."), (3.2, 3.6, "Three.")])


def one_take_timeline(keep, points=None, duration=4.0):
    return cut.build_timeline(words_one_take(), keep, {"s1": {"duration": duration, "fps": 30}}, match_points=points)


def test_windows_never_reach_into_a_word():
    words = words_one_take()
    tl = one_take_timeline([{"from": "w0", "to": "w0"}, {"from": "w2", "to": "w2", "join": {"transition": "match", "frames": 0}}])
    (row,) = tl.match_joins
    win = match.windows(tl, row, {"s1": {"duration": 4.0, "fps": 30}})
    assert min(win["outTimes"]) >= words[0]["e"] + match.WORD_GUARD - 1e-6
    assert max(win["outTimes"]) <= words[1]["s"] - match.WORD_GUARD + 1e-6
    assert max(win["inTimes"]) <= words[2]["s"] + 1e-6
    assert min(win["inTimes"]) >= words[1]["e"] + match.WORD_GUARD - 1e-6
    assert win["planned"] == (tl.segments[0].src_end, tl.segments[1].src_start)


def test_without_points_a_match_join_plays_as_a_hard_cut():
    keep = [{"from": "w0", "to": "w0"}, {"from": "w2", "to": "w2", "join": {"transition": "match", "frames": 0}}]
    tl = one_take_timeline(keep)
    hard = one_take_timeline([keep[0], {"from": "w2", "to": "w2"}])
    assert tl.segments[1].join_transition == "hard"
    assert [(s.src_start, s.src_end, s.out_start) for s in tl.segments] == [(s.src_start, s.src_end, s.out_start) for s in hard.segments]
    assert tl.match_joins[0]["played"] == "hard"


def test_a_matched_point_moves_only_the_air_around_the_join():
    keep = [{"from": "w0", "to": "w0"}, {"from": "w2", "to": "w2", "join": {"transition": "match", "frames": 0}}]
    plain = one_take_timeline(keep)
    out_end, in_start = plain.segments[0].src_end + 0.1, plain.segments[1].src_start + 0.1
    tl = one_take_timeline(keep, {1: {"matched": True, "outEnd": out_end, "inStart": in_start}})
    a, b = tl.segments
    assert (a.src_end, b.src_start) == (out_end, in_start)
    assert b.join_transition == "match" and tl.match_joins[0]["played"] == "match"
    assert b.out_start == pytest.approx(a.out_end)
    assert tl.duration == pytest.approx(plain.duration)       # +0.1 s on one side, -0.1 s on the other
    assert tl.words_out[0] == plain.words_out[0]              # the outgoing word keeps its time
    assert tl.words_out[1]["s"] == pytest.approx(plain.words_out[1]["s"])


def test_an_unmatched_point_plays_a_hard_cut_and_says_why():
    keep = [{"from": "w0", "to": "w0"}, {"from": "w2", "to": "w2", "join": {"transition": "match", "frames": 0}}]
    tl = one_take_timeline(keep, {1: {"matched": False, "why": "the speaker moves too much across the cut"}})
    assert tl.segments[1].join_transition == "hard"
    assert (tl.match_joins[0]["played"], tl.match_joins[0]["why"]) == ("hard", "the speaker moves too much across the cut")


def test_a_match_inside_one_continuous_stretch_is_no_cut():
    keep = [{"from": "w0", "to": "w0"}, {"from": "w1", "to": "w1", "join": {"transition": "match", "frames": 0}}]
    tl = cut.build_timeline(words_one_take(), keep, {"s1": {"duration": 4.0, "fps": 30}}, gap_cap=2)
    assert all(s.join_transition is None for s in tl.segments)
    assert [m["played"] for m in tl.match_joins] == ["none"]


# --- through project.timeline, on decoded frames --------------------------------------------------

def head_x(t):
    """Where the speaker's head is at source time t: it moves away during "Gone." and comes back
    at 2.15 s, then moves again at 2.9 s for good."""
    if t < 1.0:
        return 0.3
    if t < 2.15:
        return 0.7
    if t < 2.9:
        return 0.3
    return 0.7


def write_take(path, background=0, seconds=4.0, fps=30):
    still = room(background)
    frames = b"".join(np.clip(head(still, head_x(k / fps)), 0, 255).astype(np.uint8).tobytes()
                      for k in range(int(seconds * fps)))
    subprocess.run([compose_util.ffmpeg_bin(), "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "gray",
                    "-s", f"{W}x{H}", "-r", str(fps), "-i", "-", "-c:v", "mpeg4", "-q:v", "2",
                    "-pix_fmt", "yuv420p", str(path)], input=frames, check=True)


def face_track(path, seconds=4.0, fps=3.0):
    """The disc as the face track sees it (placement.detect_faces' shape)."""
    r = 0.2 * W
    samples = [{"t": round(k / fps, 3), "box": [head_x(k / fps) * W - r, 0.35 * H - r, 2 * r, 2 * r], "score": 1.0}
               for k in range(int(seconds * fps))]
    path.parent.mkdir(parents=True, exist_ok=True)
    project.write_json(path, {"version": 2, "width": W, "height": H, "fps": fps, "samples": samples,
                              "median": [0.5 * W - r, 0.35 * H - r, 2 * r, 2 * r], "found": 1.0})


def take_project(tmp_path, keep):
    (tmp_path / "media").mkdir()
    write_take(tmp_path / "media" / "s1.mp4")
    face_track(tmp_path / "work" / "face-s1.json")
    p = project.new_project("Match")
    p["format"] = {"width": W, "height": H, "fps": 30}
    p["sources"] = [{"id": "s1", "path": "media/s1.mp4", "duration": 4.0, "fps": 30, "width": W, "height": H}]
    p["cut"]["keep"] = keep
    return p


def test_the_engine_finds_the_frames_where_the_head_is_back(tmp_path):
    """Planned bounds show the head at 0.3 then 0.7 (a jump); the search finds 2.15 s, where it is back."""
    keep = [{"from": "w0", "to": "w0"}, {"from": "w2", "to": "w2", "join": {"transition": "match", "frames": 0}}]
    p = take_project(tmp_path, keep)
    assert not project.validate(p)
    tl = project.timeline(tmp_path, p, words_one_take())
    (row,) = tl.match_joins
    assert row["played"] == "match", row
    assert tl.segments[0].src_end <= 1.0 + 1e-6
    assert tl.segments[1].src_start >= 2.15 - 1e-6
    assert (tmp_path / "work" / match.CACHE_FILE).exists()
    again = project.timeline(tmp_path, p, words_one_take())
    assert [(s.src_start, s.src_end) for s in again.segments] == [(s.src_start, s.src_end) for s in tl.segments]


def test_the_engine_refuses_a_match_where_the_head_never_comes_back(tmp_path):
    keep = [{"from": "w0", "to": "w0"}, {"from": "w3", "to": "w3", "join": {"transition": "match", "frames": 0}}]
    p = take_project(tmp_path, keep)
    tl = project.timeline(tmp_path, p, words_one_take())
    (row,) = tl.match_joins
    assert row["played"] == "hard"
    assert "moves too much" in row["why"]
    assert tl.segments[1].join_transition == "hard"
