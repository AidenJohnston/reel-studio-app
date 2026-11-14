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
  * with music.onBeat "zooms", the punch-in lands on the nearest beat up to BEAT_EARLY before its
    word or BEAT_LATE after it (beats.py)

`style: "snap"` eases the punch in and the release back out instead of cutting. Motion never runs
across a cut: a release that would is made on the cut instead, the way a b-roll exit hides one.
A snap that would sweep the face across the frame (MAX_FACE_DRIFT) punches in hard instead.

A1's render applies each span as a crop-and-scale of the cut video about (cx, cy).
"""
from __future__ import annotations

import math
from dataclasses import dataclass

from . import beats
from .compose_util import fmt_of, log, word_end, word_start

try:
    from .render_ctx import ZoomSpan
except ImportError:  # pragma: no cover
    @dataclass
    class ZoomSpan:  # type: ignore[no-redef]
        t0: float
        t1: float
        scale: float
        cx: float
        cy: float
        ramp_in: int = 0
        ramp_out: int = 0
        last_word_end: float = 0.0
        kind: str = "punch"
        blur: bool = False

DEFAULT_SCALE = 1.12
# Preset scales are starting choices; no output-quality comparison supports them yet.
from .cut_style import CUT_STYLES
NAMED_SCALES = {name: spec["framingPair"][1] for name, spec in CUT_STYLES.items()}
MAX_SCALE = 2.0
TAIL = 0.05           # hold a hair past the last word so the release is not on a syllable
EYE_BIAS = 0.12       # centre this fraction of a face-height above the face's middle
BEAT_EARLY = 0.15     # a zoom on the beat may punch in this much before its word...
BEAT_LATE = 0.06      # ...or this much after it (later reads as a missed hit)
SNAP_IN = 0.22        # judged by eye on rendered frames between 0.18 and 0.26 s, no measurement behind it
SNAP_OUT = 0.30       # slower than the punch: the release should not draw the eye
SPRING = 7.0          # stiffness per ramp length, also judged by eye
# How far a snap may carry the eyes across the frame, as a fraction of its width; past it the zoom
# punches in hard. On a real night take at scale 1.15 (1080 px wide), a fixed point on the frame's
# side moved the eyes about 90 px and read as a quick dolly-in; one in the top corner moved them
# about 170 px, streaked them diagonally and read as a tilt. Nothing in between was checked.
MAX_FACE_DRIFT = 0.09


def punch(u: float) -> float:
    """Ease-out quart: already moving on the word's first frame, settling into the hold."""
    u = min(max(u, 0.0), 1.0)
    return 1 - (1 - u) ** 4


def release(u: float) -> float:
    """A critically damped spring leaving rest (the hold): no jerk at the start, no overshoot or
    wobble at the end. Scaled to land exactly at u = 1."""
    u = min(max(u, 0.0), 1.0)
    return (1 - (1 + SPRING * u) * math.exp(-SPRING * u)) / (1 - (1 + SPRING) * math.exp(-SPRING))


def progress(z, t: float, fps: float = 30) -> float:
    """How far zoom z is pushed in at output time t: 0 = full frame, 1 = its scale."""
    ramp_in, ramp_out = z.ramp_in / fps, z.ramp_out / fps
    if ramp_in and t < z.t0 + ramp_in:
        return punch((t - z.t0) / ramp_in)
    if ramp_out and t > z.t1 - ramp_out:
        curve = release if z.blur else punch
        return 1.0 - curve((t - z.t1 + ramp_out) / ramp_out)
    return 1.0


def clamp_centre(scale: float, cx: float, cy: float, W: int, H: int) -> tuple[float, float]:
    """Keep the zoomed crop rect (W/scale x H/scale, centred on cx, cy) inside the frame."""
    hw, hh = W / scale / 2, H / scale / 2
    return min(max(cx, hw), W - hw), min(max(cy, hh), H - hh)


def face_drift(scale: float, cx: float, cy: float, eyes: tuple, W: int, H: int) -> float:
    """Output pixels the eyes travel while a zoom about (cx, cy) pushes in from full frame.

    Every crop between the full frame and the zoom's shares one fixed point, the point the picture
    grows out of (render._snap_chain). It sits scale / (scale - 1) times as far from the frame's
    centre as (cx, cy) does, 7.7x at scale 1.15, so a face only a little high and off centre puts it
    in a corner. A point at distance r from it travels (scale - 1) * r."""
    k = scale / (scale - 1)
    fx, fy = W / 2 + k * (cx - W / 2), H / 2 + k * (cy - H / 2)
    return (scale - 1) * math.hypot(eyes[0] - fx, eyes[1] - fy)


