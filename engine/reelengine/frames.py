"""`frames --times t1,t2,... [--words w1,...]`: PNG stills so the AI can look at its work.

`--render-id r_...` takes them from that one render and never "the newest video": a render replaced
since is refused (render_identity.py). `--file` takes them from that video's own render. With neither,
they show the edit as it is now (a note's private copy with `--project-file`): a full render that still
shows it is reused (render.current_render, bound by its render id), and otherwise the stills are drawn
straight from the project (render.stills), so looking never waits for a whole preview. Every path shows
the nearest output frame for a time (render.frame_at); the edit's paths also move a time inside an
animation to its settled end (render.settle_on_animations). `--words` adds the middle of each word on
the timeline being shown."""
from __future__ import annotations

from pathlib import Path
from typing import Optional

from . import render_identity, tools
from .proto import EngineError, progress


def run(project_dir: Path, times: list, render_id: Optional[str] = None, file: Optional[Path] = None,
        width: int = 540, project_file: Optional[Path] = None, words: Optional[list] = None) -> dict:
    from . import render
    project_dir = Path(project_dir).resolve()
    out_dir = project_dir / "work" / "frames"      # never inside a saved version
    if render_id or file:
        bound = render_identity.resolve(project_dir, render_id) if render_id else render_identity.for_file(file)
        times = [*times, *render.word_times(bound["manifest"].get("words") or [], words)]
        _need(times)
        return dict(from_video(bound["video"], times, width, out_dir), renderId=bound["manifest"]["renderId"])
    bound = render.current_render(project_dir, project_file)
    if bound is None:
        return dict(render.stills(project_dir, times, width, project_file=project_file, words=words), source="edit")
    man = bound["manifest"]
    times = [*times, *render.word_times(man.get("words") or [], words)]
    _need(times)
    pick, moved = render.settle_on_animations(man.get("layerItems") or [], times)
    return dict(from_video(bound["video"], pick, width, out_dir), renderId=man["renderId"],
                animationsSampledAtEnd=moved, source="render")


def _need(times: list) -> None:
    if not times:
        raise EngineError("BAD_ARGS", "no times given", "Reel Studio didn't say which moments to show.")


def from_video(src: Path, times: list, width: int, out_dir: Path) -> dict:
    from .probe import probe
    from .render import frame_at
    if not src.exists():
        raise EngineError("NO_RENDER", "no rendered video to take frames from",
                          "There's no video to look at yet. Make a preview first.")
    info = probe(src, quick=True)
    fps = info["fps"] or 30.0
    n_frames = max(1, int(round((info["vduration"] or info["duration"]) * fps)))
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
