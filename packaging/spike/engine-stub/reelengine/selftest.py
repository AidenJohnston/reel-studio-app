"""Packaging self-test. Runs INSIDE the bundled Python.

Prints JSON lines on stdout (same shape as the real engine CLI): progress events, then one
{"event":"done","result":{...}}. Exit 0 only if every required check passed.

Env (same names as docs/architecture.md section 4): REELENGINE_FFMPEG, REELENGINE_FFPROBE, REELENGINE_MODELS.
Extra: SELFTEST_WAV (speech sample), SELFTEST_WORKDIR (scratch dir; deliberately has spaces).
"""
import json
import os
import platform
import subprocess
import sys
import time
import traceback
from pathlib import Path

checks = []


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def check(name, fn, required=True):
    t0 = time.time()
    try:
        detail = fn()
        ok = True
    except Exception as e:  # noqa: BLE001 - report everything
        detail = "%s: %s" % (type(e).__name__, e)
        emit({"event": "log", "check": name, "trace": traceback.format_exc()})
        ok = False
    rec = {"name": name, "ok": ok, "required": required, "seconds": round(time.time() - t0, 2), "detail": detail}
    checks.append(rec)
    emit({"event": "check", **rec})
    return ok


def run(cmd, **kw):
    return subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True,
                          encoding="utf-8", errors="replace", **kw)


def t_python():
    return {"version": platform.python_version(), "executable": sys.executable, "prefix": sys.prefix,
            "machine": platform.machine(), "platform": sys.platform, "flags_isolated": sys.flags.isolated}


def t_imports():
    import numpy, PIL, cv2, ctranslate2, faster_whisper, yt_dlp, jsonschema  # noqa: E401
    import pi_heif
    pi_heif.register_heif_opener()
    try:  # pillow-heif bundles GPL x265 and must never ship
        import pillow_heif  # noqa: F401
        raise RuntimeError("pillow_heif is installed: its wheel bundles GPL x265")
    except ImportError:
        pass
    from importlib import metadata
    return {
        "numpy": numpy.__version__, "pillow": PIL.__version__, "opencv": cv2.__version__,
        "ctranslate2": ctranslate2.__version__, "faster_whisper": metadata.version("faster-whisper"),
        "yt_dlp": yt_dlp.version.__version__, "jsonschema": jsonschema.__version__,
        "pi_heif": pi_heif.__version__, "libheif": pi_heif.libheif_version(),
    }


def t_ffmpeg():
    ff, fp = os.environ["REELENGINE_FFMPEG"], os.environ["REELENGINE_FFPROBE"]
    a = run([ff, "-hide_banner", "-version"])
    b = run([fp, "-hide_banner", "-version"])
    if a.returncode or b.returncode:
        raise RuntimeError("ffmpeg/ffprobe exit codes %s/%s: %s" % (a.returncode, b.returncode, a.stderr[:200]))
    enc = run([ff, "-hide_banner", "-encoders"]).stdout
    filt = run([ff, "-hide_banner", "-filters"]).stdout
    return {"ffmpeg": a.stdout.splitlines()[0], "ffprobe": b.stdout.splitlines()[0],
            "libx264": "libx264" in enc, "h264_videotoolbox": "h264_videotoolbox" in enc,
            "h264_nvenc": "h264_nvenc" in enc,
            "ass_filter": " ass " in filt, "subtitles_filter": " subtitles " in filt}


def t_ffmpeg_features():
    d = run([os.environ["REELENGINE_FFMPEG"], "-hide_banner", "-encoders"]).stdout
    f = run([os.environ["REELENGINE_FFMPEG"], "-hide_banner", "-filters"]).stdout
    missing = [n for n, ok in (("libx264", "libx264" in d), ("aac", " aac " in d), ("ass filter", " ass " in f),
                               ("loudnorm", "loudnorm" in f), ("sidechaincompress", "sidechaincompress" in f),
                               ("overlay", " overlay " in f)) if not ok]
    if missing:
        raise RuntimeError("ffmpeg build lacks: %s" % ", ".join(missing))
    return "libx264, aac, ass, loudnorm, sidechaincompress, overlay present"


