"""Shared helpers for the compositing modules (broll, placement, zoom, music, cover, assets).

Owned by A2 (engine-compositing). Nothing here calls an LLM or touches project.json; it is
plumbing: finding ffmpeg and fonts, decoding frames through ffmpeg (so paths with spaces and
non-ASCII characters always work, unlike cv2.VideoCapture on Windows), probing media, mapping
word anchors to output time, and the source -> output pixel transform.
"""
from __future__ import annotations

import math
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
from pathlib import Path
from typing import Any, Iterable, Optional

import numpy as np

PKG_DIR = Path(__file__).resolve().parent

IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".heic", ".heif", ".avif"}
VIDEO_EXT = {".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"}
AUDIO_EXT = {".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus"}


try:  # share A1's error type so render/cli handle compositing errors like their own
    from .proto import EngineError as _BaseError
except ImportError:  # pragma: no cover
    _BaseError = Exception


class EngineError(_BaseError):
    """An error with a developer message and a grandma-friendly userMessage (docs/architecture.md section 4)."""

    def __init__(self, code: str, message: str, user_message: str):
        if _BaseError is Exception:
            Exception.__init__(self, message)
        else:
            _BaseError.__init__(self, code, message, user_message)
        self.code = code
        self.message = message
        self.user_message = user_message
        self.userMessage = user_message

    def to_event(self) -> dict:
        return {"event": "error", "code": self.code, "message": self.message,
                "userMessage": self.userMessage}


def log(msg: str) -> None:
    """stderr is free-form logs; stdout is reserved for JSON lines."""
    print(f"[compositing] {msg}", file=sys.stderr, flush=True)


# --- binaries ----------------------------------------------------------------------------------

def ffmpeg_bin(ctx=None) -> str:
    if ctx is not None and getattr(ctx, "ffmpeg", None):
        return ctx.ffmpeg
    return os.environ.get("REELENGINE_FFMPEG") or shutil.which("ffmpeg") or "ffmpeg"


def ffprobe_bin(ctx=None) -> str:
    if ctx is not None and getattr(ctx, "ffprobe", None):
        return ctx.ffprobe
    return os.environ.get("REELENGINE_FFPROBE") or shutil.which("ffprobe") or "ffprobe"


def run(cmd: list, timeout: float = 600, what: str = "ffmpeg", binary: bool = False):
    """Run a command, raise EngineError with the tail of stderr on failure."""
    try:
        # stdin closed: an engine spawned by the app has an open stdin pipe ffmpeg would otherwise
        # read keystrokes from (and a background job on macOS/Linux can be stopped by SIGTTIN)
        proc = subprocess.run([str(c) for c in cmd], capture_output=True, timeout=timeout, stdin=subprocess.DEVNULL,
                              text=not binary, **({} if binary else {"encoding": "utf-8", "errors": "replace"}))
    except subprocess.TimeoutExpired:
        raise EngineError("TIMEOUT", f"{what} exceeded {timeout:.0f}s",
                          "This step took too long. Try a shorter video.") from None
    except FileNotFoundError:
        raise EngineError("NO_FFMPEG", f"{cmd[0]} not found",
                          "A video tool is missing. Reinstall Reel Studio.") from None
    if proc.returncode != 0:
        err = proc.stderr if not binary else proc.stderr.decode("utf-8", "replace")
        raise EngineError("FFMPEG_FAILED", f"{what} failed: {err[-1500:]}",
                          "Something went wrong while making your video. Try again.")
    return proc


# --- probing -----------------------------------------------------------------------------------

