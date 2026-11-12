"""Sound effects: project.sfx -> one stereo track mixed under the voice by music.build_audio.

The pack (sfx/pack.json and its Opus files, rebuilt by engine/scripts/build_sfx_pack.py from CC0
sources) gives each sound a job, an energy, a loudness and an onset: the time from the start of the
file to its audible hit (`hit_offset`). An entry `{"at", "sound", "gainDb"}` puts that hit on its
moment, so a whoosh peaks as the picture lands instead of starting there. `at` names one moment:

  {"word": "w12"}   that word starts, if the cut still keeps it (a zoom or a caption cue lands here)
  {"broll": "b3"}   that b-roll appears, its lead-in included
  {"cut": "w40"}    the cut into the kept range that starts with that word (never the video's start)

Restraint is enforced here rather than left to the prompt:
  * one effect at a time, at most one every MIN_GAP seconds; a later one that is closer, or that
    would start before the previous one has finished, is left out. So is one whose build-up would
    start before the video does (it would come in mid-swell on the first frame).
  * level from the measured voice, like the music bed: an effect peaks LEVEL_DB under the voice's
    speech loudness, gainDb moves it, and nothing goes above CAP_DB under the voice
  * an effect that sounds while the voice is talking, from its start to just after its hit, is ducked
    SPEECH_DUCK_DB more
  * an effect's sample peak stays PEAK_UNDER_DB under the voice's loudest peak: a 20 ms click at the
    loudness cap peaks about 9 dB over the voice and would drive the final limiter, dipping the voice
No listening test has set these numbers yet: they keep an effect audible in a pause and well under
the words, between the music bed (19 dB under) and the voice.
"""
from __future__ import annotations

import hashlib
import json
from functools import lru_cache
from pathlib import Path
from typing import Optional

import numpy as np

from .compose_util import ctx_words, fmt_of, word_start
from .music import HOP, SR, block_power, decode, lufs, speech_mask

PACK_DIR = Path(__file__).resolve().parent / "sfx"
MIN_GAP = 2.0
LEVEL_DB = -10.0
CAP_DB = -4.0
SPEECH_DUCK_DB = -6.0
HIT_WITHIN_DB = 6.0
END_FADE = 0.05
PEAK_UNDER_DB = 3.0


@lru_cache(maxsize=1)
def load_pack() -> dict:
    data = json.loads((PACK_DIR / "pack.json").read_text(encoding="utf-8"))
    return {s["id"]: s for s in data["sounds"]}


@lru_cache(maxsize=None)
def _file_hash(name: str) -> str:
    return hashlib.sha1((PACK_DIR / name).read_bytes()).hexdigest()


def hit_offset(x: np.ndarray, sr: int = SR) -> float:
    """Seconds from the start of `x` to its hit: where the loudness rises to within HIT_WITHIN_DB of
    its peak and stays there through the peak (20 ms windows, 1 ms apart, timed at their centres).
    For a click that is the attack; for a whoosh or a riser it is the swell's arrival. An earlier
    bump that only grazes the threshold does not count, so the answer cannot jump between them."""
    p = (x.astype(np.float64) ** 2).reshape(len(x), -1).sum(axis=1)
    w, h = int(0.020 * sr), int(0.001 * sr)
    p = np.pad(p, (w, w))
    c = np.concatenate([[0.0], np.cumsum(p)])
    starts = np.arange(0, len(p) - w, h)
    e = 10 * np.log10(np.maximum((c[starts + w] - c[starts]) / w, 1e-12))
    k = int(np.argmax(e))
    quiet = np.flatnonzero(e[:k] < e[k] - HIT_WITHIN_DB)
    first = quiet[-1] + 1 if len(quiet) else 0
    return max(0.0, (starts[first] + w / 2 - w) / sr)


def peak_loudness(x: np.ndarray, sr: int = SR) -> float:
    """The loudest BS.1770 momentary loudness (400 ms windows), LUFS. Padded with silence so a sound
    shorter than a window is measured over a whole window, as the standard does."""
    pad = int(0.4 * sr)
    return float(lufs(block_power(np.pad(x, ((pad, pad), (0, 0))), sr, 0.4, 0.01)).max())


def _peak_db(x: np.ndarray) -> float:
    return 20 * float(np.log10(max(float(np.abs(x).max()), 1e-9)))