def t_render_with_captions(work):
    """Encode a 1s clip with libx264 AND burn a caption via libass, in a folder with spaces,
    then read a frame back with OpenCV. This is the engine's critical render path in miniature."""
    ff = os.environ["REELENGINE_FFMPEG"]
    work = Path(work)
    work.mkdir(parents=True, exist_ok=True)
    ass = work / "cap test.ass"
    ass.write_text(
        "[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\n\n[V4+ Styles]\n"
        "Format: Name,Fontname,Fontsize,PrimaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\n"
        "Style: Default,Arial,76,&H00FFFFFF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,6,0,2,40,40,600,1\n\n"
        "[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n"
        "Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,HELLO REEL\n", encoding="utf-8")
    out = work / "out clip.mp4"
    # run with cwd=work and a relative ass filename: avoids drive-letter colon escaping inside the filter graph
    cmd = [ff, "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=1080x1920:rate=30:duration=1",
           "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-vf", "ass=%s" % ass.name,
           "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", out.name]
    r = run(cmd, cwd=str(work))
    if r.returncode or not out.exists():
        raise RuntimeError("ffmpeg render failed: " + r.stderr[-400:])
    import cv2
    cap = cv2.VideoCapture(str(out))
    ok, frame = cap.read()
    cap.release()
    if not ok or frame.shape[:2] != (1920, 1080):
        raise RuntimeError("OpenCV could not read the rendered clip back")
    probe = run([os.environ["REELENGINE_FFPROBE"], "-v", "error", "-show_entries", "stream=codec_name,width,height", "-of", "csv=p=0", str(out)])
    return {"bytes": out.stat().st_size, "probe": probe.stdout.split(), "opencv_frame": list(frame.shape), "workdir": str(work)}


def t_model():
    from huggingface_hub import snapshot_download
    from tqdm.auto import tqdm

    models = Path(os.environ["REELENGINE_MODELS"])
    target = models / "faster-whisper-tiny"
    if (target / "model.bin").exists():
        return {"path": str(target), "downloaded": False, "bytes": (target / "model.bin").stat().st_size}

    class Progress(tqdm):
        _last = 0.0

        def update(self, n=1):
            r = super().update(n)
            now = time.time()
            if self.total and now - Progress._last > 0.5 or (self.total and self.n >= self.total):
                Progress._last = now
                emit({"event": "progress", "stage": "model-download", "pct": round(100.0 * self.n / self.total) if self.total else None,
                      "message": "Downloading the speech model", "desc": str(self.desc or "")[:60]})
            return r

    models.mkdir(parents=True, exist_ok=True)
    snapshot_download("Systran/faster-whisper-tiny", local_dir=str(target), tqdm_class=Progress,
                      allow_patterns=["config.json", "preprocessor_config.json", "model.bin", "tokenizer.json", "vocabulary.*"])
    size = (target / "model.bin").stat().st_size
    if size < 10_000_000:
        raise RuntimeError("model.bin looks truncated (%d bytes)" % size)
    return {"path": str(target), "downloaded": True, "bytes": size}


def t_transcribe():
    from faster_whisper import WhisperModel

    wav = os.environ["SELFTEST_WAV"]
    target = Path(os.environ["REELENGINE_MODELS"]) / "faster-whisper-tiny"
    t0 = time.time()
    model = WhisperModel(str(target), device="cpu", compute_type="int8")
    load = time.time() - t0
    segments, info = model.transcribe(wav, language="en", word_timestamps=True, beam_size=1)
    words = []
    for seg in segments:
        for w in seg.words or []:
            words.append({"w": w.word.strip(), "s": round(w.start, 2), "e": round(w.end, 2)})
    text = " ".join(w["w"] for w in words).lower()
    keywords = [k for k in ("hello", "test", "reel", "studio") if k in text]
    if len(keywords) < 2 or not words:
        raise RuntimeError("transcript did not contain the spoken words: %r" % text)
    return {"text": text, "word_count": len(words), "first_word": words[0], "keywords": keywords,
            "load_seconds": round(load, 2), "total_seconds": round(time.time() - t0, 2), "language": info.language}


def main():
    work = os.environ.get("SELFTEST_WORKDIR") or os.path.join(os.getcwd(), "selftest work")
    emit({"event": "progress", "stage": "start", "pct": 0, "message": "Starting self-test"})
    check("python", t_python)
    check("imports", t_imports)
    check("ffmpeg", t_ffmpeg)
    check("ffmpeg-features", t_ffmpeg_features)
    check("render-captions-spaces", lambda: t_render_with_captions(work))
    check("model-download", t_model)
    check("transcribe", t_transcribe)
    ok = all(c["ok"] for c in checks if c["required"])
    emit({"event": "done", "result": {"ok": ok, "checks": checks}})
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
