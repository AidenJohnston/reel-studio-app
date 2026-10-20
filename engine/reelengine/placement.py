"""Face-aware placement: where can a graphic go without covering the speaker or the captions?

Two halves:

* `detect_faces(video_path, out_json)` samples the video (~3 fps through ffmpeg, so any path
  works), finds the primary face per sample with YuNet (vendored ONNX, MIT) or OpenCV's Haar
  cascade, fills gaps, median-smooths the track and writes face.json. Coordinates are SOURCE
  display pixels (rotation applied).
* `safe_boxes(face_track, t, frame)` maps that track into OUTPUT pixels (scale-to-cover, centre
  crop) and returns the empty regions around the head that are inside the platform-safe area and
  clear of the caption band, largest first.

The PROTECTED zone is eyes-to-chin (eyes, nose, mouth), not the whole face box (docs/architecture.md section 7, amended
2026-10-17): a card may cover hair, the forehead down to just above the eyebrows, and the sides of
the head. Each sample carries `core` = that zone, from YuNet's eye/mouth landmarks (top = eye line
minus half the eye distance, i.e. just above the brows; sides = eyes +- 0.4 eye distance; bottom =
chin, the box bottom). Tracks without landmarks (Haar, old caches) derive it from the box's
proportions (eyes at ~38% of its height). `head_box` (hair to neck) is still there for graphics
that must clear the whole head ("above-head").

Ported from the original pipeline's safe_placement.py (zones around the face) and layout.py
(caption band + platform-safe area), generalised to any frame size and to a face TRACK.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Optional

import numpy as np

from .compose_util import EngineError, decode_frames, log, map_box, probe

YUNET_MODEL = Path(__file__).resolve().parent / "models" / "face_detection_yunet_2023mar.onnx"
DETECT_WIDTH = 480          # detection runs on a downscaled frame; faces in a talking head are big
SAMPLE_FPS = 3.0
SMOOTH_WINDOW = 5           # samples in the running median

# Platform-safe area as fractions of the frame (Instagram/TikTok UI). Graphics may use the top
# band from TOP_CHROME (the feed shows it) but keep off the very top and bottom where UI sits.
TOP_CHROME = 0.094          # 180 / 1920
SAFE_TOP = 0.17             # 325 / 1920: below the player UI
SAFE_BOTTOM = 0.83          # 1595 / 1920
SIDE_MARGIN = 0.035

# Head = face box expanded (fractions of the face box size)
HEAD_UP, HEAD_DOWN, HEAD_SIDE = 0.45, 0.18, 0.15

# Eyes-to-chin protected zone. From landmarks: top = eye line - CORE_BROW x eye distance (just above
# the eyebrows, measured on 5 real takes), sides = outer eye +- CORE_SIDE x eye distance. Without
# landmarks: proportions of the face box (YuNet: eyes at ~34-38% of the box height, the eye
# distance ~0.465 of its width, eyes at ~25% / ~73% of its width).
CORE_BROW, CORE_SIDE = 0.5, 0.4
BOX_EYE_Y, BOX_IOD, BOX_EYE_X = 0.38, 0.465, (0.26, 0.73)
TRACK_VERSION = 2              # 2 = samples carry "core"


# --- detection ---------------------------------------------------------------------------------

class _Detector:
    def __init__(self, w: int, h: int):
        import cv2
        self.cv2 = cv2
        self.kind = "none"
        self.det = None
        if YUNET_MODEL.exists() and hasattr(cv2, "FaceDetectorYN"):
            try:
                self.det = cv2.FaceDetectorYN.create(str(YUNET_MODEL), "", (w, h), 0.6, 0.3, 5000)
                self.kind = "yunet"
            except Exception as e:  # pragma: no cover - depends on the cv2 build
                log(f"YuNet unavailable ({e}); trying Haar")
        if self.det is None and hasattr(cv2, "CascadeClassifier") and hasattr(cv2, "data"):
            path = os.path.join(cv2.data.haarcascades, "haarcascade_frontalface_default.xml")
            casc = cv2.CascadeClassifier(path)
            if not casc.empty():
                self.det = casc
                self.kind = "haar"

    def __call__(self, bgr: np.ndarray):
        """-> (x, y, w, h, score, landmarks or None) of the largest face, or None."""
        if self.det is None:
            return None
        h, w = bgr.shape[:2]
        if self.kind == "yunet":
            self.det.setInputSize((w, h))
            _, faces = self.det.detect(bgr)
            if faces is None or not len(faces):
                return None
            f = max(faces, key=lambda f: float(f[2]) * float(f[3]) * float(f[14]))
            lm = [float(v) for v in f[4:14]]
            return float(f[0]), float(f[1]), float(f[2]), float(f[3]), float(f[14]), lm
        gray = self.cv2.cvtColor(bgr, self.cv2.COLOR_BGR2GRAY)
        faces = self.det.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5,
                                          minSize=(int(w * 0.08), int(w * 0.08)))
        if not len(faces):
            return None
        x, y, fw, fh = max(faces, key=lambda r: r[2] * r[3])
        return float(x), float(y), float(fw), float(fh), 0.8, None


def core_from_landmarks(box, lm) -> list:
    """Eyes-to-chin zone [x, y, w, h] from YuNet landmarks (re, le, nose, rm, lm as x, y pairs)."""
    x, y, w, h = box
    exl, exr = min(lm[0], lm[2]), max(lm[0], lm[2])
    ey = (lm[1] + lm[3]) / 2
    iod = max(exr - exl, 0.2 * w)            # a turned head squeezes the eyes together
    x0, x1 = exl - CORE_SIDE * iod, exr + CORE_SIDE * iod
    y0 = ey - CORE_BROW * iod
    y1 = max(y + h, max(lm[7], lm[9]) + 0.3 * iod)   # chin: box bottom, never above the mouth
    return [x0, y0, x1 - x0, y1 - y0]


def core_from_box(box) -> list:
    """Eyes-to-chin zone [x, y, w, h] from the face box alone (proportions of a YuNet box)."""
    x, y, w, h = box
    iod = BOX_IOD * w
    exl, exr = x + BOX_EYE_X[0] * w, x + BOX_EYE_X[1] * w
    x0, x1 = exl - CORE_SIDE * iod, exr + CORE_SIDE * iod
    y0 = y + BOX_EYE_Y * h - CORE_BROW * iod
    return [x0, y0, x1 - x0, y + h - y0]


def detect_in_frame(bgr: np.ndarray):
    """Detect the primary face in one BGR frame. -> dict {box, core, score, landmarks} in frame px
    or None. `core` = the eyes-to-chin protected zone [x, y, w, h]."""
    det = _Detector(bgr.shape[1], bgr.shape[0])
    r = det(bgr)
    if r is None:
        return None
    box = list(r[:4])
    core = core_from_landmarks(box, r[5]) if r[5] else core_from_box(box)
    return {"box": box, "core": core, "score": r[4], "landmarks": r[5], "detector": det.kind}


def _median_smooth(vals: list[Optional[list]], k: int) -> list[Optional[list]]:
    n = len(vals)
    out = []
    for i in range(n):
        win = [v for v in vals[max(0, i - k // 2): i + k // 2 + 1] if v is not None]
        out.append([float(np.median([v[j] for v in win])) for j in range(4)] if win else None)
    return out


def _fill_gaps(vals: list[Optional[list]]) -> list[Optional[list]]:
    """Nearest-neighbour fill (a face that blinks out for a sample has not moved)."""
    idx = [i for i, v in enumerate(vals) if v is not None]
    if not idx:
        return vals
    out = list(vals)
    for i, v in enumerate(vals):
        if v is None:
            j = min(idx, key=lambda k: abs(k - i))
            out[i] = list(vals[j])
    return out


def detect_faces(video_path, out_json=None, fps: float = SAMPLE_FPS, ctx=None) -> dict:
    """Face box track for a video. Writes `out_json` if given and returns the track dict:

    {"version": 2, "video": str, "width": W, "height": H, "fps": sample fps, "detector": str,
     "samples": [{"t": s, "box": [x, y, w, h] | null, "core": [x, y, w, h] | null, "score": float,
                  "rawCore": [x, y, w, h] (only where a face was really found)}],
     "median": [x, y, w, h] | null, "found": fraction of samples with a real detection}
    Samples are smoothed and gap-filled; `core` is the eyes-to-chin protected zone. `rawCore` is the
    same zone unsmoothed: the running median lags a moving head by up to ~40 px at the brows, so a
    window's protected zone takes both (face_union).
    """
    video_path = Path(video_path)
    info = probe(video_path, ctx)
    if not info["has_video"]:
        raise EngineError("NO_VIDEO", f"{video_path} has no video", "This file has no picture in it.")
    W, H = info["width"], info["height"]
    scale = DETECT_WIDTH / max(1, W)
    det = None
    raw, cores, times, scores = [], [], [], []
    for t, fr in decode_frames(video_path, fps, DETECT_WIDTH, ctx=ctx):
        if det is None:
            det = _Detector(fr.shape[1], fr.shape[0])
        r = det(fr)
        times.append(round(t, 3))
        if r is None:
            raw.append(None)
            cores.append(None)
            scores.append(0.0)
        else:
            box = [r[0] / scale, r[1] / scale, r[2] / scale, r[3] / scale]
            raw.append(box)
            cores.append(core_from_landmarks(box, [v / scale for v in r[5]]) if r[5] else core_from_box(box))
            scores.append(round(r[4], 3))
    found = sum(1 for v in raw if v is not None)
    smooth = _median_smooth(_fill_gaps(raw), SMOOTH_WINDOW)
    smooth_core = _median_smooth(_fill_gaps(cores), SMOOTH_WINDOW)
    real = [v for v in raw if v is not None]
    med = [float(np.median([v[j] for v in real])) for j in range(4)] if real else None
    track = {
        "version": TRACK_VERSION, "video": str(video_path), "width": W, "height": H, "fps": fps,
        "detector": det.kind if det else "none",
        "samples": [{"t": t, "box": None if b is None else [round(x, 1) for x in b],
                     "core": None if c is None else [round(x, 1) for x in c], "score": s,
                     **({"rawCore": [round(x, 1) for x in rc]} if rc is not None else {})}
                    for t, b, c, s, rc in zip(times, smooth, smooth_core, scores, cores)],
        "median": None if med is None else [round(x, 1) for x in med],
        "found": round(found / max(1, len(raw)), 3),
    }
    if out_json:
        Path(out_json).parent.mkdir(parents=True, exist_ok=True)
        Path(out_json).write_text(json.dumps(track, indent=1), encoding="utf-8")
    return track


def default_face(W: int, H: int) -> list:
    """Where a talking head's face usually is when nothing is detected (centred, upper-middle)."""
    fw = W * 0.36
    return [W / 2 - fw / 2, H * 0.30, fw, fw * 1.25]