def probe(path: Path, ctx=None) -> dict:
    """{duration, width, height, fps, has_video, has_audio, rotation} for any media file.
    width/height are DISPLAY dimensions (rotation applied)."""
    proc = run([ffprobe_bin(ctx), "-v", "error", "-show_format", "-show_streams", "-of", "json", str(path)],
               timeout=60, what=f"ffprobe {Path(path).name}")
    data = json.loads(proc.stdout or "{}")
    out = {"duration": 0.0, "width": 0, "height": 0, "fps": 0.0, "has_video": False,
           "has_audio": False, "rotation": 0}
    try:
        out["duration"] = float(data.get("format", {}).get("duration") or 0.0)
    except ValueError:
        pass
    for s in data.get("streams", []):
        if s.get("codec_type") == "video" and not out["has_video"]:
            disp = s.get("disposition") or {}
            if disp.get("attached_pic"):
                continue
            out["has_video"] = True
            w, h = int(s.get("width") or 0), int(s.get("height") or 0)
            rot = 0
            for sd in s.get("side_data_list") or []:
                if "rotation" in sd:
                    rot = int(round(float(sd["rotation"])))
            if "rotate" in (s.get("tags") or {}):
                rot = int(s["tags"]["rotate"])
            if abs(rot) % 180 == 90:
                w, h = h, w
            out.update(width=w, height=h, rotation=rot)
            num, _, den = str(s.get("avg_frame_rate") or s.get("r_frame_rate") or "0/1").partition("/")
            try:
                out["fps"] = float(num) / float(den or 1) if float(den or 1) else 0.0
            except ValueError:
                out["fps"] = 0.0
            if not out["duration"]:
                try:
                    out["duration"] = float(s.get("duration") or 0.0)
                except ValueError:
                    pass
        elif s.get("codec_type") == "audio":
            out["has_audio"] = True
    return out


def kind_of(path: Path) -> str:
    ext = Path(path).suffix.lower()
    if ext in IMAGE_EXT:
        return "image"
    if ext in VIDEO_EXT:
        return "video"
    if ext in AUDIO_EXT:
        return "audio"
    return "unknown"


# --- frame decoding ----------------------------------------------------------------------------

def decode_frames(path: Path, fps: float, width: int, start: float = 0.0, duration: Optional[float] = None,
                  ctx=None, times: Optional[list] = None):
    """Yield (t_seconds, bgr ndarray) frames scaled to `width` px wide (aspect kept, even height),
    sampled at `fps` from `start` for `duration` seconds. Uses ffmpeg so any path works.
    If `times` is given, decodes exactly those timestamps (one seek each)."""
    info = probe(path, ctx)
    if not info["has_video"]:
        raise EngineError("NO_VIDEO", f"{path} has no video stream", "This file has no picture in it.")
    sw, sh = info["width"], info["height"]
    w = int(width) // 2 * 2
    h = int(round(sh * w / max(1, sw))) // 2 * 2
    if times is not None:
        win = _dense_window(times, info)
        if win is not None:
            # many close timestamps (the cover's search around one moment): ONE decode of the
            # window instead of one ffmpeg start + seek per frame (25 spawns, 10-15 s on HEVC)
            yield from _window_frames(path, times, win, w, h, ctx)
            return
        for t in times:
            cmd = [ffmpeg_bin(ctx), "-v", "error", "-nostdin", "-ss", f"{max(0.0, t):.3f}", "-i", str(path),
                   "-frames:v", "1", "-vf", f"scale={w}:{h}:flags=area", "-f", "rawvideo", "-pix_fmt", "bgr24", "-"]
            proc = run(cmd, timeout=60, what="frame grab", binary=True)
            buf = proc.stdout
            if len(buf) >= w * h * 3:
                yield t, np.frombuffer(buf[: w * h * 3], np.uint8).reshape(h, w, 3)
        return
    cmd = [ffmpeg_bin(ctx), "-v", "error", "-nostdin"]
    if start > 0:
        cmd += ["-ss", f"{start:.3f}"]
    cmd += ["-i", str(path)]
    if duration is not None:
        cmd += ["-t", f"{duration:.3f}"]
    cmd += ["-an", "-vf", f"fps={fps},scale={w}:{h}:flags=area", "-f", "rawvideo", "-pix_fmt", "bgr24", "-"]
    proc = subprocess.Popen([str(c) for c in cmd], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            stdin=subprocess.DEVNULL)
    size = w * h * 3
    i = 0
    try:
        while True:
            buf = proc.stdout.read(size)
            if len(buf) < size:
                break
            yield start + i / fps, np.frombuffer(buf, np.uint8).reshape(h, w, 3)
            i += 1
    finally:
        proc.stdout.close()
        proc.kill()
        proc.wait()


