"""Music: track analysis for the AI, and the final voice + music mix (docs/architecture.md section 5).

`build_audio(ctx, voice_wav)` -> final mixed wav at -14 LUFS integrated, true peak <= -1.5 dBTP.

The level doctrine (from the original pipeline's taste file, rule m1, eight notes deep): set the
music by the MEASURED voice-over-music gap, never by a fixed gain. A fixed gain read as "so loud at
some points" at a +13 dB gap; +19 dB passed. So the mixer:

  1. measures the voice's loudness while speaking (BS.1770 momentary, K-weighted, numpy)
  2. measures the music's short-term loudness bar by bar and PRE-LEVELS it flat: quiet bars are
     lifted at most +6 dB, loud bars are cut down to the track's median (the stem's peaks capped)
  3. sets the bed so the voice sits GAP dB over the music's median (preset: under-voice 19,
     quiet 24, loud-intro 19 with a loud lead-in before the first word)
  4. ducks under speech: the music comes up a little in the pauses and dips just before the voice
     returns, so a word is never fighting a swell
  5. applies the project's word-anchored automation (gainDb between two words)
  6. starts on the song's attack (analyze_track's suggestedStartAt is a transient), fades it in over
     `fadeIn` (0.6 s unless set; DECLICK_S at least, so it never clicks) and out at the end over `fadeOut`
  7. drops the music out for a named line (music.drops: from the line's first word through its last)
     and brings it back hard on the first beat after it, the way an editor lets a punchline land in
     silence; the song keeps running underneath, so it comes back on the grid
  8. adds the project's sound effects (sfx.py), placed and levelled against the same voice, and the
     reverb throw on the last word (voice.reverbThrow: an echo tail on the voice's final THROW_S)
  9. two-pass loudness: measure the mix, apply a static gain to -14 LUFS, true-peak limit
     (4x oversampled), measure again and correct the residual

The music also gets a gentle low cut (highpass 90 Hz, -6 dB shelf at 160 Hz): the original
"too loud" note was once TONAL, not level, and taking the bed out of the voice's body fixed it.

`analyze_track(path)` returns duration, loudness, lead silence, a loudness curve with arrivals,
a beat grid and rough energy/mood tags so the AI can choose a song and a start point.
"""
from __future__ import annotations

import hashlib
import json
import math
import subprocess
import sys
from pathlib import Path
from typing import Optional

import numpy as np

from . import beats as beatmod
from .compose_util import (EngineError, ctx_words, ffmpeg_bin, fmt_of, log, probe, report, resolve_asset, run,
                           word_end, word_start)
from .project import song_ref

SR = 48000
TARGET_LUFS = -14.0
TRUE_PEAK_DBTP = -1.5
HOP = 0.1                 # control-rate block hop, seconds
LEVELS = {
    "under-voice": {"gap": 19.0, "pauseLift": 3.0},
    "quiet": {"gap": 24.0, "pauseLift": 2.0},
    "loud-intro": {"gap": 19.0, "pauseLift": 3.0, "introGap": 10.0, "introMin": 1.0},
}
LIFT_CAP = 6.0            # quiet bars lifted at most this much
CUT_CAP = 12.0            # loud bars cut at most this much
MUSIC_EQ = "highpass=f=90,lowshelf=f=160:g=-6"
BEAT_MAX_SHIFT = 0.12
DECLICK_S = 0.01          # the shortest fade-in: long enough that the first sample does not click
DECLICK = 0.005           # the song's first and last edges, and a drop's: long enough not to click
DROP_LEAD = 0.04          # the music is gone this long before the line's first word
DROP_BACK_WITHIN = 1.0    # it comes back on the first beat this soon after the line...
DROP_BACK_AFTER = 0.15    # ...or, with no beat in reach, this long after the line's last word
THROW_S = 0.7             # the reverb throw catches the voice's final 0.7 s
THROW_DB = -8.0           # its tail peaks this far under the voice's speech loudness
THROW_RT60 = 1.6          # seconds for the tail to fall 60 dB
THROW_END_FADE = 0.1      # a tail still ringing at the end of the video fades over this
MIX_VERSION = 5           # bump when the mix changes for the same inputs (the mix cache key)


# --- decoding ----------------------------------------------------------------------------------

def decode(path: Path, ctx=None, start: float = 0.0, dur: Optional[float] = None, sr: int = SR, ch: int = 2,
           af: Optional[str] = None) -> np.ndarray:
    """Audio as float32 (n, ch) at sr. Any format ffmpeg reads; any path."""
    cmd = [ffmpeg_bin(ctx), "-v", "error", "-nostdin"]
    if start > 0:
        cmd += ["-ss", f"{start:.4f}"]
    cmd += ["-i", str(path)]
    if dur is not None:
        cmd += ["-t", f"{dur:.4f}"]
    cmd += ["-vn"]
    if af:
        cmd += ["-af", af]
    cmd += ["-ac", str(ch), "-ar", str(sr), "-f", "f32le", "-"]
    proc = run(cmd, timeout=600, what=f"decode {Path(path).name}", binary=True)
    a = np.frombuffer(proc.stdout, np.float32)
    return a.reshape(-1, ch).copy() if ch > 1 else a.copy()


def fit_length(x: np.ndarray, n: int) -> np.ndarray:
    """Exactly n rows: trim the tail or pad it with silence."""
    if x.shape[0] > n:
        return x[:n]
    if x.shape[0] < n:
        pad = [(0, n - x.shape[0])] + [(0, 0)] * (x.ndim - 1)
        return np.pad(x, pad)
    return x


