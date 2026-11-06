"""Several cameras on one recording ("angles"): which camera the picture shows on each kept stretch.

A source with `angleOf: {source, offset}` is another camera on the recording of `source`: what that
source shows at second t, this one shows at t + offset. sync_offset() finds the offset by cross-
correlating the two cameras' sound. The words, the sound and every cut stay on the main take; only the
picture changes camera, so an angle can only ever be shown where it was rolling.

With `cut.angles: "auto"`, choose() picks a camera per output segment: the one whose face fills more
of the frame, held for at least MIN_HOLD seconds, changed after HOLD_MAX seconds on one camera when
another has a usable face, and never changed across a match cut or a cut on action (those were judged
on the main take's frames). A keep item's `angle` forces its camera. picture_segments() returns the
segments the picture plays: the cut's own segments, with source and times moved to the chosen camera.

Only tested on two angles made from one take (a crop and a time offset): real multi-camera footage,
with different lenses, mics and drift between clocks, is untested.
"""
from __future__ import annotations

import dataclasses
import hashlib
import json
import subprocess
from pathlib import Path
from typing import Optional

import numpy as np

from .proto import EngineError, log

SYNC_RATE = 4000            # Hz: speech's energy is below 2 kHz; a quarter-millisecond lag step
SYNC_SECONDS = 120.0        # of each camera's sound compared
SYNC_MAX_LAG = 60.0         # seconds one camera may have started before or after the other
# A real offset stands out from every other lag: its peak is at least this many times the next
# highest one (more than 50 ms away). Untuned: no multi-camera recording behind it.
SYNC_MIN_CONFIDENCE = 1.5
MIN_HOLD = 2.0              # seconds on a camera before it may change (a quicker change reads as a glitch)
HOLD_MAX = 7.0              # seconds on one camera before changing to another usable one
SWITCH_GAIN = 1.25          # before HOLD_MAX, change only to a face this much bigger
SAMPLES = (0.2, 0.5, 0.8)   # where in a stretch its cameras are looked at
VERSION = 1


def angle_of(src: dict) -> Optional[tuple]:
    """(main source id, offset seconds) for an angle source, else None."""
    a = src.get("angleOf")
    if isinstance(a, dict) and isinstance(a.get("source"), str) and isinstance(a.get("offset"), (int, float)):
        return a["source"], float(a["offset"])
    return None


# --- sync --------------------------------------------------------------------------------------

def _sound(ffmpeg: str, path: Path, seconds: float) -> np.ndarray:
    raw = subprocess.run([ffmpeg, "-v", "error", "-nostdin", "-i", str(path), "-t", f"{seconds:.3f}", "-vn", "-ac", "1",
                          "-ar", str(SYNC_RATE), "-f", "f32le", "-"], capture_output=True, timeout=600).stdout
    x = np.frombuffer(raw, np.float32).astype(np.float64)
    if x.size < SYNC_RATE:
        raise EngineError("ANGLE_NO_SOUND", f"{path.name} has under a second of sound",
                          "One of the cameras has no sound to line it up with, so it can't be used as an angle.")
    x = np.diff(x, prepend=x[0])                     # lifts the voice over hum and room rumble
    return (x - x.mean()) / (x.std() + 1e-9)