def _dense_window(times: list, info: dict) -> Optional[tuple]:
    """(start, end) when `times` are ascending, >= 4 of them, and no two more than 0.5 s apart."""
    if len(times) < 4 or any(b < a or b - a > 0.5 for a, b in zip(times, times[1:])):
        return None
    fps = float(info.get("fps") or 0)
    if fps <= 0:
        return None
    return max(0.0, float(times[0])), float(times[-1]) + 2.0 / fps


def _window_frames(path: Path, times: list, win: tuple, w: int, h: int, ctx=None):
    """For each t, the first frame at or after t (what `-ss t -frames:v 1` returns), from one decode.
    Frame k of an accurate `-ss a` seek is at a + k/fps (sources are constant frame rate)."""
    info = probe(path, ctx)
    fps = float(info["fps"])
    a, b = win
    cmd = [ffmpeg_bin(ctx), "-v", "error", "-nostdin", "-ss", f"{a:.3f}", "-i", str(path), "-t", f"{b - a:.3f}",
           "-an", "-vf", f"scale={w}:{h}:flags=area", "-f", "rawvideo", "-pix_fmt", "bgr24", "-"]
    size = w * h * 3
    t0 = round(a, 3)
    # A separate file keeps stderr from filling a pipe while stdout is read one frame at a time.
    with tempfile.TemporaryFile() as stderr:
        try:
            proc = subprocess.Popen([str(c) for c in cmd], stdout=subprocess.PIPE, stderr=stderr,
                                    stdin=subprocess.DEVNULL)
        except FileNotFoundError:
            raise EngineError("NO_FFMPEG", f"{cmd[0]} not found",
                              "A video tool is missing. Reinstall Reel Studio.") from None
        timed_out = threading.Event()

        def timeout():
            timed_out.set()
            proc.kill()

        timer = threading.Timer(120, timeout)
        index, buf, eof = -1, b"", False
        try:
            timer.start()
            for t in times:
                k = max(0, int(math.ceil((t - t0) * fps - 1e-6)))
                while index < k and not eof:
                    frame = proc.stdout.read(size)
                    if len(frame) < size:
                        eof = True
                    else:
                        buf = frame
                        index += 1
                # At EOF, repeat the final complete frame, as the buffered decoder did.
                if buf:
                    yield t, np.frombuffer(buf, np.uint8).reshape(h, w, 3)
            while not eof:
                eof = len(proc.stdout.read(size)) < size
            proc.wait()
            timer.cancel()
            timer.join()
            if timed_out.is_set():
                raise EngineError("TIMEOUT", "frame grab exceeded 120s",
                                  "This step took too long. Try a shorter video.")
            if proc.returncode != 0:
                stderr.seek(0, os.SEEK_END)
                stderr.seek(max(0, stderr.tell() - 6000))
                err = stderr.read().decode("utf-8", "replace")
                raise EngineError("FFMPEG_FAILED", f"frame grab failed: {err[-1500:]}",
                                  "Something went wrong while making your video. Try again.")
        finally:
            timer.cancel()
            proc.kill()
            proc.wait()
            proc.stdout.close()
            if timer.ident is not None:
                timer.join()


def grab_frame(path: Path, t: float, ctx=None, width: Optional[int] = None) -> np.ndarray:
    """One full-resolution (or `width`-scaled) BGR frame at t seconds."""
    info = probe(path, ctx)
    w = width or info["width"]
    for _, fr in decode_frames(path, 1, w, ctx=ctx, times=[t]):
        return fr
    raise EngineError("FRAME_FAILED", f"no frame at {t}s in {path}", "I couldn't read a picture from this video.")


# --- fonts -------------------------------------------------------------------------------------

FONT_PREFS = {
    "bold": ["Montserrat-Bold.ttf", "Montserrat-ExtraBold.ttf", "Montserrat-SemiBold.ttf", "Montserrat-VF.ttf",
             "Inter_700Bold.ttf", "Inter-Bold.ttf", "Roboto-Bold.ttf"],
    "semibold": ["Montserrat-SemiBold.ttf", "Montserrat-VF.ttf", "Inter_600SemiBold.ttf", "Inter-SemiBold.ttf",
                 "Roboto-Medium.ttf"],
}
SYSTEM_FONTS = [
    "C:/Windows/Fonts/arialbd.ttf", "C:/Windows/Fonts/segoeuib.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/Library/Fonts/Arial Bold.ttf",
    "/System/Library/Fonts/Helvetica.ttc", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
]