def write_wav(path: Path, x: np.ndarray, sr: int = SR, ctx=None, codec: str = "pcm_s24le") -> Path:
    """Write float (n, ch) through ffmpeg (s24 wav by default)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    x = np.ascontiguousarray(x.astype(np.float32))
    ch = 1 if x.ndim == 1 else x.shape[1]
    tmp = path.with_suffix(".part.wav")
    proc = subprocess.run([ffmpeg_bin(ctx), "-y", "-v", "error", "-nostdin", "-f", "f32le", "-ar", str(sr),
                           "-ac", str(ch), "-i", "-", "-c:a", codec, str(tmp)], input=x.tobytes(),
                          capture_output=True, timeout=600)
    if proc.returncode != 0:
        raise EngineError("WAV_WRITE", proc.stderr.decode("utf-8", "replace")[-800:],
                          "I couldn't save the sound for your video. Check there is free disk space.")
    tmp.replace(path)
    return path


# --- loudness (ITU-R BS.1770, numpy) -----------------------------------------------------------

def _k_weight(x: np.ndarray, sr: int) -> np.ndarray:
    """K-weighting applied in the frequency domain (magnitude of the two BS.1770 biquads).
    Zero-phase, which is fine: loudness only needs power."""
    n = x.shape[0]
    if n == 0:
        return x
    nfft = 1 << (int(n - 1).bit_length())
    f = np.fft.rfftfreq(nfft, 1.0 / sr)
    w = 2 * np.pi * f / sr
    z = np.exp(-1j * w)

    def biquad(b, a):
        return np.abs((b[0] + b[1] * z + b[2] * z * z) / (a[0] + a[1] * z + a[2] * z * z))
    # BS.1770 stage 1 (high shelf) and stage 2 (RLB high-pass), coefficients derived for sr
    f0, G, Q = 1681.974450955533, 3.999843853973347, 0.7071752369554196
    K = math.tan(math.pi * f0 / sr)
    Vh = 10 ** (G / 20)
    Vb = Vh ** 0.4996667741545416
    a0 = 1 + K / Q + K * K
    b1 = [(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0]
    a1 = [1.0, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0]
    f0, Q = 38.13547087602444, 0.5003270373238773
    K = math.tan(math.pi * f0 / sr)
    a2 = [1.0, 2 * (K * K - 1) / (1 + K / Q + K * K), (1 - K / Q + K * K) / (1 + K / Q + K * K)]
    b2 = [1.0, -2.0, 1.0]
    H = biquad(b1, a1) * biquad(b2, a2)
    X = np.fft.rfft(x, nfft, axis=0)
    y = np.fft.irfft(X * (H[:, None] if x.ndim > 1 else H), nfft, axis=0)[:n]
    return y.astype(np.float32)


def block_power(x: np.ndarray, sr: int = SR, win: float = 0.4, hop: float = HOP, weighted: bool = True) -> np.ndarray:
    """Mean-square power per block (summed over channels), K-weighted. Block i covers
    [i*hop, i*hop + win)."""
    y = _k_weight(x, sr) if weighted else x
    p = (y.astype(np.float64) ** 2)
    if p.ndim > 1:
        p = p.sum(axis=1)
    c = np.concatenate([[0.0], np.cumsum(p)])
    n = len(p)
    h, w = int(round(hop * sr)), int(round(win * sr))
    starts = np.arange(0, max(1, n), h)
    ends = np.minimum(starts + w, n)
    lens = np.maximum(1, ends - starts)
    return (c[ends] - c[starts]) / lens


def lufs(power: np.ndarray) -> np.ndarray:
    return -0.691 + 10 * np.log10(np.maximum(power, 1e-12))


def integrated(x: np.ndarray, sr: int = SR) -> float:
    """Gated integrated loudness, LUFS (BS.1770-4)."""
    p = block_power(x, sr, 0.4, 0.1)
    L = lufs(p)
    keep = L > -70
    if not keep.any():
        return float("-inf")
    rel = lufs(np.array([p[keep].mean()]))[0] - 10
    keep &= L > rel
    if not keep.any():
        return float("-inf")
    return float(lufs(np.array([p[keep].mean()]))[0])


def true_peak_db(x: np.ndarray, sr: int = SR, over: int = 4) -> float:
    """dBTP via FFT oversampling (chunked so memory stays bounded)."""
    peak = 0.0
    chunk = sr * 5
    for i in range(0, x.shape[0], chunk):
        seg = x[max(0, i - 64): i + chunk + 64]
        n = seg.shape[0]
        if n < 4:
            continue
        S = np.fft.rfft(seg, axis=0)
        up = np.fft.irfft(S, n * over, axis=0) * over
        peak = max(peak, float(np.abs(up).max()))
    return 20 * math.log10(max(peak, 1e-9))


def ffmpeg_measure(path: Path, ctx=None) -> dict:
    """Independent EBU R128 reading by ffmpeg's ebur128 (integrated LUFS, LRA, true peak dBTP)."""
    proc = subprocess.run([ffmpeg_bin(ctx), "-hide_banner", "-nostats", "-nostdin", "-i", str(path), "-map", "a:0",
                           "-af", "ebur128=peak=true", "-f", "null", "-"], capture_output=True, text=True,
                          stdin=subprocess.DEVNULL,
                          encoding="utf-8", errors="replace", timeout=600)
    log_ = proc.stderr or ""
    if "Summary:" not in log_:
        return {}
    s = log_[log_.rindex("Summary:"):]
    import re

    def num(pat):
        m = re.findall(pat, s, flags=re.M)
        try:
            return float(m[-1]) if m else None
        except ValueError:
            return None
    return {"lufs": num(r"^\s*I:\s*(-?[\d.]+)\s*LUFS"), "lra": num(r"^\s*LRA:\s*(-?[\d.]+)\s*LU"),
            "truePeak": num(r"^\s*Peak:\s*(-?[\d.]+|-?inf)\s*dBFS")}


# --- the mix -----------------------------------------------------------------------------------

def _smooth_db(g: np.ndarray, hop: float, down: float = 0.08, up: float = 0.30) -> np.ndarray:
    """One-pole smoothing in dB: fast going down (duck), slower coming up (release)."""
    out = np.empty_like(g)
    a_dn = math.exp(-hop / down)
    a_up = math.exp(-hop / up)
    v = g[0]
    for i, x in enumerate(g):
        a = a_dn if x < v else a_up
        v = a * v + (1 - a) * x
        out[i] = v
    return out


def _dilate(mask: np.ndarray, before: int, after: int) -> np.ndarray:
    out = mask.copy()
    idx = np.flatnonzero(mask)
    for i in idx:
        out[max(0, i - before): i + after + 1] = True
    return out


def speech_mask(voice: np.ndarray, sr: int = SR) -> tuple[np.ndarray, float]:
    """(per-block speech flags, median speech loudness LUFS) from the voice track."""
    M = lufs(block_power(voice, sr, 0.4, HOP))
    loud = M[M > -60]
    if not len(loud):
        return np.zeros_like(M, bool), -70.0
    ref = float(np.percentile(loud, 90))
    mask = M > max(-55.0, ref - 18.0)
    v = float(np.median(M[mask])) if mask.any() else ref
    return mask, v


