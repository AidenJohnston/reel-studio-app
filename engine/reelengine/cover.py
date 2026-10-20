"""The cover: a clean frame of the speaker, optionally with big text (docs/architecture.md section 5).

`render(ctx, out_png)` picks the best frame near `project.cover.atSourceTime` (or across the cut
when unset): the face detector must be confident, the face sharp, the eyes open, and ideally the
speaker between words (a mid-syllable mouth makes a strange cover). The frame is the source's
FULL picture fitted to the output format the same way the video is (no extra zoom or crop: a
cover that crops differently from the video reads as a different shot).

Optional `cover.text` is drawn big, white with a heavy black outline and a slight tilt, above the
face (or under it if there is no room above). Nothing else is added.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from .compose_util import (EngineError, ctx_words, decode_frames, fmt_of, grab_frame, log, probe, reframe_rect,
                           report, source_path)
from . import placement

SEARCH_HALF = 1.5        # seconds either side of atSourceTime
EXACT_HALF = 0.2         # cover.exact: the AI LOOKED at this frame (cover-candidates); stay on it
CANDIDATE_HALF = 0.6     # cover-candidates searches this far either side of each moment
DETECT_W = 480


def _sharpness(gray: np.ndarray) -> float:
    import cv2
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def _eye_openness(gray: np.ndarray, lm, fw: float) -> float:
    """Vertical-edge energy around both eyes relative to the face: open eyes (iris, lid line) are
    much busier than closed ones."""
    import cv2
    if not lm:
        return 1.0
    r = max(3, int(fw * 0.10))
    vals = []
    for ex, ey in ((lm[0], lm[1]), (lm[2], lm[3])):
        x0, y0 = int(ex - r), int(ey - r * 0.7)
        patch = gray[max(0, y0): y0 + int(r * 1.4), max(0, x0): x0 + 2 * r]
        if patch.size < 16:
            continue
        sy = cv2.Sobel(patch.astype(np.float32), cv2.CV_32F, 0, 1, ksize=3)
        vals.append(float(np.abs(sy).mean()))
    return float(np.mean(vals)) if vals else 1.0


def _between_words(ctx, sid: str, t: float) -> bool:
    for w in ctx_words(ctx).values():
        if w.get("source", "s1") == sid and float(w["s"]) - 0.03 <= t <= float(w["e"]) + 0.03:
            return False
    return True


def candidate_times(ctx, sid: str, at, half: float | None = None) -> list[float]:
    info = probe(source_path(ctx, sid), ctx)
    dur = info["duration"]
    if at is not None:
        step = 1 / 4 if getattr(ctx, "draft", False) else 1 / 8
        half = half if half is not None else SEARCH_HALF
        if half <= EXACT_HALF:
            step = 1 / 15
        a, b = max(0.0, at - half), min(dur - 0.05, at + half)
        return [round(a + k * step, 3) for k in range(int((b - a) / step) + 1)]
    # no time given: spread across the kept parts of this source
    spans = [(float(s.src_start), float(s.src_end)) for s in (ctx.out_timeline or []) if s.source == sid] \
        or [(0.0, dur)]
    total = sum(b - a for a, b in spans)
    n = 24 if getattr(ctx, "draft", False) else 48
    out = []
    for a, b in spans:
        k = max(1, int(round(n * (b - a) / max(total, 1e-6))))
        out += [round(a + (b - a) * (i + 0.5) / k, 3) for i in range(k)]
    return out


def score_frames(ctx, sid: str, times: list[float]) -> list[dict]:
    path = source_path(ctx, sid)
    det = None
    rows = []
    for t, fr in decode_frames(path, 1, DETECT_W, ctx=ctx, times=times):
        if det is None:
            det = placement._Detector(fr.shape[1], fr.shape[0])
        r = det(fr)
        if r is None:
            rows.append({"t": t, "score": 0.0})
            continue
        x, y, w, h, conf, lm = r
        import cv2
        gray = cv2.cvtColor(fr, cv2.COLOR_BGR2GRAY)
        face = gray[max(0, int(y)): int(y + h), max(0, int(x)): int(x + w)]
        rows.append({"t": t, "det": round(conf, 3), "sharp": _sharpness(face) if face.size else 0.0,
                     "eyes": _eye_openness(gray, lm, w), "between": _between_words(ctx, sid, t),
                     # the whole frame: a talking hand smeared across the chest blurs the cover
                     # even when the face is sharp
                     "still": _sharpness(gray), "faceArea": w * h})
    good = [r for r in rows if r.get("det")]
    if not good:
        return rows
    for key in ("sharp", "eyes", "still"):
        vals = np.array([r[key] for r in good])
        hi = float(np.percentile(vals, 90)) or 1.0
        for r in good:
            r[key + "N"] = min(1.0, r[key] / hi)
    for r in good:
        # between words = mouth closed or relaxed, never a mid-word smear
        r["score"] = round(r["det"] * (0.35 * r["sharpN"] + 0.35 * r["eyesN"] + 0.10 * r["stillN"]
                                       + 0.20 * (1.0 if r["between"] else 0.0)), 4)
    return rows


def _fit_frame(bgr: np.ndarray, W: int, H: int, rect=None):
    """Fit the frame exactly as the video is fitted (render's reframe crop, else cover). -> PIL RGBA."""
    from PIL import Image
    img = Image.fromarray(bgr[:, :, ::-1].copy()).convert("RGBA")
    if rect:
        x, y, cw, ch = rect
        return img.crop((x, y, x + cw, y + ch)).resize((W, H), Image.LANCZOS)
    s = max(W / img.width, H / img.height)
    img = img.resize((max(W, round(img.width * s)), max(H, round(img.height * s))), Image.LANCZOS)
    x, y = (img.width - W) // 2, (img.height - H) // 2
    return img.crop((x, y, x + W, y + H))


def render(ctx, out_png) -> Path:
    """Write the cover PNG (output format size) and work/cover.json (chosen time + scores)."""
    out_png = Path(out_png)
    report(ctx, "cover", 10, "Making your cover")
    cov = dict((ctx.project or {}).get("cover") or {})
    sources = ctx.project.get("sources") or []
    if not sources:
        raise EngineError("NO_SOURCE", "project has no sources", "Add a video first.")
    sid = cov.get("source") or (ctx.out_timeline[0].source if ctx.out_timeline else sources[0]["id"])
    if source_path(ctx, sid) is None:
        sid = sources[0]["id"]
    at = cov.get("atSourceTime")
    times = candidate_times(ctx, sid, at, EXACT_HALF if cov.get("exact") and at is not None else None)
    rows = score_frames(ctx, sid, times)
    best = max(rows, key=lambda r: r.get("score", 0.0)) if rows else {"t": at or 0.0}
    if not best.get("score"):
        best = {"t": at if at is not None else times[len(times) // 2]}
        log("cover: no face found near the chosen time; using the frame as is")
    W, H, _ = fmt_of(ctx)
    frame = grab_frame(source_path(ctx, sid), best["t"], ctx)
    rect = reframe_rect(ctx, sid)
    if frame.shape[1] < rect[0] + rect[2] or frame.shape[0] < rect[1] + rect[3]:
        rect = None                          # source metadata disagrees with the decoded frame
    img = _fit_frame(frame, W, H, rect)
    text = cov.get("text")
    if text:
        img = _draw_text(ctx, img, str(text), frame, W, H)
    out_png.parent.mkdir(parents=True, exist_ok=True)
    tmp = out_png.with_suffix(".part.png")
    img.convert("RGB").save(tmp)
    tmp.replace(out_png)
    (Path(ctx.work)).mkdir(parents=True, exist_ok=True)
    (Path(ctx.work) / "cover.json").write_text(json.dumps(
        {"source": sid, "requested": at, "chosen": best["t"], "best": best,
         "candidates": len(rows), "text": text, "file": str(out_png)}, indent=1, default=float), encoding="utf-8")
    report(ctx, "cover", 100, "Making your cover")
    return out_png


def candidates(ctx, sid: str, moments: list[float], out_dir, width: int = 360) -> list[dict]:
    """The best cover frame near each moment (raw-take seconds), for the AI to LOOK at before it
    picks: faces scored as for the cover (detector confidence, sharpness, eyes open, between words),
    each saved as a small still fitted like the video. Sorted by score, best first."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    W, H, _ = fmt_of(ctx)
    rect = reframe_rect(ctx, sid)
    out = []
    for m in moments:
        rows = [r for r in score_frames(ctx, sid, candidate_times(ctx, sid, float(m), CANDIDATE_HALF)) if r.get("score")]
        if not rows:
            continue
        best = max(rows, key=lambda r: r["score"])
        frame = grab_frame(source_path(ctx, sid), best["t"], ctx)
        rc = rect if rect and frame.shape[1] >= rect[0] + rect[2] and frame.shape[0] >= rect[1] + rect[3] else None
        img = _fit_frame(frame, W, H, rc).convert("RGB")
        img = img.resize((width, round(width * H / W)))
        f = out_dir / f"cover_{best['t']:08.3f}.jpg"
        img.save(f, "JPEG", quality=85)
        out.append({"moment": float(m), "atSourceTime": round(float(best["t"]), 3), "score": best["score"],
                    "eyesOpen": round(float(best.get("eyesN", 0.0)), 2), "sharp": round(float(best.get("sharpN", 0.0)), 2),
                    "betweenWords": bool(best.get("between")), "file": str(f)})
    out.sort(key=lambda r: -r["score"])
    return out


COVER_BELOW_MAX = 0.24      # under the chin, the text stays within this fraction of the height


def cover_text_zone(zones: list, H: int) -> tuple:
    """(zone, "above" | "below") for the cover text: above the face when that band is tall enough,
    else UNDER THE CHIN. The below zone is cut to the band right under the chin: in a wide shot with
    the head high, the whole below-face zone is the chest, and centring in it put the words there."""
    zone = placement.zone(zones, "above-face")
    if zone is not None and zone["h"] >= 0.12 * H:
        return zone, "above"
    below = placement.zone(zones, "below-face")
    if below is None:
        return zone, "above"
    return dict(below, h=int(min(below["h"], COVER_BELOW_MAX * H))), "below"


def _detect_face(bgr: np.ndarray):
    """The face on the composed cover. At full size the detector can take a talking hand or the
    microphone for a face (measured: a hand at 0.67 while the real face scored 0.92 at the size the
    cover frames are scored at), which put the cover words on the chest. Detect at both sizes and
    keep the surer one."""
    import cv2
    s = DETECT_W / bgr.shape[1]
    small = None
    if s < 1:
        d = placement.detect_in_frame(cv2.resize(bgr, (DETECT_W, max(1, int(round(bgr.shape[0] * s))))))
        if d:
            small = dict(d, box=[v / s for v in d["box"]], core=[v / s for v in d["core"]] if d.get("core") else None)
    full = placement.detect_in_frame(bgr)
    cands = [d for d in (full, small) if d]          # a tie keeps the full-size box
    return max(cands, key=lambda d: float(d.get("score") or 0.0)) if cands else None


def _draw_text(ctx, img, text, src_bgr, W, H):
    from .broll import _place_in, _rotate, _text_image
    # Detect on the COMPOSED cover (output px), not the raw source: the cover is a face-centred crop
    # of the source, so source boxes mapped by a plain centre crop landed in the wrong place.
    composed = np.ascontiguousarray(np.array(img.convert("RGB"))[:, :, ::-1])
    det = _detect_face(composed)
    track = {"width": W, "height": H,
             "samples": [{"t": 0.0, "box": det["box"], "core": det.get("core")}] if det else []}
    zones = placement.safe_boxes(track, 0.0, {"width": W, "height": H, "captions": False})
    zone, where = cover_text_zone(zones, H)
    size = int(0.13 * W)
    while True:
        tim, ok = _text_image(text.upper(), int(zone["w"] * 0.94), size, "#FFFFFF", "#000000", W)
        rot = _rotate(tim, -4.0)
        if (rot.width <= zone["w"] and rot.height <= zone["h"] and ok) or size <= int(0.05 * W):
            break
        size = int(size * 0.9)
    # hug the face: the bottom of the band above it, or the top of the band under the chin
    cy = zone["y"] + zone["h"] - rot.height / 2 if where == "above" else zone["y"] + rot.height / 2
    x, y = _place_in(zone, rot.width, rot.height, None, cy)
    img.alpha_composite(rot, (x, y))
    try:
        ctx._cover_text_box = (x, y, rot.width, rot.height, where)       # for the cover report / tests
    except Exception:
        pass
    return img
