"""`frames --times t1,t2,...`: PNG stills of the edit so the AI can look at its work.

A full render that still shows the project as it is (render.current_render) is reused: its frames are
cut out of the mp4. Otherwise the stills are drawn straight from the project (render.stills), so
looking never waits for a whole preview. Both give the same frame for a time (render.frame_at), and
both move a time inside an animation to its settled end (render.settle_on_animations).
`--file` takes frames from that video, as it always did."""
from __future__ import annotations

from pathlib import Path
from typing import Optional

from . import tools
from .proto import EngineError, progress


def run(project_dir: Path, times: list, file: Optional[Path] = None, width: int = 540) -> dict:
    from . import render
    if not times:
        raise EngineError("BAD_ARGS", "no times given", "Reel Studio didn't say which moments to show.")
    project_dir = Path(project_dir)
    if file:
        return from_video(Path(file), times, width)
    src = render.current_render(project_dir)
    # The render's own animation windows: layers.json belongs to whatever was drawn last, which can be
    # another edit. A render from before they were recorded is drawn again instead.
    manifest = {} if src is None else render.render_manifest(src)
    windows = manifest.get("animations")
    if windows is None:
        return dict(render.stills(project_dir, times, width), source="edit")
    pick, moved = render.settle_on_animations(project_dir, times, windows)
    # the render's own b-roll report and warnings, as render_draft gave them
    return dict(from_video(src, pick, width), animationsSampledAtEnd=moved, source="render",
                warnings=manifest.get("warnings") or [], broll=manifest.get("broll") or [])


def from_video(src: Path, times: list, width: int) -> dict:
    from .probe import probe
    from .render import frame_at
    if not src.exists():
        raise EngineError("NO_RENDER", "no rendered video to take frames from",
                          "There's no video to look at yet. Make a preview first.")
    info = probe(src, quick=True)
    fps = info["fps"] or 30.0
    n_frames = max(1, int(round((info["vduration"] or info["duration"]) * fps)))
    out_dir = src.parent / "frames"
    out_dir.mkdir(parents=True, exist_ok=True)
    out = []
    for n, t in enumerate(times):
        k = frame_at(t, fps, n_frames)
        png = out_dir / f"{src.stem}_{k:06d}.png"
        # An input seek keeps the first frame at or after the seek time: half a frame early lands on
        # frame k whichever way the printed time rounds.
        seek = ["-ss", f"{(k - 0.5) / fps:.6f}"] if k else []
        tools.text_run([tools.ffmpeg(), "-y", "-nostdin", "-hide_banner", "-loglevel", "error",
                        *seek, "-i", str(src), "-frames:v", "1",
                        "-vf", f"scale={width}:-2", str(png)], 60, "frame grab")
        out.append({"t": round(k / fps, 3), "file": str(png)})
        progress("frames", 100 * (n + 1) / len(times), "Looking at your video")
    return {"video": str(src), "frames": out}
