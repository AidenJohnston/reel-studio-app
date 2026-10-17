"""Locating binaries/resources and running ffmpeg safely.

Env (docs/architecture.md section 4): REELENGINE_FFMPEG, REELENGINE_FFPROBE, REELENGINE_MODELS, REELENGINE_FONTS,
REELENGINE_ROOT. Defaults: PATH, then repo-relative.

Every subprocess is bounded by a timeout, decoded as utf-8 (Windows' code page cannot represent a
non-ASCII path in ffmpeg's log), and gets its arguments as a list, so spaces never need quoting.
"""
from __future__ import annotations

import os
import hashlib
import json
import platform
import re
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Callable, Optional

from .proto import EngineError, log

PKG_DIR = Path(__file__).resolve().parent
ENGINE_DIR = PKG_DIR.parent
REPO_DIR = ENGINE_DIR.parent

_CACHE: dict = {}


def _which(env: str, name: str) -> Optional[str]:
    val = os.environ.get(env)
    if val:
        return val if Path(val).exists() else None
    found = shutil.which(name)
    if found:
        return found
    exe = name + (".exe" if os.name == "nt" else "")
    for cand in (REPO_DIR / "packaging" / "runtime" / "ffmpeg" / exe, ENGINE_DIR / "bin" / exe):
        if cand.exists():
            return str(cand)
    return None


def ffmpeg() -> str:
    p = _which("REELENGINE_FFMPEG", "ffmpeg")
    if not p:
        raise EngineError("FFMPEG_MISSING", "ffmpeg not found (REELENGINE_FFMPEG / PATH)",
                          "Reel Studio is missing a part it needs to make videos. "
                          "Please reinstall the app.")
    return p


def ffprobe() -> str:
    p = _which("REELENGINE_FFPROBE", "ffprobe")
    if not p:
        raise EngineError("FFMPEG_MISSING", "ffprobe not found (REELENGINE_FFPROBE / PATH)",
                          "Reel Studio is missing a part it needs to read videos. "
                          "Please reinstall the app.")
    return p


def documents_dir() -> Path:
    if os.name == "nt":
        return Path(os.environ.get("USERPROFILE", str(Path.home()))) / "Documents"
    return Path.home() / "Documents"


def root_dir(explicit: Optional[str] = None) -> Path:
    """The Reel Studio root (holds Library/, Projects/, My style.json)."""
    if explicit:
        return Path(explicit)
    env = os.environ.get("REELENGINE_ROOT")
    return Path(env) if env else documents_dir() / "Reel Studio"


def appdata_dir() -> Path:
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Reel Studio"
    if os.name == "nt":
        return Path(os.environ.get("APPDATA", str(Path.home()))) / "Reel Studio"
    return Path.home() / ".local" / "share" / "reel-studio"


def models_dir() -> Path:
    env = os.environ.get("REELENGINE_MODELS")
    if env:
        return Path(env)
    return appdata_dir() / "models"


def font_dirs() -> list[Path]:
    """Where caption fonts may live, most specific first. The bundled fonts always come last so a
    font named in project.json can never silently fall back to a system face (libass would)."""
    dirs = []
    env = os.environ.get("REELENGINE_FONTS")
    if env:
        dirs += [Path(p) for p in env.split(os.pathsep) if p]
    dirs.append(PKG_DIR / "fonts")
    return [d for d in dirs if d.is_dir()]


def text_run(cmd: list, timeout: float, what: str, check: bool = True, cwd=None,
             user_message: Optional[str] = None) -> subprocess.CompletedProcess:
    try:
        proc = subprocess.run([str(c) for c in cmd], capture_output=True, text=True,
                              encoding="utf-8", errors="replace", timeout=timeout,
                              cwd=str(cwd) if cwd else None, stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        raise EngineError("TIMEOUT", f"{what} exceeded {timeout:.0f}s",
                          "This took far longer than it should, so I stopped it. "
                          "Please try again.")
    except FileNotFoundError as exc:
        raise EngineError("FFMPEG_MISSING", f"{what}: {exc}",
                          "Reel Studio is missing a part it needs. Please reinstall the app.")
    if check and proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "")[-2000:]
        raise EngineError("FFMPEG_FAILED", f"{what} failed (exit {proc.returncode}):\n{tail}",
                          user_message or "Something went wrong while working on your video. "
                                          "Please try again.")
    return proc


