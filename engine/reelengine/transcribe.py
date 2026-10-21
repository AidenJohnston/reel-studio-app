"""`transcribe`: faster-whisper word timestamps -> work/transcript.json with stable word ids.

GPU (CUDA float16) when it loads, else CPU int8. Word edges are then measured against the audio
(audio_env.refine_words), because whisper's own word times drift around pauses.

Word ids are stable for the life of the project: re-transcribing keeps an id for any new word that
overlaps an old word in time (same source), and only brand-new words get fresh ids.

Models live in REELENGINE_MODELS/<name>/ (CTranslate2 format). A missing model is the error
MODEL_MISSING; `python -m reelengine download-model --name X` fetches one with progress.
"""
from __future__ import annotations

import ctypes
import hashlib
import http.client
import importlib
import json
import os
import re
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Optional

from . import audio_env, project as projmod, tools, vocab as vocabmod
from .proto import EngineError, log, progress

DEFAULT_MODEL = "small.en"          # measured: best WER on CPU int8 at RTF ~0.19
MULTILINGUAL_MODEL = "small"         # used when the project language is set to anything but English
STAGE = "transcribe"

# CTranslate2 conversions on the Hugging Face hub (the same ones faster-whisper uses).
MODEL_REPOS = {
    "tiny": "Systran/faster-whisper-tiny", "tiny.en": "Systran/faster-whisper-tiny.en",
    "base": "Systran/faster-whisper-base", "base.en": "Systran/faster-whisper-base.en",
    "small": "Systran/faster-whisper-small", "small.en": "Systran/faster-whisper-small.en",
    "medium": "Systran/faster-whisper-medium", "medium.en": "Systran/faster-whisper-medium.en",
    "large-v2": "Systran/faster-whisper-large-v2", "large-v3": "Systran/faster-whisper-large-v3",
    "large-v3-turbo": "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
    "distil-large-v3": "Systran/faster-distil-whisper-large-v3",
}
REQUIRED_FILES = ("model.bin", "config.json")
# Models pinned to one Hugging Face revision, every file with its size and SHA-256
# (models/README.md). The app reads the same file to reuse a matching copy already on the computer.
PINNED_MODELS = json.loads((Path(__file__).parent / "models" / "speech-models.json").read_text("utf-8"))


def model_dir(name: str) -> Path:
    return tools.models_dir() / name


def model_present(name: str) -> bool:
    d = model_dir(name)
    return all((d / f).exists() for f in REQUIRED_FILES) and any(
        (d / f).exists() for f in ("tokenizer.json", "vocabulary.txt", "vocabulary.json"))


def default_model() -> str:
    return os.environ.get("REELENGINE_MODEL") or DEFAULT_MODEL


def require_model(name: str) -> Path:
    if not model_present(name):
        raise EngineError("MODEL_MISSING", f"speech model {name!r} not found in {model_dir(name)}",
                          "Reel Studio needs to download its listening model first (about "
                          "500 MB, one time only).")
    return model_dir(name)


# --- download -----------------------------------------------------------------------------------

def _http_json(url: str):
    req = urllib.request.Request(url, headers={"User-Agent": "reel-studio-engine/0.1"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))


def _safe_rfilename(fname) -> bool:
    """A model file name from the (mirror-overridable) index: one plain file name, nothing else.
    "x/../../ESCAPED.bin" used to be written outside the model folder."""
    return (isinstance(fname, str) and bool(fname) and "/" not in fname and "\\" not in fname
            and ".." not in fname and not fname.startswith(".") and ":" not in fname and "\x00" not in fname)


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


RESUME_TRIES = 6                 # automatic resumes after a dropped connection, per file
RESUME_BACKOFF = (1, 2, 4, 8, 15, 30)   # seconds before each one (REELENGINE_RESUME_BACKOFF=0: none, tests)


def _content_range_start(r) -> Optional[int]:
    cr = r.headers.get("Content-Range") or ""
    try:
        return int(cr.split()[1].split("-")[0]) if cr.lower().startswith("bytes ") else None
    except (IndexError, ValueError):
        return None