def _anchored(ctx, fps: float):
    """(index, t0, t1, scale, kind, last word's end) for every zoom that draws, before the spans meet
    each other: from its first word to the end of its last word plus TAIL, on the output clock, unrounded."""
    grid = beats.ctx_synced(ctx, "zooms")
    for i, z in enumerate((ctx.project or {}).get("zooms") or []):
        anc = z.get("anchor") or {}
        a, b = anc.get("from"), anc.get("to") or anc.get("from")
        t0 = word_start(ctx, a) if a else None
        t1 = word_end(ctx, b) if b else None
        if t0 is None or t1 is None:
            log(f"zoom {i}: anchor {a}..{b} is not in the cut; skipped")
            continue
        last_word_end = t1
        t1 += TAIL
        t0 = beats.snap(t0, grid, BEAT_EARLY, BEAT_LATE)
        raw_kind = z.get("kind")
        kind = raw_kind if raw_kind in {"punch", "snap", "drift"} else ("snap" if z.get("style") == "snap" else "punch")
        cut_style = (ctx.project or {}).get("cutStyle")
        preset = cut_style.get("preset") if isinstance(cut_style, dict) and isinstance(cut_style.get("preset"), str) else None
        named_default = NAMED_SCALES.get(preset or "standard", 1.15)
        default_scale = named_default if raw_kind in {"punch", "snap", "drift"} else DEFAULT_SCALE
        scale = min(MAX_SCALE, max(1.0, float(z.get("scale", default_scale) or default_scale)))
        if scale <= 1.001 or t1 - t0 < 1.0 / fps:
            continue
        yield i, t0, t1, scale, kind, last_word_end


def _centre(ctx, z: dict, kind: str, scale: float, t0: float, t1: float, W: int, H: int) -> tuple:
    """(cx, cy, snaps): the zoom's centre, and whether it eases in and out. A snap whose fixed point
    would sweep the face across the frame (MAX_FACE_DRIFT) punches in hard instead."""
    focus = z.get("focus")
    snap = kind == "snap"
    eyes = None
    if snap or not focus:
        from .broll import output_face_union
        fx, fy, fw, fh = output_face_union(ctx, t0, t1)
        eyes = (fx + fw / 2, fy + fh / 2 - EYE_BIAS * fh)
    if focus:      # [fx, fy] as fractions of the frame
        cx, cy = float(focus[0]) * W, float(focus[1]) * H
    else:
        cx, cy = eyes
    cx, cy = clamp_centre(scale, cx, cy, W, H)
    if snap and face_drift(scale, cx, cy, eyes, W, H) > MAX_FACE_DRIFT * W:
        snap = False
    return cx, cy, snap


def _ramps(z: dict, kind: str, snap: bool, fps: float) -> tuple:
    if kind == "drift":
        return (0, 0)  # resolved after overlap, b-roll and duration clipping
    return (z.get("resolvedRampFrames", round(SNAP_IN * fps)), round(SNAP_OUT * fps)) if snap else ()


