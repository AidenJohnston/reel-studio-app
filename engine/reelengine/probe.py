"""`probe <file>`: what is this file? Duration, fps, size, rotation, audio, and a kind guess."""
from __future__ import annotations

import json
import re
from pathlib import Path

from . import tools
from .proto import EngineError

VIDEO_EXT = {".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm", ".mts", ".3gp"}
IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".heif", ".avif", ".bmp", ".tif", ".tiff"}
AUDIO_EXT = {".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".aif", ".aiff"}

HDR_TRANSFERS = {"arib-std-b67", "smpte2084"}


def _fps(stream) -> float:
    for key in ("avg_frame_rate", "r_frame_rate"):
        raw = stream.get(key) or "0/0"
        num, _, den = raw.partition("/")
        try:
            val = float(num) / float(den or 1)
        except (ValueError, ZeroDivisionError):
            val = 0.0
        if 0 < val < 1000:
            return round(val, 3)
    return 0.0


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
    out = {
        "path": str(path),
        "duration": round(duration, 3),
        "hasVideo": v is not None,
        "hasAudio": a is not None,
        "fps": _fps(v) if v else 0.0,
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
