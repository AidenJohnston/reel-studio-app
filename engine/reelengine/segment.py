"""The speaker cut out of the picture, for words drawn behind them (broll treatment "text-behind").

The person is found by PP-HumanSeg (OpenCV Model Zoo, Apache-2.0; THIRD_PARTY.md), run on cv2.dnn,
the same OpenCV the face detector uses. The model is not bundled: it is downloaded once, from one
pinned revision of OpenCV's own Hugging Face copy of the zoo, and kept only when its size and
SHA-256 match models/segment-models.json.

matte_clip() writes a grey clip for one output window: white where the speaker is, black elsewhere,
in the picture the render draws BEFORE its zooms (each frame is the source frame through the same
crop, turn and mirror as render.reframe_filter). render.build_video_cmd pushes that clip through the
same zoom chain as the footage, so the cut-out follows every zoom exactly.
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import urllib.error
from pathlib import Path
from typing import Optional

import numpy as np

from . import tools
from .proto import EngineError, log, progress

PIN = json.loads((Path(__file__).parent / "models" / "segment-models.json").read_text("utf-8"))["pphumanseg"]
NET_SIZE = 192          # the model's input, square (the zoo's demo squashes any picture to it)
DECODE_DIV = 5          # frames are decoded at 1/5 of the output size: 216x384 for 1080x1920
# Edges: the model sees 192 px, so its edge is soft at output size anyway. A pixel is fully the
# speaker above EDGE_HI and fully background below EDGE_LO, smooth in between. Judged on the
# rendered frames of one take (cutting1106 evidence); no measurement behind the numbers.
EDGE_LO, EDGE_HI = 0.35, 0.65
SMOOTH = 0.4            # of the previous frame kept, within one kept stretch: damps edge flicker
VERSION = 1             # bump when the matte for the same inputs would change


def model_path() -> Path:
    return tools.models_dir() / "pphumanseg" / PIN["file"]["name"]


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _good(path: Path) -> bool:
    spec = PIN["file"]
    return path.is_file() and path.stat().st_size == spec["size"] and _sha256(path) == spec["sha256"]


def ensure_model() -> Path:
    """The model file, downloading it (6 MB, once) when it is missing or not the pinned bytes."""
    from .transcribe import _download_lock, _fetch_part
    dest = model_path()
    if _good(dest):
        return dest
    spec = PIN["file"]
    base = os.environ.get("REELENGINE_MODEL_MIRROR", "https://huggingface.co").rstrip("/")
    url = f"{base}/{PIN['repo']}/resolve/{PIN['revision']}/{spec['name']}"
    with _download_lock(dest):
        if _good(dest):
            return dest
        part = dest.with_name(dest.name + ".part")
        if part.exists() and part.stat().st_size > spec["size"]:
            part.unlink()
        try:
            _fetch_part(url, part, spec["size"], lambda got: progress(
                "download", 100.0 * got / spec["size"], "Downloading the model that finds you in the picture"))
        except (urllib.error.URLError, OSError) as exc:
            raise EngineError("OFFLINE", f"download of {spec['name']} failed: {exc}",
                              "I couldn't download the model that cuts you out of the picture. "
                              "Check your internet connection and make the version again.")
        got = _sha256(part) if part.exists() else ""
        if got != spec["sha256"]:
            part.unlink(missing_ok=True)
            raise EngineError("DOWNLOAD_CORRUPT", f"{spec['name']}: sha256 {got or 'missing'}, pinned {spec['sha256']}",
                              "The model that cuts you out of the picture downloaded with errors. "
                              "Make the version again to retry.")
        os.replace(part, dest)
    return dest


_NET = None


def _net():
    global _NET
    if _NET is None:
        import cv2
        _NET = cv2.dnn.readNet(str(ensure_model()))
    return _NET


def person_prob(bgr: np.ndarray) -> np.ndarray:
    """Probability (0-1, NET_SIZE square) that each pixel of the picture is a person."""
    import cv2
    img = cv2.resize(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB), (NET_SIZE, NET_SIZE), interpolation=cv2.INTER_AREA)
    img = (img.astype(np.float32) / 255.0 - 0.5) / 0.5          # the zoo's mean and std
    net = _net()
    net.setInput(cv2.dnn.blobFromImage(img))
    out = net.forward()[0]                                        # (2, 192, 192): background, person
    if out.min() < 0 or np.abs(out.sum(axis=0) - 1).max() > 1e-3:  # logits, not yet probabilities
        e = np.exp(out - out.max(axis=0, keepdims=True))
        out = e / e.sum(axis=0, keepdims=True)
    return out[1]


def _alpha(prob: np.ndarray, w: int, h: int) -> np.ndarray:
    import cv2
    p = cv2.resize(prob.astype(np.float32), (w, h), interpolation=cv2.INTER_LINEAR)
    u = np.clip((p - EDGE_LO) / (EDGE_HI - EDGE_LO), 0, 1)
    return (u * u * (3 - 2 * u) * 255 + 0.5).astype(np.uint8)


def frame_plan(segments: list, sources: dict, t0: float, t1: float, fps: float) -> list:
    """[(source id, source frame index)] for each output frame k (time k/fps) in [t0, t1): the frame
    the render shows there. A time on no segment (past the end) repeats the last one."""
    out = []
    k0, k1 = int(np.ceil(t0 * fps - 1e-6)), int(np.ceil(t1 * fps - 1e-6))
    for k in range(k0, k1):
        t = k / fps
        seg = next((s for s in segments if s.out_start - 1e-9 <= t < s.out_start + (s.src_end - s.src_start) - 1e-9), None)
        if seg is None:
            if out:
                out.append(out[-1])
            continue
        sfps = float(sources[seg.source].get("fps") or fps)
        out.append((seg.source, int(np.floor((seg.src_start + t - seg.out_start) * sfps + 0.5))))
    return out


def _runs(plan: list) -> list:
    """Consecutive output frames reading one source forward: [(source, first index, last index, [indices])]."""
    runs = []
    for sid, i in plan:
        if runs and runs[-1][0] == sid and runs[-1][2] <= i <= runs[-1][2] + 4:
            runs[-1][2] = i
            runs[-1][3].append(i)
        else:
            runs.append([sid, i, i, [i]])
    return runs


def _decode(ctx, path: Path, src: dict, face, first: int, last: int, w: int, h: int) -> dict:
    """{source frame index: bgr frame} for first..last, through the render's own crop, turn and mirror."""
    from .render import no_rotate_args, reframe_filter
    sfps = float(src.get("fps") or 30)
    n = last - first + 1
    cmd = [ctx.ffmpeg, "-v", "error", "-nostdin", *no_rotate_args(src),
           "-ss", f"{max(0.0, (first - 0.5) / sfps):.6f}", "-i", str(path), "-frames:v", str(n), "-an",
           "-vf", reframe_filter(src, w, h, face, False), "-f", "rawvideo", "-pix_fmt", "bgr24", "-"]
    raw = subprocess.run(cmd, capture_output=True, timeout=600, stdin=subprocess.DEVNULL).stdout
    size = w * h * 3
    return {first + j: np.frombuffer(raw[j * size:(j + 1) * size], np.uint8).reshape(h, w, 3)
            for j in range(min(n, len(raw) // size))}


def matte_clip(ctx, t0: float, t1: float, out_dir: Path, stem: str) -> Optional[Path]:
    """The speaker's matte for output seconds [t0, t1) at the render's size and frame rate, as a grey
    FFV1 clip (frame j shows at t0's first frame + j). Cached by everything that decides its pixels.
    None when the window has no frames."""
    from . import project as projmod
    from .compose_util import fmt_of
    from .render import source_faces
    W, H, fps = fmt_of(ctx)
    sources = {s["id"]: s for s in ctx.project["sources"]}
    plan = frame_plan(ctx.picture_timeline or ctx.out_timeline, sources, t0, t1, fps)
    if not plan:
        return None
    faces = source_faces(ctx.project_dir, ctx.project)
    paths = {sid: projmod.source_path(ctx.project_dir, sources[sid], root=ctx.root) for sid in {p[0] for p in plan}}
    key = hashlib.sha256(json.dumps([VERSION, PIN["file"]["sha256"], W, H, fps, EDGE_LO, EDGE_HI, SMOOTH, plan,
                                     {sid: [str(p), p.stat().st_size, p.stat().st_mtime_ns, faces.get(sid),
                                            {k: sources[sid].get(k) for k in ("width", "height", "rotation", "mirror", "fps")}]
                                      for sid, p in sorted(paths.items())}], default=str).encode()).hexdigest()[:16]
    out = out_dir / f"{stem}-matte-{key}.mkv"
    if out.exists() and out.stat().st_size > 0:
        return out
    dw, dh = max(2, W // DECODE_DIV // 2 * 2), max(2, H // DECODE_DIV // 2 * 2)
    part = out.with_name(out.name + ".part.mkv")
    enc = subprocess.Popen([ctx.ffmpeg, "-y", "-v", "error", "-nostdin", "-f", "rawvideo", "-pix_fmt", "gray",
                            "-s", f"{W}x{H}", "-r", f"{fps:.6f}", "-i", "-", "-c:v", "ffv1", "-pix_fmt", "gray", str(part)],
                           stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    try:
        for sid, first, last, wanted in _runs(plan):
            frames = _decode(ctx, paths[sid], sources[sid], faces.get(sid), first, last, dw, dh)
            prev, held = None, None
            for i in wanted:
                if i in frames:
                    p = person_prob(frames[i])
                    prev = p if prev is None else (1 - SMOOTH) * p + SMOOTH * prev
                    held = _alpha(prev, W, H)
                if held is None:          # the take ended early: nothing found to cut out
                    held = np.zeros((H, W), np.uint8)
                enc.stdin.write(held.tobytes())
        enc.stdin.close()
        err = enc.stderr.read().decode("utf-8", "replace")
        if enc.wait(timeout=600) != 0:
            raise EngineError("MATTE_FAILED", f"matte encode failed: {err[-400:]}",
                              "I couldn't cut you out of the picture for the words behind you.")
    except BaseException:
        enc.kill()
        part.unlink(missing_ok=True)
        raise
    os.replace(part, out)
    log(f"# matte {out.name}: {len(plan)} frames")
    return out
