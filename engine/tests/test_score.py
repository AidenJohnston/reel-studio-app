"""score.py: each mechanical check on fixed data with one right answer, and a saved version scored end to end.
The numbers it reads are what render.py leaves beside a version; the sentences are the app's (shared/edit-score.ts)."""
import json
from types import SimpleNamespace

import pytest

from reelengine import score, verify
from reelengine.proto import EngineError

W, H = 1080, 1920


def words(*gaps):
    """Kept words 0.3 s long, separated by these pauses."""
    out, t = [], 0.0
    for i, g in enumerate((0.0, *gaps)):
        t += g
        out.append({"id": f"w{i}", "s": t, "e": t + 0.3})
        t += 0.3
    return SimpleNamespace(words_out=out)


PROJ = {"cut": {"gapCap": 0.25, "minSaving": 0.08}, "sources": [{"fps": 30}]}


def test_dead_air_counts_only_pauses_longer_than_the_cut_keeps():
    # allowed = 0.25 + 0.08 + 2/30 + 0.002 = 0.399
    rep = score.dead_air(words(0.2, 0.39, 0.41, 1.5), PROJ)
    assert rep == {"id": "deadAir", "ok": False, "count": 2, "longest": 1.5, "allowed": 0.4}
    assert score.dead_air(words(0.2, 0.3), PROJ)["ok"] is True


def cue(y, h=120, x=300, w=480):
    return {"box": [x, y, w, h], "ids": []}


def test_safe_zone_fails_a_subtitle_under_instagram_buttons_or_without_a_box():
    bottom = H * (1 - verify.IG_BOTTOM_FRAC)
    rep = score.safe_band([cue(1200), cue(bottom - 100), {"ids": []}, cue(50)], (W, H))
    assert rep == {"id": "subtitleSafeZone", "ok": False, "count": 3, "subtitles": 4}
    assert score.safe_band([cue(1200)], (W, H))["ok"] is True


def test_verify_report_splits_into_loudness_and_the_video_file():
    rep = {"lufs": -18.2, "checks": [{"name": "loudness", "status": "FAIL"}, {"name": "duration", "status": "PASS"},
                                     {"name": "sync", "status": "FAIL"}, {"name": "fps", "status": "WARN"}]}
    assert score.from_verify(rep) == [
        {"id": "loudness", "ok": False, "lufs": -18.2, "target": verify.TARGET_LUFS},
        {"id": "videoFile", "ok": False, "count": 1, "failed": ["sync"]},
    ]
    # an older version with no verify report measures neither
    assert score.from_verify(None) == []


def test_a_version_that_is_not_saved_is_refused(tmp_path):
    with pytest.raises(EngineError) as e:
        score.run(tmp_path, 3)
    assert e.value.code == "NOT_FOUND" and e.value.user_message
