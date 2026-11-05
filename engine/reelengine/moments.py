"""`moments`: what an edit changed on screen, drawn in the order a person wants to see it.

After the AI changes project.json, the app should show the change at once instead of after a whole
draft. `changed()` compares the project as it was last shown (`work/moments/base.json`) with the
project now and finds the output seconds whose picture changed. `run()` then draws two or three
stills inside them, the 2 s window around the first still, and the full draft, and reports each one
on the protocol (`ready`) the moment its file exists.

What changes the picture, on the new project's output clock:
  - the output format, the sources (or their mirroring), the caption look (`captions.style`,
    `captions.enabled`) or any field this module does not know: the whole video;
  - the cut: everything from the first frame of the first segment that differs to the end, since every
    later frame moved;
  - a b-roll item or a zoom: where it was and where it is now, the whole of both spans even when only its
    timing changed (a fade, a clip's playback, an animation and a zoom's framing all follow the span);
  - a b-roll item whose span meets a changed zoom: its whole span, since cards are placed around the zoom;
    a b-roll item or zoom that runs across the cut's first moved frame: its whole span, since cards and
    zooms are framed on the face over their whole span;
  - a caption line whose words, text or timing changed (a correction, a hidden line): where it was and
    is (lines fade in and out, so a retimed line changes over its whole span); a line that meets a
    changed b-roll item: its whole span, since a split view moves every line it mostly covers.
Music, the post text, notes, the title and the cover are not in the picture and change nothing.

Each span is taken from the renderer's own timing (cut.build_timeline, broll.plan_windows,
zoom.windows, captions.build_cues), so it is the span the render draws. Spans of the old project are
on the old clock; the two clocks agree up to the first changed frame of the cut and everything after
it is already changed, so an old span is used as it is, cut to the new video's length.

The stills follow simple rules (no ranker): one inside a whole-video change (on a caption line, so a
new caption look shows), the middle of each edited b-roll item and zoom, each new cut, the middle of
each changed caption line, in that order, at most three. Something that only moved because of another
edit gets no still of its own.
"""
from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Optional

from . import broll as brollmod, captions as capmod, project as projmod, tools, zoom as zoommod
from .proto import EngineError, log, progress, ready
from .render_ctx import RenderCtx

BASE_REL = "work/moments/base.json"
SNAPSHOT_VERSION = 1
MAX_STILLS = 3
WINDOW_SECONDS = 2.0
STILL_WIDTH = 540          # what look_at_frames shows (frames.run)
EPS = 1e-6

# Top-level project fields, by what they do to the picture. Anything else that changes redraws the
# whole video: a new field nobody taught this module about must never be read as "nothing changed".
WHOLE = ("format", "sources")
DIFFED = ("cut", "captions", "broll", "zooms")
NOT_SEEN = ("music", "post", "notes", "title", "cover", "updatedAt", "createdAt", "version", "id", "slug",
            "schemaVersion", "transcript")
# captions: these redraw every line; corrections, hidden lines, splits, joins and digits are compared line by line
CAPTION_LOOK = ("style", "enabled")
CAPTION_LINES = ("corrections", "hidden", "split", "join", "digits")

KIND_ORDER = ("all", "broll", "zoom", "cut", "caption")


# --- snapshots ----------------------------------------------------------------------------------

def base_file(project_dir: Path) -> Path:
    return Path(project_dir) / BASE_REL


def animation_stats(project_dir: Path) -> dict:
    """{file name: [size, mtime_ns]} of the app's rendered animations. A remade animation keeps its
    file name and its project.json entry, so only the file shows that it changed."""
    d = Path(project_dir) / "work" / "animations"
    out = {}
    if d.is_dir():
        for f in sorted(d.iterdir()):
            try:
                st = f.stat()
            except OSError:
                continue
            if f.is_file():
                out[f.name] = [st.st_size, st.st_mtime_ns]
    return out


def snapshot(project_dir: Path) -> dict:
    """What the screen shows once this state is drawn: the project and its animation files."""
    return {"version": SNAPSHOT_VERSION, "project": projmod.load(project_dir),
            "animations": animation_stats(project_dir)}


