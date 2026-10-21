"""B-roll treatments -> timed overlay layers (docs/architecture.md sections 5 and 7).

`build_layers(ctx)` turns every `project.broll[]` item into one or more `Layer`s that A1's render
composites over the cut video (ascending z, captions always on top). Each treatment is a
deterministic layout from (asset, face box, frame size, params); nothing here is random and every
rendered file is cached under work/layers/ by a hash of everything that shaped it.

Treatments (descriptions + defaults live in templates/treatments/<name>.json):
  card-above-head  image/video card above the face, slight tilt, sized to read
  full-frame       covers the frame (face hidden)
  phone-card       asset inside a phone frame, beside the face
  side-card        card left or right of the face
  text-pop         big words above the head
  post-wall        full-screen grid of images, one tile per spoken word
  icon-wall        grid of logos/icons above the face, one per word
  split-top        asset top half, speaker bottom half
  animation        a make_animation .mov (+ .anim.json sidecar) overlaid full-frame at 0,0 as rendered

House rules carried over from the original pipeline (general taste, not brand):
  * a card LEADS its phrase by ~0.13 s (landing ON the word reads late)
  * hard cuts by default (no fades); a still holds >= 2 s unless the next b-roll takes over
  * graphics never cover the EYES-TO-CHIN zone (eyes, nose, mouth) or the caption band, except
    treatments that hide the speaker on purpose (full-frame, post-wall, split-top); cards may cover
    hair, the forehead down to just above the brows, and the sides of the head
  * sized to read on a phone: a card with text is >= 55% of the frame wide (logos/icons smaller);
    it sits as low as the brow line allows; a text card is cropped to its words first (only plain
    margins / flat blocks go, and the floor shrinks with the width dropped, so the words stay as
    big); then over the hair on one side; split view only when nothing readable fits
  * no blurred backdrops behind anything
  * a gap under ~0.22 s between two b-roll windows flashes the bare face: close it
"""
from __future__ import annotations

import hashlib
import json
import math
import re
from pathlib import Path
from typing import Optional

from . import placement
from .compose_util import (EngineError, _get, ffmpeg_bin, fmt_of, kind_of, layers_dir, load_font, log,
                           open_image, probe, reframe_rect, reframe_vf, report, resolve_asset, run, source_path,
                           source_spans, word_end, word_ids_between, word_start)

try:
    from .render_ctx import Layer
except ImportError:  # pragma: no cover - only before A1's render_ctx exists
    from dataclasses import dataclass

    @dataclass
    class Layer:  # type: ignore[no-redef]
        path: Path
        kind: str
        t0: float
        t1: float
        x: int
        y: int
        w: int
        h: int
        rotate_deg: float = 0.0
        z: int = 0
        fade_in: float = 0.0
        fade_out: float = 0.0

VERSION = 8                    # bump when drawing code changes so cached files are redrawn
LEAD = 0.13
MIN_GAP = 0.22
STILL_MIN_HOLD = 2.0
VIDEO_MIN_HOLD = 0.6
LABEL_SIZE = 0.075             # text-pop style "label": ~81 px type at 1080 wide (hand-edit labels), one or two lines
ANIM_TAIL = 0.35              # an animation stays this long after its last word (its last reveal settles)
TEMPLATES = Path(__file__).resolve().parent / "templates" / "treatments"

FACE_HIDING = {"full-frame", "post-wall", "split-top"}
CARD_MIN_WIDTH = 0.55          # a card with text (screenshot, article, post, clip) reads on a phone at >= 55% wide
ICON_MIN_WIDTH = 0.22          # a logo / cut-out / tiny asset: >= 22% wide (~240 px)...
ICON_MIN_AREA = 0.035          # ...and this fraction of the frame (a ~270 px square logo at 1080x1920)
UPPER_SIDE_WIDTH = 0.70        # side card over the hair: the half of the top band on its side
UPPER_SIDE_MIN_WIDTH = 0.40    # ...and a text card there must still be this wide
TEXT_MIN_WIDTH_FLOOR = 0.30    # a text card cropped to its words may shrink its floor, never below this
MIN_PHONE_WIDTH = 0.30         # phone screen width, fraction of frame width
SIDE_MIN_WIDTH = ICON_MIN_WIDTH   # side card beside the face: at least this fraction of the frame wide...
SIDE_MIN_AREA = ICON_MIN_AREA     # ...and this fraction of its area

BUILTIN_DEFAULTS = {
    "card-above-head": {"tilt": -2.5, "scale": 1.0, "radius": 0.026, "shadow": True, "maxWidth": 0.88},
    "full-frame": {"fit": "auto", "focusX": 0.5, "focusY": 0.5, "background": "#101010"},
    "phone-card": {"tilt": 0.0, "scale": 1.0, "side": "auto", "focusY": 0.0},
    "side-card": {"tilt": 2.0, "scale": 1.0, "side": "auto", "radius": 0.022, "shadow": True},
    "text-pop": {"text": None, "tilt": -3.0, "color": "#FFFFFF", "outline": "#000000", "size": 0.11,
                 "case": "upper"},
    "post-wall": {"columns": 3, "gap": 0.012, "background": "#101010", "items": []},
    "icon-wall": {"items": [], "tile": "auto"},
    "split-top": {"focusX": 0.5, "focusY": 0.5, "split": "auto", "fit": "auto", "background": "#101010"},
    "animation": {},
}

ANIM_KIND = "reelstudio-animation"
ANIM_TOP_REGION = {"x": 50, "y": 130, "w": 980, "h": 590}   # templates' default `top` region (1080x1920)


def animation_sidecar(path: Path) -> Optional[dict]:
    """The `<name>.anim.json` written next to a rendered animation `<name>.mov`, or None. A file with
    this sidecar is a finished full-frame transparent layer, never a card."""
    try:
        side = Path(path).with_suffix(".anim.json")
        if not side.exists():
            return None
        data = json.loads(side.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) and data.get("kind") == ANIM_KIND else None


def animation_region(sc: dict, W: int, H: int) -> Optional[dict]:
    """Where the animation's content may be (output px), from its sidecar: the `region` it was
    rendered with, else the templates' default top region. None for a full-screen animation."""
    if (sc.get("layout") or (sc.get("params") or {}).get("layout")) == "full":
        return None
    r = (sc.get("params") or {}).get("region") or sc.get("region") or ANIM_TOP_REGION
    f = W / 1080.0
    return {"x": r["x"] * f, "y": r["y"] * f, "w": r["w"] * f, "h": r["h"] * f}


def treatment_defaults(name: str) -> dict:
    """Defaults for a treatment: the template JSON's params merged over the built-in ones."""
    d = dict(BUILTIN_DEFAULTS.get(name, {}))
    f = TEMPLATES / f"{name}.json"
    if name in BUILTIN_DEFAULTS and f.exists():      # never a project-supplied path to a .json
        try:
            spec = json.loads(f.read_text(encoding="utf-8"))
            for k, v in (spec.get("params") or {}).items():
                d[k] = v.get("default") if isinstance(v, dict) and "default" in v else v
        except (OSError, ValueError) as e:
            log(f"bad template {f.name}: {e}")
    return d


def list_treatments() -> list[dict]:
    """Every treatment's template (id, label, description, params) for the AI's tool schema."""
    out = []
    for name in BUILTIN_DEFAULTS:
        f = TEMPLATES / f"{name}.json"
        spec = {"id": name}
        if f.exists():
            spec.update(json.loads(f.read_text(encoding="utf-8")))
        out.append(spec)
    return out


# --- timing ------------------------------------------------------------------------------------

def plan_windows(ctx) -> list[dict]:
    """[{id, index, treatment, t0, t1, words, item}] for every broll item whose anchor is in the cut,
    in start order, with hold, handoff and gap rules applied. Cheap: renders nothing."""
    items = list((ctx.project or {}).get("broll") or [])
    plans = []
    for i, it in enumerate(items):
        anc = it.get("anchor") or {}
        a, b = anc.get("from"), anc.get("to") or anc.get("from")
        s = word_start(ctx, a) if a else None
        e = word_end(ctx, b) if b else None
        if s is None or e is None:
            log(f"broll {it.get('id', i)}: anchor {a}..{b} is not in the cut; skipped")
            continue
        lead = float(it.get("leadIn", LEAD) if it.get("leadIn") is not None else LEAD)
        t0 = max(0.0, s - lead)
        params = it.get("params") or {}
        is_video = _is_video_item(ctx, it)
        hold = params.get("hold")
        min_hold = float(hold) if hold is not None else (VIDEO_MIN_HOLD if is_video else STILL_MIN_HOLD)
        anim = _anim_of(ctx, it)
        tail = 0.05
        if anim is not None and hold is None:
            # an animation leaves with its line, like any card: held long enough to read, never past
            # its own length (_t_anim caps it), and never playing out over the NEXT idea (a 3 s
            # count-up on a 1.7 s line used to sit on the following sentence)
            min_hold, tail = STILL_MIN_HOLD, ANIM_TAIL
        t1 = max(e + tail, t0 + min_hold)
        plans.append({"id": it.get("id", f"b{i + 1}"), "index": i, "treatment": it.get("treatment", "card-above-head"),
                      "t0": t0, "t1": t1, "word_from": a, "word_to": b, "item": it})
    plans.sort(key=lambda p: (p["t0"], p["index"]))
    dur = float(getattr(ctx, "duration", 0.0) or 0.0)
    for k, p in enumerate(plans):
        if k + 1 < len(plans):
            nxt = plans[k + 1]["t0"]
            if p["t1"] > nxt:                 # hard-cut handoff to the next b-roll
                p["t1"] = nxt
            elif nxt - p["t1"] < MIN_GAP:     # don't flash the bare face for a few frames
                p["t1"] = nxt
        if dur:
            p["t1"] = min(p["t1"], dur)
    return [p for p in plans if p["t1"] - p["t0"] > 0.05]


def _anim_of(ctx, it) -> Optional[dict]:
    a = it.get("asset")
    if not a:
        return None
    try:
        return animation_sidecar(_asset_path(ctx, a))
    except EngineError:
        return None