def _settle(ctx, spans: list, with_broll: bool, W: int, H: int, fps: float) -> list:
    """Sorts the spans and applies the rules between them: hold under a face-hiding b-roll, a later
    zoom cuts an earlier one short, no motion across a cut, nothing past the end; then the variation's
    static framing between them."""
    spans.sort(key=lambda s: s.t0)
    if with_broll and spans:
        try:
            from .broll import FACE_HIDING, plan_windows
            hiding = [(p["t0"], p["t1"]) for p in plan_windows(ctx) if p["treatment"] in FACE_HIDING]
            for s in spans:
                for h0, h1 in hiding:
                    if h0 < s.t1 < h1:          # release would show: hold to the b-roll's exit
                        s.t1, s.ramp_out = h1, 0
        except Exception as e:
            log(f"zoom/broll handoff skipped: {e}")
    dur = float(getattr(ctx, "duration", 0.0) or 0.0)
    cuts = {round(seg.out_start * fps) / fps: seg.out_start for seg in ctx.out_timeline[1:]}
    out = []
    for k, s in enumerate(spans):
        if k + 1 < len(spans) and s.t1 >= spans[k + 1].t0:
            s.t1, s.ramp_out = spans[k + 1].t0, 0
        if dur and s.t1 > dur:
            s.t1, s.ramp_out = dur, 0
        if out and out[-1].t1 >= s.t0:
            s.ramp_in = 0
        cut = max((c for c in cuts if s.t1 - s.ramp_out / fps < c < s.t1), default=None) if s.ramp_out else None
        if cut is not None:
            # Compare unrounded times: frame rounding can put the cut before a short last word ends.
            if cut > s.t0 and cuts[cut] >= s.last_word_end - 1e-9:
                s.t1 = cut
            s.ramp_out = 0
        if s.ramp_in and any(s.t0 < c < s.t0 + s.ramp_in / fps for c in cuts):
            s.ramp_in = 0
        if s.ramp_out and s.t1 - s.t0 - s.ramp_in / fps - s.ramp_out / fps < s.ramp_in / fps and s.t1 - s.t0 >= (s.ramp_in + s.ramp_out) / fps:
            s.ramp_out = 0
        if s.kind == "drift":
            # Include both endpoints so the last visible frame reaches the target scale.
            s.ramp_in = max(0, round(s.t1 * fps) - round(s.t0 * fps) - 1)
            s.ramp_out = 0
        if s.t1 - s.t0 >= 1.0 / fps:
            out.append(s)
    decisions = getattr(ctx, "variation", None)
    if decisions:
        # Keep each authored motion span intact; split only the static background.
        resolved = list(out)
        for base in decisions["framing"]:
            boundaries = sorted({base["t0"], base["t1"], *(max(base["t0"], min(base["t1"], t)) for z in out for t in (z.t0, z.t1))})
            for a, b in zip(boundaries, boundaries[1:]):
                if base["scale"] <= 1.001 or any(z.t0 < b and z.t1 > a for z in out):
                    continue
                from .broll import output_face_union
                fx, fy, fw, fh = output_face_union(ctx, a, b)
                cx, cy = clamp_centre(base["scale"], fx + fw / 2, fy + fh / 2 - EYE_BIAS * fh, W, H)
                resolved.append(ZoomSpan(a, b, base["scale"], cx, cy))
        return sorted(resolved, key=lambda z: z.t0)
    return out


def build_zooms(ctx, with_broll: bool = True) -> list:
    """project.zooms -> [ZoomSpan] on the output clock, sorted, non-overlapping."""
    W, H, fps = fmt_of(ctx)
    spans = []
    for i, t0, t1, scale, kind, last_word_end in _anchored(ctx, fps):
        z = ctx.project["zooms"][i]
        cx, cy, snap = _centre(ctx, z, kind, scale, t0, t1, W, H)
        if kind == "snap" and not snap:
            log(f"zoom {i}: its fixed point is too far from the face to snap; punching in hard")
        spans.append(ZoomSpan(round(t0 * fps) / fps, round(t1 * fps) / fps, scale, round(cx, 1), round(cy, 1),
                              *_ramps(z, kind, snap, fps), last_word_end=last_word_end, kind=kind, blur=snap))
    return _settle(ctx, spans, with_broll, W, H, fps)


def framed_over(ctx) -> dict:
    """{index into project.zooms: (t0, t1)}: the span each zoom's framing reads the face over (build_zooms
    centres it on the face across its anchored span, before a later zoom cuts it short)."""
    _W, _H, fps = fmt_of(ctx)
    return {i: (t0, t1) for i, t0, t1, *_rest in _anchored(ctx, fps)}


def windows(ctx, with_broll: bool = True) -> list:
    """[(index into project.zooms, t0, t1)] for each zoom on screen, with build_zooms' timing: what
    moments.py compares between two edits. Only a snap reads the face track here, since whether the
    face lets it snap decides whether its release moves onto a cut; the variation's static framing
    is left out (it belongs to no zoom of the project)."""
    W, H, fps = fmt_of(ctx)
    spans, index = [], {}
    for i, t0, t1, scale, kind, last_word_end in _anchored(ctx, fps):
        z = ctx.project["zooms"][i]
        snap = kind == "snap" and _centre(ctx, z, kind, scale, t0, t1, W, H)[2]
        s = ZoomSpan(round(t0 * fps) / fps, round(t1 * fps) / fps, scale, 0.0, 0.0,
                     *_ramps(z, kind, snap, fps), last_word_end=last_word_end, kind=kind, blur=snap)
        spans.append(s)
        index[id(s)] = i
    return [(index[id(s)], s.t0, s.t1) for s in _settle(ctx, spans, with_broll, W, H, fps) if id(s) in index]