def read_base(project_dir: Path) -> Optional[dict]:
    """The last state shown, or None when there is none (or it can't be read): then all of it is new."""
    f = base_file(project_dir)
    try:
        snap = projmod.read_json(f)
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as exc:
        log(f"# moments: unreadable {f}: {exc}")
        return None
    if not isinstance(snap, dict) or snap.get("version") != SNAPSHOT_VERSION or not isinstance(snap.get("project"), dict):
        log(f"# moments: {f} is not a version {SNAPSHOT_VERSION} snapshot")
        return None
    return snap


# --- what changed -------------------------------------------------------------------------------

def _plan_ctx(proj: dict, tl, project_dir: Path, root: Optional[Path]) -> RenderCtx:
    """A RenderCtx carrying only what the timing functions read (no ffmpeg, no output)."""
    return RenderCtx(project=proj, project_dir=Path(project_dir), root=root, out_timeline=tl.segments,
                     word_out_time=tl.word_out_time, duration=tl.duration, fmt=dict(proj["format"]),
                     draft=True, work=Path(project_dir) / "work", ffmpeg="", ffprobe="",
                     progress=lambda *_: None, word_out_end=tl.word_out_end, words=tl.words)


def _key(obj) -> str:
    return json.dumps(obj, sort_keys=True, ensure_ascii=False)


def _whole_picture(old: dict, new: dict) -> Optional[str]:
    """Why every frame may have changed, or None."""
    for k in WHOLE:
        if _key(old.get(k)) != _key(new.get(k)):
            return f"{k} changed"
    oc, nc = old.get("captions") or {}, new.get("captions") or {}
    for k in CAPTION_LOOK:
        if _key(oc.get(k)) != _key(nc.get(k)):
            return f"captions.{k} changed"
    for k in sorted(set(oc) | set(nc)):
        if k not in CAPTION_LOOK + CAPTION_LINES and _key(oc.get(k)) != _key(nc.get(k)):
            return f"captions.{k} changed (not a field compared line by line)"
    for k in sorted(set(old) | set(new)):
        if k not in WHOLE + DIFFED + NOT_SEEN and _key(old.get(k)) != _key(new.get(k)):
            return f"{k} changed (not a field compared moment by moment)"
    return None


def _seg_key(s) -> tuple:
    return (s.source, round(s.src_start, 6), round(s.src_end, 6))


def first_moved(old_segs: list, new_segs: list) -> Optional[float]:
    """The first output second (new clock) whose frame comes from a different source moment, or None
    when every frame of the new cut is where it was (the same cut, or the old one with its end cut off)."""
    for i, n in enumerate(new_segs):
        if i >= len(old_segs):
            return n.out_start
        o = old_segs[i]
        if _seg_key(o) == _seg_key(n):
            continue
        if o.source == n.source and abs(o.src_start - n.src_start) < EPS:
            # same start, other end: the frames up to the shorter end are the same
            return n.out_start + min(o.src_end - o.src_start, n.src_end - n.src_start)
        return n.out_start
    return None


def _cuts(segs: list) -> list:
    """[(output second, (outgoing source moment, incoming source moment))] for each splice."""
    out = []
    for a, b in zip(segs, segs[1:]):
        if a.source != b.source or abs(a.src_end - b.src_start) > EPS:
            out.append((b.out_start, (a.source, round(a.src_end, 6), b.source, round(b.src_start, 6))))
    return out


def _mid(span) -> float:
    return (span[0] + span[1]) / 2.0


def _match(old: list, new: list) -> list:
    """Pairs (old item or None, new item or None) by identity, the n-th of a repeated identity with
    the n-th. Items are (identity, content key, (t0, t1), label, framed over)."""
    left: dict = {}
    for it in old:
        left.setdefault(it[0], []).append(it)
    pairs = []
    for it in new:
        q = left.get(it[0])
        pairs.append((q.pop(0) if q else None, it))
    pairs += [(it, None) for q in left.values() for it in q]
    return pairs


