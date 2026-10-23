"""The app's cover picker: a frame the person picks is the frame that renders, and the reasons it shows for
each suggestion name only signals where that frame stood out."""
import json
from types import SimpleNamespace

import numpy as np
import pytest

from reelengine import cover


@pytest.mark.parametrize("flags, rendered", [({"manual": True}, 2.0), ({"exact": True}, 1.8)])
def test_a_manual_pick_renders_that_frame_while_the_ai_pick_still_searches(monkeypatch, tmp_path, flags, rendered):
    grabbed = []
    monkeypatch.setattr(cover, "report", lambda *a: None)
    monkeypatch.setattr(cover, "source_path", lambda ctx, sid: "take.mp4")
    monkeypatch.setattr(cover, "fmt_of", lambda ctx: (108, 192, 30))
    monkeypatch.setattr(cover, "reframe_rect", lambda ctx, sid: (0, 0, 108, 192))
    monkeypatch.setattr(cover, "candidate_times", lambda ctx, sid, at, half=None: [1.8, 2.0])
    # a neighbour scores higher than the picked frame, so any search moves off it
    monkeypatch.setattr(cover, "score_frames", lambda ctx, sid, times: [{"t": 1.8, "score": 0.9}, {"t": 2.0, "score": 0.5}])
    monkeypatch.setattr(cover, "grab_frame", lambda path, t, ctx: grabbed.append(t) or np.zeros((192, 108, 3), np.uint8))
    ctx = SimpleNamespace(project={"sources": [{"id": "s1"}], "cover": {"atSourceTime": 2.0, "source": "s1", **flags}},
                          out_timeline=[], work=tmp_path)

    cover.render(ctx, tmp_path / "cover.png")

    assert grabbed == [rendered]
    assert json.loads((tmp_path / "cover.json").read_text())["chosen"] == rendered


def _faces(eyes, sharp, still, between):
    return [{"eyes": e, "sharp": s, "still": st, "between": b} for e, s, st, b in zip(eyes, sharp, still, between)]


def test_reasons_need_a_real_distinction():
    good = _faces(eyes=[1.0, 3.0, 3.0, 3.0, 9.0], sharp=[5.0, 5.0, 5.0, 5.0, 5.0], still=[1.0, 2.0, 3.0, 9.95, 10.0],
                  between=[False, True, True, True, True])
    cover._mark_reasons(good)
    # eyes: the clear winner only. sharp: flat, names nothing. still: 9.95 is 0.997 of the 90th percentile
    # (9.98), which rounds to 1.00 but is below it.
    assert good[4]["reasons"] == ["eyesOpen", "betweenWords", "still"]
    assert good[3]["reasons"] == ["betweenWords"]

    few = _faces(eyes=[1.0, 9.0], sharp=[1.0, 9.0], still=[1.0, 9.0], between=[False, True])
    cover._mark_reasons(few)
    assert few[1]["reasons"] == []

    quiet = _faces(eyes=[1.0, 2.0, 9.0], sharp=[1.0, 1.0, 1.0], still=[1.0, 1.0, 1.0], between=[True, True, True])
    cover._mark_reasons(quiet)
    assert quiet[2]["reasons"] == ["eyesOpen"]          # all between words: not why this one won


def test_each_candidate_carries_the_reasons_of_the_frame_that_won(monkeypatch, tmp_path):
    rows = [{"t": 1.9, "score": 0.5, "reasons": ["sharp"]}, {"t": 2.1, "score": 0.8, "reasons": ["eyesOpen", "still"]}]
    monkeypatch.setattr(cover, "fmt_of", lambda ctx: (1080, 1920, 30))
    monkeypatch.setattr(cover, "reframe_rect", lambda ctx, sid: None)
    monkeypatch.setattr(cover, "source_path", lambda ctx, sid: "take.mp4")
    monkeypatch.setattr(cover, "candidate_times", lambda ctx, sid, at, half=None: [r["t"] for r in rows])
    monkeypatch.setattr(cover, "score_frames", lambda ctx, sid, times: [dict(r) for r in rows])
    monkeypatch.setattr(cover, "grab_frame", lambda path, t, ctx: np.zeros((1920, 1080, 3), np.uint8))

    ctx = SimpleNamespace(project={"sources": [{"id": "s1"}]})
    [c] = cover.candidates(ctx, "s1", [2.0], tmp_path, width=90)

    assert (c["atSourceTime"], c["score"], c["reasons"]) == (2.1, 0.8, ["eyesOpen", "still"])