def sync_offset(ffmpeg: str, main: Path, angle: Path) -> dict:
    """{offset, confidence}: the angle shows main's second t at t + offset. Raises when no lag stands
    out (the two sounds aren't the same recording, or one is silent)."""
    a, b = _sound(ffmpeg, main, SYNC_SECONDS), _sound(ffmpeg, angle, SYNC_SECONDS)
    n = 1 << int(np.ceil(np.log2(a.size + b.size)))
    c = np.fft.irfft(np.fft.rfft(a, n) * np.conj(np.fft.rfft(b, n)), n)
    # c[k] = sum a[t + k] b[t]: the angle's sample t is main's sample t + k (k < 0 wraps to the end)
    lags = np.concatenate([np.arange(0, n // 2), np.arange(-(n - n // 2), 0)])
    ok = np.abs(lags) <= SYNC_MAX_LAG * SYNC_RATE
    c = np.where(ok, c, -np.inf)
    i = int(np.argmax(c))
    peak = float(c[i])
    away = ok & (np.abs(lags - lags[i]) > 0.05 * SYNC_RATE)
    second = float(np.max(c[away])) if away.any() else 0.0
    confidence = peak / second if second > 0 else float("inf")
    k = float(lags[i])
    j0, j1 = (i - 1) % n, (i + 1) % n                # parabola through the peak: a sub-sample lag
    y0, y1, y2 = c[j0], peak, c[j1]
    if np.isfinite(y0) and np.isfinite(y2) and (y0 - 2 * y1 + y2) != 0:
        k += 0.5 * (y0 - y2) / (y0 - 2 * y1 + y2)
    if confidence < SYNC_MIN_CONFIDENCE:
        raise EngineError("ANGLE_NO_SYNC", f"{angle.name}: best lag {k / SYNC_RATE:.3f} s only {confidence:.2f}x the next",
                          "I couldn't line this camera up with the main one by their sound. "
                          "Are they the same recording?")
    return {"offset": round(-k / SYNC_RATE, 4), "confidence": round(confidence, 2)}


# --- choosing ----------------------------------------------------------------------------------

def choose(stretches: list) -> list:
    """The camera for each stretch, in order. A stretch is {dur, scores: {source id: face score or
    None (no usable face)}, main: source id, forced: id or None, locked: bool (joined to the one
    before by a match cut or a cut on action)}. The main take is always usable."""
    picks, cur, held = [], None, 0.0
    for st in stretches:
        scores = st["scores"]
        usable = {sid: (sc or 0.0) for sid, sc in scores.items() if sc is not None or sid == st["main"]}
        best = max(usable, key=lambda s: (usable[s], s == st["main"]))
        if st.get("forced") in scores:
            pick = st["forced"]
        elif cur is None or cur not in usable:
            pick = best
        elif st.get("locked") or held < MIN_HOLD:
            pick = cur
        elif held >= HOLD_MAX:
            others = [s for s in usable if s != cur and (usable[s] > 0 or s == st["main"])]
            pick = max(others, key=lambda s: (usable[s], s == st["main"])) if others else cur
        else:
            pick = best if usable[best] > usable[cur] * SWITCH_GAIN else cur
        held = held + st["dur"] if pick == cur else st["dur"]
        cur = pick
        picks.append(pick)
    return picks


def _face_score(ctx_ffmpeg: str, path: Path, src: dict, face, fmt: tuple, times: list) -> Optional[float]:
    """Mean face height over the output frame's height at `times` (seconds in this source), through
    the render's crop; None when a face is found at fewer than two of them."""
    from .placement import _Detector
    from .render import no_rotate_args, reframe_filter
    w, h = 216, max(2, int(round(216 * fmt[1] / fmt[0])) // 2 * 2)
    det, found = _Detector(w, h), []
    for t in times:
        raw = subprocess.run([ctx_ffmpeg, "-v", "error", "-nostdin", *no_rotate_args(src), "-ss", f"{max(0.0, t):.3f}",
                              "-i", str(path), "-frames:v", "1", "-an", "-vf", reframe_filter(src, w, h, face, False),
                              "-f", "rawvideo", "-pix_fmt", "bgr24", "-"], capture_output=True, timeout=120).stdout
        if len(raw) < w * h * 3:
            continue
        f = det(np.frombuffer(raw[:w * h * 3], np.uint8).reshape(h, w, 3))
        if f is not None:
            found.append(f[3] / h * min(1.0, f[4]))
    return round(float(np.mean(found)), 4) if len(found) >= 2 else None


def _keep_angle(proj: dict, words: list, seg) -> Optional[str]:
    """A keep item's forced `angle` for the stretch starting at seg.first_word."""
    order = {w["id"]: i for i, w in enumerate(words)}
    at = order.get(seg.first_word)
    for item in (proj.get("cut") or {}).get("keep") or []:
        if not isinstance(item, dict) or not item.get("angle") or "from" not in item:
            continue
        a, b = order.get(item["from"]), order.get(item.get("to"))
        if at is not None and a is not None and b is not None and a <= at <= b:
            return item["angle"]
    return None


def picture_segments(project_dir: Path, proj: dict, segments: list, words: list, ffmpeg: str,
                     warnings: Optional[list] = None) -> tuple:
    """(segments the picture plays, [{out, angle}] per segment) for the cut's `segments`. Unchanged when
    the project has no angles in use."""
    from .cut import SEARCHED
    from . import project as projmod
    from .render import source_faces
    sources = {s["id"]: s for s in proj["sources"]}
    angles = {}
    for s in proj["sources"]:
        ao = angle_of(s)
        if ao and ao[0] in sources:
            angles.setdefault(ao[0], []).append((s["id"], ao[1]))
    auto = (proj.get("cut") or {}).get("angles") == "auto"
    forced = [_keep_angle(proj, words, seg) for seg in segments]
    if not angles or not (auto or any(forced)):
        return segments, []
    faces = source_faces(project_dir, proj)
    fmt = (int(proj["format"]["width"]), int(proj["format"]["height"]))
    cache_file = Path(project_dir) / "work" / "angles.json"
    try:
        cache = json.loads(cache_file.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        cache = {}
    stretches = []
    for seg, want in zip(segments, forced):
        scores = {}
        for sid, off in [(seg.source, 0.0)] + angles.get(seg.source, []):
            src = sources[sid]
            a, b = seg.src_start + off, seg.src_end + off
            dur = float(src.get("duration") or 0)
            if a < 0 or (dur and b > dur):
                continue                                    # that camera wasn't rolling
            if not auto:
                scores[sid] = 0.0 if sid == want or sid == seg.source else None
                continue
            path = projmod.source_path(project_dir, src)
            st = path.stat()
            times = [a + u * (b - a) for u in SAMPLES]
            key = hashlib.sha1(json.dumps([VERSION, str(path), st.st_size, st.st_mtime_ns, fmt, faces.get(sid),
                                           [round(t, 3) for t in times]], default=str).encode()).hexdigest()[:16]
            if key not in cache:
                cache[key] = _face_score(ffmpeg, path, src, faces.get(sid), fmt, times)
            scores[sid] = cache[key]
        if want and want not in scores:
            (warnings if warnings is not None else []).append(
                f"The camera asked for at {seg.out_start:.1f} s wasn't rolling there, so the main one is shown.")
            log(f"# angle {want} not usable at {seg.out_start:.2f}s")
            want = None
        stretches.append({"dur": seg.src_end - seg.src_start, "scores": scores, "main": seg.source, "forced": want,
                          "locked": seg.join_transition in SEARCHED})
    if auto:
        cache_file.parent.mkdir(parents=True, exist_ok=True)
        cache_file.write_text(json.dumps(cache), encoding="utf-8")
    picks = choose(stretches)
    out, rows = [], []
    for seg, pick in zip(segments, picks):
        off = dict(angles.get(seg.source, [])).get(pick, 0.0) if pick != seg.source else 0.0
        out.append(seg if pick == seg.source else
                   dataclasses.replace(seg, source=pick, src_start=seg.src_start + off, src_end=seg.src_end + off))
        rows.append({"out": round(seg.out_start, 3), "angle": pick})
    return out, rows