def _is_video_item(ctx, it) -> bool:
    a = it.get("asset")
    if not a:
        return False
    try:
        return kind_of(_asset_path(ctx, a)) == "video"
    except EngineError:
        return False


def _asset_path(ctx, a: str) -> Path:
    p = resolve_asset(ctx, a)          # UNSAFE_PATH for anything outside media/, work/, Library/
    if p.exists():
        return p
    # an animation id rendered by the app into work/animations/<id>.(mov|webm|mp4)
    if _ANIM_ID.match(str(a)):
        for ext in (".mov", ".webm", ".mp4", ".png"):
            q = Path(ctx.work) / "animations" / f"{a}{ext}"
            if q.exists():
                return q
    raise EngineError("ASSET_MISSING", f"b-roll asset not found: {a} ({p})",
                      "A picture or clip for your b-roll is missing. It may have been moved or deleted.")


_ANIM_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$")
_HEX = re.compile(r"^#?([0-9A-Fa-f]{6})([0-9A-Fa-f]{2})?$")


def ff_hex(c, default: str = "101010") -> str:
    """A treatment colour as the RRGGBB ffmpeg expects after `0x`, or `default`.

    `params` is free-form JSON the AI writes; a colour must never be spliced into a filter graph
    as given: "000000,metadata=mode=print:file=X" would add a filter that writes files
. Only six hex digits ever reach the graph."""
    if isinstance(c, (list, tuple)) and len(c) >= 3 and all(isinstance(v, int) and 0 <= v <= 255 for v in c[:3]):
        return "".join(f"{v:02X}" for v in c[:3])
    m = _HEX.match(str(c).strip()) if isinstance(c, str) else None
    if not m:
        if c not in (None, ""):
            log(f"b-roll background {c!r} is not a #RRGGBB colour; used #{default}")
        return default
    return m.group(1).upper()


# --- geometry ----------------------------------------------------------------------------------

def _frame(ctx) -> dict:
    W, H, _ = fmt_of(ctx)
    cap = (ctx.project or {}).get("captions") or {}
    style = cap.get("style") or {}
    return {"width": W, "height": H, "captions": bool(cap.get("enabled", True)),
            "captionPosition": float(style.get("position", 0.70)), "captionSize": float(style.get("size", 76))}


def _zoom_at(ctx, t0, t1):
    try:
        from .zoom import build_zooms
        for z in build_zooms(ctx, with_broll=False):
            if z.t0 < t1 and z.t1 > t0:
                return (z.scale, z.cx, z.cy)
    except Exception as e:  # zoom problems must never break b-roll
        log(f"zoom lookup failed: {e}")
    return None


def _union(boxes) -> tuple:
    x0 = min(b[0] for b in boxes)
    y0 = min(b[1] for b in boxes)
    x1 = max(b[0] + b[2] for b in boxes)
    y1 = max(b[1] + b[3] for b in boxes)
    return (x0, y0, x1 - x0, y1 - y0)


def output_faces(ctx, t0: float, t1: float) -> tuple[tuple, tuple]:
    """(face box, eyes-to-chin zone), each output px (x, y, w, h), unioned over an output window
    across every source piece."""
    W, H, _ = fmt_of(ctx)
    frame = {"width": W, "height": H}
    faces, cores = [], []
    for sid, a, b, _o in source_spans(ctx, t0, t1) or []:
        rect = reframe_rect(ctx, sid)          # decided before any face file is written
        tr = placement.track_for_source(ctx, sid)
        o = placement.output_face(tr, a, b, {**frame, "reframe": rect})
        faces.append(o["face"])
        cores.append(o["core"])
    if not faces:
        fb = getattr(ctx, "face_box", None)
        box = (fb["x"], fb["y"], fb["w"], fb["h"]) if fb else tuple(placement.default_face(W, H))
        faces.append(box)
        cores.append(tuple(placement.core_from_box(box)))
    return _union(faces), _union(cores)


def output_face_union(ctx, t0: float, t1: float) -> tuple:
    """Union face box (output px, x, y, w, h) over an output window, across every source piece."""
    return output_faces(ctx, t0, t1)[0]


def zones_for(ctx, t0: float, t1: float) -> tuple[list[dict], tuple, dict]:
    """(safe zones, output face box, frame) for an output window, zoom-aware. frame["core"] is the
    eyes-to-chin protected zone (output px, x, y, w, h) the zones keep clear of."""
    frame = _frame(ctx)
    W, H = frame["width"], frame["height"]
    face, core = output_faces(ctx, t0, t1)
    z = _zoom_at(ctx, t0, t1)
    if z:
        frame["zoom"] = z
    synthetic = {"width": W, "height": H, "samples": [{"t": 0.0, "box": list(face), "core": list(core)}]}
    zones = placement.safe_boxes(synthetic, (0.0, 0.0), frame)
    if z:
        s, cx, cy = z
        face = (cx + (face[0] - cx) * s, cy + (face[1] - cy) * s, face[2] * s, face[3] * s)
        core = (cx + (core[0] - cx) * s, cy + (core[1] - cy) * s, core[2] * s, core[3] * s)
    frame["core"] = core
    return zones, face, frame


def fit_rotated(aspect: float, bw: float, bh: float, tilt: float, pad: float) -> float:
    """Largest card width (content aspect w/h) whose padded, rotated canvas fits in bw x bh."""
    th = math.radians(abs(tilt))
    c, s = math.cos(th), math.sin(th)
    w1 = (bw - 2 * pad * (c + s)) / (c + s / aspect)
    w2 = (bh - 2 * pad * (s + c)) / (s + c / aspect)
    return max(1.0, min(w1, w2))


def shadow_zone(zone: dict, W: int, H: int, pad: Optional[int] = None) -> dict:
    """The zone a padded card CANVAS may use: its transparent shadow pad may hang over the zone's
    edges (most on the top and sides, less at the bottom where the shadow falls), so the opaque card
    itself, not its shadow margin, is what fills the zone. Clamped to the frame."""
    pad = _shadow_pad(0, W) if pad is None else pad
    side, down = int(0.75 * pad), int(0.4 * pad)
    x0, y0 = max(0, zone["x"] - side), max(0, zone["y"] - side)
    x1, y1 = min(W, zone["x"] + zone["w"] + side), min(H, zone["y"] + zone["h"] + down)
    return {**zone, "x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0}


def _place_in(zone: dict, cw: int, ch: int, cx: Optional[float] = None, cy: Optional[float] = None):
    """Top-left (x, y) for a cw x ch canvas centred near (cx, cy) but fully inside the zone."""
    zx, zy, zw, zh = zone["x"], zone["y"], zone["w"], zone["h"]
    cx = zx + zw / 2 if cx is None else cx
    cy = zy + zh / 2 if cy is None else cy
    x = min(max(cx - cw / 2, zx), zx + zw - cw)
    y = min(max(cy - ch / 2, zy), zy + zh - ch)
    return int(round(x)), int(round(y))


# --- drawing (Pillow) --------------------------------------------------------------------------

def _rgba(c, default=(255, 255, 255, 255)):
    if not c:
        return default
    if isinstance(c, (list, tuple)):
        return tuple(c) + ((255,) if len(c) == 3 else ())
    m = _HEX.match(str(c).strip())
    if not m:
        return default
    c = m.group(1) + (m.group(2) or "")
    v = tuple(int(c[i:i + 2], 16) for i in range(0, len(c), 2))
    return v + ((255,) if len(v) == 3 else ())


def _trim_alpha(img):
    bb = img.getchannel("A").point(lambda a: 255 if a > 8 else 0).getbbox()
    return img.crop(bb) if bb else img


def _has_transparency(img) -> bool:
    import numpy as np
    a = np.asarray(img.getchannel("A"))
    return float((a < 250).mean()) > 0.05


def _round(img, radius: int):
    from PIL import Image, ImageChops, ImageDraw
    if radius <= 0:
        return img
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, img.width - 1, img.height - 1], radius, fill=255)
    out = img.copy()
    out.putalpha(ImageChops.multiply(img.getchannel("A"), mask))
    return out


def _shadow_pad(cw: int, W: int) -> int:
    return int(round(max(10, 0.03 * W)))


def _with_shadow(img, pad: int, opacity: float = 0.38):
    """Canvas with `img` centred on a soft drop shadow (shadow follows the alpha)."""
    from PIL import Image, ImageFilter
    W, H = img.width + 2 * pad, img.height + 2 * pad
    canvas = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    a = img.getchannel("A").point(lambda v: int(v * opacity))
    sh = Image.new("RGBA", img.size, (0, 0, 0, 0))
    sh.putalpha(a)
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    off = int(pad * 0.35)
    layer.alpha_composite(sh, (pad, pad + off))
    layer = layer.filter(ImageFilter.GaussianBlur(pad * 0.45))
    canvas.alpha_composite(layer)
    canvas.alpha_composite(img, (pad, pad))
    return canvas


def _rotate(img, deg: float):
    from PIL import Image
    if abs(deg) < 0.01:
        return img
    return img.rotate(deg, resample=Image.BICUBIC, expand=True)


def _cover(img, w: int, h: int, fx: float = 0.5, fy: float = 0.5):
    from PIL import Image
    s = max(w / img.width, h / img.height)
    r = img.resize((max(1, round(img.width * s)), max(1, round(img.height * s))), Image.LANCZOS)
    x = int((r.width - w) * min(max(fx, 0), 1))
    y = int((r.height - h) * min(max(fy, 0), 1))
    return r.crop((x, y, x + w, y + h))


def _contain(img, w: int, h: int):
    from PIL import Image
    s = min(w / img.width, h / img.height)
    return img.resize((max(1, round(img.width * s)), max(1, round(img.height * s))), Image.LANCZOS)


def _opaque_bbox(img, x: int, y: int, thresh: int = 40):
    bb = img.getchannel("A").point(lambda a: 255 if a > thresh else 0).getbbox()
    if not bb:
        return None
    return (x + bb[0], y + bb[1], x + bb[2], y + bb[3])


