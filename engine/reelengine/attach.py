"""`attach --project <dir> <file> [--name N]`: a picture, GIF or short clip the user attached to a
note goes into the project, ready for the AI to place as b-roll (0.1.2 F2).

    <project>/work/assets/attach-<id>-<stem>.<ext>          the asset the edit points at
    <project>/work/assets/attach-<id>-<stem>.<ext>.attach.json  sidecar (what it is, where it came from)
    <project>/work/thumbs/attach-<id>-<stem>.jpg            320 px still the AI and the app look at

Conversions, so every attachment is something the renderer already handles:
  - JPG / PNG are copied as they are.
  - HEIC / HEIF (iPhone photos, through pi-heif), still GIF, still WebP and BMP become PNG.
  - An ANIMATED GIF or WebP becomes a silent H.264 mp4 (yuv420p, even size). The renderer treats
    `.gif` as a still (compose_util.IMAGE_EXT), so without this a GIF would freeze on frame one.
    Short loops are repeated to at least GIF_MIN_SECONDS so a reaction GIF does not end mid-phrase.
  - Clips (mp4 mov m4v webm) are copied as they are and probed.

Everything is checked BEFORE anything is written: a file that is the wrong type, too big, too long or
unreadable is refused with a plain message and leaves nothing behind.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import unicodedata
import uuid
from datetime import datetime, timezone
from pathlib import Path

from .proto import EngineError, progress

PICTURE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".heic", ".heif", ".bmp"}
CLIP_EXT = {".mp4", ".mov", ".m4v", ".webm"}
COPY_AS_IS = {".png", ".jpg", ".jpeg"}

MB = 1024 * 1024
PICTURE_MAX_BYTES = 25 * MB        # a still picture
CLIP_MAX_BYTES = 200 * MB          # a clip or any GIF
CLIP_MAX_SECONDS = 60.0
GIF_MIN_SECONDS = 3.0              # a short animated GIF loops until it lasts at least this long
GIF_MAX_SIDE = 1920
GIF_FPS = 30
THUMB_SIDE = 320

MSG_TYPE = ("That file type isn't supported. Use a picture (JPG, PNG, GIF, HEIC) "
            "or a short video (MP4, MOV).")
MSG_PICTURE_BIG = "That picture is too big. Use one under 25 MB."
MSG_CLIP_BIG = "That file is too big. Use a clip or GIF under 200 MB."
MSG_CLIP_LONG = "That clip is too long. Use one that is 1 minute or shorter."
MSG_UNREADABLE = "I couldn't open that file. It may be damaged. Try a different one."
MSG_MISSING = "I couldn't find that file. It may have been moved or deleted."
MSG_NO_PICTURE = "That video has no picture in it. Try a different one."
MSG_HEIC = "This photo format isn't supported on this computer. Save it as a JPG or PNG and try again."


def _err(code: str, detail: str, msg: str) -> EngineError:
    return EngineError(code, detail, msg)


def safe_stem(name: str, n: int = 40) -> str:
    """ASCII, lowercase, dash-separated stem for the file name (the original name lives in the sidecar)."""
    stem = Path(name or "").stem
    stem = unicodedata.normalize("NFKD", stem).encode("ascii", "ignore").decode("ascii")
    stem = re.sub(r"[^a-z0-9]+", "-", stem.lower())
    stem = re.sub(r"-{2,}", "-", stem).strip("-")[:n].strip("-")
    return stem or "file"


def clean_name(name: str) -> str:
    """The original file name to show the user: no folders, no control characters, not too long."""
    base = re.split(r"[\\/]", name or "")[-1]
    base = "".join(c for c in base if unicodedata.category(c)[0] != "C").strip()
    return base[:120] or "file"


def _limits_for(ext: str) -> tuple[int, str]:
    if ext in CLIP_EXT or ext == ".gif":
        return CLIP_MAX_BYTES, MSG_CLIP_BIG
    return PICTURE_MAX_BYTES, MSG_PICTURE_BIG


def check_file(src: Path, name: str) -> tuple[str, int]:
    """(extension, size) or a plain EngineError. Reads nothing but the file's metadata."""
    ext = Path(name).suffix.lower() or src.suffix.lower()
    if ext not in PICTURE_EXT and ext not in CLIP_EXT:
        ext2 = src.suffix.lower()
        if ext2 in PICTURE_EXT or ext2 in CLIP_EXT:
            ext = ext2
        else:
            raise _err("ATTACH_TYPE", f"unsupported attachment type {ext or '(none)'}: {name}", MSG_TYPE)
    if not src.is_file():
        raise _err("NOT_FOUND", f"no such file: {src}", MSG_MISSING)
    size = src.stat().st_size
    limit, msg = _limits_for(ext)
    if size > limit:
        raise _err("ATTACH_TOO_BIG", f"{name}: {size} bytes > {limit}", msg)
    if size == 0:
        raise _err("ATTACH_UNREADABLE", f"{name}: empty file", MSG_UNREADABLE)
    return ext, size


