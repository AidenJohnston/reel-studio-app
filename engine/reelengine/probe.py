"""`probe <file>`: what is this file? Duration, fps, size, rotation, audio, and a kind guess."""
from __future__ import annotations

import json
import re
from fractions import Fraction
from pathlib import Path

from . import tools
from .proto import EngineError

VIDEO_EXT = {".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm", ".mts", ".3gp"}
IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".heif", ".avif", ".bmp", ".tif", ".tiff"}
AUDIO_EXT = {".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".aif", ".aiff"}

HDR_TRANSFERS = {"arib-std-b67", "smpte2084"}
STANDARD_FPS = (24000 / 1001, 24.0, 25.0, 30000 / 1001, 30.0, 48.0, 50.0, 60000 / 1001, 60.0)


def _rate(raw) -> float:
    try:
        val = float(Fraction(raw or "0/0"))
    except (ValueError, ZeroDivisionError):
        return 0.0
    return round(val, 3) if 0 < val < 1000 else 0.0


def _fps(stream) -> float:
    for key in ("avg_frame_rate", "r_frame_rate"):
        val = _rate(stream.get(key))
        if val:
            return val
    return 0.0


def _window_rate(path: Path, stream: dict, start: float) -> tuple[float, float] | None:
    proc = tools.text_run([
        tools.ffprobe(), "-v", "error", "-select_streams", str(stream["index"]),
        "-read_intervals", f"{start:.3f}%+#120", "-show_entries", "packet=pts,dts", "-of", "json", str(path)
    ], 30, f"sample frame cadence for {path.name}", check=False)
    if proc.returncode:
        return None
    packets = json.loads(proc.stdout or "{}").get("packets", [])
    if any("pts" not in packet for packet in packets):
        return None
    timestamps = sorted(packet["pts"] for packet in packets)
    # Future packets can still fill presentation-time gaps after the last sampled decode time.
    if stream.get("has_b_frames"):
        decode_times = [packet["dts"] for packet in packets if "dts" in packet]
        if not decode_times:
            return None
        last_decode_time = max(decode_times)
        timestamps = [pts for pts in timestamps if pts <= last_decode_time]
    if len(timestamps) < 5:
        return None
    cadence = (timestamps[-1] - timestamps[0]) / (len(timestamps) - 1)
    if cadence <= 0:
        return None
    tolerance = max(1.0, cadence * 0.01)
    if any(b <= a or abs(b - a - cadence) > tolerance for a, b in zip(timestamps, timestamps[1:])):
        return None
    timebase = Fraction(stream.get("time_base") or "0/1")
    if timebase <= 0:
        return None
    rate = 1 / (cadence * float(timebase))
    standard = min(STANDARD_FPS, key=lambda candidate: abs(candidate - rate))
    expected_ticks = 1.0 / (standard * float(timebase))
    if all(abs(pts - timestamps[0] - i * expected_ticks) <= 1.000001 for i, pts in enumerate(timestamps)):
        rate = standard
    return rate, rate / (timestamps[-1] - timestamps[0])


def _sample_frame_cadence(path: Path, stream: dict, duration: float) -> tuple[float, bool]:
    """Check bounded packet windows across the stream and its whole-frame count."""
    duration = float(stream.get("duration") or duration)
    starts = {max(0.0, (duration - 2.0) * i / 3) for i in range(4)}
    windows = [_window_rate(path, stream, start) for start in sorted(starts)]
    if any(window is None for window in windows):
        return 0.0, True
    rate, tolerance = windows[0]
    if any(abs(other - rate) > tolerance + error for other, error in windows[1:]):
        return 0.0, True
    frame_count = stream.get("nb_frames") or stream.get("nb_read_packets")
    try:
        frame_count = int(frame_count)
    except (TypeError, ValueError):
        return 0.0, True
    timebase = float(Fraction(stream.get("time_base") or "0/1"))
    if abs(frame_count - duration * rate) > 1.0 + rate * timebase:
        return 0.0, True
    return rate, False


def _rotation(stream) -> int:
    """CLOCKWISE degrees the stored picture must be turned to display upright (0/90/180/270).
    ffprobe's display-matrix value is counter-clockwise (an upright iPhone portrait MOV reports
    -90, i.e. 90 clockwise); the legacy `rotate` tag is already clockwise."""
    for sd in stream.get("side_data_list") or []:
        if "rotation" in sd:
            try:
                return int(round(-float(sd["rotation"]) / 90.0)) * 90 % 360
            except (TypeError, ValueError):
                pass
    tag = (stream.get("tags") or {}).get("rotate")
    if tag:
        try:
            return int(round(float(tag) / 90.0)) * 90 % 360
        except ValueError:
            pass
    return 0


def ffprobe_json(path: Path) -> dict:
    proc = tools.text_run([tools.ffprobe(), "-v", "error", "-print_format", "json",
                           "-show_format", "-show_streams", str(path)], 120,
                          f"ffprobe {path.name}", check=False)
    if proc.returncode != 0:
        raise EngineError("UNREADABLE", f"ffprobe could not read {path}: {proc.stderr[-500:]}",
                          "I couldn't open this file. It may not be a video, or it may be damaged.")
    return json.loads(proc.stdout or "{}")


def probe(path: Path, quick: bool = False) -> dict:
    path = Path(path)
    if not path.exists():
        raise EngineError("NOT_FOUND", f"no such file: {path}",
                          "I couldn't find that file. It may have been moved or deleted.")
    ext = path.suffix.lower()
    info = ffprobe_json(path)
    fmt = info.get("format", {}) or {}
    streams = info.get("streams", []) or []
    v = next((s for s in streams if s.get("codec_type") == "video"
              and not (s.get("disposition") or {}).get("attached_pic")), None)
    a = next((s for s in streams if s.get("codec_type") == "audio"), None)
    duration = float(fmt.get("duration") or 0.0)
    cadence_fps, sampled_vfr = _sample_frame_cadence(path, v, duration) if v and ext not in IMAGE_EXT else (0.0, False)
    out = {
        "path": str(path),
        "duration": round(duration, 3),
        "hasVideo": v is not None,
        "hasAudio": a is not None,
        "fps": cadence_fps or (_fps(v) if v else 0.0),
        "variableFrameRate": sampled_vfr,
        "width": int(v.get("width") or 0) if v else 0,
        "height": int(v.get("height") or 0) if v else 0,
        "rotation": _rotation(v) if v else 0,
        "vcodec": v.get("codec_name") if v else None,
        "acodec": a.get("codec_name") if a else None,
        "pixFmt": v.get("pix_fmt") if v else None,
        "colorTransfer": (v.get("color_transfer") if v else None),
        "vduration": round(float(v.get("duration") or 0.0), 3) if v else 0.0,
        "sizeBytes": path.stat().st_size,
    }
    w, h = out["width"], out["height"]
    if out["rotation"] in (90, 270):
        w, h = h, w
    out["displayWidth"], out["displayHeight"] = w, h
    out["hdr"] = (out["colorTransfer"] or "") in HDR_TRANSFERS
    out["kind"] = guess_kind(path, out, quick=quick)
    return out


def guess_kind(path: Path, info: dict, quick: bool = False) -> str:
    ext = path.suffix.lower()
    if ext in IMAGE_EXT or (info["hasVideo"] and info["duration"] <= 0.05 and not info["hasAudio"]):
        return "image"
    if not info["hasVideo"] or ext in AUDIO_EXT:
        return "music" if info["hasAudio"] else "unknown"
    if not info["hasAudio"]:
        return "broll_video"
    # A video with sound: a talking head has steady voice-level audio for most of its length.
    # Short clips (< 12 s) are almost always b-roll even when they carry sound.
    if info["duration"] < 12.0:
        return "broll_video"
    if quick:
        return "talking_head"
    voiced = voiced_fraction(path, min(info["duration"], 90.0))
    info["voicedFraction"] = voiced
    return "talking_head" if voiced >= 0.35 else "broll_video"


def voiced_fraction(path: Path, seconds: float) -> float:
    """Share of the first `seconds` that is above -35 dB (silencedetect inverted). Cheap: audio only."""
    proc = tools.text_run([tools.ffmpeg(), "-hide_banner", "-nostats", "-t", f"{seconds:.2f}",
                           "-i", str(path), "-vn", "-af", "silencedetect=noise=-35dB:d=0.4",
                           "-f", "null", "-"], 300, "silencedetect", check=False)
    log = proc.stderr or ""
    starts = [float(x) for x in re.findall(r"silence_start:\s*(-?[0-9.]+)", log)]
    ends = [float(x) for x in re.findall(r"silence_end:\s*([0-9.]+)", log)]
    silent = 0.0
    for i, s in enumerate(starts):
        e = ends[i] if i < len(ends) else seconds
        silent += max(0.0, min(e, seconds) - max(0.0, s))
    return round(max(0.0, 1.0 - silent / max(seconds, 1e-6)), 3)