def hit_time(ctx, at: dict) -> Optional[float]:
    """Output seconds of the moment `at` names, on the frame grid, or None if it is not in the cut."""
    t = None
    if at.get("word"):
        w = ctx_words(ctx).get(at["word"])
        # Use timeline membership: snapping can move a kept segment's start past its first word.
        # word_start maps a cut-out word to the next kept one; a point sound must not move with it.
        if w and ctx.is_kept(at["word"]):
            t = word_start(ctx, at["word"])
    elif at.get("broll"):
        from .broll import plan_windows
        t = next((p["t0"] for p in plan_windows(ctx) if p["id"] == at["broll"]), None)
    elif at.get("cut"):
        t = next((s.out_start for s in ctx.out_timeline if s.first_word == at["cut"] and s.out_start > 0), None)
    if t is None:
        return None
    fps = fmt_of(ctx)[2]
    return round(t * fps) / fps


def plan(ctx) -> tuple[list, list]:
    """(placed, left_out) on the output clock. placed: [{"t", "start", "end", "sound", "gainDb", "at"}]
    in time order; left_out: [{"at", "sound", "skipped"}] with the reason in plain words."""
    pack = load_pack()
    cands, left = [], []
    for i, e in enumerate((ctx.project or {}).get("sfx") or []):
        at = e.get("at") or {}
        snd = pack.get(e.get("sound"))
        t = hit_time(ctx, at) if snd else None
        if snd is None:
            left.append({"at": at, "sound": e.get("sound"), "skipped": "it is not one of the built-in sounds"})
        elif t is None:
            left.append({"at": at, "sound": snd["id"], "skipped": "its moment is no longer in the video"})
        elif t < snd["onsetMs"] / 1000:
            left.append({"at": at, "sound": snd["id"], "skipped": "it would have to start before the video does"})
        else:
            start = t - snd["onsetMs"] / 1000
            cands.append((t, i, {"t": t, "start": start, "end": start + snd["seconds"], "sound": snd,
                                 "gainDb": float(e.get("gainDb") or 0.0), "at": at}))
    placed = []
    for t, _, c in sorted(cands, key=lambda k: k[:2]):
        if placed and (t - placed[-1]["t"] < MIN_GAP or c["start"] < placed[-1]["end"]):
            left.append({"at": c["at"], "sound": c["sound"]["id"],
                         "skipped": f"it is too close to another sound effect (one at a time, {MIN_GAP:g} seconds apart)"})
        else:
            placed.append(c)
    return placed, left


def signature(placed: list) -> list:
    """Everything the effects track depends on, for music.build_audio's cache key."""
    return [LEVEL_DB, CAP_DB, SPEECH_DUCK_DB, END_FADE, PEAK_UNDER_DB,
            [[round(p["t"], 4), p["gainDb"], p["sound"]["onsetMs"], p["sound"]["loudness"],
              _file_hash(p["sound"]["file"])] for p in placed]]


def track(ctx, placed: list, voice: np.ndarray) -> tuple[np.ndarray, list]:
    """The effects as one (n, 2) track the length of `voice` (the whole cut, on the output clock),
    plus one report row per effect."""
    out = np.zeros_like(voice)
    speech, V = speech_mask(voice)
    voice_peak = _peak_db(voice)
    rows = []
    for p in placed:
        snd = p["sound"]
        under = bool(speech[int(p["start"] / HOP): int((p["t"] + 0.3) / HOP) + 1].any())
        x = decode(PACK_DIR / snd["file"], ctx)
        level = min(V + LEVEL_DB + p["gainDb"], V + CAP_DB) + (SPEECH_DUCK_DB if under else 0.0)
        level = min(level, snd["loudness"] + voice_peak - PEAK_UNDER_DB - _peak_db(x))
        x *= np.float32(10 ** ((level - snd["loudness"]) / 20))
        a = int(round(p["start"] * SR))
        n = min(len(x), len(out) - a)
        if n < len(x):                     # cut off by the end of the video: fade instead of a click
            f = min(n, int(END_FADE * SR))
            x[n - f:n] *= np.linspace(1, 0, f, dtype=np.float32)[:, None]
        out[a:a + n] += x[:n]
        rows.append({"sound": snd["id"], "at": p["at"], "t": round(p["t"], 3),
                     "underVoiceDb": round(level - V, 1), "underSpeech": under})
    return out, rows