def _phone_chrome(sw: int, sh: int, W: int):
    """Phone body around a sw x sh screen. -> (body RGBA, screen offset (x, y), screen mask L)."""
    from PIL import Image, ImageDraw
    bez = max(6, int(round(sw * 0.045)))
    bw, bh = sw + 2 * bez, sh + 2 * bez
    body = Image.new("RGBA", (bw, bh), (0, 0, 0, 0))
    d = ImageDraw.Draw(body)
    d.rounded_rectangle([0, 0, bw - 1, bh - 1], int(bw * 0.14), fill=(18, 18, 20, 255))
    d.rounded_rectangle([1, 1, bw - 2, bh - 2], int(bw * 0.14), outline=(70, 70, 76, 255), width=max(1, bez // 4))
    mask = Image.new("L", (sw, sh), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, sw - 1, sh - 1], int(sw * 0.11), fill=255)
    return body, (bez, bez), mask


def _text_image(text: str, max_w: int, size: int, color, outline, W: int, weight="bold"):
    from PIL import Image, ImageDraw
    font = load_font(size, weight)
    stroke = max(2, int(round(size * 0.09)))
    probe_d = ImageDraw.Draw(Image.new("RGBA", (8, 8)))
    lines, cur = [], ""
    for word in text.split():
        t = f"{cur} {word}".strip()
        if probe_d.textlength(t, font=font) + 2 * stroke <= max_w or not cur:
            cur = t
        else:
            lines.append(cur)
            cur = word
    if cur:
        lines.append(cur)
    lh = int(size * 1.12)
    widths = [int(probe_d.textlength(ln, font=font)) + 2 * stroke for ln in lines]
    w = max(widths) + 2 * stroke
    h = lh * len(lines) + 2 * stroke + int(size * 0.25)
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    y = stroke
    for ln, lw in zip(lines, widths):
        d.text(((w - lw) / 2 + stroke, y), ln, font=font, fill=_rgba(color), stroke_width=stroke,
               stroke_fill=_rgba(outline, (0, 0, 0, 255)))
        y += lh
    return img, max(widths) <= max_w


def _label_image(text: str, max_w: int, size: int, W: int, fill="#FFFFFF", ink="#111111"):
    """A text label: dark type on a white box, snug sides, square corners rounded a touch. The look
    of a hook title or a picture's label ("my first apartment") in hand-edited reels."""
    from PIL import Image, ImageDraw
    font = load_font(size, "bold")
    pad_x, pad_y = int(size * 0.42), int(size * 0.26)
    probe_d = ImageDraw.Draw(Image.new("RGBA", (8, 8)))
    inner = max_w - 2 * pad_x

    def wrap(limit):
        out, cur = [], ""
        for word in text.split():
            t = f"{cur} {word}".strip()
            if probe_d.textlength(t, font=font) <= limit or not cur:
                cur = t
            else:
                out.append(cur)
                cur = word
        return out + ([cur] if cur else [])
    lines = wrap(inner)
    if len(lines) > 1:                                # balanced lines, no one-word orphan
        even = probe_d.textlength(text, font=font) / len(lines) * 1.08
        alt = wrap(max(even, max(probe_d.textlength(x, font=font) for x in text.split())))
        if len(alt) == len(lines):
            lines = alt
    lh = int(size * 1.18)
    widths = [int(probe_d.textlength(ln, font=font)) for ln in lines]
    w = max(widths) + 2 * pad_x
    h = lh * len(lines) + 2 * pad_y
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((0, 0, w - 1, h - 1), radius=max(4, int(size * 0.18)), fill=_rgba(fill))
    y = pad_y - int(size * 0.06)
    for ln, lw in zip(lines, widths):
        d.text(((w - lw) / 2, y), ln, font=font, fill=_rgba(ink, (17, 17, 17, 255)))
        y += lh
    return img, max(widths) <= inner


# --- caching -----------------------------------------------------------------------------------

def _key(*parts) -> str:
    h = hashlib.sha1(json.dumps([VERSION, *parts], sort_keys=True, default=str).encode())
    return h.hexdigest()[:12]


def _asset_sig(p: Path) -> str:
    try:
        st = p.stat()
        return f"{p}:{st.st_size}:{st.st_mtime_ns}"
    except OSError:
        return str(p)


def _save_png(img, ctx, stem: str) -> Path:
    out = layers_dir(ctx) / f"{stem}.png"
    if not out.exists():
        tmp = out.with_suffix(".part.png")
        img.save(tmp)
        tmp.replace(out)
    return out


# --- video helpers (ffmpeg) --------------------------------------------------------------------

def _enc(ctx) -> list:
    if getattr(ctx, "draft", False):
        return ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-pix_fmt", "yuv420p"]
    return ["-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p"]


def _clip_window(ctx, src: Path, params: dict, want: float) -> tuple[float, float]:
    """(in-point, usable duration) for a video asset; never asks for more than the clip has."""
    info = probe(src, ctx)
    cin = float(params.get("in", 0.0) or 0.0)
    have = max(0.0, info["duration"] - cin)
    if have <= 0.1:
        cin, have = 0.0, info["duration"]
    return cin, min(want, have)


def _video_card(ctx, src: Path, cin: float, dur: float, chrome, screen_xy, mask, stem: str) -> Path:
    """Masked video inside a static chrome PNG -> alpha .mov (qtrle) the size of the chrome."""
    _, _, fps = fmt_of(ctx)
    d = layers_dir(ctx)
    # the clip's window is part of the name: a b-roll re-anchored to a longer span must not reuse the old cut
    stem = f"{stem}-{_key(round(cin, 3), round(dur, 3))}"
    out = d / f"{stem}.mov"
    if out.exists():
        return out
    cp, mp = d / f"{stem}-chrome.png", d / f"{stem}-mask.png"
    chrome.save(cp)
    mask.save(mp)
    sw, sh = mask.size
    sx, sy = screen_xy
    fc = (f"[0:v]fps={fps},scale={sw}:{sh}:force_original_aspect_ratio=increase,crop={sw}:{sh},setsar=1,"
          f"format=rgba[v];[2:v]format=gray,scale={sw}:{sh}[m];[v][m]alphamerge[vm];"
          f"[1:v]format=rgba[bg];[bg][vm]overlay={sx}:{sy}:format=auto:shortest=1,format=argb[out]")
    tmp = d / f"{stem}.part.mov"
    run([ffmpeg_bin(ctx), "-y", "-v", "error", "-nostdin", "-ss", f"{cin:.3f}", "-t", f"{dur:.3f}", "-i", str(src),
         "-loop", "1", "-framerate", str(fps), "-t", f"{dur:.3f}", "-i", str(cp),
         "-loop", "1", "-framerate", str(fps), "-t", f"{dur:.3f}", "-i", str(mp),
         "-filter_complex", fc, "-map", "[out]", "-an", "-c:v", "qtrle", "-t", f"{dur:.3f}", str(tmp)],
        timeout=max(120, dur * 30), what="video card")
    tmp.replace(out)
    return out


def _video_full(ctx, src: Path, cin: float, dur: float, fit: str, bg: str, stem: str,
                fx: float = 0.5, fy: float = 0.5) -> Path:
    W, H, fps = fmt_of(ctx)
    d = layers_dir(ctx)
    # the clip's window is part of the name: a b-roll re-anchored to a longer span must not reuse the old cut
    out = d / f"{stem}-{_key(round(cin, 3), round(dur, 3))}.mp4"
    if out.exists():
        return out
    if fit == "contain":
        c = ff_hex(bg)
        vf = (f"fps={fps},scale={W}:{H}:force_original_aspect_ratio=decrease,"
              f"pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:color=0x{c},setsar=1")
    else:
        vf = (f"fps={fps},scale={W}:{H}:force_original_aspect_ratio=increase,"
              f"crop={W}:{H}:(iw-{W})*{fx:.3f}:(ih-{H})*{fy:.3f},setsar=1")
    tmp = out.with_name(out.stem + ".part.mp4")
    run([ffmpeg_bin(ctx), "-y", "-v", "error", "-nostdin", "-ss", f"{cin:.3f}", "-t", f"{dur:.3f}", "-i", str(src),
         "-vf", vf, "-an", *_enc(ctx), "-t", f"{dur:.3f}", str(tmp)], timeout=max(120, dur * 30), what="full-frame clip")
    tmp.replace(out)
    return out


def split_geometry(ctx, face: tuple, params: dict) -> tuple[int, int, bool]:
    """(top height, speaker crop y, face clear of captions) for the split view.

    split "auto" (default) sizes the top part so the speaker's whole head fits between the seam
    and the caption band, never less than 30% or more than 50% of the frame. A close-up face that
    cannot fit there still gets the 30% split; the record then says the captions cross the face.
    """
    W, H, _ = fmt_of(ctx)
    fx, fy, fw, fh = face
    band = placement.caption_band(_frame(ctx))
    head_top = fy - 0.35 * fh                  # hair
    head_h = fh * 1.35 + 0.02 * H
    sp = params.get("split", "auto")
    if isinstance(sp, (int, float)) and not isinstance(sp, bool):
        th = int(round(H * float(sp)))
    else:
        limit = band[0] if band else H * 0.83
        th = int(round(min(0.5 * H, max(0.30 * H, limit - head_h))))
    th = th // 2 * 2
    bh = H - th
    crop_y = int(round(min(max(head_top - 0.01 * H, 0), H - bh)))
    face_out_bottom = th + (fy + fh) - crop_y
    clear = (band is None) or face_out_bottom <= band[0] or th + (fy - crop_y) >= band[1]
    return th, crop_y, clear


def _split_video(ctx, t0: float, t1: float, top_src: Path, top_kind: str, cin: float, params: dict,
                 face: tuple, stem: str, top_png: Optional[Path] = None) -> Path:
    """Full-frame video: the asset in the top part, the speaker (same cut, unzoomed) below it."""
    W, H, fps = fmt_of(ctx)
    d = layers_dir(ctx)
    # the window is part of the name: the speaker half is cut from t0..t1, so a re-anchored split must not reuse it
    out = d / f"{stem}-{_key(round(t0, 3), round(t1, 3), round(cin, 3))}.mp4"
    if out.exists():
        return out
    dur = t1 - t0
    th, crop_y, _ = split_geometry(ctx, face, params)
    bh = H - th
    pieces = source_spans(ctx, t0, t1)
    if not pieces:
        raise EngineError("SPLIT_NO_SOURCE", "split-top window has no source video", "I couldn't find your video for this part.")
    args, chains = [], []
    for i, (sid, a, b, _o) in enumerate(pieces):
        sp = source_path(ctx, sid)
        args += ["-ss", f"{a:.3f}", "-t", f"{b - a:.3f}", "-i", str(sp)]
        chains.append(f"[{i}:v]fps={fps},{reframe_vf(ctx, sid)},"
                      f"setsar=1,crop={W}:{bh}:0:{crop_y},setpts=PTS-STARTPTS[s{i}]")
    n = len(pieces)
    chains.append("".join(f"[s{i}]" for i in range(n)) + f"concat=n={n}:v=1:a=0[spk]")
    k = n
    if top_png is not None:
        args += ["-loop", "1", "-framerate", str(fps), "-t", f"{dur:.3f}", "-i", str(top_png)]
        chains.append(f"[{k}:v]scale={W}:{th},setsar=1,format=yuv420p[top]")
    elif top_kind == "video":
        args += ["-ss", f"{cin:.3f}", "-t", f"{dur:.3f}", "-i", str(top_src)]
        info = probe(top_src, ctx)
        fit = params.get("fit", "auto")
        if fit == "auto":
            fit = "cover" if abs(math.log((info["width"] / max(1, info["height"])) / (W / th))) < 0.25 else "contain"
        if fit == "contain":
            bg = ff_hex(params.get("background", "#101010"))
            chains.append(f"[{k}:v]fps={fps},scale={W}:{th}:force_original_aspect_ratio=decrease,"
                          f"pad={W}:{th}:(ow-iw)/2:(oh-ih)/2:color=0x{bg},setsar=1,format=yuv420p[top]")
        else:
            chains.append(f"[{k}:v]fps={fps},scale={W}:{th}:force_original_aspect_ratio=increase,"
                          f"crop={W}:{th},setsar=1,format=yuv420p[top]")
    else:
        raise EngineError("SPLIT_BAD_ASSET", "split-top needs an image or video", "This b-roll needs a picture or a clip.")
    chains.append(f"[top][spk]vstack=inputs=2,format=yuv420p[out]")
    tmp = out.with_name(out.stem + ".part.mp4")
    run([ffmpeg_bin(ctx), "-y", "-v", "error", "-nostdin", *args, "-filter_complex", ";".join(chains),
         "-map", "[out]", "-an", *_enc(ctx), "-t", f"{dur:.3f}", str(tmp)], timeout=max(180, dur * 40),
        what="split-top")
    tmp.replace(out)
    return out


# --- treatments --------------------------------------------------------------------------------
# Each returns (layers, records). A record is the sidecar row used for checks and the AI's view.

def _card_layout(ctx, p, zone, tilt, scale, max_w_frac, face, radius_frac, shadow=True, center_x=None,
                 low=False):
    """Shared card maths: content image -> (canvas, x, y) placed in zone (low: as low as it goes)."""
    W, H, _ = fmt_of(ctx)
    img = p["image"]
    aspect = img.width / img.height
    pad = _shadow_pad(0, W) if shadow else 2
    zone = shadow_zone(zone, W, H, pad)
    cw = fit_rotated(aspect, zone["w"], zone["h"], tilt, pad) * min(1.0, float(scale))
    cw = min(cw, max_w_frac * W)
    ch = cw / aspect
    card = img.resize((max(1, int(round(cw))), max(1, int(round(ch)))), resample=3)
    if not p.get("cutout"):
        card = _round(card, int(round(radius_frac * W)))
    canvas = _with_shadow(card, pad) if shadow else _with_shadow(card, pad, opacity=0.0)
    canvas = _rotate(canvas, tilt)
    cx = center_x if center_x is not None else face[0] + face[2] / 2
    x, y = _place_in(zone, canvas.width, canvas.height, cx, zone["y"] + zone["h"] if low else None)
    return canvas, x, y, (int(round(cw)), int(round(ch)))


def _load_still(ctx, path: Path, params: Optional[dict] = None) -> dict:
    """A still for a card: alpha-trimmed, measured ("content": text | logo | photo, see
    placement.content_kind; params.iconic true/false pins logo/text) and a photo cropped to its
    subject (placement.subject_box; params.crop false keeps it whole)."""
    params = params or {}
    img = _trim_alpha(open_image(path))
    cut = _has_transparency(img)
    if params.get("iconic") is not None:
        content = "logo" if params["iconic"] else "text"
    else:
        content = "logo" if cut else placement.content_kind(img)
    box, tscale = None, 1.0
    if params.get("crop", True) is not False:
        box = placement.text_box(img) if content == "text" and not cut else placement.subject_box(img, content)
    if box:
        if content == "text":                      # the same words on a narrower card: same size
            tscale = (box[2] - box[0]) / img.width
        img = img.crop(box)
    return {"image": img, "cutout": cut, "content": content, **({"crop": list(box)} if box else {}),
            **({"textScale": round(tscale, 4)} if tscale < 1.0 else {})}


def text_scale(st: Optional[dict]) -> float:
    """How much narrower a text card is than the image it was cropped from (1.0 = uncropped)."""
    return float((st or {}).get("textScale") or 1.0)


def is_photo(st: Optional[dict], params: dict) -> bool:
    """A photo / poster / film still (no small text): its own, lower readable floor."""
    return bool(st) and st.get("content") == "photo" and params.get("iconic") is None


def _content_rec(st: Optional[dict]) -> dict:
    """The record fields saying what a still was measured as (and how it was cropped)."""
    if not st:
        return {}
    return {"content": st.get("content"), **({"crop": st["crop"]} if st.get("crop") else {}),
            **({"textScale": st["textScale"]} if st.get("textScale") else {}),
            **({"aspectCrop": st["aspectCrop"]} if st.get("aspectCrop") else {})}


def _refit_photo(st: Optional[dict], zone: Optional[dict], W: int, H: int, params: dict) -> Optional[dict]:
    """A photo too small to read in `zone`: the same photo cover-cropped toward the zone's shape
    (placement.aspect_crop: <= 30% of it, never through a face), or None. Text and logos never."""
    if zone is None or not is_photo(st, params) or params.get("crop", True) is False:
        return None
    gz = shadow_zone(zone, W, H)
    pad = 2 * _shadow_pad(0, W)
    box = placement.aspect_crop(st["image"], max(0.2, (gz["w"] - pad) / max(1.0, gz["h"] - pad)))
    if not box:
        return None
    return {**st, "image": st["image"].crop(box), "aspectCrop": list(box)}


def _side_fit(zones, side, st, aspect, W, H, tilt, iconic, params):
    """side_card_fit, and for a photo that doesn't read there, the same with the photo cropped to
    the side zone's shape. -> (fit, st, aspect)."""
    fit = side_card_fit(zones, side, aspect, W, H, tilt, iconic, photo=is_photo(st, params), tscale=text_scale(st))
    if not fit["ok"]:
        st2 = _refit_photo(st, fit["zone"] or _side_zone(zones, side), W, H, params)
        if st2 is not None:
            a2 = st2["image"].width / st2["image"].height
            fit2 = side_card_fit(zones, side, a2, W, H, tilt, iconic, photo=True)
            if fit2["ok"]:
                return fit2, st2, a2
    return fit, st, aspect


def is_iconic(st: Optional[dict], W: int, params: dict) -> bool:
    """A logo / icon / cut-out (or an asset too small to blow up) reads at a smaller size than a
    card with text on it. params.iconic overrides the guess."""
    if params.get("iconic") is not None:
        return bool(params["iconic"])
    if not st:
        return False
    return bool(st.get("cutout")) or st.get("content") == "logo" or \
        max(st["image"].width, st["image"].height) < 0.30 * W


def readable(cw: float, ch: float, W: int, H: int, iconic: bool, params: dict, scale: float = 1.0,
             min_width: Optional[float] = None, photo: bool = False, tscale: float = 1.0) -> bool:
    """Is a cw x ch card big enough to read on a phone? Text cards: >= CARD_MIN_WIDTH of the frame
    wide (or params.minWidth); icons: >= ICON_MIN_WIDTH wide and ICON_MIN_AREA of the frame. A
    deliberate scale < 1 lowers the floor with it. `tscale` < 1 = a text card cropped to its words
    (placement.text_box): the floor shrinks with it, so its words render exactly as big as on the
    whole image at the full floor (never below TEXT_MIN_WIDTH_FLOOR)."""
    s = min(1.0, float(scale))
    if iconic:
        return cw >= ICON_MIN_WIDTH * W * s and cw * ch >= ICON_MIN_AREA * W * H * s * s
    mw = params.get("minWidth")
    mw = float(mw) if mw is not None else (min_width if min_width is not None else CARD_MIN_WIDTH)
    if photo and params.get("minWidth") is None:       # a picture reads smaller than words
        mw = min(mw, placement.PHOTO_MIN_WIDTH)
    elif tscale < 1.0 and params.get("minWidth") is None:
        mw = max(min(mw, TEXT_MIN_WIDTH_FLOOR), mw * tscale)
    return cw >= mw * W * s - 0.5


def _t_card(ctx, plan, params, kind, src, zones, face, frame, where="above-face"):
    W, H, _ = fmt_of(ctx)
    zone = placement.zone(zones, where) or placement.zone(zones, "above-face")
    low = where in ("above-face", "upper")      # as low as the brow line allows
    tilt = float(params.get("tilt", -2.5))
    scale = float(params.get("scale", 1.0))
    maxw = float(params.get("maxWidth", 0.88))
    radius = float(params.get("radius", 0.026))
    stem = f"{plan['id']}-{_key(plan['treatment'], _asset_sig(src), params, zone, face, frame.get('zoom'))}"
    fallback_ok = params.get("fallback", True) and where == "above-face"
    if kind == "image":
        st = _load_still(ctx, src, params)
        canvas, x, y, (cw, ch) = _card_layout(ctx, st, zone, tilt, scale, maxw, face, radius,
                                              shadow=bool(params.get("shadow", True)), low=low)
        ok = readable(cw, ch, W, H, is_iconic(st, W, params), params, scale, photo=is_photo(st, params),
                      tscale=text_scale(st))
        st2 = None if ok else _refit_photo(st, zone, W, H, params)
        if st2 is not None:                  # a photo cropped to the room's shape may read there
            c2 = _card_layout(ctx, st2, zone, tilt, scale, maxw, face, radius,
                              shadow=bool(params.get("shadow", True)), low=low)
            if readable(c2[3][0], c2[3][1], W, H, False, params, scale, photo=True):
                st, ok = st2, True
                canvas, x, y, (cw, ch) = c2
        if not ok and fallback_ok:
            return _card_fallback(ctx, plan, params, kind, src, zones, face, frame,
                                  st["image"].width / st["image"].height, is_iconic(st, W, params), st)
        path = _save_png(canvas, ctx, stem)
        bbox = _opaque_bbox(canvas, x, y)
        return [Layer(path, "image", plan["t0"], plan["t1"], x, y, canvas.width, canvas.height, 0.0)], \
            {"zone": zone["zone"], "bbox": bbox, "cardWidth": round(cw / W, 3), **_content_rec(st)}
    # video card: no tilt (moving footage stays level), rounded, shadowed
    info = probe(src, ctx)
    aspect = info["width"] / max(1, info["height"])
    pad = _shadow_pad(0, W)
    gz = shadow_zone(zone, W, H, pad)
    cw = min(fit_rotated(aspect, gz["w"], gz["h"], 0, pad) * min(1.0, scale), maxw * W)
    if not readable(cw, cw / aspect, W, H, bool(params.get("iconic")), params, scale) and fallback_ok:
        return _card_fallback(ctx, plan, params, kind, src, zones, face, frame, aspect, bool(params.get("iconic")))
    cin, dur = _clip_window(ctx, src, params, plan["t1"] - plan["t0"])
    plan["t1"] = plan["t0"] + dur
    cw, ch = int(round(cw)) // 2 * 2, int(round(cw / aspect)) // 2 * 2
    from PIL import Image, ImageDraw
    blank = Image.new("RGBA", (cw, ch), (0, 0, 0, 255))
    chrome = _with_shadow(_round(blank, int(radius * W)), pad)
    mask = Image.new("L", (cw, ch), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, cw - 1, ch - 1], int(radius * W), fill=255)
    path = _video_card(ctx, src, cin, dur, chrome, (pad, pad), mask, stem)
    x, y = _place_in(gz, chrome.width, chrome.height, face[0] + face[2] / 2,
                     gz["y"] + gz["h"] if low else None)
    return [Layer(path, "video", plan["t0"], plan["t1"], x, y, chrome.width, chrome.height, 0.0)], \
        {"zone": zone["zone"], "bbox": (x + pad, y + pad, x + pad + cw, y + pad + ch), "cardWidth": round(cw / W, 3)}