# --- pictures ----------------------------------------------------------------------------------

def _open_picture(src: Path, ext: str):
    """PIL image (not yet converted) + frame count, or a plain error. HEIC goes through open_image."""
    from PIL import Image
    if ext in (".heic", ".heif"):
        from .compose_util import open_image
        try:
            return open_image(src), 1
        except EngineError as e:
            if e.code == "HEIC_UNSUPPORTED":
                raise _err("HEIC_UNSUPPORTED", e.message, MSG_HEIC) from None
            raise _err("ATTACH_UNREADABLE", e.message, MSG_UNREADABLE) from None
    try:
        im = Image.open(src)
        frames = int(getattr(im, "n_frames", 1) or 1)
        im.load()
    except Exception as e:  # noqa: BLE001 -- any decoder failure is "unreadable" to the user
        raise _err("ATTACH_UNREADABLE", f"{src.name}: {type(e).__name__}: {e}", MSG_UNREADABLE) from None
    return im, frames


def _upright_rgba(im):
    from PIL import ImageOps
    try:
        im = ImageOps.exif_transpose(im)
    except Exception:  # noqa: BLE001
        pass
    return im.convert("RGBA")


def _flatten(im, bg=(255, 255, 255)):
    from PIL import Image
    im = im.convert("RGBA")
    base = Image.new("RGBA", im.size, bg + (255,))
    base.alpha_composite(im)
    return base.convert("RGB")


def _save_thumb(im, out: Path) -> None:
    rgb = _flatten(im)
    rgb.thumbnail((THUMB_SIDE, THUMB_SIDE))
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(out.stem + ".part.jpg")
    rgb.save(tmp, "JPEG", quality=82)
    os.replace(tmp, out)


# --- animated GIF / WebP -> mp4 ----------------------------------------------------------------

def _gif_timeline(im) -> tuple[list[float], float]:
    """Per-frame durations (seconds) like a browser plays them: 0 or <20 ms counts as 100 ms."""
    durs = []
    for i in range(im.n_frames):
        im.seek(i)
        ms = im.info.get("duration") or 0
        try:
            ms = float(ms)
        except (TypeError, ValueError):
            ms = 0.0
        durs.append(0.1 if ms < 20 else ms / 1000.0)
    im.seek(0)
    return durs, sum(durs)


