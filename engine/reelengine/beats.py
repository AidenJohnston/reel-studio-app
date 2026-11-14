"""The song's beat grid, and landing edit moments on it.

`project.music.beats` stores the grid once, when the song is chosen: `{"fps", "frames", "seconds",
"sha256"}`, each beat a whole frame of SONG time (`quantise`), with the song's length and the SHA-256 of
the file it was measured on. Storing it, instead of re-detecting beats at every render, keeps a
project deterministic: the same project.json lands the same cuts on the same frames on any machine,
whatever the beat tracker or numpy version does. A grid whose hash is not the current song's (the song
was changed by hand) is ignored: nothing lands on another song's beats.

`effective_start` is the one rule for where the song really starts: the mixer plays from there and
the grid is read from there, so the beats the edits land on are the beats that are heard.

`project.music.onBeat` lists what lands on beats: "cuts" (jump cuts, cut.build_timeline), "zooms"
(punch-ins, zoom.build_zooms) and "broll" (entrances, broll.plan_windows). Each moves at most a few
frames to the nearest beat and never past the limits its own module sets.

No numpy; the only file it reads is the song, to hash it.
"""
from __future__ import annotations

import bisect
import hashlib
from functools import lru_cache
from pathlib import Path
from typing import Optional, Sequence

KINDS = ("cuts", "zooms", "broll")
END_MARGIN = 1.0      # a start this close to the song's end (or past it) starts the song from the top


def quantise(beats: Sequence[float], fps: float, seconds: float, sha256: str) -> dict:
    """Beat times in song seconds -> the stored grid (frames sorted, no duplicates)."""
    return {"fps": fps, "frames": sorted({int(round(b * fps)) for b in beats if b >= 0}),
            "seconds": round(float(seconds), 2), "sha256": sha256}


def effective_start(start_at: float, seconds: float) -> float:
    """Where the song really starts: music.startAt, or the top of the song when startAt leaves less than
    END_MARGIN of it to play. `seconds` is the song's length (rounded to 0.01 s, as the grid stores it)."""
    start_at = max(0.0, float(start_at or 0.0))
    return start_at if start_at < round(float(seconds), 2) - END_MARGIN else 0.0


def file_sha256(path: Path) -> str:
    st = Path(path).stat()
    return _sha256(str(Path(path).resolve()), st.st_size, st.st_mtime_ns)


@lru_cache(maxsize=16)
def _sha256(path: str, size: int, mtime_ns: int) -> str:      # size and mtime key the cache only
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def song_path(project_dir, proj: dict, root=None) -> Optional[Path]:
    """The file the mix plays (project.song_ref: the frozen copy of a Library song while it is current), or
    None (no song, music off, or the file is missing). The grid is checked against this file, so a Library
    song replaced or deleted since it was frozen still lands the edit on the beats heard."""
    m = (proj or {}).get("music") or {}
    if not (m.get("enabled", True) and m.get("track")):
        return None
    from .project import song_ref
    from .proto import EngineError
    from .safepath import safe_resolve
    try:
        p = safe_resolve(Path(project_dir), song_ref(m), root=Path(root) if root else None, what="music")
    except EngineError:
        return None
    return p if p.is_file() else None


def output_grid(proj: dict, song: Optional[Path]) -> list[float]:
    """The beats on the output clock (song beat minus the effective start), on the output frame grid.
    Empty when no song plays, or the stored grid was not measured on `song` (the file playing)."""
    m = (proj or {}).get("music") or {}
    grid = m.get("beats") or {}
    if song is None or not (grid.get("frames") and grid.get("fps") and grid.get("seconds")):
        return []
    if grid.get("sha256") != file_sha256(song):
        return []
    fps_out = float(((proj.get("format") or {}).get("fps")) or 30)
    start = effective_start(m.get("startAt") or 0.0, grid["seconds"])
    gfps = float(grid["fps"])
    out = {round((f / gfps - start) * fps_out) / fps_out for f in grid["frames"]}
    return sorted(t for t in out if t >= 0)


def synced(proj: dict, kind: str, song: Optional[Path]) -> list[float]:
    """The output grid if `kind` lands on beats in this project, else []."""
    if kind not in (((proj or {}).get("music") or {}).get("onBeat") or []):
        return []
    return output_grid(proj, song)


def ctx_synced(ctx, kind: str) -> list[float]:
    """`synced` for a render context (its project, folder and Reel Studio root)."""
    if kind not in (((ctx.project or {}).get("music") or {}).get("onBeat") or []):
        return []
    return output_grid(ctx.project, song_path(ctx.project_dir, ctx.project, getattr(ctx, "root", None)))


def snap(t: float, grid: Sequence[float], early: float, late: float) -> float:
    """The nearest beat at most `early` seconds before t or `late` seconds after it; t when none is."""
    best = nearest(t, grid, t - early, t + late)
    return t if best is None else best


def nearest(t: float, grid: Sequence[float], lo: float, hi: float) -> Optional[float]:
    """The beat in [lo, hi] closest to t (the earlier on a tie), or None."""
    k = bisect.bisect_left(grid, lo)
    best = None
    while k < len(grid) and grid[k] <= hi + 1e-9:
        if best is None or abs(grid[k] - t) < abs(best - t) - 1e-9:
            best = grid[k]
        k += 1
    return best


def next_beat(t: float, grid: Sequence[float], within: float) -> Optional[float]:
    """The first beat at or after t, if it is at most `within` seconds away."""
    k = bisect.bisect_left(grid, t - 1e-9)
    return grid[k] if k < len(grid) and grid[k] - t <= within else None
