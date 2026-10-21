from contextlib import closing
import hashlib
import math
import subprocess

from reelengine import compose_util


def _clip(path):
    subprocess.run([compose_util.ffmpeg_bin(), "-y", "-v", "error", "-f", "lavfi",
                    "-i", "testsrc2=s=160x90:r=30:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p",
                    str(path)], check=True)


def _old_window(path, times, width):
    info = compose_util.probe(path)
    w = width // 2 * 2
    h = round(info["height"] * w / info["width"]) // 2 * 2
    fps = float(info["fps"])
    a, b = max(0.0, times[0]), times[-1] + 2.0 / fps
    raw = subprocess.run([compose_util.ffmpeg_bin(), "-v", "error", "-nostdin", "-ss", f"{a:.3f}",
                          "-i", str(path), "-t", f"{b - a:.3f}", "-an",
                          "-vf", f"scale={w}:{h}:flags=area", "-f", "rawvideo", "-pix_fmt", "bgr24", "-"],
                         capture_output=True, check=True).stdout
    size = w * h * 3
    n = len(raw) // size
    t0 = round(a, 3)
    hashes = []
    for t in times:
        k = min(n - 1, max(0, int(math.ceil((t - t0) * fps - 1e-6))))
        hashes.append(hashlib.sha256(raw[k * size:(k + 1) * size]).hexdigest())
    return hashes


def test_dense_window_stream_matches_buffered_frames(tmp_path):
    path = tmp_path / "clip.mp4"
    _clip(path)
    times = [0.1, 0.1, 0.37, 0.8, 1.1, 1.6, 2.1, 2.4]
    expected = _old_window(path, times, 80)
    actual = [hashlib.sha256(frame.tobytes()).hexdigest()
              for _, frame in compose_util.decode_frames(path, 1, 80, times=times)]
    assert actual == expected


def test_dense_window_reaps_ffmpeg_when_consumer_stops(tmp_path, monkeypatch):
    path = tmp_path / "clip.mp4"
    _clip(path)
    started = []
    original = compose_util.subprocess.Popen

    def popen(*args, **kwargs):
        proc = original(*args, **kwargs)
        started.append(proc)
        return proc

    monkeypatch.setattr(compose_util.subprocess, "Popen", popen)
    with closing(compose_util.decode_frames(path, 1, 80, times=[0.1, 0.2, 0.3, 0.4])) as frames:
        next(frames)
        child = started[-1]
        assert child.poll() is None
    assert child.returncode is not None
    assert child.stdout.closed
