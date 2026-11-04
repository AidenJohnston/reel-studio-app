"""The final check and the preview check: a render against the reference final of the same state.

Final: frame count and timestamps exact, audio packets identical, per-frame PSNR above a floor and
a stricter floor inside the caption band.

Preview (draft, window, still): the reference final scaled to the preview's size and compared
region by region: the caption band strict, everything else loose, the mean color within a bound,
and for video the audio at the same offset with close levels.
"""
from __future__ import annotations

import math
from pathlib import Path
from typing import Optional

from . import compare, media

# Caption boxes are the engine's estimate of the drawn text (captions.render_ass); outlines and
# antialiasing spill past them, so the band is grown by this fraction of each box's height.
BAND_PAD = 0.15
# Level comparison: 100 ms slices, ignoring slices quieter than -45 dBFS (pauses).
LEVEL_WINDOW = 0.1
LEVEL_FLOOR_DB = -45.0
# The offset search spans +-0.5 s: far wider than any plausible slip, small enough to stay unambiguous.
MAX_LAG = 0.5
# A preview's audio may differ in length from the reference stretch by up to two AAC frames (the
# encoder pads the last one); more than that is missing or extra sound.
AUDIO_LENGTH_SLACK = 2048


class Tally:
    """Running min/max of per-frame metrics and where the worst frame was."""

    def __init__(self):
        self.mins: dict = {}
        self.maxs: dict = {}
        self.where: dict = {}

    def add(self, t: float, m: dict) -> None:
        for k in ("captionPsnr", "otherPsnr", "framePsnr"):
            if m[k] < self.mins.get(k, math.inf):
                self.mins[k], self.where[k] = m[k], t
        if m["meanColorDelta"] >= self.maxs.get("meanColorDelta", -1.0):
            self.maxs["meanColorDelta"], self.where["meanColorDelta"] = m["meanColorDelta"], t


def _num(x: float):
    return None if x is None else ("inf" if x == math.inf else round(x, 3))


def _result(rows: list, failures: list, extra: dict) -> dict:
    statuses = [r[2] for r in rows]
    status = "fail" if failures or "fail" in statuses else ("unset" if "unset" in statuses else "pass")
    return {"status": status, "failures": failures,
            "metrics": {name: {"value": _num(v), "status": s, **({"at": round(t, 3)} if t is not None else {})}
                        for name, v, s, t in rows}, **extra}


def _band(captions: list, w: int, h: int, scale: float):
    return compare.caption_band((c["box"] for c in captions), w, h, scale=scale, pad=BAND_PAD)


def check_final(ffmpeg: str, ffprobe: str, ref: Path, cand: Path, captions: list, th: dict) -> dict:
    failures = []
    rp, cp = media.video_pts(ffprobe, ref), media.video_pts(ffprobe, cand)
    why = compare.timestamps_match(rp, cp, tol=1e-6)
    if why:
        failures.append(f"timestamps: {why}")
    if media.audio_packets_md5(ffmpeg, ref) != media.audio_packets_md5(ffmpeg, cand):
        failures.append("audio packets differ")
    elif media.audio_timing(ffprobe, ref) != media.audio_timing(ffprobe, cand):
        failures.append("audio packets are identical but play at different times")
    w, h = media.video_size(ffprobe, ref)
    if media.video_size(ffprobe, cand) != (w, h):
        failures.append(f"size {media.video_size(ffprobe, cand)} != reference {(w, h)}")
        return _result([], failures, {})
    band = _band(captions, w, h, 1.0)
    tally = Tally()
    for i, (a, b) in enumerate(zip(media.iter_frames(ffmpeg, ref, w, h), media.iter_frames(ffmpeg, cand, w, h))):
        tally.add(rp[i] if i < len(rp) else i, compare.frame_metrics(a, b, band))
    rows = [("framePsnr", tally.mins.get("framePsnr"), compare.verdict(tally.mins.get("framePsnr", math.inf), th.get("psnrMinDb")), tally.where.get("framePsnr")),
            ("captionPsnr", tally.mins.get("captionPsnr"), compare.verdict(tally.mins.get("captionPsnr", math.inf), th.get("captionPsnrMinDb")), tally.where.get("captionPsnr"))]
    return _result(rows, failures, {})