def _card_fallback(ctx, plan, params, kind, src, zones, face, frame, aspect, iconic=False, st=None):
    """card-above-head can't read above the brows: a tall asset goes beside the face if it reads
    there (a text card still >= UPPER_SIDE_MIN_WIDTH wide), else (last resort) the split view. The
    record says which, in plain words."""
    W, H, _ = fmt_of(ctx)
    photo = is_photo(st, params)
    if aspect < 1.0 or photo:
        tilt = abs(float(params.get("tilt", 2.0))) if kind == "image" else 0.0
        fit, _st, _a = _side_fit(zones, "auto", st, aspect, W, H, tilt, iconic, params)
        if fit["ok"] and readable(fit["w"], fit["h"], W, H, iconic, params, min_width=UPPER_SIDE_MIN_WIDTH,
                                  photo=photo, tscale=text_scale(st)):
            layers, rec = _t_side(ctx, plan, {k: v for k, v in params.items() if k not in ("side", "maxWidth")},
                                  kind, src, zones, face, frame, allow_upper=False)
            rec["fallback"] = "too tall to read above the head; shown beside the face instead"
            rec["fallbackTreatment"] = "side-card"
            return layers, rec
    if kind == "image" and st is not None:
        # over the hair on one side of the top band, as low as the brows allow: the spot a side card
        # takes when the strip beside a close-up face is too narrow (same readable floor)
        tilt0 = abs(float(params.get("tilt", 2.5)))
        side = "right" if face[0] + face[2] / 2 < W / 2 else "left"     # the side with more room
        for sd in (side, "left" if side == "right" else "right"):
            up = _upper_side(ctx, plan, {k: v for k, v in params.items() if k not in ("side", "maxWidth")},
                             kind, src, zones, face, frame, st, aspect, tilt0, sd)
            if up is not None:
                layers, rec = up
                rec.pop("note", None)               # moved and smaller than asked: the render result says so
                rec["fallback"] = (f"too big to read centred above the face; shown a little smaller over the hair "
                                   f"on the {sd} instead")
                return layers, rec
    layers, rec = _t_split(ctx, plan, params, kind, src, zones, face, frame)
    rec["fallback"] = "too small to read above the face; shown above the speaker instead"
    rec["fallbackTreatment"] = "split-top"
    return layers, rec