def _diff_items(kind: str, old: list, new: list, moved_at: Optional[float], duration: float) -> list:
    """Changes between two lists of (identity, content key, (t0, t1), label, framed over) on their own clocks."""
    out = []
    for o, n in _match(old, new):
        if o and n and o[1] == n[1]:
            if abs(o[2][0] - n[2][0]) < EPS and abs(o[2][1] - n[2][1]) < EPS:
                continue
            # the same item, retimed by another edit: redrawn over both spans (fades, playback and framing
            # follow the span), but that edit's own stills show it
            out.append({"kind": kind, "id": n[3], "regions": [list(o[2]), list(n[2])], "at": [], "why": "retimed"})
            continue
        regions = [list(x[2]) for x in (o, n) if x]
        label = (n or o)[3]
        why = "added" if not o else "removed" if not n else "edited"
        # a removed item is seen where it was, inside the new video; past the cut's first moved frame
        # that second of the old clock is not the same moment of the new video
        a, b = (n or o)[2]
        b = min(b, duration) if n else min(b, duration, moved_at if moved_at is not None else b)
        out.append({"kind": kind, "id": label, "regions": regions, "at": [_mid((a, b))] if b > a + EPS else [],
                    "why": why})
    return out


def _overlaps(span, regions: list) -> bool:
    return any(span[0] < r[1] - EPS and r[0] < span[1] - EPS for r in regions)


def _brolls(proj: dict, tl, project_dir: Path, root: Optional[Path], changed_anims: set) -> list:
    """(identity, content, span, label, framed over) for every b-roll item on screen, with the renderer's
    timing. A card is placed on the face over its own span."""
    out = []
    for p in brollmod.plan_windows(_plan_ctx(proj, tl, project_dir, root)):
        it = p["item"]
        stem = _anim_stem(it.get("asset"))
        content = _key(it) + ("|remade" if stem and stem in changed_anims else "")
        out.append((str(p["id"]), content, (p["t0"], p["t1"]), str(p["id"]), (p["t0"], p["t1"])))
    return out


def _anim_stem(asset) -> Optional[str]:
    """The animation file stem an asset ref may name: a bare animation id, or a work/animations path."""
    if not isinstance(asset, str) or not asset:
        return None
    if "/" not in asset and "\\" not in asset:
        return asset.split(".")[0]
    parts = asset.replace("\\", "/").split("/")
    if len(parts) >= 3 and parts[-3] == "work" and parts[-2] == "animations":
        return parts[-1].split(".")[0]
    return None


def _zooms(proj: dict, tl, project_dir: Path, root: Optional[Path]) -> list:
    """(identity, content, span on screen, label, framed over) for every zoom on screen."""
    zs = proj.get("zooms") or []
    ctx = _plan_ctx(proj, tl, project_dir, root)
    framed = zoommod.framed_over(ctx)
    out = []
    for i, t0, t1 in zoommod.windows(ctx):
        k = _key(zs[i])
        out.append((k, k, (t0, t1), f"zoom {i + 1}", framed[i]))
    return out


def _cues(proj: dict, tl) -> list:
    cap = proj.get("captions") or {}
    if not cap.get("enabled", True):
        return []
    out = []
    for c in capmod.build_cues(tl.words_out, cap, capmod.hidden_set(tl, cap)):
        ident = _key([list(x) for x in c["wids"]])
        out.append((ident, _key([ident, c["t"]]), (c["s"], c["e"]), c["t"], (c["s"], c["e"])))
    return out


def _timeline(proj: Optional[dict], words: list, project_dir: Path):
    if proj is None:
        return None
    try:
        return projmod.timeline(project_dir, proj, words)
    except EngineError as exc:          # an empty cut (a project before its first edit)
        log(f"# moments: no earlier picture to compare ({exc.code})")
        return None


