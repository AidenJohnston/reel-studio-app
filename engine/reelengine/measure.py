"""Measure a finished reel someone else made (a reference reel in My style): how fast they talk, how long
their first sentence takes, and how often the picture changes. Only the passes the Library index already runs:
footage.py's speech (faster-whisper words) and its scene-score shot finder. No new models, nothing read off the
picture (captions drawn on the video are not read)."""
from __future__ import annotations

import statistics
import tempfile
from pathlib import Path
from typing import Optional

from . import analyze, footage, probe, tools, transcribe
from .proto import EngineError, progress

MEASURE_VERSION = 1
# A pause this long ends the opening line even without a full stop: the phrase gap analyze.py splits takes on.
HOOK_GAP = analyze.PHRASE_GAP
# The opening line is a sentence, not a paragraph: past this many words it is cut where it stands. A choice, not
# measured: whisper sometimes leaves a whole run of speech without a full stop.
HOOK_MAX_WORDS = 25
# A gap between words this long counts as a pause: the "long pause" analyze.run reports for the person's own takes.
PAUSE_SECONDS = 1.0
STAGE = "measure"
# A reel, not a film: past this the engine would listen for many minutes. The app refuses longer files first
# (app shared/references.ts MAX_REFERENCE_SECONDS).
MAX_SECONDS = 600


def _r(x: float, places: int = 2) -> float:
    return round(float(x), places)


def hook_of(words: list) -> Optional[dict]:
    """The opening line: from the first word to the first sentence end, the first long pause, or HOOK_MAX_WORDS."""
    if not words:
        return None
    end = len(words) - 1
    for i, w in enumerate(words):
        if i + 1 >= HOOK_MAX_WORDS:
            end = i
            break
        if analyze.is_sentence_end(w["w"]):
            end = i
            break
        if i + 1 < len(words) and words[i + 1]["s"] - w["e"] >= HOOK_GAP:
            end = i
            break
    line = words[:end + 1]
    return {"seconds": _r(line[-1]["e"] - line[0]["s"]), "words": len(line),
            "text": " ".join(w["w"] for w in line)}


def speech_stats(words: list) -> Optional[dict]:
    """How fast they talk while talking: words a second over the time from the first word to the last, less every
    long pause (PAUSE_SECONDS or more), so a held beat doesn't read as slow speech. Also where talking starts, the
    opening line, and the long pauses a minute over the whole span. None when nothing was said."""
    words = sorted((w for w in words if w.get("w", "").strip()), key=lambda w: (w["s"], w["e"]))
    if not words:
        return None
    span = max(words[-1]["e"] - words[0]["s"], 1e-6)
    gaps = [b["s"] - a["e"] for a, b in zip(words, words[1:]) if b["s"] - a["e"] >= PAUSE_SECONDS]
    talking = max(span - sum(gaps), 1e-6)
    return {"words": len(words), "wordsPerSecond": _r(len(words) / talking), "firstWordAt": _r(words[0]["s"]),
            "talkingSeconds": _r(talking), "pausesPerMinute": _r(len(gaps) * 60 / span, 1), "hook": hook_of(words)}


def shot_stats(edges: list, duration: float) -> dict:
    """`edges`: footage._shots' (n, start, end) shots. A shot's length is end - start; cuts are the starts after 0."""
    lengths = [e - s for _, s, e in edges if e > s]
    cuts = [s for _, s, _ in edges[1:]]
    duration = max(float(duration), 1e-6)
    return {"count": len(lengths), "medianSeconds": _r(statistics.median(lengths)) if lengths else _r(duration),
            "perMinute": _r(len(cuts) * 60 / duration, 1), "cutsFirst5": sum(1 for t in cuts if t < 5)}


def _poster(src: Path, out: Path, at: float) -> Optional[str]:
    """One still to show beside the reel; a failure leaves the reel without one."""
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(out.stem + ".part" + out.suffix)
    r = tools.text_run([tools.ffmpeg(), "-y", "-nostdin", "-v", "error", "-ss", f"{at:.3f}", "-i", str(src),
                        "-frames:v", "1", "-vf", "scale=240:-2", str(tmp)], 120, f"poster of {src.name}", check=False)
    if r.returncode != 0 or not tmp.exists():
        tmp.unlink(missing_ok=True)
        return None
    tmp.replace(out)
    return str(out)


def measure(src: Path, poster: Optional[Path] = None, model_name: Optional[str] = None) -> dict:
    src = Path(src)
    if not src.is_file():
        raise EngineError("NOT_FOUND", f"{src} missing", "That reel isn't where it was. Add the file again.")
    info = probe.probe(src, quick=True)
    duration = float(info["duration"] or 0)
    if duration <= 0:
        raise EngineError("NOT_VIDEO", f"{src.name} has no duration", "That file isn't a video Reel Studio can read.")
    if duration > MAX_SECONDS:
        raise EngineError("TOO_LONG", f"{src.name} is {duration:.0f} s", "That video is longer than 10 minutes. Add a reel, or a short part of the video.")
    progress(STAGE, 5, "Looking at the cuts", force=True)
    has_video = int(info.get("width") or 0) > 0
    shots = shot_stats(footage._shots(src, duration, has_video), duration)
    speech, missing = None, None
    if not info.get("hasAudio"):
        missing = "no-audio"
    else:
        name = model_name or transcribe.default_model()
        if not transcribe.model_present(name):
            missing = "no-model"
        else:
            progress(STAGE, 30, "Listening to the reel", force=True)
            model, _, _ = transcribe.load_model(name)
            with tempfile.TemporaryDirectory(prefix="reel-measure-") as staging:
                words, _, _ = footage._speech(src, duration, model, Path(staging))
            speech = speech_stats(words)
            if speech is None:
                missing = "no-speech"
    out = {"version": MEASURE_VERSION, "duration": _r(duration), "width": int(info.get("width") or 0),
           "height": int(info.get("height") or 0), "hasAudio": bool(info.get("hasAudio")),
           "speech": speech, "speechMissing": missing, "shots": shots}
    if poster is not None:
        out["poster"] = _poster(src, Path(poster), min(1.0, duration / 2))
    progress(STAGE, 100, "Measured", force=True)
    return out
