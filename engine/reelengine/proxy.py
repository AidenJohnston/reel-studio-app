"""`proxy --project <dir>`: a lighter copy of each 4K or HDR take, made once, for previews.

Decoding a 4K HEVC take is most of what a draft costs, and a draft decodes it again on every edit.
This command decodes it once into a copy that is cheap to read: H.264 with every frame a keyframe,
short side 1080, tonemapped to SDR, no audio. Drafts and window previews (and the stills `frames`
takes from them) read the copy; a final export and its cover always read the original (render.run).

    work/proxy/<sid>-<key>.mp4    the copy
    work/proxy/<sid>-<key>.json   written after the copy is in place: its size, picture size, offset

<key> hashes the source's project path, size and mtime (the test asset_fingerprint already uses
for "this file was replaced"), its HDR flag and RECIPE. A replaced take has another key, so a
preview can never read the copy of the old one; the next build removes copies of other keys. A
preview uses a copy only when its sidecar exists and names this key and the copy's exact size.
Anything else (no copy yet, one still being written, a stale one) reads the original: a missing
copy costs speed, never correctness.

Timing: the copy keeps every frame's timestamp (`-fps_mode passthrough`, the demuxer's time base),
and the build compares the copy's frame times with the original's packet times, keeping the copy
only when they match. A take whose video starts after its audio (the file's start) gets that
offset back at read time (`inputOffset`, applied with -itsoffset), so a segment's trim picks the
same frames from the copy as from the original.

HDR: tonemapped once into the copy, with the same chain a final uses (render.HDR_CHAIN), after the
scale to 1080 (a quarter of the pixels of 4K). A draft from the copy then needs no tonemap at all.
If FFmpeg refuses the scale first (zscale reads colour matrices `scale` does not), it tonemaps the
4K frame first instead.

The command runs at below-normal priority: the app starts it right after import, while the speech
model is listening, and the copy must not make the first edit wait.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
from pathlib import Path
from typing import Optional

from . import project as projmod, tools
from .proto import EngineError, log, progress

# Bump when the copy's picture changes for the same source; old copies then no longer match.
RECIPE = 1
SHORT_SIDE = 1080
DIR = ("work", "proxy")
_SID = re.compile(r"[A-Za-z0-9_]{1,40}")    # no "-": `<sid>-*` must not match another source
# Frame times of copy and original must agree to well under a frame (1 ms at 240 fps is a quarter).
TIME_TOLERANCE = 0.0005


def wanted(src: dict, short_side: int = SHORT_SIDE) -> bool:
    """Only a take bigger than 1080p, or an HDR one, is worth a copy."""
    w, h = int(src.get("width") or 0), int(src.get("height") or 0)
    return w > 0 and h > 0 and (min(w, h) > short_side or bool(src.get("hdr")))


def copy_size(src: dict, short_side: int = SHORT_SIDE) -> tuple:
    """Stored (unrotated) size of the copy: the short side scaled to `short_side`, never up."""
    w, h = int(src["width"]), int(src["height"])
    k = min(1.0, short_side / float(min(w, h)))
    return max(2, int(round(w * k / 2)) * 2), max(2, int(round(h * k / 2)) * 2)


def source_key(path: Path, src: dict) -> Optional[str]:
    try:
        st = Path(path).stat()
    except OSError:
        return None
    blob = json.dumps([RECIPE, src.get("path"), st.st_size, st.st_mtime_ns, bool(src.get("hdr"))])
    return hashlib.sha1(blob.encode("utf-8")).hexdigest()[:16]


def _files(project_dir: Path, sid: str, key: str) -> tuple:
    d = Path(project_dir).joinpath(*DIR)
    return d / f"{sid}-{key}.mp4", d / f"{sid}-{key}.json"


def lookup(project_dir: Path, src: dict, path: Path) -> Optional[dict]:
    """The finished copy of this source as it is now, or None."""
    sid = str(src.get("id") or "")
    key = source_key(path, src) if _SID.fullmatch(sid) else None
    if key is None:
        return None
    mp4, side = _files(project_dir, sid, key)
    try:
        meta = projmod.read_json(side)
        size = mp4.stat().st_size
    except (OSError, ValueError):
        return None
    if not isinstance(meta, dict) or meta.get("key") != key or meta.get("bytes") != size:
        return None
    try:
        return {"file": mp4, "width": int(meta["width"]), "height": int(meta["height"]),
                "offset": float(meta.get("offset") or 0.0)}
    except (KeyError, TypeError, ValueError):
        return None


def for_preview(project_dir: Path, src_meta: dict, src_paths: dict, faces: dict) -> tuple:
    """(meta, paths, faces, videoFrom) for a preview's picture: each source with a finished copy is
    swapped for it (its size, SDR, and the start offset to restore), the face centre scaled with it.
    Sound always comes from the originals; the caller keeps those."""
    meta, paths, fcs, used = dict(src_meta), dict(src_paths), dict(faces), {}
    for sid, src in src_meta.items():
        c = lookup(project_dir, src, src_paths[sid])
        if c is None:
            used[sid] = "original"
            continue
        meta[sid] = dict(src, width=c["width"], height=c["height"], hdr=False, inputOffset=c["offset"])
        paths[sid] = c["file"]
        if sid in faces:
            turned = int(src.get("rotation") or 0) % 180 == 90
            ow, oh = int(src["width"]), int(src["height"])
            cw, ch = c["width"], c["height"]
            if turned:
                ow, oh, cw, ch = oh, ow, ch, cw
            fx, fy = faces[sid]
            fcs[sid] = (fx * cw / ow, fy * ch / oh)
        used[sid] = "proxy"
    return meta, paths, fcs, used


# --- building -----------------------------------------------------------------------------------

def lower_priority() -> None:
    """Below normal for this process and the FFmpeg it starts (children inherit it)."""
    try:
        if os.name == "nt":
            import ctypes
            k32 = ctypes.windll.kernel32
            k32.SetPriorityClass(k32.GetCurrentProcess(), 0x00004000)    # BELOW_NORMAL_PRIORITY_CLASS
        else:
            os.nice(10)
    except (OSError, AttributeError) as exc:
        log(f"# proxy: could not lower priority: {exc!r}")


def frame_times(ffprobe: str, path: Path) -> tuple:
    """(offset, times) of the first video stream: offset = its start after the file's start (what
    a render's input sees as the first frame's time), times = each frame's time after the first,
    sorted, from packets (no decode). Packets the demuxer marks discarded are not frames."""
    proc = tools.text_run([ffprobe, "-v", "error", "-select_streams", "v:0",
                           "-show_entries", "format=start_time:stream=start_time:packet=pts_time,flags",
                           "-of", "json", str(path)], 300, "frame times")
    try:
        data = json.loads(proc.stdout or "{}")
        file_start = float((data.get("format") or {}).get("start_time") or 0.0)
        pts = sorted(float(p["pts_time"]) for p in data.get("packets") or []
                     if "D" not in (p.get("flags") or "") and p.get("pts_time") not in (None, "N/A"))
    except (ValueError, TypeError, KeyError) as exc:
        raise EngineError("PROXY_TIMES", f"unreadable frame times of {path}: {exc!r}",
                          "I couldn't read this video's frame times.")
    if not pts:
        raise EngineError("PROXY_TIMES", f"no frame times in {path}", "I couldn't read this video's frame times.")
    return max(0.0, pts[0] - file_start), [t - pts[0] for t in pts]


def same_times(a: list, b: list) -> bool:
    return len(a) == len(b) and all(abs(x - y) <= TIME_TOLERANCE for x, y in zip(a, b))


def build_cmd(ffmpeg: str, src: dict, path: Path, out: Path, size: tuple, tonemap_first: bool) -> list:
    w, h = size
    scale = f"scale={w}:{h}:flags=lanczos"
    from .render import HDR_CHAIN       # render imports this module; import late
    if src.get("hdr") and "zscale" in tools.filters():
        vf = f"{HDR_CHAIN},{scale}" if tonemap_first else f"{scale},{HDR_CHAIN}"
        tags = ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"]
    else:
        vf = f"{scale},format=yuv420p"
        tags = []
    return [ffmpeg, "-y", "-nostdin", "-hide_banner", "-noautorotate", "-i", str(path),
            "-map", "0:v:0", "-an", "-sn", "-dn", "-map_metadata", "-1", "-vf", vf,
            "-fps_mode", "passthrough", "-enc_time_base", "demux",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-g", "1", "-bf", "0",
            "-pix_fmt", "yuv420p", *tags, "-progress", "pipe:1", "-nostats", "-f", "mp4", str(out)]


def _take_lock(lock: Path):
    """One build per source at a time (two app windows, or the app and a script, may both start
    one). An OS lock on the file, held until the handle closes, so a killed build never leaves it
    held. -> the open handle, or None when another build holds it."""
    fh = open(lock, "a+b")
    try:
        if os.name == "nt":
            import msvcrt
            fh.seek(0)
            msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        fh.close()
        return None
    return fh


def _release_lock(fh) -> None:
    if os.name == "nt":             # Windows frees a lock at close only eventually; unlock first
        import msvcrt
        try:
            fh.seek(0)
            msvcrt.locking(fh.fileno(), msvcrt.LK_UNLCK, 1)
        except OSError:
            pass
    fh.close()


def _prune(d: Path, sid: str, keep: Path) -> None:
    """Copies and sidecars of this source under other keys, and leftovers of killed builds. Runs
    while holding the source's lock, so no other build of it is writing."""
    for f in d.glob(f"{sid}-*"):
        if f.name.startswith(keep.stem + ".") and not f.name.endswith(".part.mp4"):
            continue
        try:
            f.unlink()
        except OSError:
            pass            # a render may still have it open (Windows); the next build retries


