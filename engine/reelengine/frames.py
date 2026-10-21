"""`frames --times t1,t2,...`: PNG stills from the latest render so the AI can look at its work."""
from __future__ import annotations

from pathlib import Path
from typing import Optional

from . import tools
from .proto import EngineError, progress


def run(project_dir: Path, times: list, file: Optional[Path] = None, width: int = 540,
        out: Optional[Path] = None) -> dict:
    from .render import latest_render
    project_dir = Path(project_dir)
    src = Path(file) if file else latest_render(project_dir)
    if src is None or not src.exists():
        raise EngineError("NO_RENDER", "no rendered video to take frames from",
                          "There's no video to look at yet. Make a preview first.")
    if not times:
        raise EngineError("BAD_ARGS", "no times given", "Reel Studio didn't say which moments to show.")
    from .probe import probe
    dur = probe(src, quick=True)["duration"]
    out_dir = Path(out) if out is not None else src.parent / "frames"
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
    return {"video": str(src), "frames": out}
