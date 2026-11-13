"""`frames --render-id r_... --times t1,t2,...`: PNG stills from that one render so the AI can look
at its work. Never "the newest video": a render replaced since is refused (render_identity.py)."""
from __future__ import annotations

from pathlib import Path
from typing import Optional

from . import render_identity, tools
from .proto import EngineError, progress


def run(project_dir: Path, times: list, render_id: Optional[str] = None, file: Optional[Path] = None,
        width: int = 540) -> dict:
    if render_id:
        bound = render_identity.resolve(project_dir, render_id)
    elif file:
        bound = render_identity.for_file(file)
    else:
        raise EngineError("BAD_ARGS", "frames needs --render-id or --file",
                          "Reel Studio didn't say which video to look at.")
    src = bound["video"]
    if not times:
        raise EngineError("BAD_ARGS", "no times given", "Reel Studio didn't say which moments to show.")
    from .probe import probe
    dur = probe(src, quick=True)["duration"]
    out_dir = src.parent / "frames"
    out_dir.mkdir(parents=True, exist_ok=True)
    out = []
    for n, t in enumerate(times):
        t = max(0.0, min(float(t), max(0.0, dur - 0.05)))
        png = out_dir / f"{src.stem}_{t:07.2f}.png"
        tools.text_run([tools.ffmpeg(), "-y", "-nostdin", "-hide_banner", "-loglevel", "error",
                        "-ss", f"{t:.3f}", "-i", str(src), "-frames:v", "1",
                        "-vf", f"scale={width}:-2", str(png)], 60, "frame grab")
        out.append({"t": round(t, 3), "file": str(png)})
        progress("frames", 100 * (n + 1) / len(times), "Looking at your video")
    return {"renderId": bound["manifest"]["renderId"], "video": str(src), "frames": out}