def _side_zone(zones, side: str):
    left, right = placement.zone(zones, "left"), placement.zone(zones, "right")
    if side == "left":
        return left
    if side == "right":
        return right
    cands = [z for z in (left, right) if z]
    return max(cands, key=lambda z: z["w"]) if cands else None


def side_card_fit(zones, side: str, aspect: float, W: int, H: int, tilt: float = 2.0,
                  iconic: bool = True, photo: bool = False, tscale: float = 1.0) -> dict:
    """Where a side card would go and whether it reads: {"zone", "side", "w", "h", "ok", "why"}.
    `side` is left | right | auto (auto = the side giving the bigger card). Readable = at least
    SIDE_MIN_WIDTH of the frame wide and SIDE_MIN_AREA of its area: a card squeezed into the strip
    beside a close-up face is a sticker nobody can read."""
    cands = []
    for name in (("left", "right") if side not in ("left", "right") else (side,)):
        z = placement.zone(zones, name)
        if z is None:
            cands.append({"zone": None, "side": name, "w": 0, "h": 0})
            continue
        gz = shadow_zone(z, W, H)
        cw = fit_rotated(aspect, gz["w"], gz["h"], tilt, _shadow_pad(0, W))
        cands.append({"zone": z, "side": name, "w": cw, "h": cw / aspect})
    best = max(cands, key=lambda c: c["w"] * c["h"])
    ok = best["zone"] is not None and best["w"] >= SIDE_MIN_WIDTH * W and \
        best["w"] * best["h"] >= SIDE_MIN_AREA * W * H
    if ok and not iconic:          # a card with text must still read: no small still beside the face
        ok = readable(best["w"], best["h"], W, H, False, {}, min_width=UPPER_SIDE_MIN_WIDTH, photo=photo,
                      tscale=tscale)
    why = None
    if not ok:
        room = int(best["zone"]["w"]) if best["zone"] else 0
        where = "beside the face" if side not in ("left", "right") else f"on the {side} of the face"
        why = (f"no room {where} (only {room} px of {W}); shown above the speaker in a split view instead")
    return {**best, "ok": ok, "why": why}


def upper_side_zone(zones, side: str, W: int) -> Optional[dict]:
    """The `side` part of the top band (down to the brows): a side card that can't fit beside a
    close-up face sits there instead, over the hair on its side, clear of the eyes-to-chin zone."""
    top = placement.zone(zones, "above-face")
    if top is None:
        return None
    w = int(round(top["w"] * UPPER_SIDE_WIDTH))
    x = top["x"] if side == "left" else top["x"] + top["w"] - w
    return {**top, "zone": f"above-face-{side}", "x": x, "w": w}


def _t_side(ctx, plan, params, kind, src, zones, face, frame, allow_upper=True):
    """Card LEFT or RIGHT of the face (param side: left | right | auto), vertically on the face,
    tilted toward it. No readable room beside the eyes-to-chin zone -> the same card over the hair
    on that side (top band, down to the brows) if it reads there -> split view (asset on top,
    speaker below) as the last resort, and the record says so, so the editor can tell the user."""
    W, H, _ = fmt_of(ctx)
    side = str(params.get("side") or "auto").lower()
    st = None
    if kind == "image":
        st = _load_still(ctx, src, params)
        aspect = st["image"].width / st["image"].height
    else:
        info = probe(src, ctx)
        aspect = info["width"] / max(1, info["height"])
    tilt0 = abs(float(params.get("tilt", 2.0))) if kind == "image" else 0.0
    fit, st, aspect = _side_fit(zones, side, st, aspect, W, H, tilt0,
                                is_iconic(st, W, params) if st else bool(params.get("iconic")), params)
    if not fit["ok"] and allow_upper:
        up = _upper_side(ctx, plan, params, kind, src, zones, face, frame, st, aspect, tilt0, fit["side"])
        if up is not None:
            return up
    if not fit["ok"]:
        layers, rec = _t_split(ctx, plan, {k: v for k, v in params.items() if k not in ("tilt", "side")},
                               kind, src, zones, face, frame)
        rec["fallback"] = fit["why"]
        rec["fallbackTreatment"] = "split-top"
        return layers, rec
    z = fit["zone"]
    scale = float(params.get("scale", 1.0))
    if kind == "video":
        layers, rec = _t_card(ctx, plan, {**params, "tilt": 0, "maxWidth": 1.0}, kind, src,
                              [{**z, "zone": "above-face"}], face, frame, where="side")
        rec["zone"] = z["zone"]
        return layers, rec
    tilt = tilt0 * (1 if z["zone"] == "right" else -1)     # lean toward the face
    canvas, x, y, (cw, ch) = _card_layout(ctx, st, z, tilt, scale, 1.0, face,
                                          float(params.get("radius", 0.022)), center_x=z["x"] + z["w"] / 2)
    # vertically centre on the face
    gz = shadow_zone(z, W, H)
    y = int(min(max(face[1] + face[3] / 2 - canvas.height / 2, gz["y"]), gz["y"] + gz["h"] - canvas.height))
    stem = f"{plan['id']}-{_key('side', _asset_sig(src), params, z, face)}"
    path = _save_png(canvas, ctx, stem)
    return [Layer(path, "image", plan["t0"], plan["t1"], x, y, canvas.width, canvas.height, 0.0)], \
        {"zone": z["zone"], "bbox": _opaque_bbox(canvas, x, y), "cardWidth": round(cw / W, 3), **_content_rec(st)}