def build_one(project_dir: Path, src: dict, path: Path, short_side: int = SHORT_SIDE,
              on_pct=lambda p: None) -> dict:
    sid = str(src["id"])
    key = source_key(path, src)
    if key is None or not _SID.fullmatch(sid):
        raise EngineError("PROXY_SOURCE", f"source {sid} at {path} is unreadable", "I couldn't read this video.")
    mp4, side = _files(project_dir, sid, key)
    mp4.parent.mkdir(parents=True, exist_ok=True)
    held = _take_lock(mp4.parent / f"{sid}.lock")
    if held is None:
        return {"status": "busy", "reason": "another build of this take is running"}
    try:
        if lookup(project_dir, src, path) is not None:        # that other build has just finished it
            return {"status": "ready", "file": str(mp4)}
        return _build(project_dir, src, path, key, mp4, side, short_side, on_pct)
    finally:
        _release_lock(held)


def _build(project_dir: Path, src: dict, path: Path, key: str, mp4: Path, side: Path, short_side: int,
           on_pct) -> dict:
    sid = str(src["id"])
    part = mp4.with_name(f"{mp4.stem}.{os.getpid()}.part.mp4")
    ffmpeg, ffprobe = tools.ffmpeg(), tools.ffprobe()
    offset, want = frame_times(ffprobe, path)
    size = copy_size(src, short_side)
    dur = float(src.get("duration") or 0.0) or (want[-1] if want else 1.0)
    try:
        err = None
        for tonemap_first in ((False, True) if src.get("hdr") else (False,)):
            try:
                tools.ffmpeg_progress(build_cmd(ffmpeg, src, path, part, size, tonemap_first), dur, on_pct,
                                      timeout=max(900.0, dur * 60), what="preview copy")
                err = None
                break
            except EngineError as exc:
                err = exc
                log(f"# proxy {sid}: build failed (tonemap first={tonemap_first}): {exc.message[-400:]}")
        if err is not None:
            raise err
        _, got = frame_times(ffprobe, part)
        if not same_times(want, got):
            raise EngineError("PROXY_TIMES", f"copy of {sid} has {len(got)} frames, the take {len(want)}, "
                                             f"or their times differ", "The preview copy came out wrong.")
        if source_key(path, src) != key:
            return {"status": "stale", "reason": "the take changed while its copy was made"}
        side.unlink(missing_ok=True)     # a sidecar never describes a file other than the one beside it
        os.replace(part, mp4)
        projmod.write_json(side, {"key": key, "recipe": RECIPE, "source": src.get("path"),
                                  "bytes": mp4.stat().st_size, "width": size[0], "height": size[1],
                                  "offset": round(offset, 6), "frames": len(got)})
    finally:
        part.unlink(missing_ok=True)
    _prune(mp4.parent, sid, mp4)
    return {"status": "built", "file": str(mp4), "bytes": mp4.stat().st_size, "size": list(size)}


