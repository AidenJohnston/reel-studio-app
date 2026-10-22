"""Platform files from a finished edit, without changing project.json."""
from __future__ import annotations

import math
import struct
from pathlib import Path
from typing import Optional

from . import tools
from .probe import ffprobe_json, probe
from .proto import EngineError, progress

# Instagram's and Threads' video specs say "no edit lists". ffmpeg writes one for the B-frame delay and
# the AAC priming; without it the mov muxer stretches the first audio packet instead, so sync holds.
NO_EDIT_LIST = ["-use_editlist", "0", "-movflags", "+faststart"]


def inspect(source: Path) -> dict:
    """`probe`, plus what the platform rules check: audio bitrate, edit lists, the longest keyframe gap."""
    info = probe(source, quick=True)
    audio = next((s for s in ffprobe_json(source).get("streams", []) if s.get("codec_type") == "audio"), {})
    packets = tools.text_run([tools.ffprobe(), "-v", "error", "-select_streams", "v:0", "-show_entries",
                              "packet=pts_time,flags", "-of", "csv=p=0", str(source)], 300, "keyframe scan").stdout
    keyframes = [float(t) for t, _, flags in (line.partition(",") for line in packets.splitlines())
                 if "K" in flags and t not in ("", "N/A")]
    end = info["vduration"] or info["duration"]
    gaps = [b - a for a, b in zip(keyframes, keyframes[1:] + [end])]
    return {**info, "audioBitrate": int(audio.get("bit_rate") or 0) or None,
            "editList": _has_edit_list(source), "maxKeyframeGap": round(max(gaps, default=end), 3)}


def _has_edit_list(path: Path) -> bool:
    with open(path, "rb") as fh:
        while header := fh.read(8):
            if len(header) < 8:
                return False
            size, kind = struct.unpack(">I4s", header)
            if size == 1:
                size = struct.unpack(">Q", fh.read(8))[0] - 8
            if kind == b"moov":
                return _contains(fh.read(size - 8), [b"trak", b"edts", b"elst"])
            if size == 0:
                return False
            fh.seek(size - 8, 1)
    return False


def _contains(data: bytes, path: list) -> bool:
    off = 0
    while off + 8 <= len(data):
        size, kind = struct.unpack(">I4s", data[off:off + 8])
        if size < 8:
            return False
        if kind == path[0] and (len(path) == 1 or _contains(data[off + 8:off + size], path[1:])):
            return True
        off += size
    return False


def remux(source: Path, dest: Path) -> dict:
    """The same video stream with 128 kb/s audio and no edit list."""
    info = probe(source, quick=True)
    dest.parent.mkdir(parents=True, exist_ok=True)
    tools.ffmpeg_progress([tools.ffmpeg(), "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
                           "-i", str(source), "-map", "0:v:0", "-map", "0:a:0?", "-c:v", "copy",
                           "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2", *NO_EDIT_LIST,
                           "-progress", "pipe:1", "-nostats", str(dest)],
                          info["duration"], lambda pct: progress("export", pct, "Saving platform files"),
                          max(120, info["duration"] * 4), "platform remux")
    return {"video": str(dest), "sizeBytes": dest.stat().st_size}


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
                           *NO_EDIT_LIST, "-progress", "pipe:1", "-nostats", str(dest)],
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
