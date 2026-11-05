"""The harness's pass/fail arithmetic. Pure functions over numpy arrays: no ffmpeg, no files.

Frames are uint8 RGB arrays shaped (height, width, 3). Audio is float mono in [-1, 1].
Thresholds are passed in; config.json holds the values and whether a person approved them.
"""
from __future__ import annotations

import math
from typing import Iterable, Optional, Sequence

import numpy as np

PEAK = 255.0


def psnr(a: np.ndarray, b: np.ndarray, mask: Optional[np.ndarray] = None) -> float:
    """Peak signal-to-noise ratio in dB over the pixels where `mask` is True (all pixels if None).
    Identical pixels give +inf. An empty mask gives +inf: nothing there can differ."""
    if a.shape != b.shape:
        raise ValueError(f"frame sizes differ: {a.shape} vs {b.shape}")
    d = a.astype(np.float64) - b.astype(np.float64)
    if mask is not None:
        if mask.shape != a.shape[:2]:
            raise ValueError(f"mask {mask.shape} does not match frame {a.shape[:2]}")
        d = d[mask]
    if d.size == 0:
        return math.inf
    mse = float(np.mean(d * d))
    return math.inf if mse == 0.0 else 10.0 * math.log10(PEAK * PEAK / mse)


def caption_band(boxes: Iterable[Sequence[float]], frame_w: int, frame_h: int, scale: float = 1.0,
                 pad: float = 0.0) -> np.ndarray:
    """Boolean mask of the union of caption boxes [x, y, w, h] (in full-size output pixels),
    scaled by `scale` to the frame being checked and grown by `pad` (a fraction of the box height).

    The union over ALL of a render's cues is applied to every frame, not each cue to its own
    frames: a caption drawn where the reference has none for that moment (a regrouped line, a cue
    that starts early) then lands inside the strict region too."""
    mask = np.zeros((frame_h, frame_w), dtype=bool)
    for x, y, w, h in boxes:
        g = pad * h
        x0 = max(0, int(math.floor((x - g) * scale)))
        y0 = max(0, int(math.floor((y - g) * scale)))
        x1 = min(frame_w, int(math.ceil((x + w + g) * scale)))
        y1 = min(frame_h, int(math.ceil((y + h + g) * scale)))
        if x1 > x0 and y1 > y0:
            mask[y0:y1, x0:x1] = True
    return mask


def mean_color_delta(a: np.ndarray, b: np.ndarray) -> float:
    """Largest per-channel difference of the frame means, in 8-bit levels. Catches a draft that is
    darker or tinted relative to the final even when its detail is close."""
    if a.shape != b.shape:
        raise ValueError(f"frame sizes differ: {a.shape} vs {b.shape}")
    ma = a.reshape(-1, a.shape[-1]).astype(np.float64).mean(axis=0)
    mb = b.reshape(-1, b.shape[-1]).astype(np.float64).mean(axis=0)
    return float(np.max(np.abs(ma - mb)))


def _psnr_from(sse: float, samples: int) -> float:
    return math.inf if samples == 0 or sse == 0 else 10.0 * math.log10(PEAK * PEAK * samples / sse)


def frame_metrics(ref: np.ndarray, cand: np.ndarray, band: np.ndarray) -> dict:
    """The per-frame numbers both checks use. Same values as psnr() over the band, outside it and
    over the frame, from one pass of squared differences (the checks run this on every frame)."""
    if ref.shape != cand.shape:
        raise ValueError(f"frame sizes differ: {ref.shape} vs {cand.shape}")
    if np.array_equal(ref, cand):
        return {"captionPsnr": math.inf, "otherPsnr": math.inf, "framePsnr": math.inf, "meanColorDelta": 0.0}
    d = ref.astype(np.int32) - cand.astype(np.int32)
    per_px = np.einsum("ijk,ijk->ij", d, d)              # squared error summed over the channels
    total = float(per_px.sum())
    inside = float(per_px[band].sum())
    ch = ref.shape[2]
    n_in = int(band.sum()) * ch
    n_all = per_px.size * ch
    return {"captionPsnr": _psnr_from(inside, n_in), "otherPsnr": _psnr_from(total - inside, n_all - n_in),
            "framePsnr": _psnr_from(total, n_all), "meanColorDelta": mean_color_delta(ref, cand)}


def timestamps_match(ref: Sequence[float], cand: Sequence[float], tol: float) -> Optional[str]:
    """None when both lists have the same length and every pair is within `tol` seconds; else a
    one-line reason naming the first difference."""
    if len(ref) != len(cand):
        return f"frame count {len(cand)} != reference {len(ref)}"
    for i, (r, c) in enumerate(zip(ref, cand)):
        if abs(r - c) > tol:
            return f"frame {i} at {c:.6f}s, reference {r:.6f}s"
    return None


def audio_offset(ref: np.ndarray, cand: np.ndarray, rate: int, max_lag: float) -> float:
    """Seconds by which `cand` lags `ref` (positive = cand is late), from the peak of their
    cross-correlation within +-max_lag seconds."""
    n = min(len(ref), len(cand))
    if n == 0:
        raise ValueError("no audio to compare")
    r = ref[:n].astype(np.float64)
    c = cand[:n].astype(np.float64)
    size = 1 << int(math.ceil(math.log2(2 * n)))
    xc = np.fft.irfft(np.fft.rfft(c, size) * np.conj(np.fft.rfft(r, size)), size)
    lim = min(n - 1, int(round(max_lag * rate)))
    lags = np.concatenate([np.arange(0, lim + 1), np.arange(-lim, 0)])
    vals = np.concatenate([xc[:lim + 1], xc[size - lim:]]) if lim else xc[:1]
    return float(lags[int(np.argmax(vals))]) / rate


def level_delta_db(ref: np.ndarray, cand: np.ndarray, rate: int, window: float, floor_db: float) -> float:
    """Largest difference in RMS level (dB) between matching `window`-second slices (the last one
    may be shorter), over slices where the reference is louder than `floor_db` dBFS: a pause has no
    meaningful level. 0.0 when no slice is loud enough. Lengths are checked separately."""
    step = max(1, int(round(window * rate)))
    n = min(len(ref), len(cand))
    if n == 0:
        return 0.0
    edges = list(range(0, n, step)) + [n]

    def db(x: np.ndarray) -> np.ndarray:
        x = x.astype(np.float64)
        rms = np.array([np.sqrt(np.mean(x[a:b] ** 2)) for a, b in zip(edges, edges[1:])])
        return 20.0 * np.log10(np.maximum(rms, 1e-10))

    r, c = db(ref), db(cand)
    loud = r > floor_db
    return float(np.max(np.abs(r[loud] - c[loud]))) if loud.any() else 0.0


def verdict(value: float, minimum: Optional[float] = None, maximum: Optional[float] = None) -> str:
    """"pass" / "fail" against whichever bound is given, "unset" when the bound is not configured."""
    bound = minimum if minimum is not None else maximum
    if bound is None:
        return "unset"
    ok = value >= minimum if minimum is not None else value <= maximum
    return "pass" if ok else "fail"
