"""Audio envelope + word-edge measurement (ported from a working dead-air pass).

faster-whisper's word timestamps are guesses: it ends a sentence-final word early (the release is
still sounding), parks a word's start inside the pause before it, and sometimes stretches one word
across a long silence. Cutting on those times clips words or keeps dead air. So every word edge is
MEASURED against a 10 ms RMS envelope of the audio:

  * end   = walk forward from whisper's end until the envelope has been under the noise floor for
            60 ms (capped), so the release belongs to the word. If whisper's end sits deep in
            silence, walk back to where the sound actually stopped.
  * start = if whisper's start sits in silence, move forward to the onset; else walk back while the
            sound is still going (soft onsets), never into the previous word.
  * silent runs >= INSIDE_MIN found INSIDE a word are recorded as `gaps` so the cut can remove them.
"""
from __future__ import annotations

import wave
from pathlib import Path

import numpy as np

SR = 16000
HOP_MS = 10
PER = 1000 // HOP_MS          # envelope frames per second
QUIET_MS = 60
RELEASE_CAP = 0.30
ONSET_BACK_CAP = 0.15
ONSET_FWD_CAP = 1.50
PREROLL = 0.04                # kept before a measured onset (soft consonants)
INSIDE_MIN = 0.40             # silence inside a word worth cutting (well above a stop closure)


def read_wav(path: Path) -> np.ndarray:
    with wave.open(str(path)) as w:
        if w.getnchannels() != 1 or w.getframerate() != SR or w.getsampwidth() != 2:
            raise ValueError(f"{path}: need mono 16 kHz 16-bit")
        raw = w.readframes(w.getnframes())
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0


def envelope(samples: np.ndarray) -> np.ndarray:
    hop = SR * HOP_MS // 1000
    n = len(samples) // hop
    if n == 0:
        return np.zeros(0, dtype=np.float32)
    blocks = samples[:n * hop].reshape(n, hop)
    return np.sqrt((blocks ** 2).mean(axis=1) + 1e-12).astype(np.float32)


def noise_threshold(env) -> float:
    if len(env) == 0:
        return 0.006
    q = float(np.quantile(np.asarray(env), 0.10))
    return max(q * 3.0, 0.006)


def speech_end(env, thresh: float, e: float, release_cap: float = RELEASE_CAP) -> float:
    need = QUIET_MS // HOP_MS
    i = int(e * PER)
    quiet = 0
    for k in range(i, min(i + int(release_cap * PER), len(env))):
        quiet = quiet + 1 if env[k] < thresh else 0
        if quiet >= need:
            return (k - need + 1) / PER
    return e + release_cap


def _loud(env, k, thresh) -> bool:
    return 0 <= k < len(env) and env[k] >= thresh


def refine_words(words: list, env, thresh: float, duration: float) -> list:
    """Words of ONE source, sorted by time -> same words with measured s/e (whisper's kept as ws/we)."""
    out = []
    prev_end = 0.0
    for i, w in enumerate(words):
        s, e = float(w["s"]), float(w["e"])
        nxt_s = float(words[i + 1]["s"]) if i + 1 < len(words) else duration
        w2 = dict(w)
        w2["ws"], w2["we"] = round(s, 3), round(e, 3)
        if e < s:
            e = s
        # --- start ---
        ks = int(s * PER)
        if not _loud(env, ks, thresh):
            lim = min(int(min(e, s + ONSET_FWD_CAP) * PER), len(env))
            k = ks
            while k < lim and not _loud(env, k, thresh):
                k += 1
            if k < lim:
                s = max(prev_end, k / PER - PREROLL, s)
        else:
            floor = max(prev_end, s - ONSET_BACK_CAP)
            k = ks
            while k - 1 >= 0 and (k - 1) / PER >= floor and _loud(env, k - 1, thresh):
                k -= 1
            s = max(floor, k / PER - 0.02)
        s = max(s, prev_end)
        # --- end ---
        ke = int(e * PER)
        if not _loud(env, ke, thresh) and not _loud(env, ke - 1, thresh):
            # whisper's end is in silence: where did the sound actually stop?
            k = ke
            lo = int((s + 0.05) * PER)
            while k > lo and not _loud(env, k, thresh):
                k -= 1
            last_loud = k / PER
            if e - last_loud > 0.15:
                e = last_loud + QUIET_MS / 1000.0
        e = min(speech_end(env, thresh, e), nxt_s if nxt_s > s else e + RELEASE_CAP, duration or 1e9)
        e = max(e, s + 0.02)
        # --- silence inside the word ---
        gaps = []
        need = int(INSIDE_MIN * PER)
        run = 0
        k0, k1 = int(s * PER), min(int(e * PER), len(env))
        for k in range(k0, k1):
            if env[k] < thresh:
                run += 1
            else:
                if run >= need:
                    gaps.append([round((k - run) / PER, 3), round(k / PER, 3)])
                run = 0
        # a run touching the word's end is the release walk's business, not an inside gap
        w2["s"], w2["e"] = round(s, 3), round(e, 3)
        if gaps:
            w2["gaps"] = gaps
        else:
            w2.pop("gaps", None)
        prev_end = e
        out.append(w2)
    return out


def pause_list(words: list, min_pause: float = 0.30) -> list:
    """Dead air between consecutive words of the same source (already measured edges)."""
    pauses = []
    for a, b in zip(words, words[1:]):
        if a["source"] != b["source"]:
            continue
        gap = b["s"] - a["e"]
        if gap >= min_pause:
            pauses.append({"after": a["id"], "before": b["id"], "source": a["source"],
                           "s": round(a["e"], 3), "e": round(b["s"], 3), "dur": round(gap, 3)})
    return pauses