def font_dirs() -> list[Path]:
    dirs = []
    if os.environ.get("REELENGINE_FONTS"):
        dirs.append(Path(os.environ["REELENGINE_FONTS"]))
    dirs += [PKG_DIR / "fonts", PKG_DIR.parent.parent / "resources" / "fonts",
             PKG_DIR.parent.parent / "app" / "resources" / "fonts"]
    return [d for d in dirs if d.is_dir()]


def find_font(weight: str = "bold", name: Optional[str] = None) -> Optional[Path]:
    wanted = []
    if name:
        base = name.replace(" ", "-")
        wanted += [f"{base}.ttf", f"{base}.otf", f"{name.replace(' ', '')}.ttf", name]
    wanted += FONT_PREFS.get(weight, FONT_PREFS["bold"])
    for d in font_dirs():
        files = {p.name.lower(): p for p in d.rglob("*") if p.suffix.lower() in (".ttf", ".otf", ".ttc")}
        for want in wanted:
            if want.lower() in files:
                return files[want.lower()]
    for f in SYSTEM_FONTS:
        if Path(f).exists():
            return Path(f)
    return None


def load_font(size: int, weight: str = "bold", name: Optional[str] = None):
    from PIL import ImageFont
    f = find_font(weight, name)
    if f is not None:
        try:
            font = ImageFont.truetype(str(f), int(size))
            if f.name.lower().endswith("-vf.ttf"):
                try:
                    font.set_variation_by_axes([700 if weight == "bold" else 600])
                except Exception:
                    pass
            return font
        except OSError:
            pass
    return ImageFont.load_default(size=int(size))


# --- images ------------------------------------------------------------------------------------

def open_image(path: Path):
    """PIL RGBA image for any still we accept (HEIC if pi-heif or pillow-heif is installed)."""
    from PIL import Image
    p = Path(path)
    if p.suffix.lower() in (".heic", ".heif"):
        try:
            # The packaged app ships pi-heif (decode-only, LGPL); pillow-heif has the same API.
            try:
                import pi_heif as heif  # type: ignore
            except ImportError:
                import pillow_heif as heif  # type: ignore
            heif.register_heif_opener()
        except ImportError:
            raise EngineError("HEIC_UNSUPPORTED", f"{p.name}: needs pi-heif",
                              "This photo format isn't supported yet. Save it as a JPG or PNG and try again.") from None
    if p.suffix.lower() == ".svg":
        raise EngineError("SVG_UNSUPPORTED", f"{p.name}: SVG cannot be rasterised",
                          "This picture is a drawing file I can't use. Try a PNG or JPG instead.")
    try:
        img = Image.open(p)
        img.load()
    except FileNotFoundError:
        raise EngineError("ASSET_MISSING", f"not found: {p}",
                          "A picture for your b-roll is missing. It may have been moved or deleted.") from None
    except Exception as e:
        raise EngineError("ASSET_UNREADABLE", f"{p.name}: {e}",
                          "I couldn't open one of your pictures. Try a different file.") from None
    try:
        from PIL import ImageOps
        img = ImageOps.exif_transpose(img)
    except Exception:
        pass
    return img.convert("RGBA")


# --- word anchors ------------------------------------------------------------------------------

def _get(obj: Any, *names, default=None):
    for n in names:
        if isinstance(obj, dict) and n in obj:
            return obj[n]
        if hasattr(obj, n):
            return getattr(obj, n)
    return default


def ctx_words(ctx) -> dict:
    """word id -> word dict, from ctx.words or the project's transcript file. Cached on ctx."""
    cache = getattr(ctx, "_a2_words", None)
    if cache is not None:
        return cache
    words = list(getattr(ctx, "words", None) or [])
    if not words:
        tf = ((ctx.project.get("transcript") or {}).get("file")) if isinstance(ctx.project, dict) else None
        if tf:
            p = Path(ctx.project_dir) / "work" / "transcript.json"     # never the project-supplied path
            if p.exists():
                words = json.loads(p.read_text(encoding="utf-8")).get("words", [])
    out = {w["id"]: w for w in words if isinstance(w, dict) and "id" in w}
    try:
        setattr(ctx, "_a2_words", out)
    except Exception:
        pass
    return out