def _sample_box(s: dict, key: str):
    """A sample's box ("box") or eyes-to-chin zone ("core", derived from the box when missing)."""
    if key == "core":
        if s.get("core"):
            return s["core"]
        return core_from_box(s["box"]) if s.get("box") else None
    return s.get("box")


def face_at(track: Optional[dict], t: float, key: str = "box") -> list:
    """Face box (key "box") or eyes-to-chin zone (key "core"), source px, at source time t:
    linear interpolation between samples."""
    conv = core_from_box if key == "core" else list
    if not track:
        return conv(default_face(1080, 1920))
    samples = [(s["t"], _sample_box(s, key)) for s in track.get("samples", []) if s.get("box")]
    if not samples:
        return conv(track.get("median") or default_face(track.get("width", 1080), track.get("height", 1920)))
    ts = [s[0] for s in samples]
    i = int(np.searchsorted(ts, t))
    if i <= 0:
        return list(samples[0][1])
    if i >= len(samples):
        return list(samples[-1][1])
    (ta, a), (tb, b) = samples[i - 1], samples[i]
    u = (t - ta) / max(1e-6, tb - ta)
    return [a[j] + (b[j] - a[j]) * u for j in range(4)]


def _same_face(raw, smooth) -> bool:
    """A raw sample is the same head as the smoothed one (its centre inside it): a one-frame false
    detection elsewhere must not blow the protected zone up."""
    cx, cy = raw[0] + raw[2] / 2, raw[1] + raw[3] / 2
    return smooth[0] <= cx <= smooth[0] + smooth[2] and smooth[1] <= cy <= smooth[1] + smooth[3]


