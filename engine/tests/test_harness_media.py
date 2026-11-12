"""Media checks using decoded samples and fake processes, without FFmpeg or media files."""
from pathlib import Path
import subprocess
import sys
import threading

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


@pytest.mark.parametrize("millisecond_seek", [True, False])
def test_still_comparison_uses_the_engines_seek_precision(monkeypatch, millisecond_seek):
    fps = 29.97
    frames = [np.full((2, 2, 3), n, dtype=np.uint8) for n in (0, 100, 200)]
    monkeypatch.setattr(media, "read_image", lambda path: frames[2 if millisecond_seek else 1])
    monkeypatch.setattr(media, "video_pts", lambda *args: [0.0, 2 / fps, 3 / fps])
    monkeypatch.setattr(media, "iter_frames", lambda *args: iter(frames))
    monkeypatch.setattr(media, "video_size", lambda *args: (2, 2))
    # 2/fps is 0.066733...; frames.py seeks to 0.067, after that frame's start.
    result = checks.check_still("ffmpeg", "ffprobe", Path("ref.mp4"), Path("still.png"), 2 / fps,
                                [], {"otherPsnrMinDb": 30.0}, (2, 2), millisecond_seek=millisecond_seek)
    assert result["status"] == "unset"
    assert result["metrics"]["otherPsnr"]["value"] == "inf"


@pytest.mark.parametrize("exit_code", [0, 7])
def test_frame_decoder_handles_stderr_larger_than_a_pipe(monkeypatch, exit_code):
    popen = subprocess.Popen
    children, timers = [], []
    script = ("import sys; sys.stderr.buffer.write(b'x' * (2 * 1024 * 1024) + b'damaged clip'); "
              "sys.stderr.buffer.flush(); sys.stdout.buffer.write(bytes([10, 20, 30])); "
              f"sys.stdout.buffer.flush(); sys.exit({exit_code})")

    def decoder(cmd, **kwargs):
        child = popen([sys.executable, "-c", script], **kwargs)
        children.append(child)
        # Bound the regression case: an undrained stderr pipe prevents the RGB frame from arriving.
        timer = threading.Timer(10, child.kill)
        timers.append(timer)
        timer.start()
        return child

    monkeypatch.setattr(media.subprocess, "Popen", decoder)
    frames = media.iter_frames("ffmpeg", Path("damaged.mp4"), 1, 1)
    try:
        assert next(frames).tolist() == [[[10, 20, 30]]]
        if exit_code:
            with pytest.raises(RuntimeError, match=r"failed \(7\): .*damaged clip"):
                next(frames)
        else:
            assert list(frames) == []
    finally:
        frames.close()
        for timer in timers:
            timer.cancel()
            timer.join()
        for child in children:
            if child.poll() is None:
                child.kill()
            child.wait()