def _seg_at(ctx, source: str, t: float, prefer_end: bool = False):
    best = None
    for seg in ctx.out_timeline or []:
        if _get(seg, "source") != source:
            continue
        a, b = float(_get(seg, "src_start")), float(_get(seg, "src_end"))
        if a - 1e-3 <= t <= b + 1e-3:
            best = seg
            if not prefer_end:
                break
    return best


def word_start(ctx, wid: str) -> Optional[float]:
    """Output seconds where word `wid` starts, or None if it is not in the cut."""
    try:
        v = ctx.word_out_time(wid)
        if v is not None:
            return float(v)
    except Exception:
        pass
    w = ctx_words(ctx).get(wid)
    if not w:
        return None
    seg = _seg_at(ctx, w.get("source", "s1"), float(w["s"]))
    if seg is None:
        return None
    return float(_get(seg, "out_start")) + max(0.0, float(w["s"]) - float(_get(seg, "src_start")))


def word_end(ctx, wid: str) -> Optional[float]:
    """Output seconds where word `wid` ends, or None if it is not in the cut."""
    fn = getattr(ctx, "word_out_end", None)
    if fn is not None:
        try:
            v = fn(wid)
            if v is not None:
                return float(v)
        except Exception:
            pass
    w = ctx_words(ctx).get(wid)
    s = word_start(ctx, wid)
    if s is None:
        return None
    if not w:
        return s + 0.3
    seg = _seg_at(ctx, w.get("source", "s1"), float(w["s"]))
    end = s + max(0.05, float(w["e"]) - float(w["s"]))
    if seg is not None:
        end = min(end, float(_get(seg, "out_start")) + float(_get(seg, "src_end")) - float(_get(seg, "src_start")))
    return end


def word_ids_between(ctx, a: str, b: str) -> list[str]:
    """Kept word ids from a to b inclusive, in output order (used for one-tile-per-word builds)."""
    words = ctx_words(ctx)
    sa, sb = word_start(ctx, a), word_start(ctx, b)
    if sa is None or sb is None:
        return [x for x in (a, b) if word_start(ctx, x) is not None]
    out = []
    for wid in words:
        s = word_start(ctx, wid)
        if s is not None and sa - 1e-6 <= s <= sb + 1e-6:
            out.append((s, wid))
    out.sort()
    return [w for _, w in out] or [a]


def output_to_source(ctx, t: float):
    """Output seconds -> (source id, source seconds) via the cut timeline, or (None, None)."""
    segs = list(ctx.out_timeline or [])
    for seg in segs:
        o0 = float(_get(seg, "out_start"))
        dur = float(_get(seg, "src_end")) - float(_get(seg, "src_start"))
        if o0 - 1e-6 <= t < o0 + dur + 1e-6:
            return _get(seg, "source"), float(_get(seg, "src_start")) + (t - o0)
    if segs:
        last = segs[-1]
        return _get(last, "source"), float(_get(last, "src_end"))
    return None, None


def source_spans(ctx, t0: float, t1: float):
    """Output window -> [(source id, src_a, src_b, out_a)] pieces it plays."""
    out = []
    for seg in ctx.out_timeline or []:
        o0 = float(_get(seg, "out_start"))
        sa, sb = float(_get(seg, "src_start")), float(_get(seg, "src_end"))
        o1 = o0 + (sb - sa)
        a, b = max(t0, o0), min(t1, o1)
        if b - a > 1e-3:
            out.append((_get(seg, "source"), sa + (a - o0), sa + (b - o0), a))
    return out


def source_entry(ctx, sid: str) -> Optional[dict]:
    for s in (ctx.project.get("sources") or []):
        if s.get("id") == sid:
            return s
    return None


def source_path(ctx, sid: str) -> Optional[Path]:
    s = source_entry(ctx, sid)
    if not s:
        return None
    return resolve_asset(ctx, s["path"])