def music_gain_curve(ctx, music: np.ndarray, voice: np.ndarray, mcfg: dict, offset: float = 0.0) -> tuple[np.ndarray, dict]:
    """Per-block music gain in dB (block i at i*HOP seconds of the OUTPUT), plus a report."""
    level = mcfg.get("level") or "under-voice"
    preset = LEVELS.get(level, LEVELS["under-voice"])
    nb = int(math.ceil(voice.shape[0] / (HOP * SR)))
    speech, V = speech_mask(voice)
    speech = np.pad(speech, (0, max(0, nb - len(speech))))[:nb]
    # music short-term loudness (3 s), centred on the block
    Ms = lufs(block_power(music, SR, 3.0, HOP))
    shift = int(round(1.5 / HOP))
    Ms = np.concatenate([np.full(shift, Ms[0]), Ms])[:nb]
    Ms = np.pad(Ms, (0, max(0, nb - len(Ms))), mode="edge")[:nb]
    audible = Ms > -60
    m_med = float(np.median(Ms[audible])) if audible.any() else -30.0
    prelevel = np.clip(m_med - Ms, -CUT_CAP, LIFT_CAP)
    prelevel[~audible] = 0.0
    base = (V - preset["gap"]) - m_med
    g = base + prelevel
    # ducking: up in pauses, down a little before speech returns
    talk = _dilate(speech, before=int(0.25 / HOP), after=int(0.30 / HOP))
    g = g + np.where(talk, 0.0, preset["pauseLift"])
    first = int(np.argmax(speech)) if speech.any() else nb
    if level == "loud-intro":
        # the opening hits loud (voice still introGap dB on top), then eases down to the bed
        intro = (V - preset["introGap"]) - m_med + prelevel
        end = min(nb, max(first - int(0.15 / HOP), int(preset["introMin"] / HOP)))
        ramp = int(0.5 / HOP)
        g[:end] = np.maximum(g[:end], intro[:end])
        for k in range(ramp):
            i = end + k
            if i < nb:
                u = (k + 1) / (ramp + 1)
                g[i] = max(g[i], intro[i] * (1 - u) + g[i] * u)
    # Word automation and derived smash dips share the same gain curve and smoothing.
    autos, spans = [], []
    for a in mcfg.get("automation") or []:
        t0 = word_start(ctx, a.get("fromWord")) if a.get("fromWord") else 0.0
        t1 = word_end(ctx, a.get("toWord")) if a.get("toWord") else None
        if t0 is None:
            continue
        t1 = t1 if t1 is not None else nb * HOP
        spans.append((t0, t1, float(a.get("gainDb", 0.0))))
    for seg in ctx.out_timeline:
        if seg.join_transition == "smash":
            # A 200 ms, -6 dB dip leaves room for the impact without ducking a whole
            # sentence. These are untested starting values, not measured preferences.
            t0 = round(seg.out_start * fmt_of(ctx)[2]) / fmt_of(ctx)[2]
            spans.append((t0, t0 + 0.2, -6.0))
    for t0, t1, gain_db in spans:
        i0, i1 = int((t0 - offset) / HOP), int(math.ceil((t1 - offset) / HOP))
        i0, i1 = max(0, i0), min(nb, i1)
        if i1 > i0:
            g[i0:i1] += gain_db
            autos.append({"from": round(t0, 3), "to": round(t1, 3), "gainDb": gain_db})
    g = _smooth_db(g, HOP)
    rep = {"level": level, "voiceSpeechLUFS": round(V, 2), "musicMedianLUFS": round(m_med, 2),
           "targetGapDb": preset["gap"], "baseGainDb": round(base, 2), "automation": autos,
           "firstSpeech": round(first * HOP + offset, 2)}
    return g, rep


def _limit(ctx, x: np.ndarray, work: Path, tag: str) -> np.ndarray:
    """True-peak limiter: 4x oversampled ffmpeg alimiter at -1.5 dBTP (minus a hair of margin)."""
    lim = 10 ** ((TRUE_PEAK_DBTP - 0.3) / 20)
    src = write_wav(work / f"{tag}-prelimit.wav", x, codec="pcm_f32le", ctx=ctx)
    af = (f"aresample={SR * 4},alimiter=limit={lim:.5f}:attack=1:release=60:level=0:asc=1,"
          f"aresample={SR}")
    out = decode(src, ctx, af=af)
    src.unlink(missing_ok=True)
    n = min(out.shape[0], x.shape[0])
    y = np.zeros_like(x)
    y[:n] = out[:n]
    return y


def normalize(ctx, x: np.ndarray, work: Path, tag: str = "mix", expected_silence: bool = False) -> tuple[np.ndarray, dict]:
    """Two-pass loudness to TARGET_LUFS with a true-peak ceiling. Returns (audio, readings)."""
    if expected_silence and not np.any(x):
        return x, {"expectedSilence": True, "inputLUFS": None, "pass1LUFS": None, "finalLUFS": None}
    I0 = integrated(x)
    if not math.isfinite(I0):
        raise EngineError("SILENT", "mix is silent", "Your video seems to have no sound. Check the microphone and try again.")
    y = x * (10 ** ((TARGET_LUFS - I0) / 20))
    y = _limit(ctx, y, work, tag)
    I1 = integrated(y)
    if abs(I1 - TARGET_LUFS) > 0.2:           # the limiter took some loudness: correct and re-limit
        y = y * (10 ** ((TARGET_LUFS - I1) / 20))
        y = _limit(ctx, y, work, tag)
    I2 = integrated(y)
    return y, {"inputLUFS": round(I0, 2), "pass1LUFS": round(I1, 2), "finalLUFS": round(I2, 2)}


def fade_lengths(mcfg: dict) -> tuple[float, float]:
    """(fade-in, fade-out) of the bed in seconds. Without `fadeIn` the song comes in over 0.6 s, or at once
    under loud-intro, whose point is a loud first beat. Even `fadeIn: 0` keeps DECLICK_S: a song cut in
    mid-waveform starts with a click."""
    level = mcfg.get("level") or "under-voice"
    fi = mcfg.get("fadeIn")
    fi = (0.05 if level == "loud-intro" else 0.6) if fi is None else max(DECLICK_S, float(fi))
    return fi, float(mcfg.get("fadeOut", 1.5) or 0.0)



def _ramp(n: int, up: bool) -> np.ndarray:
    r = np.linspace(0, 1, max(1, n), dtype=np.float32)
    return r if up else r[::-1]


def drop_windows(ctx, mcfg: dict, dur: float, track: Optional[Path]) -> list[dict]:
    """music.drops -> [{"from", "to", "out", "back", "onBeat"}] on the output clock, frame-aligned: the music
    leaves DROP_LEAD before the line's first word and comes back on the first beat within
    DROP_BACK_WITHIN of its last word (else DROP_BACK_AFTER after it). A line the cut removed, or one
    that ends where it starts, has no window."""
    fps = fmt_of(ctx)[2]
    grid = beatmod.output_grid(ctx.project, track)
    out = []
    for d in mcfg.get("drops") or []:
        t0, t1 = word_start(ctx, d.get("from")), word_end(ctx, d.get("to"))
        if t0 is None or t1 is None or t1 <= t0:
            continue
        a = max(0.0, round((t0 - DROP_LEAD) * fps) / fps)
        back = beatmod.next_beat(t1, grid, DROP_BACK_WITHIN)
        b = min(dur, back if back is not None else round((t1 + DROP_BACK_AFTER) * fps) / fps)
        if b > a:
            out.append({"from": d.get("from"), "to": d.get("to"), "out": round(a, 4), "back": round(b, 4),
                        "onBeat": back is not None})
    return out