_TIME_RE = re.compile(r"out_time_us=(\d+)")


def ffmpeg_progress(cmd: list, duration: float, on_pct: Callable[[float], None], timeout: float,
                    what: str, cwd=None, user_message: Optional[str] = None) -> str:
    """Run an ffmpeg command that has `-progress pipe:1 -nostats` and report 0-100 as it encodes.
    Returns stderr (the caller may inspect libass' fontselect lines)."""
    cmd = [str(c) for c in cmd]
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                stdin=subprocess.DEVNULL, text=True, encoding="utf-8",
                                errors="replace", cwd=str(cwd) if cwd else None)
    except FileNotFoundError as exc:
        raise EngineError("FFMPEG_MISSING", f"{what}: {exc}",
                          "Reel Studio is missing a part it needs. Please reinstall the app.")
    err_chunks: list[str] = []

    def pump_err():
        for line in proc.stderr:
            err_chunks.append(line)

    t = threading.Thread(target=pump_err, daemon=True)
    t.start()
    timed_out = threading.Event()

    def on_timeout():
        timed_out.set()
        proc.kill()

    timer = threading.Timer(timeout, on_timeout)
    timer.start()
    try:
        for line in proc.stdout:
            m = _TIME_RE.search(line)
            if m and duration > 0:
                on_pct(min(100.0, int(m.group(1)) / 1e6 / duration * 100.0))
        proc.wait()
    finally:
        timer.cancel()
    t.join(timeout=5)
    err = "".join(err_chunks)
    if timed_out.is_set():
        raise EngineError("TIMEOUT", f"{what} exceeded {timeout:.0f}s and was stopped",
                          "This took far longer than it should, so I stopped it. Please try again.")
    if proc.returncode != 0:
        raise EngineError("FFMPEG_FAILED", f"{what} failed (exit {proc.returncode}):\n{err[-2500:]}",
                          user_message or "Something went wrong while making your video. "
                                          "Please try again.")
    return err


def ffmpeg_version() -> tuple:
    """(major, minor) of the ffmpeg in use; (0, 0) when the banner has no release number (git
    builds print e.g. 'N-112345-g...': treated as new)."""
    if "version" not in _CACHE:
        out = text_run([ffmpeg(), "-hide_banner", "-version"], 30, "ffmpeg -version", check=False)
        m = re.search(r"ffmpeg version n?(\d+)\.(\d+)", out.stdout or "")
        _CACHE["version"] = (int(m.group(1)), int(m.group(2))) if m else (0, 0)
    return _CACHE["version"]


def filter_script_args(graph_file) -> list:
    """Read -filter_complex from a file. FFmpeg 7.0 added `-/filter_complex <file>` and 8.0
    REMOVED the old `-filter_complex_script` (Homebrew on macOS ships 8+); 6.1 only knows the old one."""
    major, _ = ffmpeg_version()
    if major and major < 7:
        return ["-filter_complex_script", str(graph_file)]
    return ["-/filter_complex", str(graph_file)]


def encoders() -> set:
    if "encoders" not in _CACHE:
        out = text_run([ffmpeg(), "-hide_banner", "-encoders"], 60, "ffmpeg -encoders", check=False)
        names = set()
        for line in (out.stdout or "").splitlines():
            parts = line.split()
            if len(parts) >= 2 and len(parts[0]) == 6:
                names.add(parts[1])
        _CACHE["encoders"] = names
    return _CACHE["encoders"]