def resolve_asset(ctx, p: str) -> Path:
    """project.json path -> real path inside media/, work/ or root/Library; UNSAFE_PATH otherwise.
    No fallback: a resolver that fails must never fall through to an unchecked join."""
    from .safepath import safe_resolve
    return safe_resolve(Path(ctx.project_dir), p, root=Path(ctx.root) if getattr(ctx, "root", None) else None,
                        what="asset")


# --- source -> output pixel transform -------------------------------------------------------------

def cover_transform(src_w: int, src_h: int, out_w: int, out_h: int):
    """Scale-to-cover + centre crop (how the cut video fills the 9:16 frame).
    Returns (scale, offset_x, offset_y): out = src * scale - offset."""
    s = max(out_w / max(1, src_w), out_h / max(1, src_h))
    return s, (src_w * s - out_w) / 2.0, (src_h * s - out_h) / 2.0


def map_box(box, src_w, src_h, out_w, out_h):
    s, ox, oy = cover_transform(src_w, src_h, out_w, out_h)
    x, y, w, h = box
    return (x * s - ox, y * s - oy, w * s, h * s)


def reframe_rect(ctx, sid: str) -> tuple:
    """(x, y, cw, ch): the crop of source `sid` (display px) that the render scales to the output
    frame. Mirrors render.reframe_filter (A1) exactly, including its face-centred crop for sources
    whose shape differs from the output. Decided once per ctx, before any face file is written by
    this module, so it matches what render decided at its start."""
    cache = getattr(ctx, "_a2_reframe", None)
    if cache is None:
        cache = {}
        try:
            setattr(ctx, "_a2_reframe", cache)
        except Exception:
            pass
    if sid in cache:
        return cache[sid]
    W, H, _ = fmt_of(ctx)
    s = source_entry(ctx, sid) or {}
    w, h = int(s.get("width") or W), int(s.get("height") or H)
    if int(s.get("rotation") or 0) % 180 == 90:
        w, h = h, w
    face = None
    try:
        from .render import face_center
        face = face_center(Path(ctx.project_dir), sid, w, h)
    except Exception:
        face = None
    target = W / H
    if w / h > target + 1e-3:
        cw, ch = int(round(h * target)) // 2 * 2, h // 2 * 2
        cx = face[0] if face else w / 2
        x, y = int(min(max(0, cx - cw / 2), w - cw)), 0
    elif w / h < target - 1e-3:
        cw, ch = w // 2 * 2, int(round(w / target)) // 2 * 2
        cy = face[1] if face else h * 0.45
        x, y = 0, int(min(max(0, cy - ch * 0.42), h - ch))
    else:
        cw, ch, x, y = w // 2 * 2, h // 2 * 2, 0, 0
    cache[sid] = (x, y, cw, ch)
    return cache[sid]


def map_box_rect(box, rect, out_w: int, out_h: int):
    """Source px box -> output px through a reframe crop rect."""
    x0, y0, cw, ch = rect
    sx, sy = out_w / cw, out_h / ch
    x, y, w, h = box
    return ((x - x0) * sx, (y - y0) * sy, w * sx, h * sy)


def reframe_vf(ctx, sid: str) -> str:
    W, H, _ = fmt_of(ctx)
    x, y, cw, ch = reframe_rect(ctx, sid)
    return f"crop={cw}:{ch}:{x}:{y},scale={W}:{H}"


def fmt_of(ctx) -> tuple[int, int, float]:
    f = getattr(ctx, "fmt", None) or (ctx.project.get("format") if isinstance(ctx.project, dict) else None) or {}
    return int(f.get("width", 1080)), int(f.get("height", 1920)), float(f.get("fps", 30))


def layers_dir(ctx) -> Path:
    d = Path(ctx.work) / "layers"
    d.mkdir(parents=True, exist_ok=True)
    return d


def report(ctx, stage: str, pct: float, message: str) -> None:
    fn = getattr(ctx, "progress", None)
    if fn:
        try:
            fn(stage, pct, message)
        except Exception:
            pass


def iter_chunks(seq: Iterable, n: int):
    buf = []
    for x in seq:
        buf.append(x)
        if len(buf) == n:
            yield buf
            buf = []
    if buf:
        yield buf
