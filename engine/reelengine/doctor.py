"""`doctor`: is this install able to make videos? A human report on stderr, JSON on stdout."""
from __future__ import annotations

import shutil
import sys

from . import tools, transcribe
from .proto import EngineError, log, progress


def run() -> dict:
    checks = []

    def add(ok, name, detail, fix=""):
        checks.append({"ok": bool(ok), "name": name, "detail": detail, "fix": fix})

    progress("doctor", 10, "Checking Reel Studio", force=True)
    try:
        ff = tools.ffmpeg()
        ver = tools.text_run([ff, "-hide_banner", "-version"], 30, "ffmpeg -version").stdout.splitlines()[0]
        major, minor = tools.ffmpeg_version()
        new_enough = major == 0 or (major, minor) >= (6, 1)     # 0 = git build, assume current
        add(new_enough, "ffmpeg", f"{ff} ({ver[:60]})",
            "" if new_enough else "FFmpeg 6.1 or newer is needed (rotated phone videos). Reinstall Reel Studio.")
    except EngineError as exc:
        add(False, "ffmpeg", exc.message, "Reinstall Reel Studio.")
        ff = None
    try:
        add(True, "ffprobe", tools.ffprobe())
    except EngineError as exc:
        add(False, "ffprobe", exc.message, "Reinstall Reel Studio.")
    if ff:
        enc = tools.encoders()
        flt = tools.filters()
        add("libx264" in enc, "final encoder (libx264)", "present" if "libx264" in enc else "missing",
            "The bundled ffmpeg must include libx264.")
        add(True, "fast preview encoder", tools.draft_encoder())
        for f in ("subtitles", "loudnorm", "ebur128", "blackdetect"):
            add(f in flt, f"filter {f}", "present" if f in flt else "missing",
                "The bundled ffmpeg is missing a filter Reel Studio needs.")
        add("zscale" in flt, "HDR conversion (zscale)", "present" if "zscale" in flt else
            "missing: HDR phone videos will look washed out", "")
    progress("doctor", 50, "Checking Reel Studio")
    model = transcribe.default_model()
    present = transcribe.model_present(model)
    add(present, "speech model", f"{model} in {transcribe.model_dir(model)}" if present else
        f"{model} not downloaded ({tools.models_dir()})", "Run: python -m reelengine download-model")
    try:
        from . import captions
        fam, path, _, warn = captions.resolve_font(captions.DEFAULT_FONT)
        add(warn is None, "caption font", f"{fam}: {path}")
    except EngineError as exc:
        add(False, "caption font", exc.message, "Reinstall Reel Studio.")
    try:
        import faster_whisper
        add(True, "faster-whisper", faster_whisper.__version__)
    except ImportError as exc:
        add(False, "faster-whisper", str(exc), "pip install faster-whisper")
    gpu = transcribe.cuda_available()
    add(True, "GPU for listening", "NVIDIA CUDA" if gpu else "none (uses the CPU; slower but fine)")
    root = tools.root_dir()
    try:
        free = shutil.disk_usage(root if root.exists() else root.anchor).free
        add(free > 2e9, "free disk space", f"{free / 1e9:.1f} GB", "Free up some space on your disk.")
    except OSError:
        pass
    ok = all(c["ok"] for c in checks)
    for c in checks:
        log(f"  {'OK ' if c['ok'] else 'BAD'}  {c['name']:<26} {c['detail']}" +
            (f"   -> {c['fix']}" if not c["ok"] and c["fix"] else ""))
    progress("doctor", 100, "All checked", force=True)
    return {"ok": ok, "checks": checks, "machine": tools.machine(), "python": sys.version.split()[0],
            "root": str(root), "models": str(tools.models_dir())}