def _preview_rows(tally: Tally, th: dict) -> list:
    g = tally.mins.get
    return [("captionPsnr", g("captionPsnr"), compare.verdict(g("captionPsnr", math.inf), th.get("captionPsnrMinDb")), tally.where.get("captionPsnr")),
            ("otherPsnr", g("otherPsnr"), compare.verdict(g("otherPsnr", math.inf), th.get("otherPsnrMinDb")), tally.where.get("otherPsnr")),
            ("meanColorDelta", tally.maxs.get("meanColorDelta"),
             compare.verdict(tally.maxs.get("meanColorDelta", 0.0), maximum=th.get("meanColorMaxDelta")),
             tally.where.get("meanColorDelta"))]


def check_preview_video(ffmpeg: str, ffprobe: str, ref: Path, cand: Path, captions: list, th: dict,
                        fps: float, start: float = 0.0, end: float = math.inf) -> dict:
    """A draft (all of the reference) or a window (the reference's output seconds [start, end))
    against the reference. The range comes from the request, not the candidate, so a short output
    fails the frame count."""
    failures = []
    w, h = media.video_size(ffprobe, cand)
    rp_all = media.video_pts(ffprobe, ref)
    cp = media.video_pts(ffprobe, cand)
    eps = 1e-6
    picked = [i for i, t in enumerate(rp_all) if start - eps <= t < end - eps]
    why = compare.timestamps_match([rp_all[i] - start for i in picked], cp, tol=0.5 / fps)
    if why:
        failures.append(f"timestamps: {why}")
    band = _band(captions, w, h, w / media.video_size(ffprobe, ref)[0])
    tally = Tally()
    want = set(picked)
    cand_frames = media.iter_frames(ffmpeg, cand, w, h)
    for i, a in enumerate(media.iter_frames(ffmpeg, ref, w, h)):
        if i not in want:
            continue
        b = next(cand_frames, None)
        if b is None:
            break
        tally.add(rp_all[i], compare.frame_metrics(a, b, band))
    rows = _preview_rows(tally, th)
    ra = media.audio_mono(ffmpeg, ref, start=start, duration=len(picked) / fps)
    ca = media.audio_mono(ffmpeg, cand)
    if abs(len(ca) - len(ra)) > AUDIO_LENGTH_SLACK:
        failures.append(f"audio is {len(ca) / media.AUDIO_RATE:.3f}s, reference stretch {len(ra) / media.AUDIO_RATE:.3f}s")
    off_ms = 1000.0 * compare.audio_offset(ra, ca, media.AUDIO_RATE, MAX_LAG)
    lvl = compare.level_delta_db(ra, ca, media.AUDIO_RATE, LEVEL_WINDOW, LEVEL_FLOOR_DB)
    rows += [("audioOffsetMs", abs(off_ms), compare.verdict(abs(off_ms), maximum=th.get("audioOffsetMaxMs")), None),
             ("audioLevelDb", lvl, compare.verdict(lvl, maximum=th.get("audioLevelMaxDb")), None)]
    return _result(rows, failures, {"size": [w, h], "frames": len(cp)})


def check_still(ffmpeg: str, ffprobe: str, ref: Path, png: Path, t: float, captions: list, th: dict) -> dict:
    """One still `frames --times t` made: the first reference frame at or after t (what ffmpeg's
    accurate input seek in frames.py returns), scaled to the still's size."""
    b = media.read_image(png)
    h, w = b.shape[:2]
    rp = media.video_pts(ffprobe, ref)
    idx = next((i for i, x in enumerate(rp) if x >= t - 1e-6), len(rp) - 1)
    a: Optional[object] = None
    for i, fr in enumerate(media.iter_frames(ffmpeg, ref, w, h)):
        if i == idx:
            a = fr
            break
    tally = Tally()
    tally.add(rp[idx], compare.frame_metrics(a, b, _band(captions, w, h, w / media.video_size(ffprobe, ref)[0])))
    return _result(_preview_rows(tally, th), [], {"size": [w, h]})