def _fetch_part(url: str, part: Path, size: int, on_bytes) -> None:
    """Download url into part, resuming with Range. A `.part` that is already complete (killed
    between the last write and the rename) or that the server answers with 416 is discarded and
    fetched again from zero, instead of failing the same way forever.

    A connection that drops mid-file (a clean close leaving the file short, a reset, a chunked
    IncompleteRead, a stalled read hitting the timeout) is resumed HERE from the bytes already on
    disk, up to RESUME_TRIES times with a growing pause, so a flaky network finishes on its own.
    Only a drop that keeps happening reaches the caller (who says "try again; it will pick up where
    it left off", and it does: the .part stays)."""
    restarted = False
    drops = 0
    no_wait = os.environ.get("REELENGINE_RESUME_BACKOFF") == "0"
    while True:
        have = part.stat().st_size if part.exists() else 0
        if have and size and have >= size:
            return                              # complete already; the caller verifies it
        headers = {"User-Agent": "reel-studio-engine/0.1"}
        if have:
            headers["Range"] = f"bytes={have}-"
        req = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                resumed = bool(have) and r.status == 206 and _content_range_start(r) in (None, have)
                mode = "ab" if resumed else "wb"
                got = have if resumed else 0
                with open(part, mode) as fh:
                    while True:
                        chunk = r.read(1 << 20)
                        if not chunk:
                            break
                        fh.write(chunk)
                        got += len(chunk)
                        on_bytes(got)
            if not size or got >= size:
                return
            err = f"connection closed at {got} of {size} bytes"
        except urllib.error.HTTPError as exc:
            if exc.code == 416 and not restarted:
                log(f"# {part.name}: server refused the resume range (416); starting this file again")
                part.unlink(missing_ok=True)
                restarted = True
                continue
            raise
        except (urllib.error.URLError, OSError, http.client.HTTPException) as exc:
            if drops == 0 and (part.stat().st_size if part.exists() else 0) == have:
                # not one byte on the first try: we are offline, not dropped. Say so right away.
                raise exc if isinstance(exc, OSError) else OSError(f"{type(exc).__name__}: {exc}")
            err = f"{type(exc).__name__}: {exc}"
        drops += 1
        if drops > RESUME_TRIES:
            if err.startswith("connection closed"):
                return                          # short file: the caller reports DOWNLOAD_INCOMPLETE
            raise OSError(err)
        now = part.stat().st_size if part.exists() else 0
        wait = 0 if no_wait else RESUME_BACKOFF[min(drops - 1, len(RESUME_BACKOFF) - 1)]
        log(f"# {part.name}: {err}; resuming from {now} bytes in {wait}s (try {drops} of {RESUME_TRIES})")
        if wait:
            time.sleep(wait)


def _index_files(base: str, repo: str) -> list:
    """(name, size, sha256 or None) for every model file in the repo's live index (unpinned models)."""
    try:
        info = _http_json(f"{base}/api/models/{repo}?blobs=true")
    except (urllib.error.URLError, OSError, ValueError) as exc:
        raise EngineError("OFFLINE", f"could not reach {base}: {exc}",
                          "I couldn't connect to the internet to download the listening model. "
                          "Check your connection and try again.")
    files = []
    for sib in info.get("siblings", []) or []:
        fname = sib.get("rfilename")
        if not isinstance(fname, str) or fname.startswith(".") or fname.lower() == "readme.md":
            continue
        if not _safe_rfilename(fname):
            raise EngineError("BAD_MODEL_INDEX", f"refusing model file name {fname!r}",
                              "The listening model download looked wrong, so I stopped. Please try again later.")
        lfs = sib.get("lfs") or {}
        sha = str(lfs.get("sha256") or "").lower() or None
        files.append((fname, int(lfs.get("size") or sib.get("size") or 0), sha))
    return files


def download_model(name: str) -> dict:
    """Fetch a CTranslate2 whisper model into REELENGINE_MODELS/<name>/. Resumable: each file is
    downloaded to <file>.part with an HTTP Range request picking up where it stopped.

    A pinned model (PINNED_MODELS) downloads its exact revision, and every file must match the pinned
    size AND SHA-256 before it is kept. Any other model follows the repo's live index, checked
    against the sizes and the SHA-256 it lists (LFS files only)."""
    repo = MODEL_REPOS.get(name)
    if not repo:
        raise EngineError("BAD_MODEL", f"unknown model {name!r}; known: {sorted(MODEL_REPOS)}",
                          "That listening model isn't one Reel Studio knows about.")
    dest = model_dir(name)
    if model_present(name):
        progress("download", 100, "The listening model is ready", force=True)
        return {"model": name, "path": str(dest), "downloaded": False}
    base = os.environ.get("REELENGINE_MODEL_MIRROR", "https://huggingface.co").rstrip("/")
    progress("download", 0, "Getting ready to download", force=True)
    pin = PINNED_MODELS.get(name)
    if pin:
        repo, revision = pin["repo"], pin["revision"]
        files = [(f["name"], int(f["size"]), f["sha256"]) for f in pin["files"]]
    else:
        revision = "main"
        files = _index_files(base, repo)
    total = sum(sz for _, sz, _ in files) or 1
    dest.mkdir(parents=True, exist_ok=True)
    done_bytes = 0
    for fname, size, sha in files:
        target = dest / fname
        if target.exists() and (not size or target.stat().st_size == size) and (not sha or _sha256(target) == sha):
            done_bytes += size
            continue
        part = target.with_name(target.name + ".part")
        if part.exists() and size and part.stat().st_size > size:
            part.unlink()                       # longer than the file can be: never resumable
        url = f"{base}/{repo}/resolve/{revision}/{fname}"

        def on_bytes(got, _done=done_bytes):
            progress("download", (_done + got) / total * 100,
                     f"Downloading the listening model ({(_done + got) / 1e6:.0f} of {total / 1e6:.0f} MB)")
        for verify_try in range(2):
            try:
                _fetch_part(url, part, size, on_bytes)
            except (urllib.error.URLError, OSError) as exc:
                raise EngineError("OFFLINE", f"download of {fname} failed: {exc}",
                                  "The download stopped. Check your internet connection and try "
                                  "again; it will pick up where it left off.")
            got = part.stat().st_size if part.exists() else 0
            if size and got != size:
                raise EngineError("DOWNLOAD_INCOMPLETE", f"{fname}: got {got} of {size} bytes",
                                  "The download didn't finish. Please try again; it will pick up "
                                  "where it left off.")
            if sha and _sha256(part) != sha:
                part.unlink(missing_ok=True)    # a corrupt file of the right length: start it again
                if verify_try == 0:
                    log(f"# {fname}: checksum mismatch; downloading it again")
                    continue
                raise EngineError("DOWNLOAD_CORRUPT", f"{fname}: sha256 mismatch after two downloads",
                                  "The listening model downloaded with errors. Please try again.")
            break
        os.replace(part, target)
        done_bytes += size
    if not model_present(name):
        raise EngineError("DOWNLOAD_INCOMPLETE", f"{dest} is missing model files after download",
                          "The download didn't finish properly. Please try again.")
    progress("download", 100, "The listening model is ready", force=True)
    return {"model": name, "path": str(dest), "downloaded": True, "bytes": total}


