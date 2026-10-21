"""cover-candidates reports the winning frame's own signals, which the app's cover picker turns into reasons."""
import numpy as np

from reelengine import cover


def test_each_candidate_carries_the_signals_of_the_frame_that_won(monkeypatch, tmp_path):
    rows = [
        {"t": 1.9, "score": 0.5, "det": 0.9, "eyesN": 0.4, "sharpN": 1.0, "stillN": 0.3, "between": False},
        {"t": 2.1, "score": 0.8, "det": 0.9, "eyesN": 1.0, "sharpN": 0.7, "stillN": 0.9, "between": True},
        {"t": 2.3, "score": 0.0},
    ]
    monkeypatch.setattr(cover, "fmt_of", lambda ctx: (1080, 1920, 30))
    monkeypatch.setattr(cover, "reframe_rect", lambda ctx, sid: None)
    monkeypatch.setattr(cover, "source_path", lambda ctx, sid: "take.mp4")
    monkeypatch.setattr(cover, "candidate_times", lambda ctx, sid, at, half=None: [r["t"] for r in rows])
    monkeypatch.setattr(cover, "score_frames", lambda ctx, sid, times: [dict(r) for r in rows])
    monkeypatch.setattr(cover, "grab_frame", lambda path, t, ctx: np.zeros((1920, 1080, 3), np.uint8))

    [c] = cover.candidates(object(), "s1", [2.0], tmp_path, width=90)

    assert c["atSourceTime"] == 2.1
    assert c["score"] == 0.8
    assert (c["eyesOpen"], c["sharp"], c["still"], c["betweenWords"]) == (1.0, 0.7, 0.9, True)