def face_union(track: Optional[dict], t0: float, t1: float, key: str = "box") -> list:
    """Union of the face boxes (or eyes-to-chin zones, key "core") over a source window: a graphic
    must clear it the WHOLE time."""
    if not track:
        return (core_from_box if key == "core" else list)(default_face(1080, 1920))
    near = [s for s in track.get("samples", []) if s.get("box") and t0 - 0.4 <= s["t"] <= t1 + 0.4]
    boxes = [_sample_box(s, key) for s in near]
    if key == "core":                       # the unsmoothed zone too: the median lags a moving head
        boxes += [s["rawCore"] for s in near if s.get("rawCore") and s.get("core") and _same_face(s["rawCore"], s["core"])]
    boxes += [face_at(track, t0, key), face_at(track, t1, key)]
    x0 = min(b[0] for b in boxes)
    y0 = min(b[1] for b in boxes)
    x1 = max(b[0] + b[2] for b in boxes)
    y1 = max(b[1] + b[3] for b in boxes)
    return [x0, y0, x1 - x0, y1 - y0]


def head_box(face: list, W: int, H: int) -> tuple:
    """Expanded head box (x0, y0, x1, y1) in the same pixel space as `face`, clamped to the frame."""
    x, y, w, h = face
    return (max(0.0, x - w * HEAD_SIDE), max(0.0, y - h * HEAD_UP),
            min(float(W), x + w * (1 + HEAD_SIDE)), min(float(H), y + h * (1 + HEAD_DOWN)))


# --- safe regions ------------------------------------------------------------------------------

def caption_band(frame: dict) -> Optional[tuple]:
    """(top, bottom) px of the caption band for an output frame dict, or None if captions are off.
    frame may carry "captionBand": [top, bottom] explicitly; otherwise it is derived from
    "captionPosition" (fraction of height, default 0.70) and "captionSize" (px, default 76)."""
    if frame.get("captions") is False:
        return None
    if frame.get("captionBand"):
        a, b = frame["captionBand"]
        return float(a), float(b)
    H = float(frame.get("height", 1920))
    pos = float(frame.get("captionPosition", 0.70))
    size = float(frame.get("captionSize", 76)) * H / 1920.0 * 1.0
    # position may be the line's centre, top or baseline depending on the caption renderer:
    # keep clear of all three readings (the band is ~2.6 line-heights tall).
    return pos * H - 1.35 * size, pos * H + 1.35 * size