# --- device -------------------------------------------------------------------------------------

_DLL_DONE = False


def add_cuda_dll_dirs() -> list:
    """ctranslate2 does not search pip's nvidia/*/bin folders on Windows; register them."""
    global _DLL_DONE
    added = []
    if _DLL_DONE or not hasattr(os, "add_dll_directory"):
        return added
    for pkg in ("nvidia.cublas", "nvidia.cudnn", "nvidia.cuda_runtime"):
        try:
            mod = importlib.import_module(pkg)
        except ImportError:
            continue
        roots = list(getattr(mod, "__path__", []))
        folder = os.path.join(roots[0], "bin") if roots else ""
        if folder and os.path.isdir(folder):
            os.add_dll_directory(folder)
            os.environ["PATH"] = folder + os.pathsep + os.environ.get("PATH", "")
            added.append(folder)
    _DLL_DONE = True
    return added


def cuda_available() -> bool:
    try:
        import ctranslate2
        return ctranslate2.get_cuda_device_count() > 0
    except Exception:
        return False


_CUDA_SELFTEST = r"""
import sys
sys.path.insert(0, sys.argv[1])
from reelengine.transcribe import add_cuda_dll_dirs
add_cuda_dll_dirs()
import numpy as np
from faster_whisper import WhisperModel
m = WhisperModel(sys.argv[2], device="cuda", compute_type="float16")
list(m.transcribe(np.zeros(16000, dtype=np.float32), language="en", beam_size=1)[0])
print("CUDA_OK")
"""
_CUDA_OK: dict = {}


def cuda_selftest(model_path: str, timeout: float = 180.0) -> bool:
    """Run one tiny GPU encode in a CHILD process first. With the CUDA runtime present but a cuDNN
    or cuBLAS DLL missing, ctranslate2 aborts the whole PROCESS at the first encode (no Python
    exception), which would kill the engine with no JSON error line. A crash
    here only costs the child; the parent then uses the CPU. Cached per model for this process."""
    if model_path in _CUDA_OK:
        return _CUDA_OK[model_path]
    pkg_parent = str(Path(__file__).resolve().parent.parent)
    try:
        proc = subprocess.run([sys.executable, "-c", _CUDA_SELFTEST, pkg_parent, model_path],
                              capture_output=True, text=True, encoding="utf-8", errors="replace",
                              timeout=timeout, stdin=subprocess.DEVNULL)
        ok = proc.returncode == 0 and "CUDA_OK" in (proc.stdout or "")
        if not ok:
            log(f"# GPU self-test failed (exit {proc.returncode}): {(proc.stderr or '')[-300:]}")
    except (OSError, subprocess.SubprocessError) as exc:
        log(f"# GPU self-test could not run: {exc}")
        ok = False
    _CUDA_OK[model_path] = ok
    return ok


# --- CPU threads --------------------------------------------------------------------------------
#
# More threads is not faster. Measured 2026-10-20 on an M4 Pro (8 performance + 4 efficiency
# cores), small.en int8 on six talking-head clips: 4 threads 24.8 s, 8 threads 51.7 s, 12 threads
# 155.5 s, with identical words and word times. The best count depends on the machine, so setup
# measures it (speech_check) and the app passes the answer back in REELENGINE_ASR_THREADS.

def default_threads() -> int:
    """The rule from before the speech check, still used when the check has not run."""
    return max(1, min(8, os.cpu_count() or 4))


def cpu_threads() -> int:
    raw = os.environ.get("REELENGINE_ASR_THREADS", "")
    if raw.isdigit() and int(raw) > 0:
        return int(raw)
    if raw:
        log(f"# REELENGINE_ASR_THREADS={raw!r} is not a positive whole number; using {default_threads()}")
    return default_threads()


def _windows_fast_cores() -> Optional[int]:
    """Physical cores of the highest efficiency class (the P-cores of a hybrid Intel chip; every core
    otherwise), from GetLogicalProcessorInformationEx(RelationProcessorCore)."""
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    size = ctypes.c_ulong(0)                    # DWORD
    k32.GetLogicalProcessorInformationEx(0, None, ctypes.byref(size))
    buf = ctypes.create_string_buffer(size.value)
    if not size.value or not k32.GetLogicalProcessorInformationEx(0, buf, ctypes.byref(size)):
        return None
    classes, off, raw = [], 0, buf.raw
    while off + 10 <= size.value:
        relationship, record = struct.unpack_from("<II", raw, off)
        if record <= 0:
            break
        if relationship == 0:                   # RelationProcessorCore
            classes.append(raw[off + 9])        # PROCESSOR_RELATIONSHIP.EfficiencyClass (after Flags)
        off += record
    return classes.count(max(classes)) if classes else None


