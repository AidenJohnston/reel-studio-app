"""The song's beat grid, and landing edit moments on it.

`project.music.beats` stores the grid once, when the song is chosen: `{"fps", "frames"}`, each beat a
whole frame of SONG time (`quantise`). Storing it, instead of re-detecting beats at every render,
keeps a project deterministic: the same project.json lands the same cuts on the same frames on any
machine, whatever the beat tracker or numpy version does.

`project.music.onBeat` lists what lands on beats: "cuts" (jump cuts, cut.build_timeline), "zooms"
(punch-ins, zoom.build_zooms) and "broll" (entrances, broll.plan_windows). Each moves at most a few
frames to the nearest beat and never past the limits its own module sets.

Pure functions; no numpy.
"""
from __future__ import annotations

import bisect
from typing import Optional, Sequence

KINDS = ("cuts", "zooms", "broll")


def quantise(beats: Sequence[float], fps: float) -> dict:
    """Beat times in song seconds -> the stored grid {"fps", "frames"} (sorted, no duplicates)."""
    return {"fps": fps, "frames": sorted({int(round(b * fps)) for b in beats if b >= 0})}


def output_grid(proj: dict) -> list[float]:
    """The beats on the output clock (song beat minus music.startAt), on the output frame grid.
    Empty when there is no song playing or no stored grid."""
    m = (proj or {}).get("music") or {}
    grid = m.get("beats") or {}
    if not (m.get("enabled", True) and m.get("track") and grid.get("frames") and grid.get("fps")):
        return []
    fps_out = float(((proj.get("format") or {}).get("fps")) or 30)
    start = float(m.get("startAt") or 0.0)
    gfps = float(grid["fps"])
    out = {round((f / gfps - start) * fps_out) / fps_out for f in grid["frames"]}
    return sorted(t for t in out if t >= 0)


def synced(proj: dict, kind: str) -> list[float]:
    """The output grid if `kind` lands on beats in this project, else []."""
    if kind not in (((proj or {}).get("music") or {}).get("onBeat") or []):
        return []
    return output_grid(proj)


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
