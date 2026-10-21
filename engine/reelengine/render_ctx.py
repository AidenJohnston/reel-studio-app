"""Shared render-time data types (docs/architecture.md section 5).

A1 (engine-core) owns this file. A2 (engine-compositing) imports it to build
b-roll layers, zoom spans, the music mix and the cover. Keep it dependency-free:
anything here may be imported by any module without pulling in ffmpeg or numpy.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional


@dataclass
class Segment:
    """One kept span of a source, placed on the output timeline.

    src_start/src_end are seconds in the source file; out_start is where the
    span begins in the rendered output. Its output length is src_end - src_start.
    """

    source: str          # source id, e.g. "s1"
    src_start: float
    src_end: float
    out_start: float
    # the inclusive word-id range this segment came from (first, last); informational
    first_word: Optional[str] = None
    last_word: Optional[str] = None

    @property
    def duration(self) -> float:
        return self.src_end - self.src_start

    @property
    def out_end(self) -> float:
        return self.out_start + self.duration


@dataclass
class Layer:
    """An overlay drawn on top of the cut video between t0 and t1 (output seconds).

    x, y, w, h are in output pixels (top-left origin). kind is 'image' or 'video'.
    Layers are composited in ascending z; captions are always drawn above every layer.
    """

    path: Path
    kind: str            # 'image' | 'video'
    t0: float
    t1: float
    x: int
    y: int
    w: int
    h: int
    rotate_deg: float = 0.0
    z: int = 0
    fade_in: float = 0.0
    fade_out: float = 0.0


@dataclass
class ZoomSpan:
    """Punch-in on the cut video between t0 and t1 (output seconds).

    scale > 1 zooms in; (cx, cy) is the zoom centre in output pixels.
    """

    t0: float
    t1: float
    scale: float
    cx: float
    cy: float


@dataclass
class RenderCtx:
    project: dict
    project_dir: Path
    root: Path                                   # Reel Studio root (resolves "Library/...")
    out_timeline: list[Segment]                  # cut segments in output order
    word_out_time: Callable[[str], float]        # word id -> output seconds (word start)
    duration: float                              # output duration, seconds
    fmt: dict                                    # {"width", "height", "fps"} of the output
    draft: bool
    work: Path                                   # <project>/work
    ffmpeg: str
    ffprobe: str
    progress: Callable[[str, float, str], None]  # (stage, pct 0-100, user-facing message)
    # --- optional extras (added fields only; A2 may rely on them being present) ---
    word_out_end: Optional[Callable[[str], float]] = None   # word id -> output seconds (word end)
    words: list = field(default_factory=list)               # transcript words (dicts) for the project
    face_box: Optional[dict] = None                         # output-space face box {x,y,w,h} or None
    window: Optional[tuple] = None                          # (a, b) output seconds when --window used
    out_dir: Optional[Path] = None                          # versions/vN

    staged_dir: Optional[Path] = None                       # optional read overlay for new work assets

    def resolve_path(self, p: str) -> Path:
        """Resolve a project.json asset path: 'Library/...' against root, else project-relative.
        Raises EngineError UNSAFE_PATH for anything outside media/, work/ or root/Library."""
        from .safepath import resolve_input
        return resolve_input(self.project_dir, p, root=self.root, staged_dir=self.staged_dir)
