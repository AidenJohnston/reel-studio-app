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


def test_still_comparison_uses_the_engines_rounded_seek(monkeypatch):
    fps = 29.97
    frames = [np.full((2, 2, 3), n, dtype=np.uint8) for n in (0, 100, 200)]
    monkeypatch.setattr(media, "read_image", lambda path: frames[2])
    monkeypatch.setattr(media, "video_pts", lambda *args: [0.0, 2 / fps, 3 / fps])
    monkeypatch.setattr(media, "iter_frames", lambda *args: iter(frames))
    monkeypatch.setattr(media, "video_size", lambda *args: (2, 2))
    # 2/fps is 0.066733...; frames.py seeks to 0.067, after that frame's start.
    result = checks.check_still("ffmpeg", "ffprobe", Path("ref.mp4"), Path("still.png"), 2 / fps,
                                [], {"otherPsnrMinDb": 30.0}, (2, 2))
    assert result["status"] == "unset"
    assert result["metrics"]["otherPsnr"]["value"] == "inf"