def changed(old: Optional[dict], new: dict, words: list, project_dir: Path, root: Optional[Path] = None,
            old_anims: Optional[dict] = None, new_anims: Optional[dict] = None) -> dict:
    """The output seconds whose picture differs between project `old` (None: nothing shown yet) and
    project `new`, both timed from `words`.
    -> {"duration", "fps", "intervals": [[a, b], ...] sorted and merged on the new clock,
        "changes": [{"kind": all|cut|broll|zoom|caption, "id"?, "regions": [[a, b]], "at": [seconds], "why"}]}
    `at` holds the moments each change would best be seen at; pick_stills chooses among them."""
    tl = projmod.timeline(project_dir, new, words)
    dur, fps = tl.duration, float(new["format"]["fps"])
    old_tl = _timeline(old, words, project_dir)
    whole = "nothing was shown before" if old_tl is None else _whole_picture(old, new)
    if whole:
        cues = _cues(new, tl)
        at = ([_mid(cues[0][2])] if cues else []) + [dur / 2.0]
        changes = [{"kind": "all", "regions": [[0.0, dur]], "at": at, "why": whole}]
    else:
        changes = []
        x = first_moved(old_tl.segments, tl.segments)
        if x is not None and x < dur - EPS:
            known = {k for _, k in _cuts(old_tl.segments)}
            new_cuts = [t for t, k in _cuts(tl.segments) if t >= x - EPS and k not in known]
            changes.append({"kind": "cut", "regions": [[x, dur]], "at": new_cuts or [x],
                            "why": "the cut changed from here on"})
        anims = {n for n in set(old_anims or {}) | set(new_anims or {})
                 if (old_anims or {}).get(n) != (new_anims or {}).get(n)}
        stems = {n.split(".")[0] for n in anims}
        old_b, new_b = _brolls(old, old_tl, project_dir, root, set()), _brolls(new, tl, project_dir, root, stems)
        old_z, new_z = _zooms(old, old_tl, project_dir, root), _zooms(new, tl, project_dir, root)
        zooms = _diff_items("zoom", old_z, new_z, x, dur)
        brolls = _diff_items("broll", old_b, new_b, x, dur)
        # Each rule below can redraw what a later one reads, so they run in this order.
        if x is not None:
            # framed on the face over a span that runs across x, and the face after x is other footage now
            for side, out in ((new_z, zooms), (new_b, brolls)):
                done = {c["id"] for c in out}
                for _ident, _content, span, label, framed in side:
                    if label not in done and framed[0] < x - EPS < framed[1]:
                        out.append({"kind": "zoom" if out is zooms else "broll", "id": label, "regions": [list(span)],
                                    "at": [], "why": "framed across the cut's first moved frame"})
        # cards are placed around the zoom under them (broll.zones_for): a changed zoom moves every card it meets
        zr = [r for c in zooms for r in c["regions"]]
        done = {c["id"] for c in brolls}
        for side in (old_b, new_b):
            for ident, _content, span, label, _framed in side:
                if ident not in done and _overlaps(span, zr):
                    done.add(ident)         # unchanged, so its span is the same on both clocks
                    brolls.append({"kind": "broll", "id": label, "regions": [list(span)], "at": [],
                                   "why": "placed around a changed zoom"})
        changes += brolls + zooms
        old_c, new_c = _cues(old, old_tl), _cues(new, tl)
        changes += _diff_items("caption", old_c, new_c, x, dur)
        # a split view moves each caption line it mostly covers (captions.cue_position), whole line
        br = [r for c in brolls for r in c["regions"]]
        for _ident, _content, span, label, _framed in old_c + new_c:
            if _overlaps(span, br):
                changes.append({"kind": "caption", "id": label, "regions": [list(span)], "at": [],
                                "why": "a line a changed b-roll item may move"})
    return {"duration": dur, "fps": fps, "intervals": merge([r for c in changes for r in c["regions"]], dur),
            "changes": changes}


def merge(spans: list, duration: float) -> list:
    """Spans cut to [0, duration], sorted, overlapping or touching ones joined, empty ones dropped."""
    cut = sorted([max(0.0, a), min(duration, b)] for a, b in spans)
    out: list = []
    for a, b in cut:
        if b - a <= EPS:
            continue
        if out and a <= out[-1][1] + EPS:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return [[round(a, 6), round(b, 6)] for a, b in out]


# --- what to draw -------------------------------------------------------------------------------

def frame_in(t: float, intervals: list, fps: float, duration: float) -> Optional[int]:
    """The frame shown at `t` (render.frame_at), moved to the first frame of t's interval when
    rounding left it; None when t is in no interval or the interval holds no frame start."""
    n = max(1, int(round(duration * fps)))
    for a, b in intervals:
        if a - EPS <= t <= b + EPS:
            k = min(max(0, int(round(t * fps))), n - 1)
            if a - EPS <= k / fps < b:
                return k
            k = max(0, int(math.ceil(a * fps - EPS)))
            return k if k / fps < b and k <= n - 1 else None
    return None


