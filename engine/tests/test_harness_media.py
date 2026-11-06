"""Media checks using decoded samples and fake processes, without FFmpeg or media files."""
from pathlib import Path

import numpy as np
import pytest

from harness import checks, media


@pytest.mark.parametrize("audio", ["missing", "empty"])
def test_preview_with_missing_or_empty_candidate_audio_is_a_failed_check(monkeypatch, audio):
    ref, cand = Path("reference.mp4"), Path("candidate.mp4")
    monkeypatch.setattr(media, "video_size", lambda *args: (2, 2))
    monkeypatch.setattr(media, "video_pts", lambda *args: [0.0])
    monkeypatch.setattr(media, "iter_frames", lambda *args: iter([np.zeros((2, 2, 3), dtype=np.uint8)]))

    def samples(ffmpeg, path, **kwargs):
        if path == ref:
            return np.ones(1600, dtype=np.float32)
        if audio == "missing":
            raise RuntimeError("no audio stream")
        return np.array([], dtype=np.float32)

    monkeypatch.setattr(media, "audio_mono", samples)
    result = checks.check_preview_video("ffmpeg", "ffprobe", ref, cand, [], {}, 30, (2, 2))
    assert result["status"] == "fail"
    assert any("candidate audio" in failure for failure in result["failures"])
    assert result["frames"] == 1