def _to_output(box, face_track: Optional[dict], frame: dict) -> tuple:
    """A source-px box -> OUTPUT px (reframe crop or scale-to-cover, then any zoom)."""
    W, H = int(frame.get("width", 1080)), int(frame.get("height", 1920))
    if frame.get("reframe"):
        from .compose_util import map_box_rect
        fx, fy, fw, fh = map_box_rect(box, frame["reframe"], W, H)
    else:
        sw = (face_track or {}).get("width", W)
        sh = (face_track or {}).get("height", H)
        fx, fy, fw, fh = map_box(box, sw, sh, W, H)
    zoom = frame.get("zoom")
    if zoom:   # (scale, cx, cy): the video is magnified about (cx, cy) while the graphic shows
        s, cx, cy = zoom
        fx, fy, fw, fh = cx + (fx - cx) * s, cy + (fy - cy) * s, fw * s, fh * s
    return fx, fy, fw, fh


def output_face(face_track: Optional[dict], t0: float, t1: Optional[float], frame: dict) -> dict:
    """{"head": (x0, y0, x1, y1), "face": (x, y, w, h), "core": (x, y, w, h)} in OUTPUT px over a
    source window [t0, t1]. `core` is the eyes-to-chin protected zone."""
    W, H = int(frame.get("width", 1080)), int(frame.get("height", 1920))
    t1 = t1 if t1 is not None else t0
    if face_track:
        face, core = face_union(face_track, t0, t1), face_union(face_track, t0, t1, "core")
    else:
        face = default_face(W, H)
        core = core_from_box(face)
    f = _to_output(face, face_track if face_track else {"width": W, "height": H}, frame)
    c = _to_output(core, face_track if face_track else {"width": W, "height": H}, frame)
    return {"head": head_box(f, W, H), "face": f, "core": c}


def output_head(face_track: Optional[dict], t0: float, t1: Optional[float], frame: dict) -> tuple:
    """(expanded head box (x0, y0, x1, y1), face box (x, y, w, h)) in OUTPUT px over [t0, t1]."""
    o = output_face(face_track, t0, t1, frame)
    return o["head"], o["face"]


def safe_boxes(face_track: Optional[dict], t, frame: dict) -> list[dict]:
    """Regions (output px) where a graphic can sit without covering the face or the captions.

    t: source seconds, or a (t0, t1) source window (the graphic must clear the face throughout).
    frame: {"width", "height"} of the output, plus optional caption info (see caption_band) and
    optional "zoom": (scale, cx, cy).
    Returns [{"zone", "x", "y", "w", "h"}], largest area first. Zones:
      "above-head"  top band down to the hair line (clears the whole head)
      "above-face"  top band down to just above the eyebrows (covers hair and forehead, never the
                    eyes-to-chin zone): the room a card that has to READ gets
      "left"/"right" beside the eyes-to-chin zone (may cover the side of the head, the ear, side
                    hair), above the caption band
      "below-face"  under the chin, above the caption band
    Always non-empty: if the face fills everything, "above-face" is the platform top band.
    """
    W, H = int(frame.get("width", 1080)), int(frame.get("height", 1920))
    t0, t1 = (t if isinstance(t, (tuple, list)) else (t, t))
    o = output_face(face_track, t0, t1, frame)
    hx0, hy0, hx1, hy1 = o["head"]
    fx, fy, fw, fh = o["core"]                 # every zone below clears the eyes-to-chin zone
    top = TOP_CHROME * H
    bottom = SAFE_BOTTOM * H
    band = caption_band(frame)
    mx = SIDE_MARGIN * W
    gap = 0.012 * H
    # the eyes-to-chin zone already carries its own margin (brows, outer eye corners), and cards
    # carry a shadow pad, so the zones touching it keep only a hairline gap
    bgap = 0.004 * H
    sgap = 0.008 * W
    out = []

    def add(zone, x0, y0, x1, y1):
        if x1 - x0 > 0.12 * W and y1 - y0 > 0.06 * H:
            out.append({"zone": zone, "x": int(round(x0)), "y": int(round(y0)),
                        "w": int(round(x1 - x0)), "h": int(round(y1 - y0))})

    add("above-head", mx, top, W - mx, hy0 - gap)
    add("above-face", mx, top, W - mx, fy - bgap)
    face_bottom = fy + fh
    if band and band[0] > face_bottom + gap:          # room between the chin and the captions
        add("below-face", mx, face_bottom + gap, W - mx, band[0] - gap)
    elif band:                                        # captions cross the chin: go under them
        add("below-face", mx, max(face_bottom, band[1]) + gap, W - mx, bottom)
    else:
        add("below-face", mx, face_bottom + gap, W - mx, bottom)
    side_bottom = band[0] - gap if band and band[0] > SAFE_TOP * H + 0.2 * H else bottom
    add("left", mx, SAFE_TOP * H, fx - sgap, side_bottom)
    add("right", fx + fw + sgap, SAFE_TOP * H, W - mx, side_bottom)
    if not any(z["zone"] == "above-face" for z in out):
        out.append({"zone": "above-face", "x": int(mx), "y": int(top), "w": int(W - 2 * mx),
                    "h": int(max(0.06 * H, fy - bgap - top))})
    out.sort(key=lambda r: -r["w"] * r["h"])
    return out