def _upper_side(ctx, plan, params, kind, src, zones, face, frame, st, aspect, tilt0, side):
    """Side card over the hair on its side (see upper_side_zone), or None if it wouldn't read."""
    W, H, _ = fmt_of(ctx)
    side = side if side in ("left", "right") else "left"
    z = upper_side_zone(zones, side, W)
    if z is None:
        return None
    scale = float(params.get("scale", 1.0))
    gz = shadow_zone(z, W, H)
    iconic = is_iconic(st, W, params) if st else bool(params.get("iconic"))

    def reads(a):
        cw = fit_rotated(a, gz["w"], gz["h"], tilt0, _shadow_pad(0, W)) * min(1.0, scale)
        return readable(cw, cw / a, W, H, iconic, params, scale, UPPER_SIDE_MIN_WIDTH, photo=is_photo(st, params),
                        tscale=text_scale(st))
    if not reads(aspect):
        st2 = _refit_photo(st, z, W, H, params) if kind == "image" else None   # a tall photo: cover-crop it
        if st2 is None or not reads(st2["image"].width / st2["image"].height):
            return None
        st, aspect = st2, st2["image"].width / st2["image"].height
    if kind == "video":
        layers, rec = _t_card(ctx, plan, {**params, "tilt": 0, "maxWidth": 1.0}, kind, src,
                              [{**z, "zone": "above-face"}], face, frame, where="upper")
        rec["zone"] = z["zone"]
        return layers, rec
    tilt = tilt0 * (1 if side == "right" else -1)           # lean toward the face
    canvas, x, y, (cw, ch) = _card_layout(ctx, st, z, tilt, scale, 1.0, face, float(params.get("radius", 0.022)),
                                          center_x=z["x"] + (0 if side == "left" else z["w"]), low=True)
    stem = f"{plan['id']}-{_key('side-up', _asset_sig(src), params, z, face)}"
    path = _save_png(canvas, ctx, stem)
    return [Layer(path, "image", plan["t0"], plan["t1"], x, y, canvas.width, canvas.height, 0.0)], \
        {"zone": z["zone"], "bbox": _opaque_bbox(canvas, x, y), "cardWidth": round(cw / W, 3), **_content_rec(st),
         "note": f"no room beside the face; shown over the hair on the {side} instead"}


def _phone_screen(ctx, src, kind, sw, sh, params):
    if kind == "image":
        img = open_image(src)
        return _cover(img, sw, sh, 0.5, float(params.get("focusY", 0.0)))
    return None