def filters() -> set:
    if "filters" not in _CACHE:
        out = text_run([ffmpeg(), "-hide_banner", "-filters"], 60, "ffmpeg -filters", check=False)
        names = set()
        for line in (out.stdout or "").splitlines():
            parts = line.split()
            if len(parts) >= 3 and len(parts[0]) == 3:
                names.add(parts[1])
        _CACHE["filters"] = names
    return _CACHE["filters"]


# Hardware H.264 encoders worth trying for the fast draft, best first. The binary lists an encoder when it was
# BUILT with the vendor's headers; whether this machine has the GPU and a driver for it is only known by opening it.
HW_DRAFT_ENCODERS = {
    "darwin": ("h264_videotoolbox",),
    "win32": ("h264_nvenc", "h264_amf", "h264_qsv"),
}
_DEFAULT_HW_DRAFT_ENCODERS = ("h264_nvenc",)

# Codec options per hardware encoder (the colour tags and the -pix_fmt for the encoder's input are added by
# render.encoder_args). The probe below uses exactly these, so it tests what a render will ask for.
HW_ENCODER_OPTS = {
    "h264_nvenc": ["-preset", "p4", "-rc", "vbr", "-cq", "23", "-b:v", "0", "-profile:v", "high"],
    "h264_videotoolbox": ["-b:v", "6M", "-profile:v", "high"],
    "h264_amf": ["-quality", "speed", "-rc", "vbr_peak", "-b:v", "6M", "-profile:v", "high"],
    "h264_qsv": ["-preset", "veryfast", "-b:v", "6M", "-profile:v", "high"],
}
HW_ENCODER_PIX_FMT = {"h264_qsv": "nv12"}      # everything else takes yuv420p

PROBE_OK_DAYS = 30        # a working GPU encoder is re-tested monthly
PROBE_FAIL_DAYS = 3       # a failing one sooner: the user may have just installed a driver


def probe_cache_file() -> Path:
    env = os.environ.get("REELENGINE_CACHE")
    return (Path(env) if env else appdata_dir()) / "encoder-probe.json"