def zone(boxes: list[dict], name: str) -> Optional[dict]:
    for b in boxes:
        if b["zone"] == name:
            return b
    return None


def violates(bbox: tuple, head: tuple, band: Optional[tuple]) -> list[str]:
    """Which placement rules an opaque bbox (x0, y0, x1, y1) breaks: 'face' (overlaps `head`, the
    protected box as (x0, y0, x1, y1): normally the eyes-to-chin zone), 'captions'."""
    x0, y0, x1, y1 = bbox
    out = []
    hx0, hy0, hx1, hy1 = head
    if x0 < hx1 and x1 > hx0 and y0 < hy1 and y1 > hy0:
        out.append("face")
    if band and y0 < band[1] and y1 > band[0]:
        out.append("captions")
    return out


# --- project integration -----------------------------------------------------------------------

def track_for_source(ctx, sid: str) -> Optional[dict]:
    """The face track for project source `sid`: work/face-<sid>.json, else work/face.json when it
    belongs to that source, else detected now and cached as work/face-<sid>.json. None if the
    source video cannot be found."""
    from .compose_util import source_path
    cache = getattr(ctx, "_a2_faces", None)
    if cache is None:
        cache = {}
        try:
            setattr(ctx, "_a2_faces", cache)
        except Exception:
            pass
    if sid in cache:
        return cache[sid]
    work = Path(ctx.work)
    src = source_path(ctx, sid)
    track = None
    for cand in (work / f"face-{sid}.json", work / "face.json"):
        if not cand.exists():
            continue
        try:
            data = json.loads(cand.read_text(encoding="utf-8"))
        except ValueError:
            continue
        if isinstance(data.get("sources"), dict):           # {"sources": {"s1": track, ...}}
            data = data["sources"].get(sid)
            if not data:
                continue
        if cand.name == "face.json" and src is not None and data.get("video"):
            n_sources = len(ctx.project.get("sources") or [])
            if n_sources > 1 and Path(data["video"]).name != src.name:
                continue
        if data.get("samples") is not None:
            track = data
            break
    if track is not None and track.get("detector") == "yunet" and int(track.get("version") or 1) < TRACK_VERSION \
            and src is not None and src.exists():
        track = None          # an older YuNet track has no landmarks: detect again for the eyes-to-chin zone
    if track is None and src is not None and src.exists():
        try:
            track = detect_faces(src, work / f"face-{sid}.json", ctx=ctx)
        except EngineError as e:
            log(f"face detection failed for {sid}: {e.message}")
    cache[sid] = track
    return track


# --- what a still IS (text card / logo / photo) and its subject crop ----------------------------
# A card's readable floor depends on what is on it: a screenshot's words need 55% of the frame
# (40% beside the face), but a photo, poster or film still reads as a picture at 30% and a logo at
# 22%. The engine has no metadata saying which an image is, so it measures it:
#
#   text   small text lines (a text-line detector: morphological gradient -> Otsu -> close
#          horizontally -> components 7-45 px tall at a 960 px long side, >= 2.5x as wide as tall,
#          >= 35% filled). 12+ lines or >= 2% of the image covered = text. Big type (a headline at
#          > ~5% of the long side, a wordmark) doesn't count: it reads small.
#   logo   no small text, >= 80% flat pixels and >= 85% of the image in its 8 commonest colours
#          (app icons, wordmarks on a plain ground, a product shot on a big white ground). Judged on
#          the whole image on purpose: judging only the subject turned white app icons into
#          "photos" and cropped them to their glyph.
#   photo  everything else (continuous tone: photos, film stills, posters without small text)
#
# Measured on ~100 real stills (photos, screenshots, logos, app icons, posters) + the synthetic
# fixtures (status/issues-placement.md): every text screenshot is "text"; a book cover with a
# blurb counts as text (safe direction); a text line over a photo banner is text. A photo misread
# as text only costs a split view; a text card misread as a photo would be unreadable, so the
# thresholds lean to text.

TEXT_LINES_MIN = 12
TEXT_AREA_MIN = 0.02
LOGO_FLAT_MIN, LOGO_TOP8_MIN = 0.80, 0.85
PHOTO_MIN_WIDTH = 0.30          # a photo / poster / film still reads at ~30% of the frame (looked at 26-36%)