def fast_cores() -> Optional[int]:
    """How many of this computer's fastest cores there are, or None when it can't tell."""
    if sys.platform == "darwin":
        for key in ("hw.perflevel0.physicalcpu", "hw.physicalcpu"):   # Apple silicon, then Intel
            out = subprocess.run(["sysctl", "-n", key], capture_output=True, text=True, timeout=5)
            if out.returncode == 0 and out.stdout.strip().isdigit():
                return int(out.stdout.strip())
    elif sys.platform == "win32":
        try:   # not yet run on Windows; a wrong guess only means today's thread count is used
            return _windows_fast_cores()
        except (OSError, ValueError, struct.error) as exc:
            log(f"# could not count fast cores: {type(exc).__name__}: {exc}")
    return None


SPEECH_CHECK_WAV = Path(__file__).parent / "models" / "speech-check.wav"
SPEECH_CHECK_BUDGET = 15.0      # seconds; setup promises a short check, so no new count starts past this


def thread_candidates(default: int, fast: Optional[int]) -> list:
    """Today's rule first (every other count must reproduce its transcript), then the fast-core count
    and half of it."""
    fast = fast or default
    out = [default]
    for n in (fast, max(1, fast // 2)):
        if n not in out:
            out.append(n)
    return out


def choose_threads(runs: list) -> int:
    """runs[0] is today's rule. The fastest run whose words and word times equal it exactly: a count
    that hears anything differently is never chosen, however fast."""
    same = [r for r in runs if r["words"] == runs[0]["words"]]
    return min(same, key=lambda r: (r["seconds"], r["threads"]))["threads"]


def speech_check(name: Optional[str] = None) -> dict:
    """Transcribe the bundled sample at each candidate thread count and pick one (choose_threads).
    Model loading is not timed. Returns {"threads": n or None, "default", "device", "runs", "complete"};
    complete is False when the time budget stopped it before every count ran (a busy computer)."""
    name = name or default_model()
    path = str(require_model(name))
    default = default_threads()
    if cuda_available():
        # The GPU ignores the CPU thread count; leave it to load_model's own GPU check.
        return {"threads": None, "default": default, "device": "cuda", "runs": [], "complete": True}
    from faster_whisper import WhisperModel
    from faster_whisper.vad import get_vad_model
    progress("speech-check", 0, "Getting the listener ready for this computer", force=True)
    get_vad_model()              # loaded once, on first use: keep that out of the first count's time
    duration = len(audio_env.read_wav(SPEECH_CHECK_WAV)) / 16000
    cands = thread_candidates(default, fast_cores())
    start, runs, last_cost = time.perf_counter(), [], 0.0
    for i, n in enumerate(cands):
        if runs and time.perf_counter() - start + last_cost > SPEECH_CHECK_BUDGET:
            log(f"# speech check: no time left for {cands[i:]} thread(s)")
            break
        t_load = time.perf_counter()
        model = WhisperModel(path, device="cpu", compute_type="int8", cpu_threads=n)
        t0 = time.perf_counter()
        words, _, _ = _transcribe_one(model, SPEECH_CHECK_WAV, "en", None, duration, 0, 0)
        seconds = time.perf_counter() - t0
        last_cost = time.perf_counter() - t_load
        del model
        runs.append({"threads": n, "seconds": round(seconds, 3),
                     "words": [(w["w"], w["s"], w["e"]) for w in words]})
        log(f"# speech check: {n} thread(s) {seconds:.2f}s, {len(words)} words")
        progress("speech-check", 100 * (i + 1) / len(cands), "Getting the listener ready for this computer")
    if not runs[0]["words"]:
        raise EngineError("SPEECH_CHECK_EMPTY", "the speech check sample produced no words",
                          "The listener didn't hear the test recording. Reel Studio will keep its usual settings.")
    return {"threads": choose_threads(runs), "default": default, "device": "cpu",
            "complete": len(runs) == len(cands),
            "runs": [{"threads": r["threads"], "seconds": r["seconds"],
                      "sameWords": r["words"] == runs[0]["words"]} for r in runs]}


def load_model(name: str, prefer: Optional[str] = None):
    """(WhisperModel, device, compute_type). The GPU is a speed choice, never a failure."""
    from faster_whisper import WhisperModel
    path = str(require_model(name))
    want = (prefer or os.environ.get("REELENGINE_ASR_DEVICE") or "auto").lower()
    order = []
    if want in ("auto", "cuda") and cuda_available() and cuda_selftest(path):
        order.append(("cuda", "float16"))
    order.append(("cpu", "int8"))
    last = None
    for device, compute in order:
        if device == "cuda":
            add_cuda_dll_dirs()
        try:
            threads = 0 if device == "cuda" else cpu_threads()
            model = WhisperModel(path, device=device, compute_type=compute, cpu_threads=threads)
            if device == "cuda":
                # CUDA can load fine and still die at the first encode when a DLL is missing; prove it.
                import numpy as np
                list(model.transcribe(np.zeros(16000, dtype=np.float32), language="en",
                                      beam_size=1)[0])
            return model, device, compute
        except Exception as exc:   # noqa: BLE001
            last = exc
            log(f"# whisper on {device} unavailable ({type(exc).__name__}: {str(exc)[:160]}); falling back")
    raise EngineError("MODEL_LOAD_FAILED", f"could not load {name}: {last}",
                      "The listening model wouldn't start. Try downloading it again in Settings.")


# --- audio --------------------------------------------------------------------------------------

def extract_audio(src: Path, out: Path) -> Path:
    """Mono 16 kHz wav on the source's own clock (aresample first_pts=0 pads a late-starting audio
    stream so audio time == video time)."""
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(out.stem + ".part.wav")
    tools.text_run([tools.ffmpeg(), "-y", "-nostdin", "-hide_banner", "-i", str(src), "-vn",
                    "-af", "aresample=async=1:first_pts=0", "-ac", "1", "-ar", "16000",
                    "-c:a", "pcm_s16le", str(tmp)], 1800, f"extract audio from {src.name}",
                   user_message="I couldn't read the sound in your video. Try a different file.")
    os.replace(tmp, out)
    return out


def audio_path(project_dir: Path, sid: str) -> Path:
    return Path(project_dir) / "work" / "audio" / f"{sid}.wav"


# --- vocabulary hints ---------------------------------------------------------------------------
#
# Whisper mishears names and jargon ("Nave" for Neve, "flatly" for Flowly). We give it the words this
# user is likely to say, from: the project title, an optional script (project.json `script`, or
# script.txt / script.md in the project folder), every caption correction the user has made before in
# ANY project, and words quoted in My style rules. Two channels:
#   * `hotwords` (faster-whisper): prepended as "previous text" to EVERY 30 s window. This carries the
#     vocabulary. (initial_prompt alone does nothing past the first window here: with
#     condition_on_previous_text=False faster-whisper drops it after window one.)
#   * `initial_prompt`: the title + the start of the script, for the first window only.
# Only DISTINCTIVE words go in (a capital letter, a digit or hyphen, or a word the model's own tokenizer
# splits into 2+ pieces, i.e. one it finds rare): common words in the hint list buy nothing and can
# pull whisper toward them.

HOTWORDS_MAX_TOKENS = 40         # MEASURED: a long list (120 tokens) made whisper skip whole stretches
# Words corrected in OTHER projects: off by default. Measured on 3 takes (status/issues.md): the
# library list fixed "Flowly" but made whisper DROP 21-63% of the words on two other takes.
USE_LIBRARY = os.environ.get("REELENGINE_HINT_LIBRARY") == "1"
PROMPT_MAX_CHARS = 600
_COMMON = set("""a an and are as at be but by for from had has have he her his i if in into is it its
me my no not of on or our she so that the their them then there they this to too up us was we were
what when where which who will with you your one two three four five six seven eight nine ten first
last number video reel take final new untitled i'm it's don't""".split())
_WORD_RE = re.compile(r"\w[\w'’.+&-]*[\w+]|\w", re.UNICODE)
_STRIP = " \t\r\n.,;:!?\"“”'‘’()[]{}"


def _clean_word(w: str) -> str:
    return w.strip(_STRIP)


def _distinctive(word: str, tok=None) -> bool:
    w = _clean_word(word)
    if len(w) < 2 or w.lower() in _COMMON or any(c.isdigit() or c in "%$" for c in w):
        return False
    if any(c.isupper() for c in w) or any(c.isdigit() for c in w) or "-" in w or "." in w:
        return True
    if tok is not None:
        try:
            return len(tok(" " + w)) >= 2
        except Exception:  # noqa: BLE001 - a tokenizer hiccup must never stop transcription
            pass
    return len(w) >= 9


def _tokenizer_fn(model):
    hf = getattr(model, "hf_tokenizer", None)
    if hf is None:
        return None
    return lambda text: hf.encode(text, add_special_tokens=False).ids


def _script_text(project_dir: Path, proj: dict) -> str:
    sc = proj.get("script")
    if isinstance(sc, dict):
        sc = sc.get("text") or sc.get("script") or ""
    if isinstance(sc, str) and sc.strip():
        return sc
    for name in ("script.txt", "script.md"):
        f = Path(project_dir) / name
        try:
            if f.is_file() and f.stat().st_size < 200_000:
                return f.read_text(encoding="utf-8", errors="replace")
        except OSError:
            pass
    return ""


def _library_root(project_dir: Path) -> Optional[Path]:
    env = os.environ.get("REELSTUDIO_ROOT")
    if env:
        return Path(env)
    pd = Path(project_dir).resolve()
    return pd.parent.parent if pd.parent.name.lower() == "projects" else None


def _correction_targets(corrections) -> list:
    """The words the user typed as the RIGHT spelling, skipping pure reformatting (case, punctuation,
    "three" -> "3"): those say nothing about how a word sounds."""
    out = []
    for c in corrections or []:
        if not isinstance(c, dict):
            continue
        heard = [_clean_word(x).lower() for x in str(c.get("from", "")).split()]
        for w in str(c.get("to", "")).split():
            cw = _clean_word(w)
            if not cw or cw.isdigit():
                continue
            # a case-only fix counts when it is a real spelling (TAMS, iPhone), not a sentence capital
            if cw.lower() not in heard or any(c.isupper() for c in cw[1:]):
                out.append(cw)
    return out


def gather_vocab(project_dir: Path, proj: dict, max_projects: int = 200) -> dict:
    """Raw hint material for this project: title, script, corrected words (this project first, then
    the rest of the library, most recently edited first) and words quoted in My style rules."""
    own_pairs = [c for c in ((proj.get("captions") or {}).get("corrections") or []) if isinstance(c, dict)]
    corrected = _correction_targets(own_pairs)
    library, library_pairs = [], []
    root = _library_root(project_dir)
    style_words = []
    if root is not None:
        here = Path(project_dir).resolve()
        try:
            others = [p for p in (root / "Projects").glob("*/project.json") if p.parent.resolve() != here]
            others.sort(key=lambda p: p.stat().st_mtime, reverse=True)
        except OSError:
            others = []
        for pf in others[:max_projects]:
            try:
                other = json.loads(pf.read_text(encoding="utf-8"))
                pairs = [c for c in ((other.get("captions") or {}).get("corrections") or []) if isinstance(c, dict)]
                library += _correction_targets(pairs)
                library_pairs += pairs
            except (OSError, ValueError, AttributeError):
                continue
        try:
            rules = json.loads((root / "My style.json").read_text(encoding="utf-8")).get("rules") or []
            for r in rules:
                text = str((r or {}).get("text", ""))
                style_words += re.findall(r"[\"“‘]([^\"”’]{2,40})[\"”’]", text)
        except (OSError, ValueError, AttributeError):
            pass
    title = str(proj.get("title") or "")
    if title.strip().lower() in ("my video", "untitled"):
        title = ""
    words = (proj.get("captions") or {}).get("vocabulary") or []
    return {"title": title, "script": _script_text(project_dir, proj), "corrected": corrected,
            "library": library, "style": style_words,
            # for the after-transcription pass (vocab.py): the corrections as heard -> meant pairs, and
            # terms the user or the AI typed in (captions.vocabulary)
            "correctedPairs": own_pairs, "libraryPairs": library_pairs,
            "vocabulary": [str(v) for v in words if isinstance(v, str)][:200]}


def _text_words(text: str, tok=None) -> list:
    """Distinctive words of free text. A capital at the start of a sentence says nothing, so such a
    word must be distinctive in lower case too ("So", "Why" are not hints; "Flowly" is)."""
    out = []
    for m in _WORD_RE.finditer(text or ""):
        w = m.group(0)
        before = text[:m.start()].rstrip(" \t")
        initial = not before.strip() or before[-1] in ".!?:\n"
        if initial and w[:1].isupper() and not any(c.isupper() for c in w[1:]):
            if not _distinctive(w.lower(), tok):
                continue
        if _distinctive(w, tok):
            out.append(_clean_word(w))
    return out


def build_hints(vocab: dict, tok=None) -> dict:
    """-> {"hotwords": str|None, "initialPrompt": str|None, "words": [...]}.
    Order (each word once, within HOTWORDS_MAX_TOKENS): words corrected in THIS project, My style
    words, the title; then this take's script (up to 60% of the budget); then words corrected in other
    projects, most recent first; then the rest of the script."""
    seen, kept, used = set(), [], [0]
    cost = (lambda w: len(tok(" " + w + ","))) if tok else (lambda w: max(1, len(w) // 3))

    def add(w, cap=HOTWORDS_MAX_TOKENS, check=True):
        cw = _clean_word(w)
        if not cw or cw.lower() in seen or (check and not _distinctive(cw, tok)):
            return
        n = cost(cw)
        if used[0] + n > cap:
            return
        seen.add(cw.lower())
        kept.append(cw)
        used[0] += n
    for w in vocab.get("corrected") or []:
        add(w)
    for phrase in vocab.get("style") or []:
        for w in _WORD_RE.findall(phrase):
            add(w)
    for w in _text_words(vocab.get("title") or "", tok):
        add(w, check=False)
    script = re.sub(r"[#*_>`|\[\]]+", " ", vocab.get("script") or "")
    script_words = _text_words(script, tok)
    for w in script_words:
        add(w, cap=int(HOTWORDS_MAX_TOKENS * 0.6), check=False)
    for w in (vocab.get("library") or []) if USE_LIBRARY else []:
        add(w)
    for w in script_words:
        add(w, check=False)
    parts = []
    if vocab.get("title"):
        parts.append(vocab["title"].strip().rstrip(".") + ".")
    if script.strip():
        parts.append(re.sub(r"\s+", " ", script).strip())
    prompt = " ".join(parts)[:PROMPT_MAX_CHARS].strip() or None
    return {"hotwords": ", ".join(kept) or None, "initialPrompt": prompt, "words": kept}


# --- transcription ------------------------------------------------------------------------------

def _transcribe_one(model, wav: Path, language: Optional[str], prompt: Optional[str],
                    duration: float, pct0: float, pct1: float, hotwords: Optional[str] = None):
    import numpy as np
    samples = audio_env.read_wav(wav)
    if len(samples) == 0 or float(np.abs(samples).max()) < 1e-4:
        return [], [], language
    segments, info = model.transcribe(
        samples, language=language, beam_size=5, word_timestamps=True,
        vad_filter=True, vad_parameters={"min_silence_duration_ms": 700, "speech_pad_ms": 250},
        # off: with it on, whisper tends to swallow the SECOND take of a line it has just written,
        # and retakes are exactly what we need to see.
        condition_on_previous_text=False,
        initial_prompt=prompt or None,
        hotwords=hotwords or None)
    words, segs = [], []
    for seg in segments:
        progress(STAGE, pct0 + (pct1 - pct0) * min(1.0, seg.end / max(duration, 1e-6)),
                 "Listening to your video")
        if getattr(seg, "no_speech_prob", 0) > 0.7 and getattr(seg, "avg_logprob", 0) < -1.0:
            continue           # whisper hallucinating over silence
        seg_words = []
        for w in (seg.words or []):
            token = w.word.strip()
            if not token:
                continue
            seg_words.append({"s": round(float(w.start), 3), "e": round(float(w.end), 3), "w": token,
                              "p": round(float(w.probability), 3), "_seg": len(segs)})
        if seg_words:
            segs.append({"s": round(float(seg.start), 3), "e": round(float(seg.end), 3),
                         "text": seg.text.strip(), "n": len(seg_words)})
            words.extend(seg_words)
    return words, segs, getattr(info, "language", language)


def assign_ids(new_words: list, old: Optional[dict]) -> tuple:
    """Keep old ids by time overlap (same source, overlap >= half the shorter word)."""
    next_id = 0
    by_src = {}
    if old and old.get("words"):
        next_id = int(old.get("nextId") or 0)
        for w in old["words"]:
            by_src.setdefault(w["source"], []).append(w)
            try:
                next_id = max(next_id, int(w["id"][1:]) + 1)
            except ValueError:
                pass
    used = set()
    for w in new_words:
        best, best_ov = None, 0.0
        for o in by_src.get(w["source"], []):
            if o["id"] in used or o["e"] < w["s"] or o["s"] > w["e"]:
                continue
            ov = min(o["e"], w["e"]) - max(o["s"], w["s"])
            shorter = max(1e-3, min(o["e"] - o["s"], w["e"] - w["s"]))
            if ov / shorter >= 0.5 and ov > best_ov:
                best, best_ov = o, ov
        if best is not None:
            w["id"] = best["id"]
            used.add(best["id"])
        else:
            w["id"] = f"w{next_id}"
            next_id += 1
    return new_words, next_id


def run(project_dir: Path, model_name: Optional[str] = None, language: Optional[str] = None,
        prompt: Optional[str] = None, device: Optional[str] = None) -> dict:
    project_dir = Path(project_dir)
    proj = projmod.load(project_dir)
    if not proj.get("sources"):
        raise EngineError("NO_SOURCES", "project has no sources",
                          "This project has no video in it yet. Add your video first.")
    if language is None:
        language = (proj.get("transcript") or {}).get("language") or None
    if language in ("auto", ""):
        language = None
    name = model_name or (proj.get("transcript") or {}).get("model") or default_model()
    if not model_name and not model_present(name) and model_present(default_model()):
        name = default_model()             # the model this project used before is gone: use ours
    if language and not language.startswith("en") and name.endswith(".en"):
        name = MULTILINGUAL_MODEL          # English-only models cannot hear other languages
    require_model(name)

    progress(STAGE, 1, "Getting your video ready", force=True)
    t0 = time.time()
    wavs = {}
    for i, src in enumerate(proj["sources"]):
        sp = projmod.source_path(project_dir, src)
        wav = audio_path(project_dir, src["id"])
        if not wav.exists() or wav.stat().st_mtime < sp.stat().st_mtime:
            extract_audio(sp, wav)
        wavs[src["id"]] = wav
        progress(STAGE, 2 + 6 * (i + 1) / len(proj["sources"]), "Getting your video ready")
    t_extract = time.time() - t0

    progress(STAGE, 9, "Waking up the listening model", force=True)
    t1 = time.time()
    model, dev, compute = load_model(name, prefer=device)
    t_load = time.time() - t1
    log(f"# whisper {name} on {dev} ({compute}), loaded in {t_load:.1f}s")

    hints = {"hotwords": None, "initialPrompt": None, "words": []}
    # OPT-IN (REELENGINE_HINTS=1). Measured 2026-10-17 (status/issues.md): hints fixed Neve/Flowly on one
    # take but made whisper SKIP 39-63% of the speech on another, even with a single hint word.
    if os.environ.get("REELENGINE_HINTS") == "1":
        try:
            hints = build_hints(gather_vocab(project_dir, proj), _tokenizer_fn(model))
        except Exception as exc:  # noqa: BLE001 - hints are a bonus; never fail the transcription
            log(f"# vocabulary hints skipped: {exc}")
    if prompt:                               # an explicit --prompt wins for the first window
        hints["initialPrompt"] = prompt
    if hints["words"]:
        log(f"# hinting {len(hints['words'])} word(s): {hints['hotwords'][:200]}")

    # ON by default: respell misheard names AFTER transcription (vocab.py). It only rewrites words
    # whisper heard, so unlike the hints above it cannot drop speech. REELENGINE_VOCAB=0 turns it off.
    terms, is_common = [], None
    if os.environ.get("REELENGINE_VOCAB", "1") != "0":
        try:
            g = gather_vocab(project_dir, proj)
            is_common = vocabmod.make_is_common(_tokenizer_fn(model))
            terms = vocabmod.build({"corrected": g["correctedPairs"], "vocabulary": g["vocabulary"],
                                    "title": g["title"], "script": g["script"], "style": g["style"],
                                    "library": g["libraryPairs"]}, is_common)
        except Exception as exc:  # noqa: BLE001 - a bonus; never fail the transcription
            log(f"# vocabulary skipped: {exc}")
            terms = []

    total_dur = sum(float(s.get("duration") or 0.0) for s in proj["sources"]) or 1.0
    done_dur = 0.0
    all_words, all_segs, lang = [], [], language
    t2 = time.time()
    for src in proj["sources"]:
        dur = float(src.get("duration") or 0.0)
        p0 = 10 + 80 * done_dur / total_dur
        p1 = 10 + 80 * (done_dur + dur) / total_dur
        words, segs, got_lang = _transcribe_one(model, wavs[src["id"]], lang, hints["initialPrompt"],
                                                dur, p0, p1, hotwords=hints["hotwords"])
        lang = lang or got_lang
        samples = audio_env.read_wav(wavs[src["id"]])
        env = audio_env.envelope(samples)
        thresh = audio_env.noise_threshold(env)
        for w in words:
            w["source"] = src["id"]
        words.sort(key=lambda w: (w["s"], w["e"]))
        words = audio_env.refine_words(words, env, thresh, len(samples) / audio_env.SR)
        if terms:
            try:
                words, _ = vocabmod.correct(words, terms, is_common)
            except Exception as exc:  # noqa: BLE001 - keep whisper's words rather than fail
                log(f"# vocabulary pass skipped: {exc}")
        # a respelled name can join 2-3 heard words (never across segments): recount each segment
        tagged = all("_seg" in w for w in words)
        per_seg = {}
        for w in words:
            k = w.pop("_seg", None)
            per_seg[k] = per_seg.get(k, 0) + 1
        if tagged:
            for idx, sg in enumerate(segs):
                sg["n"] = per_seg.get(idx, 0)
            segs = [sg for sg in segs if sg["n"]]
        for sg in segs:
            sg["source"] = src["id"]
        all_words.extend(words)
        all_segs.extend(segs)
        done_dur += dur
    t_asr = time.time() - t2

    if not all_words:
        raise EngineError("NO_SPEECH", "whisper returned no words",
                          "I couldn't hear anyone talking in this video. Check that the sound is on "
                          "and try again.")

    tp = projmod.transcript_path(project_dir, proj)
    old = projmod.read_json(tp) if tp.exists() else None
    all_words, next_id = assign_ids(all_words, old)
    # segments carry word-id ranges so retake detection and the AI can cite them
    k = 0
    for sg in all_segs:
        n = sg.pop("n")
        sg["from"], sg["to"] = all_words[k]["id"], all_words[k + n - 1]["id"]
        k += n
    # every respelling, so the app/AI can say "I spelled Neve the way you do" (and undo it with a
    # caption correction). The word itself keeps "heard" (whisper's text) and "vocab" (the source).
    respelled = [{"id": w["id"], "heard": w["heard"], "written": w["w"], "source": w.get("vocab")}
                 for w in all_words if "heard" in w]
    transcript = {"model": name, "device": dev, "language": lang, "createdAt": projmod.now_iso(),
                  "nextId": next_id, "words": all_words, "segments": all_segs,
                  "vocab": {"terms": vocabmod.summarize(terms), "replacements": respelled}}
    projmod.write_json(tp, transcript, indent=1)
    # Re-read project.json: the app or the AI may have saved an edit during the 1-2 minutes this
    # took, and saving the dict loaded at the start would silently revert it.
    proj = projmod.load(project_dir)
    moved = projmod.remap_anchors(proj, (old or {}).get("words") or [], all_words) if old else 0
    if moved:
        log(f"# re-pointed {moved} anchor(s) whose words changed in the new transcript")
    proj["transcript"] = {"file": projmod.TRANSCRIPT_REL, "language": lang, "model": name}
    projmod.save(project_dir, proj)
    progress(STAGE, 100, "Finished listening", force=True)
    return {"words": len(all_words), "segments": len(all_segs), "language": lang, "model": name,
            "anchorsMoved": moved, "hintWords": len(hints["words"]), "respelled": len(respelled),
            "device": dev, "compute": compute,
            "timings": {"extract": round(t_extract, 2), "load": round(t_load, 2),
                        "asr": round(t_asr, 2), "audioSeconds": round(total_dur, 2),
                        "realtimeFactor": round(t_asr / total_dur, 3)},
            "file": str(tp)}
