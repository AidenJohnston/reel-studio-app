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

A1's render applies each span as a crop-and-scale of the cut video about (cx, cy).
"""
from __future__ import annotations

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

DEFAULT_SCALE = 1.12
MAX_SCALE = 2.0
TAIL = 0.05           # hold a hair past the last word so the release is not on a syllable
EYE_BIAS = 0.12       # centre this fraction of a face-height above the face's middle


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
        spans.append(ZoomSpan(round(t0 * fps) / fps, round(t1 * fps) / fps, scale, round(cx, 1), round(cy, 1)))
    spans.sort(key=lambda s: s.t0)
    if with_broll and spans:
        try:
            from .broll import FACE_HIDING, plan_windows
            hiding = [(p["t0"], p["t1"]) for p in plan_windows(ctx) if p["treatment"] in FACE_HIDING]
            for s in spans:
                for h0, h1 in hiding:
                    if h0 < s.t1 < h1:          # release would show: hold to the b-roll's exit
                        s.t1 = h1
        except Exception as e:
            log(f"zoom/broll handoff skipped: {e}")
    dur = float(getattr(ctx, "duration", 0.0) or 0.0)
    out = []
    for k, s in enumerate(spans):
        if k + 1 < len(spans) and s.t1 > spans[k + 1].t0:
            s.t1 = spans[k + 1].t0
        if dur:
            s.t1 = min(s.t1, dur)
        if s.t1 - s.t0 >= 1.0 / fps:
            out.append(s)
    return out