def drop_gate(n: int, windows: list[dict], offset: float = 0.0) -> np.ndarray:
    """Per-sample music gain: 0 inside each drop window, 1 elsewhere, DECLICK ramps at the edges."""
    g = np.ones(n, np.float32)
    k = int(DECLICK * SR)
    for w in windows:
        a, b = int(round((w["out"] - offset) * SR)), int(round((w["back"] - offset) * SR))
        a, b = max(0, a), min(n, b)
        if b <= a:
            continue
        g[a:b] = 0.0
        lo = max(0, a - k)
        g[lo:a] = np.minimum(g[lo:a], _ramp(a - lo, False)[: a - lo])
        hi = min(n, b + k)
        g[b:hi] = np.minimum(g[b:hi], _ramp(hi - b, True)[: hi - b])
    return g


def throw_impulse(sr: int = SR) -> np.ndarray:
    """A stereo reverb impulse response, generated (no file, no dependency) and identical on every run:
    seeded decorrelated noise under an exponential decay of THROW_RT60, 25 ms pre-delay, band-limited
    to 250 Hz - 6 kHz so the tail is airy rather than boomy. Unit energy."""
    n = int(THROW_RT60 * sr)
    rng = np.random.default_rng(20261112)               # PCG64: the same numbers on every machine
    t = np.arange(n) / sr
    ir = rng.standard_normal((n, 2)) * np.exp(-6.91 * t / THROW_RT60)[:, None]
    f = np.fft.rfftfreq(n, 1 / sr)
    band = 1 / np.sqrt(1 + (250 / np.maximum(f, 1)) ** 4) / np.sqrt(1 + (f / 6000) ** 4)
    ir = np.fft.irfft(np.fft.rfft(ir, axis=0) * band[:, None], n, axis=0)
    ir = np.concatenate([np.zeros((int(0.025 * sr), 2)), ir])
    return (ir / np.sqrt((ir ** 2).sum() / 2)).astype(np.float32)


def final_word(ctx) -> Optional[tuple[str, float, float]]:
    """(id, output start, output end) of the word the video ends on: the last word of the cut's last
    segment, placed through that segment. A word id can play twice (a range kept twice) and a word's text
    can repeat, so neither the id's first appearance nor its text says where the video ends."""
    segs = list(getattr(ctx, "out_timeline", None) or [])
    wid = segs[-1].last_word if segs else None
    w = ctx_words(ctx).get(wid) if wid else None
    if w is None:
        return None
    last = segs[-1]

    def out_at(t: float) -> float:          # through the pieces of the last kept range, newest first
        for seg in reversed(segs):
            if seg.source == last.source and seg.src_start - 1e-6 <= t <= seg.src_end + 1e-6:
                return seg.out_start + (t - seg.src_start)
            if seg.first_word is not None:
                return seg.out_start        # the range's first piece: snapping moved its start past t
        return last.out_start
    end = last.out_start + (min(float(w["e"]), last.src_end) - last.src_start)
    return wid, min(out_at(float(w["s"])), end), end


def reverb_throw(ctx, voice: np.ndarray, offset: float = 0.0) -> tuple[Optional[np.ndarray], Optional[dict]]:
    """The wet tail of a reverb fed only the voice's final THROW_S (from the final word's end back, never
    before that word starts), as a track the length of `voice`. A pure function of that send: its samples
    are placed on the output clock's sample grid, the impulse response is fixed, and the tail's loudest
    moment sits THROW_DB under the word it echoes. Nothing else in the voice (an earlier edit, or how much
    of the video a preview window holds) changes it. The dry voice is untouched. A tail still ringing when
    the video ends fades out over THROW_END_FADE. (None, None) when there is no final word."""
    fw = final_word(ctx)
    if fw is None:
        return None, None
    wid, ws, we = fw
    base = int(round(offset * SR))
    a = max(0, int(round(max(ws, we - THROW_S) * SR)) - base)
    b = min(len(voice), int(round((we + 0.03) * SR)) - base)
    if b - a < int(0.05 * SR):
        return None, None
    send = voice[a:b].copy()
    k = int(0.01 * SR)
    send[:k] *= _ramp(k, True)[:, None]
    send[-k:] *= _ramp(k, False)[:, None]
    ir = throw_impulse()
    m = len(send) + len(ir) - 1
    nfft = 1 << (m - 1).bit_length()
    wet = np.fft.irfft(np.fft.rfft(send, nfft, axis=0) * np.fft.rfft(ir, nfft, axis=0), nfft, axis=0)[:m]
    # level from the word it echoes, measured on the whole tail before the video's end can cut it: a soft
    # last word gets a soft tail, and a word lost in room noise cannot become a loud wash of that noise
    word = float(lufs(block_power(np.pad(send, ((int(0.4 * SR), 0), (0, 0))), SR, 0.4, 0.05)).max())
    peak = float(lufs(block_power(wet, SR, 0.4, 0.05)).max())
    wet = (wet * 10 ** ((word + THROW_DB - peak) / 20)).astype(np.float32)
    out = np.zeros_like(voice)
    n = min(m, len(voice) - a)
    out[a:a + n] = wet[:n]
    if n < m:                                   # cut off by the end of the video
        f = min(n, int(THROW_END_FADE * SR))
        out[a + n - f:a + n] *= _ramp(f, False)[:, None]
    return out, {"word": wid, "from": round((a + base) / SR, 3), "to": round((b + base) / SR, 3),
                 "underWordDb": THROW_DB}


