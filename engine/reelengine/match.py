"""Match cuts (docs/architecture.md section 5): find the frames on each side of a join that line up.

A cut is hard to see when the last frame before it and the first frame after it look alike: the
speaker's head sits in the same place and the picture around it is the same. A match join asks the
engine for that. It can only move the cut inside the air around the join, never into a word:

  * the outgoing side may end anywhere from just after its last word to EXTRA past its planned end,
    while the source is still silent (before its next word in that source);
  * the incoming side may start anywhere from EXTRA before its planned start (after the word before
    it in that source) up to its first word.

Every candidate frame is reduced to what the viewer sees: the source's crop for the output format
(render.display_crop), grey, at DESCRIPTOR size. A pair lines up when both hold:

  * LOOK: the two pictures are the same shot. Normalised correlation of the blurred tone plus that of
    the edges, averaged, over the crop outside the head box (the whole crop when there is no face
    track). Two different rooms or framings score low; a head that moved does not lower it.
  * MOVE: the speaker barely moved. Mean absolute difference inside the head box (the face track's box
    grown by HEAD_GROW, both sides' boxes together), each side's mean taken out so a small exposure
    change does not count. On a locked-off single take LOOK is high for every pair, because the room
    never changes; MOVE is what tells a match from a jump cut there.

An action join (cut on action) searches the same air for the opposite: the cut lands where something is
moving on both sides, so the eye follows the movement across and doesn't see the jump. Each side's
motion is MOVE between the frame at the cut and its neighbour away from it (the frame before the last
outgoing one, the frame after the first incoming one), over the whole crop, since a gesture is often
outside the head box. The pair whose weaker side moves most wins; it needs ACTION_MIN on both.

The best pair (lowest MOVE among pairs that pass LOOK, nearest the planned bounds on a tie) becomes the
join's bounds. When no pair passes, the join plays as a plain cut and the timeline says why, so a
"match" label never sits on a jump cut. Results are cached in work/match-joins.json, keyed by the
source file, the crop and the search windows, because every render, window and still builds the
timeline again.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
from typing import Optional

import numpy as np

from . import project as projmod
from .compose_util import log

VERSION = 1
DESCRIPTOR = (54, 96)        # width, height: 9:16 at a size where a head is still ~20 px wide
DECODE_WIDTH = 270           # decoded frame width before cropping to the output's shape
EXTRA = 0.20                 # seconds each side may move past its planned bound, into silence
WORD_GUARD = 0.03            # never end or start closer than this to a word
HEAD_GROW = 1.6              # face box -> head box, so hair and shoulders count
# Proposed bounds, to be checked against frames of real joins; see engine/tests/test_match.py for the
# synthetic cases each one must separate.
LOOK_MIN = 0.80
MOVE_MAX = 0.045
TIE = 0.002                  # MOVE values this close are a tie, settled by the smaller shift
# Proposed like the two above; test_match.py's moving-disc take sits well on either side of it.
ACTION_MIN = 0.02
CACHE_FILE = "match-joins.json"
CACHE_LIMIT = 256


# Below this spread (grey 0..1) a region has no shape to compare: blurring a flat frame leaves float noise that
# would otherwise normalise into a pattern and match itself.
FLAT = 1e-3


def _unit(a: np.ndarray) -> np.ndarray:
    if float(a.std()) < FLAT:
        return np.zeros_like(a)
    a = a - a.mean()
    return a / float(np.linalg.norm(a))


def describe(gray: np.ndarray) -> dict:
    """A frame as the scores use it: grey 0..1 at DESCRIPTOR size, its blurred tone and its edges."""
    import cv2
    small = cv2.resize(gray, DESCRIPTOR, interpolation=cv2.INTER_AREA).astype(np.float32) / 255.0
    blur = cv2.GaussianBlur(small, (0, 0), 1.0)
    edges = np.hypot(cv2.Sobel(blur, cv2.CV_32F, 1, 0), cv2.Sobel(blur, cv2.CV_32F, 0, 1))
    return {"grey": small, "tone": blur, "edges": edges}


def _inside(box: Optional[tuple], shape: tuple) -> Optional[np.ndarray]:
    """Mask of the box (x0, y0, x1, y1 as fractions of the frame) on a descriptor, or None when there is
    no box or it is too small to measure."""
    if not box:
        return None
    h, w = shape
    x0, y0 = max(0, int(math.floor(box[0] * w))), max(0, int(math.floor(box[1] * h)))
    x1, y1 = min(w, int(math.ceil(box[2] * w))), min(h, int(math.ceil(box[3] * h)))
    if x1 - x0 < 2 or y1 - y0 < 2:
        return None
    mask = np.zeros(shape, bool)
    mask[y0:y1, x0:x1] = True
    return mask


def look(a: dict, b: dict, box: Optional[tuple] = None) -> float:
    """-1..1: how much the two frames are the same shot, outside the head box. A flat frame has no shape
    and scores 0. When the box leaves under a tenth of the frame, the whole frame counts."""
    inside = _inside(box, a["grey"].shape)
    keep = ~inside if inside is not None and (~inside).mean() >= 0.1 else np.ones(a["grey"].shape, bool)
    return 0.5 * sum(float((_unit(a[k][keep]) * _unit(b[k][keep])).sum()) for k in ("tone", "edges"))


def move(a: dict, b: dict, box: Optional[tuple] = None) -> float:
    """0..1: mean absolute grey difference inside the head box, each side's mean removed. No box: the
    whole frame."""
    inside = _inside(box, a["grey"].shape)
    pa, pb = (a["grey"], b["grey"]) if inside is None else (a["grey"][inside], b["grey"][inside])
    return float(np.abs((pa - pa.mean()) - (pb - pb.mean())).mean())


def best_pair(outgoing: list, incoming: list, box: Optional[tuple], planned: tuple) -> dict:
    """outgoing: [(end time, descriptor of the frame shown just before it)]; incoming: [(start time,
    descriptor of the frame shown from it)]; planned: the (end, start) the cut has without matching.

    The pair that lines up best, with `matched` true when it passes LOOK_MIN and MOVE_MAX."""
    best = None
    closest = None
    for te, da in outgoing:
        for ts, db in incoming:
            lk, mv = look(da, db, box), move(da, db, box)
            shift = abs(te - planned[0]) + abs(ts - planned[1])
            row = {"outEnd": round(te, 6), "inStart": round(ts, 6), "look": round(lk, 4), "move": round(mv, 4), "shift": round(shift, 6)}
            if closest is None or (lk, -mv) > (closest["look"], -closest["move"]):
                closest = row
            if lk < LOOK_MIN:
                continue
            if best is None or mv < best["move"] - TIE or (abs(mv - best["move"]) <= TIE and shift < best["shift"]):
                best = row
    if best is not None and best["move"] <= MOVE_MAX:
        return {**best, "matched": True}
    row = best or closest
    if row is None:
        return {"matched": False, "why": "there are no frames around this join to compare"}
    why = (f"the two sides don't look like the same shot ({round(max(row['look'], 0) * 100)}% alike, a match needs {round(LOOK_MIN * 100)}%)"
           if best is None else
           f"the speaker moves too much across the cut ({row['move']:.3f}, a match allows {MOVE_MAX})")
    return {**row, "matched": False, "why": why}


def best_action(outgoing: list, incoming: list, planned: tuple) -> dict:
    """outgoing: [(end time, motion into the cut)]; incoming: [(start time, motion out of it)]. The pair
    whose weaker side moves most, with `matched` true when both sides reach ACTION_MIN."""
    best = None
    for te, mo in outgoing:
        for ts, mi in incoming:
            shift = abs(te - planned[0]) + abs(ts - planned[1])
            row = {"outEnd": round(te, 6), "inStart": round(ts, 6), "motion": round(min(mo, mi), 4), "shift": round(shift, 6)}
            if best is None or row["motion"] > best["motion"] + TIE or (abs(row["motion"] - best["motion"]) <= TIE and shift < best["shift"]):
                best = row
    if best is None:
        return {"matched": False, "why": "there are no frames around this join to compare"}
    if best["motion"] >= ACTION_MIN:
        return {**best, "matched": True}
    return {**best, "matched": False,
            "why": f"nothing moves on both sides of this cut ({best['motion']:.3f}, a cut on action needs {ACTION_MIN})"}


def frame_grid(lo: float, hi: float, fps: float) -> list:
    """Source frame boundaries in [lo, hi]: the times a cut can sit on (cut.py snaps every bound)."""
    k0, k1 = math.ceil(lo * fps - 1e-6), math.floor(hi * fps + 1e-6)
    return [round(k / fps, 6) for k in range(k0, k1 + 1)]


def windows(tl, join: dict, sources: dict) -> Optional[dict]:
    """Where the outgoing end and the incoming start may move for one match join (see the module
    docstring), or None when there is no cut to move (both sides are one continuous stretch)."""
    words = tl.words
    out_seg, in_seg = tl.segments[join["out"]], tl.segments[join["in"]]
    prev, wi = join["prevWord"], join["word"]
    if out_seg.source == in_seg.source and abs(out_seg.src_end - in_seg.src_start) < 1e-6:
        return None
    out_meta, in_meta = sources.get(out_seg.source) or {}, sources.get(in_seg.source) or {}
    out_fps, in_fps = float(out_meta.get("fps") or 30.0), float(in_meta.get("fps") or 30.0)
    out_dur = float(out_meta.get("duration") or out_seg.src_end)
    nxt = words[prev + 1]["s"] if prev + 1 < len(words) and words[prev + 1]["source"] == out_seg.source else out_dur
    before = words[wi - 1]["e"] if wi > 0 and words[wi - 1]["source"] == in_seg.source else 0.0
    out_lo = max(words[prev]["e"] + WORD_GUARD, out_seg.src_start + 1.0 / out_fps)
    out_hi = min(out_seg.src_end + EXTRA, nxt - WORD_GUARD, out_dur)
    in_lo = max(in_seg.src_start - EXTRA, before + WORD_GUARD, 0.0)
    in_hi = min(words[wi]["s"], in_seg.src_end - 1.0 / in_fps)
    out_times = [t for t in frame_grid(min(out_lo, out_seg.src_end), max(out_hi, out_seg.src_end), out_fps)]
    in_times = [t for t in frame_grid(min(in_lo, in_seg.src_start), max(in_hi, in_seg.src_start), in_fps)]
    if out_seg.source == in_seg.source:
        # one take: the two sides may not show the same moment, or the cut would replay frames
        in_times = [t for t in in_times if t >= out_seg.src_end - 1e-6 or t + EXTRA < out_seg.src_start] or in_times
    return {"outSource": out_seg.source, "inSource": in_seg.source, "outFps": out_fps, "inFps": in_fps,
            "outTimes": out_times, "inTimes": in_times, "planned": (out_seg.src_end, in_seg.src_start)}


def _head_box(track: Optional[dict], times: list, crop: tuple, disp: tuple) -> Optional[tuple]:
    """The face boxes at `times`, together, grown by HEAD_GROW, as fractions of the crop."""
    if not track or not track.get("samples"):
        return None
    from .placement import face_at
    sx = disp[0] / float(track.get("width") or disp[0])
    sy = disp[1] / float(track.get("height") or disp[1])
    boxes = [face_at(track, t) for t in times]
    x0 = min(b[0] for b in boxes) * sx
    y0 = min(b[1] for b in boxes) * sy
    x1 = max(b[0] + b[2] for b in boxes) * sx
    y1 = max(b[1] + b[3] for b in boxes) * sy
    cx, cy, gw, gh = (x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) * HEAD_GROW / 2, (y1 - y0) * HEAD_GROW / 2
    x, y, cw, ch = crop
    return ((cx - gw - x) / cw, (cy - gh - y) / ch, (cx + gw - x) / cw, (cy + gh - y) / ch)


def _descriptors(path: Path, frames: list, fps: float, crop: tuple, disp: tuple, mirrored: bool, ctx=None) -> list:
    """[descriptor] of source frames `frames` (frame k shows from k/fps), cropped as the output crops it.

    One decode of the run k0..k1, seeking half a frame before k0: an accurate seek returns the first
    frame at or after the seek time, so the first one out is frame k0 whatever the rounding, and frame
    k0 + j follows it (sources are constant frame rate). compose_util.decode_frames is not used: it
    labels frames from a seek rounded to milliseconds, which is one frame off for times on the grid."""
    import subprocess
    import cv2
    from .compose_util import ffmpeg_bin
    k0, k1 = min(frames), max(frames)
    w = DECODE_WIDTH
    h = max(2, int(round(disp[1] * w / disp[0])) // 2 * 2)
    n = k1 - k0 + 1
    cmd = [ffmpeg_bin(ctx), "-v", "error", "-nostdin", "-ss", f"{max(0.0, (k0 - 0.5) / fps):.6f}", "-i", str(path),
           "-frames:v", str(n), "-an", "-vf", f"scale={w}:{h}:flags=area,format=gray", "-f", "rawvideo", "-pix_fmt", "gray", "-"]
    raw = subprocess.run([str(c) for c in cmd], capture_output=True, timeout=120, check=True).stdout
    if len(raw) < n * w * h:
        raise ValueError(f"{len(raw) // (w * h)} of {n} frames decoded")
    x, y, cw, ch = crop
    kx, ky = w / float(disp[0]), h / float(disp[1])
    out = []
    for k in frames:
        grey = np.frombuffer(raw[(k - k0) * w * h:(k - k0 + 1) * w * h], np.uint8).reshape(h, w)
        part = grey[int(round(y * ky)):int(round((y + ch) * ky)), int(round(x * kx)):int(round((x + cw) * kx))]
        out.append(describe(np.ascontiguousarray(part[:, ::-1] if mirrored else part)))
    return out


def _stat(path: Path):
    try:
        st = path.stat()
        return (st.st_size, st.st_mtime_ns)
    except OSError:
        return None


def _cache_key(parts: list) -> str:
    return hashlib.sha256(json.dumps(parts, sort_keys=True, default=str).encode("utf-8")).hexdigest()[:32]


def _load_cache(path: Path) -> dict:
    try:
        data = projmod.read_json(path)
        return data["entries"] if data.get("version") == VERSION and isinstance(data.get("entries"), dict) else {}
    except (OSError, ValueError, KeyError, AttributeError):
        return {}


def _track(project_dir: Path, sid: str) -> Optional[dict]:
    fp = Path(project_dir) / "work" / f"face-{sid}.json"
    try:
        return projmod.read_json(fp) if fp.exists() else None
    except (OSError, ValueError):
        return None


def plan(project_dir: Path, proj: dict, tl) -> dict:
    """{keep index: verdict} for every match join in `tl` (built without match points).

    A verdict is best_pair's row ({matched, outEnd, inStart, look, move, why?}), or {matched: False,
    why} when there is no cut to move or a source can't be read."""
    from .render import display_crop, is_mirrored, source_faces
    project_dir = Path(project_dir)
    sources = projmod.source_meta(proj)
    by_id = {s["id"]: s for s in proj.get("sources", [])}
    fmt = proj.get("format") or {}
    out_w, out_h = int(fmt.get("width") or 1080), int(fmt.get("height") or 1920)
    faces = None
    cache_path = project_dir / "work" / CACHE_FILE
    cache = _load_cache(cache_path)
    changed = False
    verdicts = {}
    for join in tl.match_joins:
        if join.get("played") == "none":
            continue
        win = windows(tl, join, sources)
        if win is None:
            verdicts[join["keep"]] = {"matched": False, "why": "there is no cut here: both sides are one continuous stretch of the take"}
            continue
        if faces is None:
            faces = source_faces(project_dir, proj)
        sides = []
        try:
            for sid in (win["outSource"], win["inSource"]):
                src = by_id[sid]
                path = projmod.source_path(project_dir, src)
                st = path.stat()
                disp = (int(src.get("width") or out_w), int(src.get("height") or out_h))
                if int(src.get("rotation") or 0) % 180 == 90:
                    disp = (disp[1], disp[0])
                sides.append({"src": src, "path": path, "stat": (st.st_size, st.st_mtime_ns), "disp": disp,
                              "crop": display_crop(disp, out_w, out_h, faces.get(sid))})
        except (KeyError, OSError) as exc:
            verdicts[join["keep"]] = {"matched": False, "why": f"a take could not be read ({exc.__class__.__name__})"}
            continue
        # the face track decides the head box, so a new analysis of the take is a new search
        kind = join.get("transition", "match")
        key = _cache_key([VERSION, kind, LOOK_MIN, MOVE_MAX, ACTION_MIN, HEAD_GROW, DESCRIPTOR, DECODE_WIDTH,
                          [(str(s["path"]), s["stat"], s["crop"], is_mirrored(s["src"]),
                            _stat(project_dir / "work" / f"face-{s['src']['id']}.json")) for s in sides],
                          win["outTimes"], win["inTimes"], win["planned"]])
        if key in cache:
            verdicts[join["keep"]] = cache[key]
            continue
        o, i = sides
        # an end at te shows frame te*fps - 1 last; a start at ts shows frame ts*fps first
        out_frames = [round(t * win["outFps"]) - 1 for t in win["outTimes"]]
        in_frames = [round(t * win["inFps"]) for t in win["inTimes"]]
        if kind == "action":
            # each side's motion compares the frame at the cut with its neighbour away from it
            out_k = sorted({k for f in out_frames for k in (max(0, f - 1), f)})
            in_k = sorted({k for f in in_frames for k in (f, f + 1)})
            try:
                at_o = dict(zip(out_k, _descriptors(o["path"], out_k, win["outFps"], o["crop"], o["disp"], is_mirrored(o["src"]))))
                at_i = dict(zip(in_k, _descriptors(i["path"], in_k, win["inFps"], i["crop"], i["disp"], is_mirrored(i["src"]))))
            except Exception as exc:   # noqa: BLE001 -- an unreadable stretch only costs the cut on action
                log(f"action join {join['keep']}: frames could not be read: {exc!r}")
                verdicts[join["keep"]] = {"matched": False, "why": "the frames around this join could not be read"}
                continue
            verdict = best_action([(t, move(at_o[max(0, f - 1)], at_o[f])) for t, f in zip(win["outTimes"], out_frames)],
                                  [(t, move(at_i[f], at_i[f + 1])) for t, f in zip(win["inTimes"], in_frames)], win["planned"])
            verdicts[join["keep"]] = cache[key] = verdict
            changed = True
            continue
        try:
            da = _descriptors(o["path"], out_frames, win["outFps"], o["crop"], o["disp"], is_mirrored(o["src"]))
            db = _descriptors(i["path"], in_frames, win["inFps"], i["crop"], i["disp"], is_mirrored(i["src"]))
        except Exception as exc:   # noqa: BLE001 -- an unreadable stretch only costs the match
            log(f"match join {join['keep']}: frames could not be read: {exc!r}")
            verdicts[join["keep"]] = {"matched": False, "why": "the frames around this join could not be read"}
            continue
        box = None
        if win["outSource"] == win["inSource"]:
            box = _head_box(_track(project_dir, win["outSource"]), [win["planned"][0], win["planned"][1]], o["crop"], o["disp"])
        else:
            a = _head_box(_track(project_dir, win["outSource"]), [win["planned"][0]], o["crop"], o["disp"])
            b = _head_box(_track(project_dir, win["inSource"]), [win["planned"][1]], i["crop"], i["disp"])
            if a and b:
                box = (min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3]))
        verdict = best_pair(list(zip(win["outTimes"], da)), list(zip(win["inTimes"], db)), box, win["planned"])
        verdicts[join["keep"]] = cache[key] = verdict
        changed = True
    if changed:
        if len(cache) > CACHE_LIMIT:
            cache = dict(list(cache.items())[-CACHE_LIMIT:])
        try:
            cache_path.parent.mkdir(parents=True, exist_ok=True)
            part = cache_path.with_name(f"{cache_path.stem}.{os.getpid()}.part")
            part.write_text(json.dumps({"version": VERSION, "entries": cache}), encoding="utf-8")
            part.replace(cache_path)
        except OSError as exc:
            log(f"match cache not saved: {exc!r}")
    return verdicts