def _t_phone(ctx, plan, params, kind, src, zones, face, frame):
    W, H, _ = fmt_of(ctx)
    z = _side_zone(zones, params.get("side", "auto"))
    ratio = 19.5 / 9.0
    stem = f"{plan['id']}-{_key('phone', _asset_sig(src), params, zones, face, frame.get('zoom'))}"
    if z is None or min(z["w"], z["h"] / ratio) < MIN_PHONE_WIDTH * W * 1.09:
        # no room beside the face for a phone you can read: phone on top, speaker below. A phone
        # is tall, so its top part is at least 45% of the frame even if captions then touch the chin.
        if not isinstance(params.get("split"), (int, float)):
            th_auto, _, _ = split_geometry(ctx, face, {})
            params = {**params, "split": max(th_auto / H, 0.45)}
        th, _, _ = split_geometry(ctx, face, params)
        from PIL import Image
        bgc = _rgba(params.get("background", "#EDEBE7"))
        top = Image.new("RGBA", (W, th), bgc)
        ph = int(th * 0.90)
        sw = int(round((ph / ratio) * 0.91)) // 2 * 2
        sh = int(round(sw * ratio)) // 2 * 2
        body, (ox, oy), mask = _phone_chrome(sw, sh, W)
        if kind == "image":
            body.paste(_phone_screen(ctx, src, kind, sw, sh, params), (ox, oy), mask)
            top.alpha_composite(body, ((W - body.width) // 2, (th - body.height) // 2))
            png = _save_png(top, ctx, stem + "-top")
            path = _split_video(ctx, plan["t0"], plan["t1"], src, "image", 0.0, params, face, stem, top_png=png)
        else:
            cin, dur = _clip_window(ctx, src, params, plan["t1"] - plan["t0"])
            plan["t1"] = plan["t0"] + dur
            card = _video_card(ctx, src, cin, dur, body, (ox, oy), mask, stem + "-ph")
            top_bg = _save_png(top, ctx, stem + "-bg")
            path = _phone_split(ctx, plan, card, top_bg, body.size, face, params, stem)
        return [Layer(path, "video", plan["t0"], plan["t1"], 0, 0, W, H, 0.0)], \
            {"zone": "split-top", "bbox": (0, 0, W, th), "fallback": "no room beside the face; phone shown above the speaker"}
    sh = int(min(z["h"], z["w"] * ratio / 1.09) * 0.96 * min(1.0, float(params.get("scale", 1.0))))
    sw = int(round(sh / ratio)) // 2 * 2
    sh = int(round(sw * ratio)) // 2 * 2
    body, (ox, oy), mask = _phone_chrome(sw, sh, W)
    cy = face[1] + face[3] / 2
    if kind == "image":
        body.paste(_phone_screen(ctx, src, kind, sw, sh, params), (ox, oy), mask)
        canvas = _with_shadow(body, _shadow_pad(0, W))
        x, y = _place_in(z, canvas.width, canvas.height, z["x"] + z["w"] / 2, cy)
        path = _save_png(canvas, ctx, stem)
        return [Layer(path, "image", plan["t0"], plan["t1"], x, y, canvas.width, canvas.height, 0.0)], \
            {"zone": z["zone"], "bbox": _opaque_bbox(canvas, x, y)}
    cin, dur = _clip_window(ctx, src, params, plan["t1"] - plan["t0"])
    plan["t1"] = plan["t0"] + dur
    path = _video_card(ctx, src, cin, dur, body, (ox, oy), mask, stem)
    x, y = _place_in(z, body.width, body.height, z["x"] + z["w"] / 2, cy)
    return [Layer(path, "video", plan["t0"], plan["t1"], x, y, body.width, body.height, 0.0)], \
        {"zone": z["zone"], "bbox": (x, y, x + body.width, y + body.height)}


def _phone_split(ctx, plan, card_mov, top_bg_png, card_size, face, params, stem):
    """Video phone above the speaker: compose the phone .mov on its plain top band, then split."""
    W, H, fps = fmt_of(ctx)
    d = layers_dir(ctx)
    th, _, _ = split_geometry(ctx, face, params)
    dur = plan["t1"] - plan["t0"]
    top = d / f"{stem}-top.mp4"
    if not top.exists():
        cw, chh = card_size
        run([ffmpeg_bin(ctx), "-y", "-v", "error", "-nostdin",
             "-loop", "1", "-framerate", str(fps), "-t", f"{dur:.3f}", "-i", str(top_bg_png), "-i", str(card_mov),
             "-filter_complex", f"[0:v]format=rgba[b];[b][1:v]overlay={(W - cw) // 2}:{(th - chh) // 2}:format=auto,format=yuv420p[o]",
             "-map", "[o]", "-an", *_enc(ctx), "-t", f"{dur:.3f}", str(top)], timeout=max(120, dur * 30), what="phone top")
    return _split_video(ctx, plan["t0"], plan["t1"], top, "video", 0.0, params, face, stem)


def _t_full(ctx, plan, params, kind, src, zones, face, frame):
    W, H, _ = fmt_of(ctx)
    fit = params.get("fit", "auto")
    bg = params.get("background", "#101010")
    fx, fy = float(params.get("focusX", 0.5)), float(params.get("focusY", 0.5))
    stem = f"{plan['id']}-{_key('full', _asset_sig(src), params, W, H)}"
    if kind == "image":
        img = open_image(src)
        if fit == "auto":
            fit = "cover" if abs(math.log((img.width / img.height) / (W / H))) < 0.22 else "contain"
        from PIL import Image
        if fit == "cover":
            canvas = _cover(img, W, H, fx, fy)
        else:
            canvas = Image.new("RGBA", (W, H), _rgba(bg))
            c = _contain(img, int(W * 0.96), int(H * 0.80))
            canvas.alpha_composite(c, ((W - c.width) // 2, (H - c.height) // 2))
        path = _save_png(canvas.convert("RGBA"), ctx, stem)
        return [Layer(path, "image", plan["t0"], plan["t1"], 0, 0, W, H, 0.0)], {"zone": "full", "bbox": (0, 0, W, H)}
    cin, dur = _clip_window(ctx, src, params, plan["t1"] - plan["t0"])
    plan["t1"] = plan["t0"] + dur
    info = probe(src, ctx)
    if fit == "auto":
        # close to the frame's shape: fill it; anything else keeps its own composition (letterboxed)
        fit = "cover" if abs(math.log((info["width"] / max(1, info["height"])) / (W / H))) < 0.22 else "contain"
    path = _video_full(ctx, src, cin, dur, fit, bg, stem, fx, fy)
    return [Layer(path, "video", plan["t0"], plan["t1"], 0, 0, W, H, 0.0)], {"zone": "full", "bbox": (0, 0, W, H)}


def _t_split(ctx, plan, params, kind, src, zones, face, frame):
    W, H, _ = fmt_of(ctx)
    stem = f"{plan['id']}-{_key('split', _asset_sig(src), params, face, W, H)}"
    th, _, clear = split_geometry(ctx, face, params)
    if kind == "image":
        from PIL import Image
        img = open_image(src)
        fit = params.get("fit", "auto")
        if fit == "auto":   # keep a screenshot's whole composition unless it already has the shape
            fit = "cover" if abs(math.log((img.width / img.height) / (W / th))) < 0.25 else "contain"
        if fit == "cover":
            top = _cover(img, W, th, float(params.get("focusX", 0.5)), float(params.get("focusY", 0.5)))
        else:
            top = Image.new("RGBA", (W, th), _rgba(params.get("background", "#101010")))
            c = _contain(img, int(W * 0.94), int(th * 0.92))
            top.alpha_composite(c, ((W - c.width) // 2, (th - c.height) // 2))
        png = _save_png(top, ctx, stem + "-top")
        path = _split_video(ctx, plan["t0"], plan["t1"], src, "image", 0.0, params, face, stem, top_png=png)
    else:
        cin, dur = _clip_window(ctx, src, params, plan["t1"] - plan["t0"])
        plan["t1"] = plan["t0"] + dur
        path = _split_video(ctx, plan["t0"], plan["t1"], src, "video", cin, params, face, stem)
    rec = {"zone": "split-top", "bbox": (0, 0, W, th), "split": th}
    if not clear:
        rec["warning"] = "captions cross the speaker's face in the split view (close-up framing)"
        rec["captionHintY"] = th / H        # render may centre captions on the seam for this window
    return [Layer(path, "video", plan["t0"], plan["t1"], 0, 0, W, H, 0.0)], rec


def _t_text(ctx, plan, params, kind, src, zones, face, frame):
    W, H, _ = fmt_of(ctx)
    text = params.get("text") or plan["item"].get("text")
    if not text:
        text = " ".join((_word_text(ctx, w) for w in word_ids_between(ctx, plan["word_from"], plan["word_to"])))
    label = params.get("style") == "label"
    asked = plan["item"].get("params") or {}          # the template defaults are for the big-words look
    case = asked.get("case", "as-is") if label else params.get("case", "upper")
    if case == "upper":
        text = text.upper()
    zone = placement.zone(zones, "above-face")
    tilt = float(params.get("tilt", -3.0))
    want = float(asked.get("size", LABEL_SIZE)) if label else float(params.get("size", 0.11))
    size = int(want * W) if want < 1 else int(want)
    while True:
        if label:
            img, ok = _label_image(text, int(zone["w"] * 0.94), size, W)
        else:
            img, ok = _text_image(text, int(zone["w"] * 0.94), size, params.get("color", "#FFFFFF"),
                                  params.get("outline", "#000000"), W)
        rot = _rotate(img, tilt)
        if (rot.width <= zone["w"] and rot.height <= zone["h"] and ok) or size <= int(0.045 * W):
            break
        size = int(size * 0.9)
    x, y = _place_in(zone, rot.width, rot.height, face[0] + face[2] / 2, None)
    stem = f"{plan['id']}-{_key('text', text, params, zone)}"
    path = _save_png(rot, ctx, stem)
    return [Layer(path, "image", plan["t0"], plan["t1"], x, y, rot.width, rot.height, 0.0)], \
        {"zone": zone["zone"], "bbox": _opaque_bbox(rot, x, y), "text": text, "fontPx": size}


def _word_text(ctx, wid):
    from .compose_util import ctx_words
    return str((ctx_words(ctx).get(wid) or {}).get("w", "")).strip()


def _items(ctx, plan, params) -> list[Path]:
    paths = []
    for it in params.get("items") or []:
        paths.append(_asset_path(ctx, it))
    a = plan["item"].get("asset")
    if a:
        p = _asset_path(ctx, a)
        if p.is_dir():
            # a symlink inside an allowed folder must not pull in a file from outside it
            paths += sorted(q for q in p.iterdir() if kind_of(q) == "image" and _contained(ctx, q))
        elif not paths:
            paths.append(p)
    if not paths:
        raise EngineError("WALL_EMPTY", f"{plan['id']}: wall has no images",
                          "This picture wall has no pictures in it yet.")
    return paths


def _contained(ctx, q: Path) -> bool:
    try:
        resolve_asset(ctx, str(q))
        return True
    except EngineError:
        log(f"post-wall: {q.name} points outside the project; left out")
        return False


def _build_times(ctx, plan, n: int) -> list[float]:
    """One appearance per spoken word across the anchor (lead applied); evenly spread if short."""
    words = word_ids_between(ctx, plan["word_from"], plan["word_to"])
    lead = float(plan["item"].get("leadIn", LEAD) or LEAD)
    starts = [max(plan["t0"], (word_start(ctx, w) or plan["t0"]) - lead) for w in words]
    if len(starts) >= n:
        return starts[:n]
    span = max(0.2, (word_end(ctx, plan["word_to"]) or plan["t1"]) - plan["t0"])
    return [plan["t0"] + span * k / n for k in range(n)]


def _t_post_wall(ctx, plan, params, kind, src, zones, face, frame):
    from PIL import Image
    W, H, _ = fmt_of(ctx)
    paths = _items(ctx, plan, params)
    n = len(paths)
    cols = int(params.get("columns", 3))
    gap = int(round(float(params.get("gap", 0.012)) * W))
    tw = (W - (cols + 1) * gap) // cols
    th = int(round(tw * 16 / 9))
    rows = math.ceil(n / cols)
    if rows * (th + gap) + gap > H:          # many posts: shorter tiles so the whole wall fits
        th = (H - (rows + 1) * gap) // rows
    total_h = rows * th + (rows + 1) * gap
    y_off = max(0, (H - total_h) // 2)
    times = _build_times(ctx, plan, n)
    bg = Image.new("RGBA", (W, H), _rgba(params.get("background", "#101010")))
    layers = [Layer(_save_png(bg, ctx, f"{plan['id']}-bg-{_key(params.get('background'), W, H)}"), "image",
                    plan["t0"], plan["t1"], 0, 0, W, H, 0.0, 0)]
    for k, p in enumerate(paths):
        r, c = divmod(k, cols)
        x = gap + c * (tw + gap)
        y = y_off + gap + r * (th + gap)
        tile = _round(_cover(open_image(p), tw, th, 0.5, 0.3), int(0.012 * W))
        path = _save_png(tile, ctx, f"{plan['id']}-t{k}-{_key(_asset_sig(p), tw, th)}")
        layers.append(Layer(path, "image", times[k], plan["t1"], x, y, tw, th, 0.0, k + 1))
    return layers, {"zone": "full", "bbox": (0, 0, W, H), "tiles": n}


def _t_icon_wall(ctx, plan, params, kind, src, zones, face, frame):
    from PIL import Image, ImageDraw
    import numpy as np
    W, H, _ = fmt_of(ctx)
    paths = _items(ctx, plan, params)
    n = len(paths)
    zone = placement.zone(zones, "above-face")
    best = None
    for cols in range(1, n + 1):
        rows = math.ceil(n / cols)
        cell = min(zone["w"] / cols, zone["h"] / rows)
        if best is None or cell > best[0]:
            best = (cell, cols, rows)
    cell, cols, rows = best
    full = cell < 0.13 * W
    layers = []
    if full:   # too many to read above the face: a full-screen wall instead
        cols = max(2, math.ceil(math.sqrt(n * 0.6)))
        rows = math.ceil(n / cols)
        cell = min((W * 0.92) / cols, (H * 0.70) / rows)
        zone = {"zone": "full", "x": int((W - cell * cols) / 2), "y": int((H - cell * rows) / 2),
                "w": int(cell * cols), "h": int(cell * rows)}
        bg = Image.new("RGBA", (W, H), _rgba(params.get("background", "#101010")))
        layers.append(Layer(_save_png(bg, ctx, f"{plan['id']}-bg-{_key(W, H, params.get('background'))}"), "image",
                            plan["t0"], plan["t1"], 0, 0, W, H, 0.0, 0))
    ox = zone["x"] + (zone["w"] - cell * cols) / 2
    oy = zone["y"] + (zone["h"] - cell * rows) / 2
    pad = cell * 0.10
    times = _build_times(ctx, plan, n)
    bboxes = []
    for k, p in enumerate(paths):
        r, c = divmod(k, cols)
        icon = _trim_alpha(open_image(p))
        inner = int(cell - 2 * pad)
        ic = _contain(icon, inner, inner)
        tile = Image.new("RGBA", (int(cell), int(cell)), (0, 0, 0, 0))
        # a logo that would wash out gets a white tile (bright icon on a bright wall stays bare)
        a = np.asarray(ic.getchannel("A")) > 128
        lum = float((np.asarray(ic.convert("L"))[a]).mean()) if a.any() else 128.0
        if params.get("tile", "auto") in ("white", True) or (params.get("tile", "auto") == "auto" and lum < 70 and not full):
            ImageDraw.Draw(tile).rounded_rectangle([pad * 0.3, pad * 0.3, cell - pad * 0.3, cell - pad * 0.3],
                                                   int(cell * 0.18), fill=(255, 255, 255, 255),
                                                   outline=(30, 30, 30, 255), width=max(2, int(cell * 0.015)))
        tile.alpha_composite(ic, ((tile.width - ic.width) // 2, (tile.height - ic.height) // 2))
        x, y = int(ox + c * cell), int(oy + r * cell)
        path = _save_png(tile, ctx, f"{plan['id']}-i{k}-{_key(_asset_sig(p), cell, params)}")
        layers.append(Layer(path, "image", times[k], plan["t1"], x, y, tile.width, tile.height, 0.0, k + 1))
        bb = _opaque_bbox(tile, x, y)
        if bb:
            bboxes.append(bb)
    union = (min(b[0] for b in bboxes), min(b[1] for b in bboxes), max(b[2] for b in bboxes), max(b[3] for b in bboxes)) \
        if bboxes else None
    return layers, {"zone": zone["zone"], "bbox": (0, 0, W, H) if full else union, "icons": n}


def _t_anim(ctx, plan, params, kind, src, zones, face, frame):
    """A rendered animation: full-frame transparent clip at 0,0, unscaled, its own length (the last
    frame holds if the window is longer). The record's bbox is the region the content was rendered
    into, so check_layers still catches an animation that now sits over the eyes (face moved, cut
    changed); a `full` animation hides the speaker on purpose."""
    W, H, fps = fmt_of(ctx)
    sc = animation_sidecar(src) or {"kind": ANIM_KIND}
    info = probe(src, ctx)
    have = float(info.get("duration") or sc.get("duration") or 0.0)
    want = plan["t1"] - plan["t0"]
    path = src
    if have and want > have + 1.0 / fps:          # hold the last frame for the rest of the window
        stem = f"{plan['id']}-{_key('anim-hold', _asset_sig(src), round(want, 3))}"
        out = layers_dir(ctx) / f"{stem}.mov"
        if not out.exists():
            tmp = layers_dir(ctx) / f"{stem}.part.mov"
            run([ffmpeg_bin(ctx), "-y", "-v", "error", "-nostdin", "-i", str(src),
                 "-vf", f"fps={fps},tpad=stop_mode=clone:stop_duration={want - have + 0.1:.3f}",
                 "-an", "-c:v", "qtrle", "-pix_fmt", "argb", "-t", f"{want:.3f}", str(tmp)],
                timeout=max(120, want * 30), what="animation hold")
            tmp.replace(out)
        path = out
    elif have:
        plan["t1"] = min(plan["t1"], plan["t0"] + have)
    region = animation_region(sc, W, H)
    rec = {"zone": "animation" if region else "full", "template": sc.get("template"),
           "bbox": (0, 0, W, H) if region is None else
           (int(region["x"]), int(region["y"]), int(region["x"] + region["w"]), int(region["y"] + region["h"]))}
    if int(info.get("width") or W) != W or int(info.get("height") or H) != H:
        rec["warning"] = f"animation is {info.get('width')}x{info.get('height')}, the video is {W}x{H}; scaled to fit"
    return [Layer(path, "video", plan["t0"], plan["t1"], 0, 0, W, H, 0.0)], rec


TREATMENT_FNS = {
    "card-above-head": _t_card, "full-frame": _t_full, "phone-card": _t_phone, "side-card": _t_side,
    "text-pop": _t_text, "post-wall": _t_post_wall, "icon-wall": _t_icon_wall, "split-top": _t_split,
    "animation": _t_anim,
}


# --- entry point -------------------------------------------------------------------------------

def build_layers(ctx) -> list:
    """project.broll -> [Layer] (output seconds, output px). Also writes work/layers/layers.json,
    the per-item record (zone, opaque bbox, fallbacks, skips) that verify and the AI can read."""
    plans = plan_windows(ctx)
    out, records = [], []
    for k, plan in enumerate(plans):
        it = plan["item"]
        tname = plan["treatment"]
        fn = TREATMENT_FNS.get(tname)
        report(ctx, "broll", 100.0 * k / max(1, len(plans)), "Adding pictures")
        if fn is None:
            log(f"broll {plan['id']}: unknown treatment {tname!r}; skipped")
            records.append({"id": plan["id"], "skipped": f"unknown treatment {tname}"})
            continue
        params = {**treatment_defaults(tname), **(it.get("params") or {})}
        params = {k2: v for k2, v in params.items() if v is not None or k2 == "text"}
        asked = tname
        try:
            src, kind = None, "none"
            if it.get("asset") and tname not in ("post-wall", "icon-wall"):
                src = _asset_path(ctx, it["asset"])
                kind = kind_of(src)
                if kind not in ("image", "video"):
                    raise EngineError("ASSET_KIND", f"{src.name} is {kind}",
                                      "This b-roll file isn't a picture or a video.")
            elif tname not in ("text-pop", "post-wall", "icon-wall"):
                raise EngineError("ASSET_NONE", f"{plan['id']}: {tname} needs an asset",
                                  "This b-roll needs a picture or a clip.")
            asked = tname
            if src is not None and tname != "animation" and animation_sidecar(src) is not None:
                tname, fn = "animation", _t_anim       # a finished full-frame layer, never a card
            elif tname == "animation" and (src is None or animation_sidecar(src) is None):
                raise EngineError("ANIM_NOT_ANIMATION", f"{plan['id']}: animation treatment without an animation file",
                                  "This b-roll is set to show an animation, but its file isn't one. Make the animation again.")
            zones, face, frame = zones_for(ctx, plan["t0"], plan["t1"])
            layers, rec = fn(ctx, plan, params, kind, src, zones, face, frame)
            if asked != tname:
                rec["note"] = f"an animation is shown full-frame as rendered (asked for {asked})"
        except EngineError as e:
            log(f"broll {plan['id']}: {e.message}")
            records.append({"id": plan["id"], "treatment": tname,
                            "skipped": getattr(e, "user_message", None) or "This b-roll couldn't be added.",
                            "detail": e.message})
            continue
        base_z = 10 * (k + 1)
        fade = params.get("fade")
        for L in layers:
            L.z = base_z + (L.z or 0)
            if fade:
                fi, fo = (fade, fade) if isinstance(fade, (int, float)) else fade
                L.fade_in, L.fade_out = float(fi), float(fo)
        out += layers
        hiding = tname in FACE_HIDING or rec.get("zone") in ("full", "split-top")
        if tname == "animation" and not hiding and rec.get("bbox"):
            # An animation's position was fixed when it was rendered. If the cut (or the framing under
            # it) changed since, it can now sit on the face or the captions: say so, so the editor
            # remakes it (a card would simply be placed again; an animation can't be).
            core = frame.get("core", face)
            clash = placement.violates(tuple(rec["bbox"]), (core[0], core[1], core[0] + core[2], core[1] + core[3]),
                                       placement.caption_band(_frame(ctx)))
            if clash:
                rec["clash"] = ["face" if c == "face" else "captions" for c in clash]
                rec["remake"] = ("This animation now covers " + " and ".join(
                    "your face" if c == "face" else "the captions" for c in rec["clash"])
                    + " because the edit changed after it was made. Make it again for these words.")
        records.append({"id": plan["id"], "treatment": tname, "t0": round(plan["t0"], 3), "t1": round(plan["t1"], 3),
                        "faceHiding": hiding,
                        **({"requested": asked} if asked != tname else {}),
                        "face": [round(v, 1) for v in face],
                        "protected": [round(v, 1) for v in frame.get("core", face)], "layers": len(layers),
                        **{k2: (list(v) if isinstance(v, tuple) else v) for k2, v in rec.items()}})
    report(ctx, "broll", 100.0, "Adding pictures")
    side = layers_dir(ctx) / "layers.json"
    side.write_text(json.dumps({"version": VERSION, "items": records,
                                "layers": [{"path": str(L.path), "kind": L.kind, "t0": round(L.t0, 3),
                                            "t1": round(L.t1, 3), "x": L.x, "y": L.y, "w": L.w, "h": L.h, "z": L.z}
                                           for L in out]}, indent=1), encoding="utf-8")
    return sorted(out, key=lambda L: L.z)


def anim_context(ctx, word_from: str, word_to: str, duration: Optional[float] = None, lead: float = LEAD) -> dict:
    """What an animation over words `word_from..word_to` needs before it is rendered:
      t0      output second the clip will start (first word minus the lead-in)
      region  the free box above the eyebrows (output px, `top` layout) over the clip's window
      layout  "top", or "full" when that box is too small for anything to read (close-up framing
              with the face high in the frame)
      words   [{id, w, t, e}] each word's start/end in seconds FROM THE CLIP START (for wordTimes / at)
    """
    from .compose_util import word_ids_between
    W, H, _ = fmt_of(ctx)
    s, e = word_start(ctx, word_from), word_end(ctx, word_to)
    if s is None or e is None:
        raise EngineError("ANCHOR_NOT_IN_CUT", f"{word_from}..{word_to} not in the cut",
                          "Those words aren't in the edit anymore, so the animation has nowhere to go.")
    t0 = max(0.0, s - lead)
    t1 = max(e + 0.05, t0 + float(duration or 3.6))
    dur = float(getattr(ctx, "duration", 0.0) or 0.0)
    if dur:
        t1 = min(t1, dur)
    zones, _face, _frame = zones_for(ctx, t0, t1)
    top = placement.zone(zones, "above-face")
    region = {k: int(top[k]) for k in ("x", "y", "w", "h")}
    layout = "top" if region["h"] >= 0.16 * H and region["w"] >= 0.6 * W else "full"
    words = []
    for wid in word_ids_between(ctx, word_from, word_to):
        ws, we = word_start(ctx, wid), word_end(ctx, wid)
        if ws is None:
            continue
        words.append({"id": wid, "w": _word_text(ctx, wid), "t": round(ws - t0, 3), "e": round((we or ws) - t0, 3)})
    f = 1080.0 / W                                  # templates work in 1080x1920 px
    return {"t0": round(t0, 3), "t1": round(t1, 3), "layout": layout,
            "region": {k: int(round(v * f)) for k, v in region.items()}, "words": words}


def check_layers(ctx, records: Optional[list] = None) -> list[str]:
    """Placement problems in the last build: the eyes-to-chin zone ("protected"; older records: the
    face box) or the caption band covered by a non-hiding item."""
    if records is None:
        side = layers_dir(ctx) / "layers.json"
        records = json.loads(side.read_text(encoding="utf-8"))["items"] if side.exists() else []
    band = placement.caption_band(_frame(ctx))
    errs = []
    for r in records:
        if r.get("skipped") or r.get("faceHiding") or not r.get("bbox"):
            continue
        fx, fy, fw, fh = r.get("protected") or r["face"]
        bad = placement.violates(tuple(r["bbox"]), (fx, fy, fx + fw, fy + fh), band)
        if bad:
            bad = ["eyes-to-chin zone" if b == "face" else b for b in bad]
            errs.append(f"{r['id']} ({r['treatment']}) covers the {' and the '.join(bad)}: bbox {r['bbox']}")
    return errs