def _ffmpeg_fingerprint() -> str:
    """Identifies this ffmpeg build; a new binary (an app update) re-runs the probes."""
    exe = Path(ffmpeg())
    try:
        h = hashlib.sha1()          # the zip stamps every file with the same date, so size+mtime cannot tell builds apart
        with open(exe, "rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                h.update(chunk)
        return f"{exe}|{h.hexdigest()}"
    except OSError:
        return str(exe)


def _probe_cache_read() -> dict:
    try:
        data = json.loads(probe_cache_file().read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _probe_cache_write(data: dict) -> None:
    f = probe_cache_file()
    try:
        f.parent.mkdir(parents=True, exist_ok=True)
        tmp = f.with_name(f.name + f".{os.getpid()}.tmp")
        tmp.write_text(json.dumps(data, indent=1, sort_keys=True), encoding="utf-8")
        os.replace(tmp, f)
    except OSError:
        pass          # a read-only profile just re-probes next time


def probe_encoder(name: str) -> bool:
    """Open `name` and encode one second through the same shape of pipeline a draft uses."""
    opts = HW_ENCODER_OPTS.get(name, [])
    pix = HW_ENCODER_PIX_FMT.get(name, "yuv420p")
    cmd = [ffmpeg(), "-hide_banner", "-nostdin", "-f", "lavfi", "-i", "color=c=black:s=640x360:d=1:r=30",
           "-vf", "format=yuv420p", "-c:v", name, *opts, "-pix_fmt", pix, "-f", "null", "-"]
    try:
        return text_run(cmd, 60, f"probe {name}", check=False).returncode == 0
    except EngineError:
        return False


def encoder_works(name: str) -> bool:
    """An encoder listed by ffmpeg can still fail at open (no GPU, old driver). Probe it once per
    machine (one second of video), remember the answer on disk next to the models."""
    key = "works:" + name
    if key in _CACHE:
        return _CACHE[key]
    ok = False
    if name in encoders():
        fp = _ffmpeg_fingerprint()
        disk = _probe_cache_read()
        hit = disk.get(name)
        now = time.time()
        if (isinstance(hit, dict) and hit.get("ffmpeg") == fp
                and now - float(hit.get("at", 0)) < 86400 * (PROBE_OK_DAYS if hit.get("ok") else PROBE_FAIL_DAYS)):
            ok = bool(hit.get("ok"))
        else:
            ok = probe_encoder(name)
            disk[name] = {"ok": ok, "at": now, "ffmpeg": fp}
            _probe_cache_write(disk)
    _CACHE[key] = ok
    return ok


def mark_encoder_failed(name: str) -> None:
    """A hardware encoder that passed the probe still failed a real render: remember that."""
    _CACHE["works:" + name] = False
    disk = _probe_cache_read()
    disk[name] = {"ok": False, "at": time.time(), "ffmpeg": _ffmpeg_fingerprint()}
    _probe_cache_write(disk)


def draft_encoder() -> str:
    """Fast preview encoder: the first hardware H.264 encoder this ffmpeg lists that really opens on this
    machine (VideoToolbox on macOS; NVENC, AMF, Quick Sync on Windows), else libx264 ultrafast.
    REELENGINE_DRAFT_ENCODER=<name> forces one (libx264 = software drafts)."""
    forced = os.environ.get("REELENGINE_DRAFT_ENCODER")
    if forced:
        return forced
    for name in HW_DRAFT_ENCODERS.get(sys.platform, _DEFAULT_HW_DRAFT_ENCODERS):
        if encoder_works(name):
            return name
    return "libx264"


def hwaccel() -> Optional[str]:
    """Hardware DECODE for previews (frames come back to system memory for the filters). The final
    export decodes in software so the same project always gives the same bytes."""
    if os.environ.get("REELENGINE_HWACCEL", "1") == "0":
        return None
    if "hwaccel" not in _CACHE:
        out = text_run([ffmpeg(), "-hide_banner", "-hwaccels"], 30, "ffmpeg -hwaccels", check=False)
        names = set((out.stdout or "").split())
        pick = None
        if sys.platform == "darwin" and "videotoolbox" in names:
            pick = "videotoolbox"
        elif "cuda" in names and encoder_works("h264_nvenc"):
            pick = "cuda"
        _CACHE["hwaccel"] = pick
    return _CACHE["hwaccel"]


def machine() -> dict:
    return {"os": sys.platform, "arch": platform.machine(), "python": platform.python_version()}


def safe_copy(src: Path, dst: Path) -> Path:
    """Hard link when possible (instant, no extra disk), else copy. REELENGINE_LINK_MEDIA=0 forces a
    copy (tests that must not share an inode with read-only source material)."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists():
        try:
            if os.path.samefile(src, dst):
                return dst
        except OSError:
            pass
        # A file left by an init that died before saving project.json is STALE: reusing it would
        # record the new file's duration/fps against the old picture. Unlink
        # (never truncate: it may be a hard link to the user's original) and link/copy afresh.
        dst.unlink()
    if os.environ.get("REELENGINE_LINK_MEDIA", "1") != "0":
        try:
            os.link(src, dst)
            return dst
        except OSError:
            pass
    shutil.copy2(src, dst)
    return dst


def unique_path(p: Path) -> Path:
    if not p.exists():
        return p
    stem, suf = p.stem, p.suffix
    for i in range(2, 10000):
        cand = p.with_name(f"{stem} ({i}){suf}")
        if not cand.exists():
            return cand
    raise EngineError("IO", f"no free name for {p}", "I couldn't save a file. Please try again.")


def debug(msg: str) -> None:
    log(f"# {msg}")
