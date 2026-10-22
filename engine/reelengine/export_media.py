"""Encode a finished edit for an export target without changing project.json."""
from __future__ import annotations

import math
from pathlib import Path

from . import tools
from .probe import probe
from .proto import EngineError


def run(source: Path, dest: Path, width: int, height: int, bitrate: int, cover_at: float) -> dict:
    if (width, height) not in ((1080, 1920), (720, 1280)) or not 128_000 <= bitrate <= 8_000_000:
        raise EngineError("BAD_ARGS", "invalid export dimensions or bitrate", "The export settings are invalid.")
    info = probe(source, quick=True)
    if not info["hasVideo"] or not math.isfinite(cover_at) or not 0 <= cover_at < info["duration"]:
        raise EngineError("BAD_ARGS", "invalid cover timestamp", "Choose a cover time inside the video.")
    dest.parent.mkdir(parents=True, exist_ok=True)
    vf = (f"scale={width}:{height}:force_original_aspect_ratio=decrease:force_divisible_by=2,"
          f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30")
    tools.text_run([tools.ffmpeg(), "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
                    "-i", str(source), "-map", "0:v:0", "-map", "0:a:0?", "-vf", vf,
                    "-c:v", "libx264", "-preset", "medium", "-b:v", str(bitrate),
                    "-maxrate", str(bitrate), "-bufsize", str(bitrate * 2), "-pix_fmt", "yuv420p", "-g", "60", "-flags", "+cgop",
                    "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
                    "-movflags", "+faststart", str(dest)], 7200, "platform export")
    cover = dest.with_suffix(".jpg")
    tools.text_run([tools.ffmpeg(), "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
                    "-ss", str(cover_at), "-i", str(dest), "-frames:v", "1", "-q:v", "2", str(cover)], 120, "export cover")
    return {"video": str(dest), "cover": str(cover), "sizeBytes": dest.stat().st_size}