def _even(n: int) -> int:
    return max(2, int(n) // 2 * 2)


def _animated_to_mp4(im, out: Path, ffmpeg: str) -> dict:
    """Frames -> constant-fps silent H.264 mp4 (frames piped as raw RGB, so no path quoting issues)."""
    from PIL import Image
    durs, loop = _gif_timeline(im)
    if loop > CLIP_MAX_SECONDS + 0.5:
        raise _err("ATTACH_TOO_LONG", f"animated picture lasts {loop:.1f}s", MSG_CLIP_LONG)
    loops = 1
    while loop * loops < GIF_MIN_SECONDS and loops < 100:
        loops += 1
    total = loop * loops
    w, h = im.size
    scale = min(1.0, GIF_MAX_SIDE / max(w, h))
    ow, oh = _even(round(w * scale)), _even(round(h * scale))
    n_out = max(1, int(round(total * GIF_FPS)))
    starts, t = [], 0.0
    for d in durs:
        starts.append(t)
        t += d
    out.parent.mkdir(parents=True, exist_ok=True)
    cmd = [ffmpeg, "-y", "-v", "error", "-nostats", "-f", "rawvideo", "-pix_fmt", "rgb24",
           "-s", f"{ow}x{oh}", "-r", str(GIF_FPS), "-i", "-", "-an", "-c:v", "libx264",
           "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(out)]
    try:
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    except FileNotFoundError:
        raise EngineError("FFMPEG_MISSING", f"{ffmpeg} not found",
                          "Reel Studio is missing a part it needs to make videos. Please reinstall the app.") from None
    cur_idx, cur_frame = -1, None
    try:
        for k in range(n_out):
            tt = (k / GIF_FPS) % loop
            idx = max(i for i, s in enumerate(starts) if s <= tt + 1e-9)
            if idx != cur_idx:
                im.seek(idx)
                frame = im.convert("RGBA")
                base = Image.new("RGBA", frame.size, (0, 0, 0, 255))
                base.alpha_composite(frame)
                rgb = base.convert("RGB")
                if rgb.size != (ow, oh):
                    rgb = rgb.resize((ow, oh), Image.LANCZOS)
                cur_idx, cur_frame = idx, rgb.tobytes()
            proc.stdin.write(cur_frame)
        proc.stdin.close()
        err = proc.stderr.read().decode("utf-8", "replace")
        code = proc.wait(timeout=600)
    except BrokenPipeError:
        err = proc.stderr.read().decode("utf-8", "replace") if proc.stderr else ""
        code = proc.wait(timeout=60)
    if code != 0:
        raise EngineError("FFMPEG_FAILED", f"gif -> mp4 failed: {err[-1500:]}",
                          "I couldn't turn that GIF into a video. Try a different one.")
    im.seek(0)
    return {"width": ow, "height": oh, "duration": round(n_out / GIF_FPS, 3), "loops": loops}


# --- clips -------------------------------------------------------------------------------------

def _probe_clip(src: Path) -> dict:
    from . import compose_util
    try:
        info = compose_util.probe(src)
    except EngineError as e:
        if e.code in ("NO_FFMPEG", "TIMEOUT"):
            raise
        raise _err("ATTACH_UNREADABLE", e.message, MSG_UNREADABLE) from None
    if not info.get("has_video") or not info.get("width"):
        raise _err("ATTACH_NO_VIDEO", f"{src.name}: no video stream", MSG_NO_PICTURE)
    if info["duration"] > CLIP_MAX_SECONDS + 0.5:
        raise _err("ATTACH_TOO_LONG", f"{src.name}: {info['duration']:.1f}s", MSG_CLIP_LONG)
    return info


def _clip_thumb(src: Path, duration: float, out: Path, ffmpeg: str) -> None:
    at = max(0.0, min(1.0, duration / 2.0))
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(out.stem + ".part.jpg")
    vf = f"scale={THUMB_SIDE}:{THUMB_SIDE}:force_original_aspect_ratio=decrease"
    from .compose_util import run
    run([ffmpeg, "-y", "-v", "error", "-nostdin", "-ss", f"{at:.3f}", "-i", str(src), "-frames:v", "1",
         "-vf", vf, "-q:v", "4", str(tmp)], timeout=120, what="attachment thumbnail")
    if not tmp.exists():   # a seek past the last frame writes nothing: take the first frame
        run([ffmpeg, "-y", "-v", "error", "-nostdin", "-i", str(src), "-frames:v", "1",
             "-vf", vf, "-q:v", "4", str(tmp)], timeout=120, what="attachment thumbnail")
    os.replace(tmp, out)


# --- the command -------------------------------------------------------------------------------

def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _rel(p: Path, proj: Path) -> str:
    return p.resolve().relative_to(proj.resolve()).as_posix()


def run(project_dir: Path, src: Path, name: str | None = None) -> dict:
    proj = Path(project_dir)
    if not (proj / "project.json").is_file():
        raise _err("NOT_FOUND", f"no project at {proj}", "I couldn't find this video's folder. Please try again.")
    src = Path(src)
    shown = clean_name(name or src.name)
    ext, size = check_file(src, shown)

    from . import tools
    progress("attach", 10, "Adding your file", force=True)

    # 1) read and check everything first (nothing is written until the file is known to be good)
    kind = "video"
    picture = None
    animated = False
    clip_info = None
    if ext in PICTURE_EXT:
        im, frames = _open_picture(src, ext)
        if frames > 1 and ext in (".gif", ".webp"):
            animated = True
            picture = im
            _, loop = _gif_timeline(im)
            if loop > CLIP_MAX_SECONDS + 0.5:
                raise _err("ATTACH_TOO_LONG", f"{shown}: animation lasts {loop:.1f}s", MSG_CLIP_LONG)
        else:
            kind = "image"
            picture = _upright_rgba(im) if ext not in (".heic", ".heif") else im
    else:
        clip_info = _probe_clip(src)

    # 2) write: <work>/assets/attach-<id>-<stem>.<ext>, its thumbnail and its sidecar
    assets = proj / "work" / "assets"
    thumbs = proj / "work" / "thumbs"
    sid = uuid.uuid4().hex[:8]
    stem = f"attach-{sid}-{safe_stem(shown)}"
    if kind == "image":
        out_ext = ext if ext in COPY_AS_IS else ".png"
        if out_ext == ".jpeg":
            out_ext = ".jpg"
    elif animated:
        out_ext = ".mp4"
    else:
        out_ext = ext
    out = assets / f"{stem}{out_ext}"
    thumb = thumbs / f"{stem}.jpg"
    side = assets / f"{out.name}.attach.json"
    part = assets / f".{stem}.part{out_ext}"
    written = [part, out, thumb, side]
    try:
        assets.mkdir(parents=True, exist_ok=True)
        record: dict = {"name": shown, "kind": kind}
        if kind == "image":
            if ext in COPY_AS_IS:
                shutil.copyfile(src, part)
            else:
                picture.save(part, "PNG")
            os.replace(part, out)
            record.update(width=picture.width, height=picture.height)
            progress("attach", 70, "Adding your file")
            _save_thumb(picture, thumb)
        elif animated:
            progress("attach", 30, "Turning your GIF into a video", force=True)
            info = _animated_to_mp4(picture, part, tools.ffmpeg())
            os.replace(part, out)
            record.update(width=info["width"], height=info["height"], duration=info["duration"], hasAudio=False)
            if ext == ".gif":
                record["fromGif"] = True
            if info["loops"] > 1:
                record["loops"] = info["loops"]
            _clip_thumb(out, info["duration"], thumb, tools.ffmpeg())
        else:
            progress("attach", 30, "Copying your clip", force=True)
            shutil.copyfile(src, part)
            os.replace(part, out)
            record.update(width=int(clip_info["width"]), height=int(clip_info["height"]),
                          duration=round(float(clip_info["duration"]), 3), hasAudio=bool(clip_info["has_audio"]))
            _clip_thumb(out, float(clip_info["duration"]), thumb, tools.ffmpeg())
        record = {"asset": _rel(out, proj), "name": shown, "kind": kind, "bytes": out.stat().st_size,
                  **{k: v for k, v in record.items() if k not in ("name", "kind")},
                  "thumb": _rel(thumb, proj), "createdAt": _now()}
        tmp = side.with_name(side.name + ".part")
        tmp.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, side)
    except BaseException:
        for p in written + [side.with_name(side.name + ".part"), thumb.with_name(thumb.stem + ".part.jpg")]:
            try:
                p.unlink()
            except OSError:
                pass
        raise
    progress("attach", 100, "Added", force=True)
    return record


def read_sidecar(project_dir: Path, asset: str) -> dict | None:
    """The sidecar of a `work/assets/attach-*` asset, or None (also for anything that is not one)."""
    a = (asset or "").replace("\\", "/")
    if not a.startswith("work/assets/attach-") or "/" in a[len("work/assets/"):] or ".." in a:
        return None
    p = Path(project_dir) / "work" / "assets" / (a[len("work/assets/"):] + ".attach.json")
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
