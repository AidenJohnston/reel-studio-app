"""Punch-in zooms on the talking head (docs/architecture.md section 5): project.zooms -> [ZoomSpan].

A zoom moves the footage itself (cards and captions never zoom). Ported from the original
pipeline's zooms.py, keeping its rules:
  * a zoom lands ON its word (no lead: a card leads its phrase, a zoom does not) and spans the
    whole line from its first word to the end of its last word
  * the centre is the speaker's face (slightly above its middle, so the eyes stay high), clamped so
    the magnified frame never shows past the edge of the picture
  * release invisibly: if a zoom would end while a face-hiding b-roll is up, it holds until that
    b-roll's exit cut instead of visibly snapping back
  * zooms never overlap: a later zoom cuts the earlier one short (a hard punch to the new framing)

`style: "snap"` eases the punch in and the release back out instead of cutting. Motion never runs
across a cut: a release that would is made on the cut instead, the way a b-roll exit hides one.

A1's render applies each span as a crop-and-scale of the cut video about (cx, cy).
"""
from __future__ import annotations

import math

from .compose_util import fmt_of, log, word_end, word_start

try:
    from .render_ctx import ZoomSpan
except ImportError:  # pragma: no cover
    from dataclasses import dataclass

    @dataclass
    class ZoomSpan:  # type: ignore[no-redef]
        t0: float
        t1: float
        scale: float
        cx: float
        cy: float
        ramp_in: float = 0.0
        ramp_out: float = 0.0

DEFAULT_SCALE = 1.12
MAX_SCALE = 2.0
TAIL = 0.05           # hold a hair past the last word so the release is not on a syllable
EYE_BIAS = 0.12       # centre this fraction of a face-height above the face's middle
SNAP_IN = 0.22        # judged by eye on rendered frames between 0.18 and 0.26 s, no measurement behind it
SNAP_OUT = 0.30       # slower than the punch: the release should not draw the eye
SPRING = 7.0          # stiffness per ramp length, also judged by eye


def punch(u: float) -> float:
    """Ease-out quart: already moving on the word's first frame, settling into the hold."""
    u = min(max(u, 0.0), 1.0)
    return 1 - (1 - u) ** 4


def release(u: float) -> float:
    """A critically damped spring leaving rest (the hold): no jerk at the start, no overshoot or
    wobble at the end. Scaled to land exactly at u = 1."""
    u = min(max(u, 0.0), 1.0)
    return (1 - (1 + SPRING * u) * math.exp(-SPRING * u)) / (1 - (1 + SPRING) * math.exp(-SPRING))


def progress(z, t: float) -> float:
    """How far zoom z is pushed in at output time t: 0 = full frame, 1 = its scale."""
    if z.ramp_in and t < z.t0 + z.ramp_in:
        return punch((t - z.t0) / z.ramp_in)
    if z.ramp_out and t > z.t1 - z.ramp_out:
        return 1.0 - release((t - z.t1 + z.ramp_out) / z.ramp_out)
    return 1.0


def clamp_centre(scale: float, cx: float, cy: float, W: int, H: int) -> tuple[float, float]:
    """Keep the zoomed crop rect (W/scale x H/scale, centred on cx, cy) inside the frame."""
    hw, hh = W / scale / 2, H / scale / 2
    return min(max(cx, hw), W - hw), min(max(cy, hh), H - hh)


def build_zooms(ctx, with_broll: bool = True) -> list:
    """project.zooms -> [ZoomSpan] on the output clock, sorted, non-overlapping."""
    W, H, fps = fmt_of(ctx)
    spans = []
    for i, z in enumerate((ctx.project or {}).get("zooms") or []):
        anc = z.get("anchor") or {}
        a, b = anc.get("from"), anc.get("to") or anc.get("from")
        t0 = word_start(ctx, a) if a else None
        t1 = word_end(ctx, b) if b else None
        if t0 is None or t1 is None:
            log(f"zoom {i}: anchor {a}..{b} is not in the cut; skipped")
            continue
        t1 += TAIL
        scale = min(MAX_SCALE, max(1.0, float(z.get("scale", DEFAULT_SCALE) or DEFAULT_SCALE)))
        if scale <= 1.001 or t1 - t0 < 1.0 / fps:
            continue
        focus = z.get("focus")
        if focus:      # [fx, fy] as fractions of the frame
            cx, cy = float(focus[0]) * W, float(focus[1]) * H
        else:
            from .broll import output_face_union
            fx, fy, fw, fh = output_face_union(ctx, t0, t1)
            cx, cy = fx + fw / 2, fy + fh / 2 - EYE_BIAS * fh
        cx, cy = clamp_centre(scale, cx, cy, W, H)
        ramps = (round(SNAP_IN * fps) / fps, round(SNAP_OUT * fps) / fps) if z.get("style") == "snap" else ()
        spans.append(ZoomSpan(round(t0 * fps) / fps, round(t1 * fps) / fps, scale, round(cx, 1), round(cy, 1),
                              *ramps))
    spans.sort(key=lambda s: s.t0)
    if with_broll and spans:
        try:
            from .broll import FACE_HIDING, plan_windows
            hiding = [(p["t0"], p["t1"]) for p in plan_windows(ctx) if p["treatment"] in FACE_HIDING]
            for s in spans:
                for h0, h1 in hiding:
                    if h0 < s.t1 < h1:          # release would show: hold to the b-roll's exit
                        s.t1, s.ramp_out = h1, 0.0
        except Exception as e:
            log(f"zoom/broll handoff skipped: {e}")
    dur = float(getattr(ctx, "duration", 0.0) or 0.0)
    cuts = [round(seg.out_start * fps) / fps for seg in ctx.out_timeline[1:]]
    out = []
    for k, s in enumerate(spans):
        if k + 1 < len(spans) and s.t1 >= spans[k + 1].t0:
            s.t1, s.ramp_out = spans[k + 1].t0, 0.0
        if dur and s.t1 > dur:
            s.t1, s.ramp_out = dur, 0.0
        if out and out[-1].t1 >= s.t0:
            s.ramp_in = 0.0
        cut = max((c for c in cuts if s.t1 - s.ramp_out < c < s.t1), default=None) if s.ramp_out else None
        if cut is not None:
            # the cut comes after the last word (t1 and the cut each round to a frame: up to one apart)
            if cut > s.t0 and cut >= s.t1 - TAIL - 1.0 / fps - 1e-9:
                s.t1 = cut
            s.ramp_out = 0.0
        if s.ramp_in and (s.t1 - s.t0 < s.ramp_in + 1.0 / fps or any(s.t0 < c < s.t0 + s.ramp_in for c in cuts)):
            s.ramp_in = 0.0
        if s.ramp_out and s.t1 - s.t0 - s.ramp_in - s.ramp_out < s.ramp_in:
            s.ramp_out = 0.0
        if s.t1 - s.t0 >= 1.0 / fps:
            out.append(s)
    return out