def build_audio(ctx, voice_wav) -> Path:
    """Cut voice wav (output timeline) + project.music + project.sfx + project.voice -> work/audio/mix-<hash>.wav
    at -14 LUFS. Writes work/audio/mix.json with the measured numbers."""
    voice_wav = Path(voice_wav)
    work = Path(ctx.work) / "audio"
    work.mkdir(parents=True, exist_ok=True)
    report(ctx, "music", 5, "Adding music")
    mcfg = dict((ctx.project or {}).get("music") or {})
    voice = decode(voice_wav, ctx)
    if voice.shape[0] == 0:
        raise EngineError("NO_AUDIO", f"{voice_wav} has no audio", "This video has no sound. Try a different file.")
    dur = voice.shape[0] / SR
    # The voice is always the full cut (render.build_audio); a preview window slices the finished mix
    # afterwards, so the song is never shifted here (a near-full window used to shift it twice: audit 11)
    offset = 0.0
    track = None
    if mcfg.get("enabled", True) and mcfg.get("track"):
        track = resolve_asset(ctx, song_ref(mcfg))
        if not track.exists():
            raise EngineError("MUSIC_MISSING", f"music not found: {track}",
                              "The song for this video is missing. Pick another song.")
    effects = None
    smash_times = [s.out_start for s in ctx.out_timeline if s.join_transition == "smash"]
    if (ctx.project or {}).get("sfx") or smash_times:
        # built before the cache lookup so a failure keeps them out of the key, not just out of the mix
        try:
            from . import sfx as sfxmod
            placed = sfxmod.plan(ctx)[0]
            if placed:
                effects, rows = sfxmod.track(ctx, placed, voice)
                fx_key = sfxmod.signature(placed)
        except Exception as exc:    # noqa: BLE001 -- a broken sound effect must never cost the music
            effects = None
            log(f"# sound effects skipped: {exc!r}")
    # a mix that is silent on purpose (no sound in any source, no song; multi-source) is normalized differently
    expected_silence = getattr(ctx, "expected_silence", False)
    vcfg = (ctx.project or {}).get("voice") or {}
    key = [MIX_VERSION, expected_silence, str(voice_wav), voice_wav.stat().st_size, voice_wav.stat().st_mtime_ns,
           mcfg, str(track) if track else None, track.stat().st_mtime_ns if track else None, offset]
    if smash_times:
        key.append(["smash", smash_times, fmt_of(ctx)[2]])
    if vcfg:
        key.append(vcfg)
    if effects is not None:
        key.append(fx_key)
        ctx.sfx_mixed = rows
    sig = hashlib.sha1(json.dumps(key, sort_keys=True, default=str).encode()).hexdigest()[:12]
    out = work / f"mix-{sig}.wav"
    rep_path = out.with_suffix(".json")
    if out.exists() and rep_path.exists():
        return out
    rep = {"duration": round(dur, 3), "music": None}
    mix = voice.copy()
    if track is not None:
        report(ctx, "music", 25, "Adding music")
        tinfo = probe(track, ctx)
        start = track_start(mcfg, tinfo["duration"], offset)
        music = decode(track, ctx, start=start, dur=dur, af=MUSIC_EQ)
        short = music.shape[0] < voice.shape[0] - SR * 0.1
        if music.shape[0] < voice.shape[0]:
            if music.shape[0] > SR:            # song ends early: let it fade out where it ends
                n = music.shape[0]
                fl = min(n, int(1.5 * SR))
                music[n - fl:] *= np.linspace(1, 0, fl, dtype=np.float32)[:, None]
            music = np.pad(music, ((0, voice.shape[0] - music.shape[0]), (0, 0)))
        # `-t dur` rounds to 4 decimals and the mp3/aac decoder adds its own priming samples, so the
        # bed can come back a few samples LONGER than the voice: trim it to the voice exactly.
        music = fit_length(music, voice.shape[0])
        g_db, mrep = music_gain_curve(ctx, music, voice, mcfg, offset)
        n = voice.shape[0]
        tb = np.arange(len(g_db)) * HOP * SR
        gain = (10 ** (np.interp(np.arange(n), tb, g_db) / 20)).astype(np.float32)
        fi, fo = fade_lengths(mcfg)
        fin = min(n, int(fi * SR))
        gain[:fin] *= np.linspace(0, 1, fin, dtype=np.float32)
        k = min(n, int(max(fo, DECLICK) * SR))     # fadeOut 0 still ends without a click
        gain[n - k:] *= _ramp(k, False)
        drops = drop_windows(ctx, mcfg, offset + dur, track)
        if drops:
            gain *= drop_gate(n, drops, offset)
        bed = music * gain[:, None]
        # measured gap while speaking, before the final normalisation (a constant gain keeps it)
        speech, V = speech_mask(voice)
        Mb = lufs(block_power(bed, SR, 0.4, HOP))[: len(speech)]
        sp = speech[: len(Mb)] & (Mb > -70)
        gap = float(np.median(V - Mb[sp])) if sp.any() else None
        gap_p10 = float(np.percentile(V - Mb[sp], 10)) if sp.any() else None
        mix = voice + bed
        mrep.update({"track": str(track), "startAt": round(start, 3), "songShorterThanVideo": bool(short),
                     "measuredGapDb": None if gap is None else round(gap, 2),
                     "gapP10Db": None if gap_p10 is None else round(gap_p10, 2)})
        if drops:
            mrep["drops"] = drops
        rep["music"] = mrep
    if effects is not None:
        mix = mix + effects
        rep["sfx"] = rows
    if vcfg.get("reverbThrow"):
        wet, trep = reverb_throw(ctx, voice, offset)
        if wet is not None:
            mix = mix + wet
            rep["reverbThrow"] = trep
    report(ctx, "music", 70, "Balancing the sound")
    mix, lrep = normalize(ctx, mix, work, expected_silence=expected_silence)
    rep.update(lrep)
    write_wav(out, mix, ctx=ctx)
    # every render writes a fresh voice wav (new mtime -> new hash): keep only the latest mixes,
    # or a project collects one ~20 MB wav per render
    old = sorted((p for p in work.glob("mix-*.wav") if p != out), key=lambda p: p.stat().st_mtime)
    for p in old[:-1]:
        p.unlink(missing_ok=True)
        p.with_suffix(".json").unlink(missing_ok=True)
    rep["file"] = str(out)
    rep["truePeakDb"] = round(true_peak_db(mix), 2)
    rep["clipped"] = bool(np.abs(mix).max() >= 0.999)
    part = rep_path.with_suffix(".part.json")
    part.write_text(json.dumps(rep, indent=1), encoding="utf-8")
    part.replace(rep_path)
    report(ctx, "music", 100, "Balancing the sound")
    return out


# --- track analysis ----------------------------------------------------------------------------