def _flat_rgb(img):
    """PIL image -> RGB, transparency over white (how a cut-out sits on a light card)."""
    from PIL import Image
    if img.mode in ("P", "LA", "RGBA", "PA"):
        img = img.convert("RGBA")
        bg = Image.new("RGBA", img.size, (255, 255, 255, 255))
        bg.alpha_composite(img)
        img = bg
    return img.convert("RGB")


def text_lines(img) -> tuple:
    """(number of small text lines, fraction of the image they cover) for a PIL image."""
    import cv2
    im = _flat_rgb(img)
    im.thumbnail((960, 960))
    g = cv2.cvtColor(np.asarray(im), cv2.COLOR_RGB2GRAY)
    grad = cv2.morphologyEx(g, cv2.MORPH_GRADIENT, np.ones((3, 3), np.uint8))
    _, bw = cv2.threshold(grad, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)
    bw = cv2.morphologyEx(bw, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (9, 1)))
    n, _lab, st, _ = cv2.connectedComponentsWithStats(bw, 8)
    lines, area = 0, 0
    for i in range(1, n):
        _x, _y, w, h, a = st[i]
        if 7 <= h <= 45 and w >= 2.5 * h and a >= 0.35 * w * h:
            lines += 1
            area += w * h
    return lines, area / float(g.shape[0] * g.shape[1])