def run(project_dir: Path, short_side: int = SHORT_SIDE) -> dict:
    """Make every missing copy. Safe to run again: a finished copy is kept. One source failing
    leaves the others (and every render) unaffected."""
    lower_priority()
    project_dir = Path(project_dir).resolve()
    proj = projmod.load(project_dir)
    sources = proj.get("sources") or []
    out = {}
    for i, src in enumerate(sources):
        sid = str(src.get("id"))
        try:
            path = projmod.source_path(project_dir, src)
        except EngineError as exc:
            out[sid] = {"status": "failed", "reason": exc.message}
            continue
        if not wanted(src, short_side):
            out[sid] = {"status": "not-needed"}
            continue
        if lookup(project_dir, src, path) is not None:
            out[sid] = {"status": "ready"}
            continue

        def on_pct(p, i=i):
            progress("proxy", (i + p / 100.0) * 100.0 / len(sources), "Preparing faster previews")
        try:
            out[sid] = build_one(project_dir, src, path, short_side, on_pct)
        except (EngineError, OSError) as exc:
            reason = exc.message if isinstance(exc, EngineError) else repr(exc)
            log(f"# proxy {sid} not made: {reason[-600:]}")
            out[sid] = {"status": "failed", "reason": reason[-300:]}
    progress("proxy", 100, "Previews are ready", force=True)
    return {"sources": out}
