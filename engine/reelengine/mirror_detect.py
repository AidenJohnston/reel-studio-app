"""Is this take mirrored? A front-camera selfie often comes out mirrored: every poster, shirt and sign in
the room reads backwards. Apps like Instagram Edits write nothing about it in the file, so this reads the
picture, and uses the one thing the file can say (which camera filmed it) to rule a flip out.

Two signals:

1. Writing in the room. A few frames are read with the text recognition the OS already has
   (Windows.Media.Ocr through PowerShell, Vision through osascript on a Mac), once as filmed and once
   flipped left to right. Writing the right way round comes out as words ("FRESH COFFEE"); backwards
   writing comes out as junk ("V1002 yqqAH' 38"). Each side scores the letters of everyday words it read.
   The dictionary is the speech model's own vocabulary (vocab.make_is_common uses the same list), so
   nothing new ships. A word that reads the same in a mirror ("WOW", "MOM", "bid") says nothing and is
   not counted.
2. The camera. An iPhone camera file names its lens in a timed-metadata track ("iPhone 14 back camera
   5.7mm f/1.5"; ffprobe does not show it). A back-camera take is never mirrored by the phone: writing
   that reads backwards there is a reflection (a mirror selfie), so it is never flipped. A front-camera
   file from the iPhone's own Camera app is as filmed unless the user turned "Mirror Front Camera" on,
   so the camera alone never flips anything either way: only the writing does.

Verdicts (a wrong flip is as bad as a missed one):
  mirrored        the flipped frames read clearly better: init flips the picture, and the app says so
                  with a one-click undo
  maybe-mirrored  they read somewhat better flipped: nothing changes, the app asks "Flip it?"
  as-filmed       the frames read clearly better as they are, or the back camera filmed it
  unsure          too little writing, or both sides read about the same (captions added in a phone app
                  read right even on a mirrored picture): change nothing, ask nothing
  unknown         could not look (no text recognition on this OS, no speech model yet, turned off, error)

Measured on real takes (labels checked by eye) and on synthetic walls: see tests/test_mirror_detect.py
and the pull request that added this file. Never raises: any failure is "unknown".
REELENGINE_MIRROR_DETECT=0 turns it off.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import struct
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Callable, Iterable, Optional

from . import tools
from .proto import log

OCR_DIR = Path(__file__).resolve().parent / "ocr"
SAMPLE_AT = (0.15, 0.38, 0.62, 0.85)     # fractions of the take: 4 moments, away from the very start and end
MAX_SIDE = 1920                         # a 4K frame is read at 1080p: plenty for wall text, and faster
TIMEOUT = 30.0                          # a cold first Vision run can be slow; past this it is "unknown"

# "mirrored" when the flipped side read at least MIN_LETTERS letters of words AND at least RATIO times
# the other side plus MARGIN (and the same the other way for "as-filmed"). On real takes: mirrored ones
# read 13-150 letters flipped vs 0-12 as filmed; takes the right way round 15-1000 as filmed vs 0-45 flipped.
MIN_LETTERS = 12
RATIO = 2.0
MARGIN = 10
# "maybe-mirrored" (ask, never flip): at least two short words, or one long one, only when flipped.
ASK_LETTERS = 6
ASK_MARGIN = 4

VERDICTS = ("mirrored", "maybe-mirrored", "as-filmed", "unsure", "unknown")
WHY = {   # what the app may tell the user; plain words, no jargon
    "mirrored": "the writing behind you reads backwards",
    "maybe-mirrored": "some writing behind you seems to read backwards",
}

_TOKEN = re.compile(r"[A-Za-z]+")
# letters that look the same in a mirror, and the pairs that swap (b <-> d, p <-> q)
_MIRROR_CHAR = {**{c: c for c in "AHIMOTUVWXYilovwx"}, "b": "d", "d": "b", "p": "q", "q": "p"}
_WORDS: dict = {}

Reader = Callable[[list], list]       # [picture paths] -> [[text lines], or None when unread, per picture]


# --- deciding --------------------------------------------------------------------------------------

def reads_same_mirrored(token: str) -> bool:
    """True for a word that a mirror leaves readable as itself ("WOW", "MOM", "TOT", "bid"): it reads
    right on both sides, so it says nothing about which way round the picture is."""
    m = [_MIRROR_CHAR.get(c) for c in reversed(token)]
    return None not in m and "".join(m) == token


def score_lines(lines: Iterable[str], words: set) -> int:
    """Letters of everyday words in the recognised lines. A word counts when it has 3+ letters, one case
    pattern (BE / be / Be, never yqqAH or sobN, which is how backwards letters come out), is in `words`
    and does not read the same in a mirror."""
    n = 0
    for line in lines:
        for t in _TOKEN.findall(line or ""):
            if (len(t) >= 3 and (t.isupper() or t.islower() or t.istitle()) and t.lower() in words
                    and not reads_same_mirrored(t)):
                n += len(t)
    return n


def decide(as_filmed: int, flipped: int, camera: Optional[str] = None) -> str:
    """The verdict from the letters of words read each way and the camera that filmed it (or None)."""
    if as_filmed >= MIN_LETTERS and as_filmed >= RATIO * flipped + MARGIN:
        return "as-filmed"
    if flipped >= MIN_LETTERS and flipped >= RATIO * as_filmed + MARGIN:
        ocr = "mirrored"
    elif flipped >= ASK_LETTERS and flipped >= RATIO * as_filmed + ASK_MARGIN:
        ocr = "maybe-mirrored"
    else:
        return "unsure"
    # the phone never mirrors its back camera: backwards writing there is a reflection in the room
    return "as-filmed" if camera == "back" else ocr


# --- the camera, from an iPhone file's track metadata ---------------------------------------------------

_LENS_KEY = b"com.apple.quicktime.camera.lens_model"
_FACING = re.compile(rb"\b(front|back)\b[ a-zA-Z]{0,30}camera")
_CONTAINERS = {b"moov", b"trak"}


def _boxes(fh, start: int, end: int):
    """(type, payload start, payload end) of each MP4/QuickTime box between start and end."""
    pos = start
    while pos + 8 <= end:
        fh.seek(pos)
        size, kind = struct.unpack(">I4s", fh.read(8))
        head = 8
        if size == 1:
            size = struct.unpack(">Q", fh.read(8))[0]
            head = 16
        elif size == 0:
            size = end - pos
        if size < head or pos + size > end:
            return
        yield kind, pos + head, pos + size
        pos += size


def camera_facing(video: Path) -> Optional[str]:
    """"front" / "back" when the file names the lens that filmed it, else None. An iPhone camera file
    keeps it in its video track's metadata (moov > trak > meta: key com.apple.quicktime.camera.lens_model,
    value "iPhone 14 front camera 2.69mm f/1.9"); ffprobe does not show it. Files saved by Instagram
    Edits, CapCut and most editors carry no such tag. Reads only box headers and the small meta boxes, so
    it is instant on a multi-gigabyte take. Never raises."""
    try:
        with open(video, "rb") as fh:
            fh.seek(0, os.SEEK_END)

            def walk(a: int, b: int) -> Optional[str]:
                for kind, x, y in _boxes(fh, a, b):
                    if kind == b"meta" and y - x <= 65536:
                        fh.seek(x)
                        meta = fh.read(y - x)
                        m = _FACING.search(meta) if _LENS_KEY in meta else None
                        if m:
                            return m.group(1).decode()
                    elif kind in _CONTAINERS:
                        got = walk(x, y)
                        if got:
                            return got
                return None

            return walk(0, fh.tell())
    except (OSError, struct.error) as exc:
        log(f"mirror_detect: no camera metadata in {Path(video).name}: {exc}")
        return None


# --- the dictionary: the speech model's vocabulary ----------------------------------------------------

def _vocab_tokens(model: Path) -> Optional[Iterable[str]]:
    tj = model / "tokenizer.json"
    if tj.is_file():
        j = json.loads(tj.read_text(encoding="utf-8"))
        model = j.get("model") if isinstance(j, dict) else None
        v = model.get("vocab") if isinstance(model, dict) else None
        return v.keys() if isinstance(v, dict) else v if isinstance(v, list) else None
    vj = model / "vocabulary.json"
    if vj.is_file():
        return json.loads(vj.read_text(encoding="utf-8"))
    vt = model / "vocabulary.txt"
    if vt.is_file():
        return vt.read_text(encoding="utf-8").splitlines()
    return None


def load_words(models: Optional[Path] = None) -> Optional[set]:
    """Everyday words: the whole words in the speech model's vocabulary (GPT-2 style tokens, a leading
    "Ġ" = starts a word; about 25k English words). None when no model is downloaded yet."""
    from . import transcribe
    models = Path(models) if models else tools.models_dir()
    key = str(models)
    if key in _WORDS:
        return _WORDS[key]
    cands = [models / transcribe.default_model()] + sorted(p for p in models.glob("*") if p.is_dir())
    words = None
    for m in cands:
        try:
            toks = _vocab_tokens(m)
        except (OSError, ValueError):
            toks = None
        if toks:
            words = {t[1:].lower() for t in toks
                     if isinstance(t, str) and t.startswith("\u0120") and t[1:].isascii() and t[1:].isalpha()}
            if len(words) > 1000:
                break
            words = None
    _WORDS[key] = words
    return words


# --- reading text with the OS ----------------------------------------------------------------------

def _parse(out: str, n: int) -> list:
    """The helper's JSON lines -> [text lines, or None for a picture it could not read]. A failed reading
    is never an empty one: empty would count as "no writing" and could tip the verdict."""
    got = [None] * n
    for line in (out or "").splitlines():
        try:
            j = json.loads(line, strict=False)      # recognised text can hold control characters
        except ValueError:
            continue
        if isinstance(j, dict) and isinstance(j.get("i"), int) and 0 <= j["i"] < n and isinstance(j.get("lines"), list):
            got[j["i"]] = [str(x) for x in j["lines"]]
    if all(g is None for g in got):
        raise RuntimeError(f"no text recognition result: {(out or '')[:300]}")
    return got


def _run(cmd: list, timeout: float) -> str:
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
    p = subprocess.run([str(c) for c in cmd], capture_output=True, text=True, encoding="utf-8", errors="replace",
                       timeout=timeout, stdin=subprocess.DEVNULL, creationflags=flags)
    if p.returncode != 0:
        raise RuntimeError(f"exit {p.returncode}: {(p.stderr or p.stdout or '')[-500:]}")
    return p.stdout


def _windows_reader(paths: list, timeout: float = TIMEOUT) -> list:
    """Reading is CPU-bound and one PowerShell reads one picture at a time, so the pictures are split over
    up to 4 PowerShells side by side (measured: 8 pictures in 5.7 s with one, 1.9 s with four)."""
    ps = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"
    exe = str(ps) if ps.exists() else "powershell.exe"

    def one(chunk: list) -> list:
        out = _run([exe, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                    "-File", OCR_DIR / "win_ocr.ps1", *chunk], timeout)
        return _parse(out, len(chunk))

    n = max(1, min(4, (os.cpu_count() or 2) // 2, len(paths)))
    chunks = [paths[i::n] for i in range(n)]
    with ThreadPoolExecutor(max_workers=n) as pool:
        parts = list(pool.map(one, chunks))
    got = [None] * len(paths)
    for i, part in enumerate(parts):
        got[i::n] = part
    return got


def _mac_reader(paths: list, timeout: float = TIMEOUT) -> list:
    return _parse(_run(["/usr/bin/osascript", "-l", "JavaScript", OCR_DIR / "mac_ocr.js", *paths], timeout), len(paths))


def os_reader() -> tuple[Optional[str], Optional[Reader]]:
    """(name, reader) for this OS, or (None, None) where there is no built-in text recognition."""
    if os.name == "nt":
        return "windows", _windows_reader
    if sys.platform == "darwin" and Path("/usr/bin/osascript").exists():
        return "mac", _mac_reader
    return None, None


# --- frames ----------------------------------------------------------------------------------------

def _grab(video: Path, t: float, a: Path, b: Path) -> bool:
    """One frame at t seconds, as filmed (a) and flipped left to right (b). Display orientation (a phone's
    rotation is applied, as the render does), long side at most MAX_SIDE."""
    fit = f"scale='min(iw,{MAX_SIDE})':'min(ih,{MAX_SIDE})':force_original_aspect_ratio=decrease"
    try:
        _run([tools.ffmpeg(), "-v", "error", "-nostdin", "-y", "-ss", f"{t:.3f}", "-i", video, "-frames:v", "1",
              "-filter_complex", f"[0:v]{fit},split[a][b];[b]hflip[f]",
              "-map", "[a]", "-frames:v", "1", "-q:v", "2", a,
              "-map", "[f]", "-frames:v", "1", "-q:v", "2", b], 60)
    except Exception as exc:  # noqa: BLE001 - one unreadable moment just means one frame fewer
        log(f"mirror_detect: no frame at {t:.2f}s: {exc}")
        return False
    return a.is_file() and b.is_file()


# --- the check ------------------------------------------------------------------------------------

def detect(video: Path, work: Path, duration: Optional[float] = None, words: Optional[set] = None,
           reader: Optional[Reader] = None, reader_name: Optional[str] = None) -> dict:
    """-> {"verdict", "why" (plain words for mirrored / maybe-mirrored, else ""), "camera" ("front" /
    "back" / None), "letters": {"asFilmed", "flipped"} (letters of everyday words read each way),
    "frames", "reader", "seconds", "detail" (developer detail)}. `words`/`reader` are for tests; by
    default the speech model's vocabulary and the OS's text recognition."""
    t0 = time.monotonic()
    res = {"verdict": "unknown", "why": "", "camera": None, "letters": {"asFilmed": 0, "flipped": 0},
           "frames": 0, "reader": None, "seconds": 0.0, "detail": ""}

    def out(**kw):
        res.update(kw, seconds=round(time.monotonic() - t0, 2))
        res["why"] = WHY.get(res["verdict"], "")
        log(f"mirror_detect {Path(video).name}: {res}")
        return res

    if os.environ.get("REELENGINE_MIRROR_DETECT", "").strip() == "0":
        return out(detail="turned off (REELENGINE_MIRROR_DETECT=0)")
    tmp = Path(work) / "mirror-check"
    try:
        res["camera"] = camera_facing(video)
        if reader is None:
            reader_name, reader = os_reader()
            if reader is None:
                return out(detail=f"no built-in text recognition on {sys.platform}")
        if words is None:
            words = load_words()
            if not words:
                return out(detail="no speech model vocabulary yet")
        shutil.rmtree(tmp, ignore_errors=True)
        tmp.mkdir(parents=True, exist_ok=True)
        if duration is None:
            duration = float(_run([tools.ffprobe(), "-v", "error", "-show_entries", "format=duration",
                                   "-of", "csv=p=0", video], 60).strip() or 0)
        jobs = [(duration * f, tmp / f"f{i}.jpg", tmp / f"f{i}-flip.jpg") for i, f in enumerate(SAMPLE_AT)]
        with ThreadPoolExecutor(max_workers=len(jobs)) as pool:
            ok = list(pool.map(lambda j: _grab(Path(video), *j), jobs))
        pairs = [(a, b) for (_, a, b), good in zip(jobs, ok) if good]
        if not pairs:
            return out(reader=reader_name, detail="could not read any frame")
        texts = reader([str(p) for ab in pairs for p in ab])
        # a frame counts only when BOTH sides were read: one failed side would look like "no writing"
        read = [(x, y) for x, y in zip(texts[0::2], texts[1::2]) if x is not None and y is not None]
        if not read:
            return out(reader=reader_name, detail="text recognition failed on every frame")
        a = sum(score_lines(x, words) for x, _ in read)
        b = sum(score_lines(y, words) for _, y in read)
        return out(verdict=decide(a, b, res["camera"]), letters={"asFilmed": a, "flipped": b},
                   frames=len(read), reader=reader_name)
    except Exception as exc:  # noqa: BLE001 - detection is a nicety: it must never stop a project
        return out(reader=reader_name, detail=f"{type(exc).__name__}: {exc}"[:500])
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def project_record(r: dict) -> dict:
    """What a take keeps in project.json (`sources[].mirrorCheck`): the verdict and why, the camera, and
    the letters read each way. No timings or paths, so the same take writes the same record."""
    rec = {"verdict": r["verdict"], "letters": dict(r["letters"])}
    if r.get("why"):
        rec["why"] = r["why"]
    if r.get("camera"):
        rec["camera"] = r["camera"]
    return rec