def pick_stills(found: dict, limit: int = MAX_STILLS) -> list:
    """Up to `limit` output seconds on the frame grid, in the order to draw them: each change's
    moments, the kinds in KIND_ORDER, each kind in time order."""
    fps, dur, iv = found["fps"], found["duration"], found["intervals"]
    picked: list = []
    for kind in KIND_ORDER:
        for t in sorted(t for c in found["changes"] if c["kind"] == kind for t in c["at"]):
            k = frame_in(t, iv, fps, dur)
            if k is not None and k not in picked and len(picked) < limit:
                picked.append(k)
    if not picked and iv:       # something changed but no rule named a moment of it: its middle, never nothing
        k = frame_in(_mid(iv[0]), iv, fps, dur)
        picked += [] if k is None else [k]
    return [round(k / fps, 6) for k in picked]


def window_around(t: float, duration: float, fps: float, seconds: float = WINDOW_SECONDS) -> Optional[list]:
    """[a, b], `seconds` long on the frame grid with `t` inside, within the video; None when the
    video is too short for a window to be worth more than the draft."""
    if duration <= seconds + EPS:
        return None
    n = int(round(seconds * fps))                      # frames in a window
    frames = max(1, int(round(duration * fps)))        # the video's frames, as render.frame_at counts them
    k = int(math.floor((t - seconds / 2) * fps + EPS))
    k = max(0, min(k, frames - n))
    return [round(k / fps, 6), round(min(duration, (k + n) / fps), 6)]


# --- the command --------------------------------------------------------------------------------

def mark(project_dir: Path) -> dict:
    """Records the project as it is as what the screen shows (the state a task starts from)."""
    f = base_file(project_dir)
    projmod.write_json(f, snapshot(project_dir))
    return {"base": str(f)}


def run(project_dir: Path, root: Optional[Path] = None, draft: bool = True) -> dict:
    """Stills inside what changed since the base snapshot, then the window around the first, then
    the draft. Each still and the window are announced with `ready` as soon as they exist. The base
    becomes this state only once everything is drawn: a run stopped part way (the next edit came
    first) leaves it, so the next run also shows what this one did not finish."""
    from . import render
    project_dir = Path(project_dir).resolve()
    root = tools.root_dir(str(root) if root else None)
    progress("moments", 1, "Looking at what changed", force=True)
    # taken first: a change saved after this is newer than the base it becomes, so it is drawn next time
    now = snapshot(project_dir)
    base = read_base(project_dir)
    words = projmod.load_transcript(project_dir, now["project"])["words"]
    found = changed(base and base["project"], now["project"], words, project_dir, root,
                    (base or {}).get("animations"), now["animations"])
    times = pick_stills(found)
    result = {"intervals": found["intervals"],
              "changes": [{k: v for k, v in c.items() if k != "at"} for c in found["changes"]],
              "stills": [], "window": None, "draft": None}
    if not times:
        projmod.write_json(base_file(project_dir), now)
        progress("moments", 100, "Nothing on screen changed", force=True)
        return result

    out_dir = render.preview_dir(project_dir) / "moments"
    if out_dir.is_dir():                 # the last run's stills: their moments are drawn again below
        for old in out_dir.glob("still_*.png"):
            old.unlink(missing_ok=True)
    win = window_around(times[0], found["duration"], found["fps"])     # its size; it is placed on the drawn still
    total = len(times) + (1 if win else 0) + (1 if draft else 0)

    def on_still(f: dict) -> None:
        result["stills"].append(f)
        ready("moments", 100.0 * len(result["stills"]) / total, "Here's your change",
              {"kind": "still", "t": f["t"], "file": f["file"]})

    drawn = render.stills(project_dir, times, STILL_WIDTH, root, out_dir=out_dir, on_still=on_still,
                          settle_within=found["intervals"])
    if win and drawn["frames"]:
        win = window_around(drawn["frames"][0]["t"], found["duration"], found["fps"])
        w = render.run(project_dir, window=f"{win[0]:.6f}:{win[1]:.6f}", root=root, verify=False)
        result["window"] = {"from": w["window"][0], "to": w["window"][1], "file": w["file"]}
        ready("moments", 100.0 * (len(times) + 1) / total, "Here's your change",
              {"kind": "window", "from": w["window"][0], "to": w["window"][1], "file": w["file"]})
    if draft:
        result["draft"] = render.run(project_dir, draft=True, root=root)
    result["animationsSampledAtEnd"] = drawn.get("animationsSampledAtEnd") or []
    projmod.write_json(base_file(project_dir), now)
    return result