def _onset_envelope(mono: np.ndarray, sr: int, n_fft: int = 1024, hop: int = 512) -> np.ndarray:
    """Positive spectral change, with window centres on the audio clock.

    The L2 magnitude change preserves transient strength. Summing log changes
    gave quiet broadband hi-hats more weight than louder tonal beat clicks.
    """
    n = len(mono)
    if n < n_fft:
        return np.zeros(1)
    # Padding keeps clicks at either edge visible and centres frame i at i*hop.
    mono = np.pad(mono, (n_fft // 2, n_fft // 2))
    frames = 1 + n // hop
    win = np.hanning(n_fft).astype(np.float32)
    env = np.zeros(frames, np.float32)
    prev = None
    for s in range(0, frames, 2048):
        idx = np.arange(s, min(frames, s + 2048))
        seg = np.stack([mono[i * hop: i * hop + n_fft] for i in idx]) * win
        mag = np.abs(np.fft.rfft(seg, axis=1))
        if prev is not None:
            mag_all = np.vstack([prev[None, :], mag])
        else:
            mag_all = np.vstack([np.zeros_like(mag[:1]), mag])
        flux = np.sqrt((np.maximum(0, np.diff(mag_all, axis=0)) ** 2).sum(axis=1))
        env[idx] = flux
        prev = mag[-1]
    env -= np.convolve(env, np.ones(16) / 16, mode="same")     # remove slow trend
    return np.maximum(env, 0)


def _tempo_and_beats(env: np.ndarray, fps: float) -> tuple[Optional[float], list[float], float]:
    """(bpm, beat times, confidence 0..1) from an onset envelope via autocorrelation + phase pick."""
    if len(env) < fps * 4 or env.max() <= 0:
        return None, [], 0.0
    # Smooth only the tempo evidence: narrow transients split across adjacent hops,
    # so raw integer-lag correlation can prefer a half-tempo harmonic (140 -> 70).
    smooth = np.convolve(env, [0.25, 0.5, 0.25], mode="same")
    e = (smooth - smooth.mean()) / (smooth.std() + 1e-9)
    ac = np.correlate(e, e, mode="full")[len(e) - 1:]
    ac /= ac[0] + 1e-9
    bpm_of = lambda lag: 60.0 * fps / lag  # noqa: E731
    lo, hi = int(fps * 60 / 180), int(fps * 60 / 60)
    best, best_lag = -1e9, None
    for lag in range(max(1, lo), min(hi, len(ac) - 1)):
        bpm = bpm_of(lag)
        prior = math.exp(-0.5 * (math.log2(bpm / 120.0) / 0.9) ** 2)   # mild preference near 120
        score = ac[lag] * prior
        if score > best:
            best, best_lag = score, lag
    if best_lag is None:
        return None, [], 0.0
    # refine with parabolic interpolation
    l = best_lag
    if 1 <= l < len(ac) - 1:
        a, b, c = ac[l - 1], ac[l], ac[l + 1]
        d = (a - c) / (2 * (a - 2 * b + c) + 1e-12)
        period = l + float(np.clip(d, -0.5, 0.5))
    else:
        period = float(l)
    padded = np.pad(env, (1, 1))
    peaks = np.flatnonzero((env > padded[:-2]) & (env >= padded[2:]))
    a, b, c = padded[peaks], env[peaks], padded[peaks + 2]
    positions = np.maximum(0, peaks + np.clip(
        (a - c) / (2 * (a - 2 * b + c) + 1e-12), -0.5, 0.5))

    # Refine the lag with local onset intervals before assigning beat numbers.
    # Average without amplitude weights: hop alignment changes peak strength,
    # so weighting those intervals biases the period on long click tracks.
    intervals = []
    for t in positions:
        start, end = np.searchsorted(positions, [t + period * 0.8, t + period * 1.2])
        if start < end:
            j = start + int(np.argmax(env[peaks[start:end]]))
            intervals.append(positions[j] - t)
    if len(intervals) >= 4:
        refined = float(np.mean(intervals))
        if abs(refined - period) < period * 0.05:
            period = refined

    # Score the same fractional period we emit. Rounding the stride accumulates
    # phase error across a track even when its BPM estimate is close.
    frames = np.arange(len(env))
    phases = np.arange(0, period, 0.5)
    phase = float(max(phases, key=lambda p: np.interp(
        np.arange(p, len(env), period), frames, smooth).sum()))

    # Fit period and phase to nearby onsets over the whole track.
    for _ in range(3):
        numbers = np.rint((positions - phase) / period)
        keep = np.abs(positions - (phase + numbers * period)) < period * 0.2
        if keep.sum() < 4:
            break
        design = np.column_stack([np.ones(keep.sum()), numbers[keep]])
        weights = np.sqrt(env[peaks[keep]])
        fitted_phase, fitted_period = np.linalg.lstsq(
            design * weights[:, None], positions[keep] * weights, rcond=None)[0]
        if abs(fitted_period - period) > period * 0.05:
            break
        phase, period = float(fitted_phase), float(fitted_period)
    phase %= period
    beats = []
    for t in np.arange(phase - period, len(env) + period * 0.1, period):
        near = np.flatnonzero(np.abs(positions - t) <= period * 0.1)
        # A grid point without an onset is not a beat to accent, including silence.
        if not len(near):
            continue
        j = positions[near[np.argmax(env[peaks[near]])]]
        beats.append(round(max(0, j) / fps, 3))
    conf = float(np.clip(ac[best_lag], 0, 1))
    return round(bpm_of(period), 1), beats, round(conf, 3)


def find_arrivals(curve: list, window: float, lookback: float = 30.0, top: int = 3) -> list[dict]:
    """Where the track gets louder and STAYS louder; the onset is where the rise has gone 25% of the
    way (that is where a listener hears the music change). Ported from the original music.py."""
    span = max(1, int(round(lookback / window)))
    if len(curve) <= span:
        return []
    levels = sorted(v for _, v in curve)
    intro_floor = levels[len(levels) // 2] - 12.0
    moves = []
    for i in range(span, len(curve)):
        before, after = curve[i - span][1], curve[i][1]
        if before < intro_floor or after <= before:
            continue
        trigger = before + (after - before) * 0.25
        onset = curve[i][0]
        for j in range(i - span + 1, i + 1):
            if curve[j][1] >= trigger:
                onset = curve[j][0]
                break
        moves.append((after - before, onset, before, after))
    moves.sort(reverse=True)
    picked = []
    for m in moves:
        if any(abs(m[1] - p[1]) < lookback for p in picked):
            continue
        picked.append(m)
        if len(picked) >= top:
            break
    return [{"at": round(o, 2), "riseDb": round(d, 1), "fromLUFS": round(b, 1), "toLUFS": round(a, 1)}
            for d, o, b, a in sorted(picked, key=lambda m: m[1])]


ANALYSIS_VERSION = 5     # bump when analyze_track's output changes (the analysis cache key); 5: the start
                         # moved onto the song's attack (attack_at)
ATTACK_SEARCH = 4.0      # look this far past the chosen bar for the song's next attack
ATTACK_PREROLL = 0.003   # start this much before the transient, so its front edge is not shaved
ATTACK_RISE_DB = 3.0     # less of a rise than this is not an attack
ONSET_FFT, ONSET_HOP = 1024, 512


def attack_in(mono: np.ndarray, sr: int, lo: float, hi: float) -> Optional[float]:
    """Seconds of the attack in mono[lo:hi], to the millisecond, or None if nothing rises there.
    The level at a moment is the RMS of the 10 ms before it (a window that ends there, so a rise is
    timed where it starts; 10 ms also smooths out a bass note's cycle). The attack is the steepest
    10 ms rise in the span, at least ATTACK_RISE_DB, timed where it has climbed halfway in dB: a pad
    sounding under the hit, or chords beating against each other, moves the level less than a hit."""
    a, b = max(0, int(lo * sr)), min(len(mono), int(hi * sr))
    w, h = max(1, int(0.010 * sr)), max(1, sr // 1000)
    steps = w // h
    if b - a < w + 2 * steps * h:
        return None
    c = np.concatenate([[0.0], np.cumsum(mono[a:b].astype(np.float64) ** 2)])
    ends = np.arange(w, b - a + 1, h)
    db = 10 * np.log10(np.maximum((c[ends] - c[ends - w]) / w, 1e-12))
    rise = db[steps:] - db[:-steps]                 # rise[j]: from db[j] to db[j + steps], 10 ms later
    j = int(np.argmax(rise))
    if rise[j] < ATTACK_RISE_DB:
        return None
    i = j + int(np.argmax(db[j:j + steps + 1] >= db[j] + rise[j] / 2))
    return (a + ends[i]) / sr


def attack_at(mono: np.ndarray, sr: int, env: np.ndarray, t: float) -> float:
    """The first strong attack at or after t (within ATTACK_SEARCH), less ATTACK_PREROLL: a song started
    there hits on the video's first frame, as an editor's cut does, instead of fading up mid-note. A
    strong onset is a spectral-flux frame 2 standard deviations over the mean (the onset-rate test);
    the attack is found inside that frame's window by `attack_in`. t unchanged when there is none."""
    if not len(env) or env.std() <= 0:
        return t
    frame_t = np.flatnonzero(env > env.mean() + 2 * env.std()) * ONSET_HOP / sr
    for f in frame_t[(frame_t >= t - ONSET_FFT / sr) & (frame_t <= t + ATTACK_SEARCH)]:
        a = attack_in(mono, sr, f - 0.02, f + 2 * ONSET_FFT / sr)
        if a is not None and a >= t - 0.02:
            return max(0.0, round(float(a) - ATTACK_PREROLL, 3))
    return t


def mood_of(energy: str, brightness: str, dynamic: bool, bpm) -> str:
    """One plain mood word from the measured sound, for matching a song to a video's tone."""
    if energy == "energetic":
        return "hype" if brightness == "bright" or (bpm or 0) >= 125 else "driving"
    if energy == "medium":
        return "upbeat" if brightness == "bright" else ("dramatic" if dynamic else "steady groove")
    if brightness == "dark":
        return "melancholic"
    return "dreamy" if dynamic else ("gentle" if brightness == "warm" else "light")


def analyze_track(path, ctx=None) -> dict:
    """What the AI needs to choose a song and where to start it.

    {duration, integratedLUFS, leadSilence, curve: [[t, LUFS] per 5 s], arrivals: [...],
     bpm, beats: [...], beatConfidence, energy: "calm"|"medium"|"energetic", tags: [...],
     suggestedStartAt}"""
    path = Path(path)
    if not path.exists():
        raise EngineError("MUSIC_MISSING", f"not found: {path}", "I can't find that song. It may have been moved.")
    info = probe(path, ctx)
    if not info["has_audio"]:
        raise EngineError("NO_AUDIO", f"{path.name} has no audio", "This file has no sound in it.")
    sr = 22050
    x = decode(path, ctx, sr=sr, ch=2)
    mono = x.mean(axis=1)
    I = integrated(x, sr)
    # lead silence: first 50 ms block above -50 dBFS RMS
    blk = int(0.05 * sr)
    rms = np.sqrt(np.convolve(mono ** 2, np.ones(blk) / blk, mode="valid")[::blk] + 1e-12)
    loud = np.flatnonzero(20 * np.log10(rms) > -50)
    lead = round(float(loud[0] * 0.05), 3) if len(loud) else 0.0
    st = lufs(block_power(x, sr, 3.0, 1.0))
    window = 5.0
    curve = []
    for k in range(0, len(st), int(window)):
        seg = st[k: k + int(window)]
        curve.append([float(k), round(float(np.mean(np.maximum(seg, -60.0))), 1)])
    arrivals = find_arrivals(curve, window)
    hop = ONSET_HOP
    env = _onset_envelope(mono.astype(np.float32), sr, ONSET_FFT, hop)
    bpm, beats, conf = _tempo_and_beats(env, sr / hop)
    beats = [b for b in beats if b < len(mono) / sr]
    onset_rate = float((env > env.mean() + 2 * env.std()).mean() * sr / hop) if len(env) else 0.0
    spec = np.abs(np.fft.rfft(mono[: sr * 60] if len(mono) > sr * 60 else mono))
    freqs = np.fft.rfftfreq(min(len(mono), sr * 60), 1 / sr)
    centroid = float((spec * freqs).sum() / (spec.sum() + 1e-9))
    stv = st[st > -60]
    dyn = float(np.percentile(stv, 90) - np.percentile(stv, 10)) if len(stv) else 0.0
    score = 0.0
    score += 1.0 if (bpm or 0) >= 115 else (0.5 if (bpm or 0) >= 90 else 0.0)
    score += 1.0 if onset_rate >= 2.0 else (0.5 if onset_rate >= 1.0 else 0.0)
    score += 1.0 if I >= -11 else (0.5 if I >= -16 else 0.0)
    energy = "energetic" if score >= 2.0 else ("medium" if score >= 1.0 else "calm")
    # Soft, dark material (solo piano, strings, a sad theme) is calm whatever the tempo/onset guess
    # says: the beat tracker reads piano arpeggios as 90-150 bpm, which made them "medium" and
    # labelled them "dramatic" or "steady groove", so a rant could be scored with a lullaby.
    if energy != "energetic" and (I < -24 or (centroid < 900 and (I < -15 or dyn >= 15))):
        energy = "calm"
    tags = [energy, "bright" if centroid > 2200 else "dark" if centroid < 1200 else "warm",
            "builds" if arrivals and max(a["riseDb"] for a in arrivals) >= 6 else "steady"]
    if dyn >= 12:
        tags.append("dynamic")
    # where to start: a quiet bar before the biggest arrival (so the video has somewhere to build to),
    # else just after the lead silence; then on that bar's first attack, not wherever the bar begins
    start = lead
    if arrivals:
        big = max(arrivals, key=lambda a: a["riseDb"])
        quiet = [t for t, v in curve if t < big["at"] and v <= big["fromLUFS"] + 1.0]
        if quiet:
            start = max(lead, float(quiet[-1]))
    start = attack_at(mono, sr, env, start)
    return {"path": str(path), "duration": round(info["duration"], 2), "integratedLUFS": round(I, 1),
            "leadSilence": lead, "curve": curve, "arrivals": arrivals, "bpm": bpm, "beats": beats,
            "beatConfidence": conf, "onsetRate": round(onset_rate, 2), "spectralCentroid": round(centroid),
            "dynamicRangeDb": round(dyn, 1), "energy": energy, "tags": tags,
            "mood": mood_of(energy, tags[1], dyn >= 12, bpm),
            "suggestedStartAt": start}


# Song analysis takes 5-18 s and a song is picked again and again (every video, every note that changes the
# music), so the result is kept on disk, keyed by the file's CONTENT (a copy into the Library, or a rename,
# still hits) and by ANALYSIS_VERSION (defined above; bump it when analyze_track's output changes).
_CACHE_KEEP = 200


def analysis_cache_dir() -> Path:
    """<per-user cache>/music-analysis (assets.cache_dir: REELENGINE_CACHE_DIR overrides)."""
    from . import assets
    return assets.cache_dir() / "music-analysis"


def _content_key(path: Path) -> str:
    h = hashlib.sha256(f"v{ANALYSIS_VERSION}|".encode())
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()[:32]


def analyze_track_cached(path, ctx=None, cache_dir: Optional[Path] = None) -> dict:
    """analyze_track, from the cache when this exact song was analysed before (any path, any run).
    A broken or unwritable cache only costs the time: the song is analysed as if it were new."""
    path = Path(path)
    if not path.exists():
        return analyze_track(path, ctx)          # the friendly MUSIC_MISSING error
    d = cache_dir or analysis_cache_dir()
    try:
        key = _content_key(path)
        hit = d / f"{key}.json"
        if hit.exists():
            r = json.loads(hit.read_text(encoding="utf-8"))
            if "path" in r:
                r["path"] = str(path)            # a copy at another path reports its own
            hit.touch()                          # newest-used survives the pruning
            return r
    except (OSError, ValueError):
        key = None
    r = analyze_track(path, ctx)
    if key:
        try:
            d.mkdir(parents=True, exist_ok=True)
            tmp = d / f"{key}.{id(r)}.part"
            tmp.write_text(json.dumps(r), encoding="utf-8")
            tmp.replace(d / f"{key}.json")
            old = sorted(d.glob("*.json"), key=lambda f: f.stat().st_mtime, reverse=True)[_CACHE_KEEP:]
            for f in old:
                f.unlink(missing_ok=True)
        except OSError:
            pass
    return r


def track_start(mcfg: dict, duration: float, offset: float = 0.0) -> float:
    """Where the mix reads the song for output second `offset`: the song's real start (beats.effective_start,
    the rule the beat grid is read with: a startAt less than a second from the end plays from the top), then
    the window's offset. The rule is applied before the offset, so a preview window plays the song the full
    render plays at that moment."""
    return beatmod.effective_start(float(mcfg.get("startAt", 0.0) or 0.0), duration) + offset


def accent_beats(ctx) -> list[float]:
    """The song's beats on the full output clock, only for projects that request accents: the grid stored in
    music.beats when it was measured on the file that plays (beats.output_grid), so every machine lands accents
    on the same frames; detected here only when there is none (a song swapped by hand, or chosen before grids
    were stored). A b-roll entrance already snapped to that grid (music.onBeat) is on one of these beats, so
    accent_time leaves it where it is (architecture review 4)."""
    from .cut_style import beat_accents_on
    proj = ctx.project or {}
    if not beat_accents_on(proj):
        return []
    mcfg = proj.get("music") or {}
    if not mcfg.get("enabled", True) or not mcfg.get("track"):
        return []
    try:
        # the file the mix plays (the frozen copy, song_ref), never the Library song it was copied from,
        # which may since have been replaced or deleted (audit 11)
        path = resolve_asset(ctx, song_ref(mcfg))
        stored = beatmod.output_grid(proj, path)
        if stored:
            return [t for t in stored if t < ctx.duration]
        stat = path.stat()
        key = (str(path), stat.st_size, stat.st_mtime_ns)
        cached = getattr(ctx, "_accent_analysis", None)
        if cached is None or cached[0] != key:
            info = analyze_track_cached(path, ctx)
            cached = (key, info["beats"], probe(path, ctx)["duration"])
            ctx._accent_analysis = cached
        _, beats, duration = cached
    except (EngineError, OSError, ValueError) as exc:
        log(f"# beat accents skipped: {exc}")
        return []
    # Preview windows slice the full audio mix, so their beats use this same full-cut clock.
    start = track_start(mcfg, duration)
    return [b - start for b in beats if 0 <= b - start < ctx.duration]


def snap_to_beat(t: float, beats: list[float], max_shift: float = BEAT_MAX_SHIFT) -> float:
    """Nearest beat within max_shift seconds, else t unchanged."""
    if not beats:
        return t
    b = min(beats, key=lambda x: abs(x - t))
    return b if abs(b - t) <= max_shift else t


def accent_time(ctx, t: float, earliest: float = 0.0, *, previous: Optional[float] = None,
                following: Optional[float] = None, min_gap: float = 0.0) -> float:
    """Snap an accent to a beat on the frame grid without exceeding its timing bounds."""
    beat = snap_to_beat(t, accent_beats(ctx))
    if beat == t:
        requests = getattr(ctx, "_lint_snap_requests", None)
        if requests is not None and t in accent_beats(ctx):
            row = {"original": t, "snapped": t}
            if row not in requests:
                requests.append(row)
        return t
    fps = fmt_of(ctx)[2]
    snapped = round(beat * fps) / fps
    # Frame rounding must preserve both the card lead and the 120 ms limit, including an SFX
    # tied to a b-roll start whose original time was already rounded onto the frame grid.
    if (snapped < earliest or snapped >= ctx.duration or abs(snapped - t) > BEAT_MAX_SHIFT
            or abs(snapped - round(t * fps) / fps) > BEAT_MAX_SHIFT):
        return t
    from .lint_edit import snap_crosses
    events = getattr(ctx, "_lint_events", [s.out_start for s in ctx.out_timeline[1:]])
    requests = getattr(ctx, "_lint_snap_requests", None)
    if requests is not None:
        row = {"original": t, "snapped": snapped, "previous": previous, "following": following, "min_gap": min_gap}
        if row not in requests:
            requests.append(row)
    if ((previous is not None and snapped - previous <= min_gap)
            or (following is not None and following - snapped <= min_gap)):
        return t
    # A boundary belongs to the incoming shot: landing on it is a forward crossing.
    for segment in ctx.out_timeline:
        cut = round(segment.out_start * fps) / fps
        if t < cut <= snapped or snapped < cut <= t:
            return t
    if snap_crosses(t, snapped, events):
        return t
    return snapped


def main(argv=None) -> int:
    """python -m reelengine.music analyze <file>   -> JSON lines (docs/architecture.md section 4)."""
    import argparse
    ap = argparse.ArgumentParser(prog="python -m reelengine.music")
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("analyze")
    a.add_argument("file")
    a.add_argument("--no-beats", action="store_true", help="omit the beat list from the output")
    m = sub.add_parser("measure")
    m.add_argument("file")
    args = ap.parse_args(argv)
    try:
        if args.cmd == "analyze":
            r = analyze_track(args.file)
            if args.no_beats:
                r.pop("beats", None)
        else:
            r = ffmpeg_measure(Path(args.file))
        print(json.dumps({"event": "done", "result": r}))
        return 0
    except EngineError as e:
        print(json.dumps(e.to_event()))
        return 1


if __name__ == "__main__":
    sys.exit(main())
