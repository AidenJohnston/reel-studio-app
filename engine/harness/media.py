"""Reading renders with the pinned ffmpeg/ffprobe: frame timestamps, decoded frames, audio."""
from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path
from typing import Iterator

import numpy as np

AUDIO_RATE = 48000


def _run(cmd: list, timeout: float = 600) -> subprocess.CompletedProcess:
    p = subprocess.run([str(c) for c in cmd], capture_output=True, timeout=timeout, stdin=subprocess.DEVNULL)
    if p.returncode != 0:
        raise RuntimeError(f"{Path(str(cmd[0])).name} failed ({p.returncode}): "
                           f"{p.stderr.decode('utf-8', 'replace')[-800:]}")
    return p


def probe(ffprobe: str, path: Path) -> dict:
    out = _run([ffprobe, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", path]).stdout
    return json.loads(out)


def video_size(ffprobe: str, path: Path) -> tuple:
    v = next(s for s in probe(ffprobe, path)["streams"] if s["codec_type"] == "video")
    return int(v["width"]), int(v["height"])


def video_pts(ffprobe: str, path: Path) -> list:
    """Presentation times (s) of every video packet, sorted: the frames a player shows, read
    without decoding."""
    out = _run([ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time",
                "-of", "csv=p=0", path]).stdout.decode()
    return sorted(float(x) for x in out.split() if x and x != "N/A")


def iter_frames(ffmpeg: str, path: Path, width: int, height: int) -> Iterator[np.ndarray]:
    """Every frame of `path` in presentation order, scaled to width x height with area averaging
    (how the reference final is "scaled to preview size"), as uint8 RGB arrays."""
    cmd = [ffmpeg, "-nostdin", "-v", "error", "-i", path, "-map", "0:v:0", "-fps_mode", "passthrough",
           "-vf", f"scale={width}:{height}:flags=area", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    # A damaged clip can fill a stderr pipe while we wait for its next frame.
    with tempfile.TemporaryFile() as errors:
        p = subprocess.Popen([str(c) for c in cmd], stdout=subprocess.PIPE, stderr=errors,
                             stdin=subprocess.DEVNULL)
        size = width * height * 3
        finished = False
        try:
            while True:
                buf = p.stdout.read(size)
                if len(buf) < size:
                    finished = True
                    break
                yield np.frombuffer(buf, dtype=np.uint8).reshape(height, width, 3)
        finally:
            if not finished:            # the caller stopped early: not a decode failure
                p.kill()
            p.stdout.close()
            code = p.wait()
        if code != 0:
            errors.seek(0, 2)
            errors.seek(max(0, errors.tell() - 800))
            err = errors.read().decode("utf-8", "replace")
            raise RuntimeError(f"decoding {Path(path).name} failed ({code}): {err}")


def read_image(path: Path) -> np.ndarray:
    from PIL import Image
    with Image.open(path) as im:
        return np.asarray(im.convert("RGB"), dtype=np.uint8)


def audio_mono(ffmpeg: str, path: Path, start: float = 0.0, duration: float = None) -> np.ndarray:
    """The first audio stream decoded to float mono at 48 kHz, optionally a slice of it."""
    cmd = [ffmpeg, "-nostdin", "-v", "error"]
    if start:
        cmd += ["-ss", f"{start:.6f}"]
    cmd += ["-i", path]
    if duration is not None:
        cmd += ["-t", f"{duration:.6f}"]
    cmd += ["-map", "0:a:0", "-ac", "1", "-ar", str(AUDIO_RATE), "-f", "f32le", "-"]
    return np.frombuffer(_run(cmd).stdout, dtype=np.float32)


def audio_timing(ffprobe: str, path: Path) -> list:
    """When each audio packet plays, as exact seconds (pts and duration times the time base), so
    two files that write the same times in different units compare equal. Identical payloads at
    different times are not identical audio."""
    from fractions import Fraction
    info = json.loads(_run([ffprobe, "-v", "error", "-select_streams", "a:0", "-show_entries",
                            "stream=time_base:packet=pts,duration", "-print_format", "json", path]).stdout)
    tb = Fraction(info["streams"][0]["time_base"])
    return [(Fraction(int(p["pts"])) * tb, Fraction(int(p.get("duration") or 0)) * tb)
            for p in info.get("packets", []) if p.get("pts") not in (None, "N/A")]


def audio_lead(ffprobe: str, path: Path) -> float:
    """Seconds the first audio sample plays after the first video frame (negative = before). Raw
    decoded samples drop this, so a preview whose audio is merely timestamped late would look in
    sync without it."""
    streams = probe(ffprobe, path)["streams"]
    start = {s["codec_type"]: float(s.get("start_time") or 0.0) for s in streams if s["codec_type"] in ("audio", "video")}
    return start.get("audio", 0.0) - start.get("video", 0.0)


def video_packets_md5(ffmpeg: str, path: Path) -> str:
    """md5 of the encoded video packets. Two finals of the same picture (libx264 is deterministic) match."""
    out = _run([ffmpeg, "-nostdin", "-v", "error", "-i", path, "-map", "0:v:0", "-c", "copy",
                "-f", "md5", "-"]).stdout.decode().strip()
    return out.split("=", 1)[-1]


def audio_packets_md5(ffmpeg: str, path: Path) -> str:
    """md5 of the encoded audio packets: "audio bytes identical" means this matches."""
    out = _run([ffmpeg, "-nostdin", "-v", "error", "-i", path, "-map", "0:a:0", "-c", "copy",
                "-f", "md5", "-"]).stdout.decode().strip()
    return out.split("=", 1)[-1]
