"""Platform files from a finished edit, without changing project.json."""
from __future__ import annotations

import math
from pathlib import Path
from typing import Optional

from . import tools
from .probe import probe
from .proto import EngineError, progress


def encode(source: Path, dest: Path, width: int, height: int, bitrate: int) -> dict:
    if (width, height) not in ((1080, 1920), (720, 1280)) or not 128_000 <= bitrate <= 8_000_000:
        raise EngineError("BAD_ARGS", "invalid export dimensions or bitrate", "The export settings are invalid.")
    info = probe(source, quick=True)
    dest.parent.mkdir(parents=True, exist_ok=True)
    vf = (f"scale={width}:{height}:force_original_aspect_ratio=decrease:force_divisible_by=2,"
          f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30")
    tools.ffmpeg_progress([tools.ffmpeg(), "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
                           "-i", str(source), "-map", "0:v:0", "-map", "0:a:0?", "-vf", vf,
                           "-c:v", "libx264", "-preset", "medium", "-profile:v", "high", "-b:v", str(bitrate),
                           "-maxrate", str(bitrate), "-bufsize", str(bitrate * 2), "-pix_fmt", "yuv420p",
                           "-g", "60", "-flags", "+cgop", "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
                           "-movflags", "+faststart", "-progress", "pipe:1", "-nostats", str(dest)],
                          info["duration"], lambda pct: progress("export", pct, "Saving platform files"),
                          max(600, info["duration"] * 40), "platform export")
    return {"video": str(dest), "sizeBytes": dest.stat().st_size}


def cover(source: Path, dest: Path, at: Optional[float]) -> dict:
    """A JPEG from `source`: the frame at `at` seconds of a video, or the whole picture when `at` is None."""
    seek = []
    if at is not None:
        info = probe(source, quick=True)
        if not math.isfinite(at) or not 0 <= at <= info["duration"]:
            raise EngineError("BAD_ARGS", "invalid cover timestamp", "Choose a cover frame inside the video.")
        # A seek onto the last frame or two decodes nothing, so the end of the scrub bar uses an earlier frame.
        end = info["vduration"] or info["duration"]
        seek = ["-ss", str(max(0.0, min(at, end - 2 / (info["fps"] or 30))))]
    dest.parent.mkdir(parents=True, exist_ok=True)
    # out_range=full: ffmpeg 9's JPEG encoder refuses limited-range input whose colour matrix is untagged.
    tools.text_run([tools.ffmpeg(), "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
                    *seek, "-i", str(source), "-frames:v", "1", "-vf", "scale=out_range=full", "-q:v", "2", str(dest)],
                   120, "export cover", user_message="I could not make the cover. Pick another frame and try again.")
    return {"cover": str(dest)}