def content_kind(img) -> str:
    """"text" | "logo" | "photo" for a still (see the table above)."""
    import cv2
    lines, area = text_lines(img)
    if lines >= TEXT_LINES_MIN or area >= TEXT_AREA_MIN:
        return "text"
    im = _flat_rgb(img)
    im.thumbnail((480, 480))
    a = np.asarray(im)
    g = cv2.cvtColor(a, cv2.COLOR_RGB2GRAY).astype(np.float32)
    mag = np.hypot(cv2.Sobel(g, cv2.CV_32F, 1, 0, ksize=3), cv2.Sobel(g, cv2.CV_32F, 0, 1, ksize=3)) / 4
    flat = float((mag < 3).mean())
    q = (a // 16).astype(np.int32)
    _, cnt = np.unique(q[..., 0] * 256 + q[..., 1] * 16 + q[..., 2], return_counts=True)
    top8 = float(np.sort(cnt)[::-1][:8].sum() / cnt.sum())
    return "logo" if flat >= LOGO_FLAT_MIN and top8 >= LOGO_TOP8_MIN else "photo"


CROP_MIN_GAIN = 0.08            # crop only if it removes at least this much of the area
CROP_PAD = 0.05                 # breathing room kept around the subject (fraction of its size)
CROP_SIDE_MAX = 0.30            # an empty-detail trim takes at most this much off each side
CROP_EDGE_ENERGY = 0.035        # ...and only while the strip it removes holds < this much detail


def _plain_border_box(a: np.ndarray) -> Optional[tuple]:
    """(x0, y0, x1, y1) of what differs from a plain border (>= 90% of the outermost 2% within a
    small colour distance of its median), or None when the border isn't plain / nothing differs."""
    import cv2
    h, w = a.shape[:2]
    b = max(2, int(0.02 * min(w, h)))
    border = np.concatenate([a[:b].reshape(-1, 3), a[-b:].reshape(-1, 3), a[:, :b].reshape(-1, 3),
                             a[:, -b:].reshape(-1, 3)])
    med = np.median(border, axis=0)
    if (np.linalg.norm(border - med, axis=1) < 22).mean() < 0.90:
        return None
    mask = (np.linalg.norm(a - med, axis=2) > 28).astype(np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    ys, xs = np.nonzero(mask)
    if len(xs) <= 0.01 * w * h:
        return None
    return (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)


def subject_box(img, kind: str) -> Optional[tuple]:
    """(x0, y0, x1, y1) crop around a photo's subject, or None to keep it whole. Photos only: never
    "text" (a crop could cut words) and never "logo" (an app icon's tile and a wordmark's margins
    are part of the design; cropping a badge to its glyph made it a different picture). Two passes, in the image's own pixels:
      1. a plain border (>= 90% of the outermost 2% within a small colour distance of its median):
         the subject = everything that differs from that colour (a product shot on white);
      2. empty detail: trim each side while the strip removed holds < 3.5% of the image's edge
         energy, at most 30% per side (sky, an empty wall; a busy photo is left alone).
    The box keeps 5% padding and is dropped when it would save < 8% of the area."""
    if kind != "photo":
        return None
    import cv2
    im = _flat_rgb(img)
    W0, H0 = im.size
    s = min(1.0, 480.0 / max(W0, H0))
    small = im.resize((max(1, round(W0 * s)), max(1, round(H0 * s))))
    a = np.asarray(small).astype(np.float32)
    h, w = a.shape[:2]
    box = _plain_border_box(a) or (0, 0, w, h)
    if box == (0, 0, w, h):
        g = cv2.cvtColor(a.astype(np.uint8), cv2.COLOR_RGB2GRAY).astype(np.float32)
        e = np.hypot(cv2.Sobel(g, cv2.CV_32F, 1, 0), cv2.Sobel(g, cv2.CV_32F, 0, 1))
        tot = float(e.sum()) or 1.0
        cols, rows = e.sum(axis=0) / tot, e.sum(axis=1) / tot

        def trim(prof):
            n = len(prof)
            lo, acc = 0, 0.0
            while lo < CROP_SIDE_MAX * n and acc + prof[lo] < CROP_EDGE_ENERGY:
                acc += prof[lo]
                lo += 1
            hi, acc = n, 0.0
            while n - hi < CROP_SIDE_MAX * n and acc + prof[hi - 1] < CROP_EDGE_ENERGY:
                acc += prof[hi - 1]
                hi -= 1
            return lo, hi
        x0, x1 = trim(cols)
        y0, y1 = trim(rows)
        box = (x0, y0, x1, y1)
    x0, y0, x1, y1 = box
    px, py = CROP_PAD * (x1 - x0), CROP_PAD * (y1 - y0)
    x0, y0 = max(0.0, x0 - px), max(0.0, y0 - py)
    x1, y1 = min(float(w), x1 + px), min(float(h), y1 + py)
    if (x1 - x0) * (y1 - y0) > (1 - CROP_MIN_GAIN) * w * h:
        return None
    return (int(x0 / s), int(y0 / s), min(W0, int(np.ceil(x1 / s))), min(H0, int(np.ceil(y1 / s))))


# A TEXT card is never cut through its content, but the plain parts around it can go: a screenshot's
# empty margin, the blank space under a short tweet, a flat colour block with nothing on it. Its
# words then sit on a smaller card at the SAME size (the readable floor scales with how much width
# was dropped, see text_box), so it fits above a close-up face instead of falling back to a split.
TEXT_CROP_MIN_GAIN = 0.12       # crop a text card only if that removes at least this much of it
TEXT_CROP_PAD = 0.03            # margin kept around the content (fraction of the image's long side)
TEXT_PLAIN_COLOURS = 2          # a dropped strip holds at most this many flat colours...
TEXT_PLAIN_SHARE = 0.97         # ...covering this much of it (a soft photo, a gradient: kept)


def _plain_strip(a: np.ndarray) -> bool:
    """Is this strip (RGB array) flat colour only: >= TEXT_PLAIN_SHARE of it within a small distance
    of its TEXT_PLAIN_COLOURS commonest colours? A margin or a flat block is; a photo, a gradient,
    a chart or any text is not."""
    if a.size == 0:
        return True
    px = a.reshape(-1, 3).astype(np.int32)
    q = px // 24
    keys, cnt = np.unique(q[:, 0] * 4096 + q[:, 1] * 64 + q[:, 2], return_counts=True)
    top = keys[np.argsort(cnt)[::-1][:TEXT_PLAIN_COLOURS]]
    cols = [px[(q[:, 0] * 4096 + q[:, 1] * 64 + q[:, 2]) == k].mean(axis=0) for k in top]
    near = np.zeros(len(px), bool)
    for c in cols:
        near |= np.abs(px - c).max(axis=1) <= 20
    return float(near.mean()) >= TEXT_PLAIN_SHARE


def text_box(img) -> Optional[tuple]:
    """(x0, y0, x1, y1) crop of a TEXT card to its content, or None to keep it whole.

    Content = every edge the text-line detector's first stage sees (morphological gradient, Otsu,
    closed horizontally), except the thin outline of a big flat box (a block's border carries no
    information). The crop keeps TEXT_CROP_PAD around that, and each side is cut only when the strip
    it drops is plain (_plain_strip): text, photos, gradients and charts are never cropped away.
    Dropped when it would save < TEXT_CROP_MIN_GAIN of the area."""
    import cv2
    im = _flat_rgb(img)
    W0, H0 = im.size
    s = min(1.0, 960.0 / max(W0, H0))
    small = im.resize((max(1, round(W0 * s)), max(1, round(H0 * s))))
    a = np.asarray(small)
    h, w = a.shape[:2]
    g = cv2.cvtColor(a, cv2.COLOR_RGB2GRAY)
    grad = cv2.morphologyEx(g, cv2.MORPH_GRADIENT, np.ones((3, 3), np.uint8))
    t, _ = cv2.threshold(grad, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)
    bw = (grad >= max(t, 24)).astype(np.uint8)
    bw = cv2.morphologyEx(bw, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (9, 1)))
    n, lab, st, _ = cv2.connectedComponentsWithStats(bw, 8)

    def outline(i) -> bool:             # a big box's thin border: (nearly) all its pixels on its bbox edge
        x, y, bw_, bh_, area = st[i]
        if bw_ <= 40 or bh_ <= 40 or area >= 0.12 * bw_ * bh_:
            return False
        inner = lab[y + 4:y + bh_ - 4, x + 4:x + bw_ - 4] == i
        return float(inner.sum()) <= 0.05 * area
    keep = [i for i in range(1, n) if st[i, 4] >= 4 and not outline(i)]
    if not keep:
        return None
    x0 = min(st[i, 0] for i in keep)
    y0 = min(st[i, 1] for i in keep)
    x1 = max(st[i, 0] + st[i, 2] for i in keep)
    y1 = max(st[i, 1] + st[i, 3] for i in keep)
    pad = TEXT_CROP_PAD * max(w, h)
    x0, y0 = int(max(0, x0 - pad)), int(max(0, y0 - pad))
    x1, y1 = int(min(w, np.ceil(x1 + pad))), int(min(h, np.ceil(y1 + pad)))
    def line_ok(line) -> bool:          # the new edge runs through ONE colour (never half a button)
        px = line.reshape(-1, 3).astype(np.int32)
        return px.size == 0 or float((np.abs(px - np.median(px, axis=0)).max(axis=1) <= 20).mean()) >= 0.95

    # A dropped strip that is NOT plain means the content map missed something (a smooth photo's
    # edge reads as a box outline): keep the whole image. A new edge through a shape (half a
    # button) only keeps that side.
    if (x0 and not _plain_strip(a[:, :x0])) or (x1 < w and not _plain_strip(a[:, x1:])):
        return None
    x0 = x0 if line_ok(a[y0:y1, x0]) else 0
    x1 = x1 if x1 >= w or line_ok(a[y0:y1, x1 - 1]) else w
    if (y0 and not _plain_strip(a[:y0, x0:x1])) or (y1 < h and not _plain_strip(a[y1:, x0:x1])):
        return None
    y0 = y0 if line_ok(a[y0, x0:x1]) else 0
    y1 = y1 if y1 >= h or line_ok(a[y1 - 1, x0:x1]) else h
    if (x1 - x0) * (y1 - y0) > (1 - TEXT_CROP_MIN_GAIN) * w * h:
        return None
    return (int(x0 / s), int(y0 / s), min(W0, int(np.ceil(x1 / s))), min(H0, int(np.ceil(y1 / s))))


ASPECT_CROP_MAX_LOSS = 0.30     # a photo may lose up to 30% of its area to fit a zone's shape


def aspect_crop(img, target: float, max_loss: float = ASPECT_CROP_MAX_LOSS) -> Optional[tuple]:
    """(x0, y0, x1, y1) crop moving a PHOTO's aspect (w/h) toward `target`, keeping at least
    1 - max_loss of its area; None when it is already within 3%. Centred on the faces in it (YuNet
    on the photo; a crop must never cut a face) or else on its edge-energy centroid. Used only
    when a photo would otherwise be too small to read in the room it has (an editor's cover crop)."""
    import cv2
    im = _flat_rgb(img)
    W0, H0 = im.size
    a = W0 / H0
    if abs(a - target) / target < 0.03:
        return None
    if target > a:                                   # wider: take height off
        nw, nh = W0, max(H0 * (1 - max_loss), W0 / target)
    else:                                            # narrower: take width off
        nw, nh = max(W0 * (1 - max_loss), H0 * target), H0
    s = min(1.0, 480.0 / max(W0, H0))
    small = np.asarray(im.resize((max(1, round(W0 * s)), max(1, round(H0 * s)))))
    bgr = small[..., ::-1].copy()
    face = detect_in_frame(bgr) if min(bgr.shape[:2]) >= 60 else None
    if face is not None:
        fx, fy, fw, fh = [v / s for v in face["box"]]
        cx, cy = fx + fw / 2, fy + fh * 0.6          # keep the head and a bit of shoulder
        lo_x, hi_x, lo_y, hi_y = fx, fx + fw, fy - 0.3 * fh, fy + fh
    else:
        g = cv2.cvtColor(small, cv2.COLOR_RGB2GRAY).astype(np.float32)
        e = np.hypot(cv2.Sobel(g, cv2.CV_32F, 1, 0), cv2.Sobel(g, cv2.CV_32F, 0, 1)) + 1e-3
        ys, xs = np.mgrid[0:e.shape[0], 0:e.shape[1]]
        cx, cy = float((e * xs).sum() / e.sum()) / s, float((e * ys).sum() / e.sum()) / s
        lo_x = hi_x = cx
        lo_y = hi_y = cy
    x0 = min(max(cx - nw / 2, 0.0), W0 - nw)
    y0 = min(max(cy - nh / 2, 0.0), H0 - nh)
    if face is not None:                             # slide so the whole face stays in
        x0 = min(max(x0, hi_x - nw), lo_x) if hi_x - lo_x <= nw else x0
        y0 = min(max(y0, hi_y - nh), max(0.0, lo_y)) if hi_y - lo_y <= nh else y0
        x0 = min(max(x0, 0.0), W0 - nw)
        y0 = min(max(y0, 0.0), H0 - nh)
    return (int(round(x0)), int(round(y0)), int(round(x0 + nw)), int(round(y0 + nh)))
