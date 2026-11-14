"""Animations that follow a re-cut.

An animation is rendered once from its template with its beats (when each quote word, list item,
label or typed line lands) and its free region above the face worked out from the cut it was made
on. The broll item is anchored to word ids, so its window moves with the cut; the beats inside the
clip did not, and a re-cut used to leave them landing on the wrong words (or the card over the face).

Here the beats are anchored to word ids too: for every animation item, its spec (template + the
params the editor chose, read from the clip's `.anim.json` sidecar) is re-timed against the CURRENT
cut. When the result differs from what the clip was rendered with, the clip to use is
work/animations/<template>-<key>.mov, keyed by the spec and the resolved timing, so the same
project.json always maps to the same file (and a re-cut back to an earlier edit reuses its clip).
The engine never runs a browser: `anim-jobs` lists the clips still to render, the app renders them
with the same template renderer (app/src/main/animation.ts) before every render, and until a clip
exists the old one plays with a note in layers.json.

The word matching is the same as ai/src/animations.ts (alignWordTimes / itemTimes / phraseTime),
so an animation on an unchanged cut resolves to exactly the params it was made with and is never
rendered twice.
"""
from __future__ import annotations

import copy
import hashlib
import json
import math
import unicodedata
from pathlib import Path
from typing import Optional

VERSION = 1                                   # bump when the resolution below changes
FED = ("region", "wordTimes", "at", "labelAt", "typeAt")   # set from the cut, never by the editor
_TOL = 0.0015                                  # seconds / px: rounding noise, not a change


# --- word matching (mirrors ai/src/animations.ts) ----------------------------------------------

def _round(x: float) -> float:
    return math.floor(x * 1000 + 0.5) / 1000          # JS Math.round(x * 1000) / 1000


def _norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", str(s).lower())
    return "".join(c for c in s if unicodedata.category(c)[0] in "LN" or c in "%$")


def _tokens(s) -> list[str]:
    return str(s if s is not None else "").split()


def _end(words: list[dict]) -> float:
    last = words[-1]
    return float(last["e"]) if last.get("e") is not None else float(last["t"])


def _fill_gaps(found: list, start: float, end: float) -> list[float]:
    out = list(found)
    for i in range(len(out)):
        if out[i] is not None:
            continue
        p = i - 1
        while p >= 0 and out[p] is None:
            p -= 1
        n = i + 1
        while n < len(out) and out[n] is None:
            n += 1
        a = out[p] if p >= 0 else start
        b = out[n] if n < len(out) else max(a, end)
        out[i] = a + (b - a) * (i - p) / (n - p)
    prev, res = 0.0, []
    for v in out:                                   # never earlier than the previous word or the clip start
        prev = max(prev, v, 0.0)
        res.append(_round(prev))
    return res


def align_word_times(text: str, words: list[dict]) -> list[float]:
    """Seconds (from the clip start) when each word of `text` is spoken."""
    toks = _tokens(text)
    if not toks or not words:
        return []
    found, j = [], 0
    for tok in toks:
        n, hit, span = _norm(tok), -1, 1
        k = j
        while n and hit < 0 and k < min(len(words), j + 4):
            if _norm(words[k]["w"]) == n:
                hit = k
            elif k + 1 < len(words) and _norm(words[k]["w"] + words[k + 1]["w"]) == n:
                hit, span = k, 2                    # "3,000" heard as "3" ",000"
            k += 1
        if hit >= 0:
            found.append(float(words[hit]["t"]))
            j = hit + span
        else:
            found.append(None)
    if all(v is None for v in found):              # a paraphrase: spread over the spoken span
        a, b = float(words[0]["t"]), float(words[-1]["t"])
        return [_round(a + (b - a) * i / max(1, len(toks) - 1)) for i in range(len(toks))]
    return _fill_gaps(found, float(words[0]["t"]), _end(words))


def item_times(items: list, words: list[dict]) -> list[float]:
    """Seconds (from the clip start) when each list item is named (its first or second word)."""
    if not items or not words:
        return []
    found, j = [], 0
    for item in items:
        ns = [x for x in (_norm(t) for t in _tokens(item)) if x][:2]
        hit = next((k for k in range(j, len(words)) if _norm(words[k]["w"]) in ns), -1)
        if hit >= 0:
            found.append(float(words[hit]["t"]))
            j = hit + 1
        else:
            found.append(None)
    return _fill_gaps(found, float(words[0]["t"]), _end(words))


def phrase_time(phrase, words: list[dict]) -> Optional[float]:
    """Start (from the clip start) of the phrase's first word among `words`, or None."""
    toks = _tokens(phrase)
    first = _norm(toks[0]) if toks else ""
    if not first:
        return None
    return next((float(w["t"]) for w in words if _norm(w["w"]) == first), None)


def beats(template: str, params: dict, words: list[dict]) -> dict:
    """The timing params for `template` from the anchor's words (empty when nothing is timed)."""
    text = params.get("text")
    if template == "big-quote" and isinstance(text, str):
        wt = align_word_times(text, words)
        return {"wordTimes": wt} if wt else {}
    if template == "list-reveal" and isinstance(params.get("items"), list):
        at = item_times(params["items"], words)
        return {"at": at} if at else {}
    if template in ("stat-count-up", "logo-pop") and isinstance(text, str):
        lt = phrase_time(text, words)
        return {} if lt is None else {"labelAt": lt}
    if template == "typing-terminal" and isinstance(text, str):
        tt = phrase_time(text, words)
        return {} if tt is None else {"typeAt": tt}
    return {}


# --- readable on a phone (mirrors ai/src/readable.ts) -----------------------------------------
# Every template shrinks its type until its content fits the region, so a smaller region above the
# face can leave the main text too small to read; the editor then goes full screen instead.

MIN_HERO_PX = 64               # main text floor, px at 1080 wide...
MIN_SCALE = 0.55               # ...and never below this share of the size the template was designed at
FULL_REGION = {"x": 60, "y": 260, "w": 960, "h": 1240}


def _chars(v) -> int:
    if isinstance(v, str):
        return len(v.strip())
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return len(str(int(v)) if float(v).is_integer() else repr(v))      # JS String(v)
    return 0


def _pieces(template: str, p: dict) -> Optional[tuple]:
    """(hero px, max scale above the face, max scale full screen, [(chars, px, nowrap, mono)])."""
    if template == "stat-count-up":
        return 230, 1.35, 2.2, [(max(1, _chars(p.get("value"))), 230, True, False), (_chars(p.get("text")), 66, False, False)]
    if template == "price-tag":
        return 196, 1.35, 2.2, [(max(1, _chars(p.get("value"))), 196, True, False), (_chars(p.get("oldValue")), 92, True, False),
                                (_chars(p.get("text")) + _chars(p.get("name")), 54, False, False)]
    if template == "big-quote":
        return 96, 1.35, 2.2, [(max(1, _chars(p.get("text"))), 96, False, False), (_chars(p.get("author")), 44, False, False)]
    if template == "list-reveal":
        items = [str(x) for x in p.get("items") or []] if isinstance(p.get("items"), list) else []
        return 72, 1.35, 2.2, [(_chars(p.get("text")), 72, False, False), *((max(1, len(x)), 72, True, False) for x in items)]
    if template == "logo-pop":
        return 72, 1.35, 2.2, [(max(1, _chars(p.get("text"))), 72, False, False)]
    if template == "typing-terminal":
        return 64, 1.35, 1.3, [(max(1, _chars(p.get("text"))), 64, False, True), (_chars(p.get("response")), 54, False, True)]
    return None


def min_hero_px(template: str) -> int:
    s = _pieces(template, {})
    return max(MIN_HERO_PX, math.floor(MIN_SCALE * s[0] + 0.5)) if s else MIN_HERO_PX


def hero_px(template: str, params: dict, region: dict, layout: str = "top") -> Optional[int]:
    """Estimated main text height (px at 1080 wide) in `region`, or None for an unknown template."""
    s = _pieces(template, params)
    if s is None:
        return None
    hero, max_top, max_full, pieces = s
    max_w, max_h = region["w"] * 0.97, region["h"] * 0.97

    def fits(k: float) -> bool:
        h = 0.0
        for chars, size, nowrap, mono in pieces:
            if not chars:
                continue
            w = chars * (0.6 if mono else 0.56) * size * k
            if nowrap and w > max_w:
                return False
            h += size * k * 1.12 * (1 if nowrap else max(1, math.ceil(w / max_w)))
        return h <= max_h
    k = max_full if layout == "full" else max_top
    while k > 0.05 and not fits(k):
        k *= 0.95
    return math.floor(hero * k + 0.5)


def readable_above_face(template: str, params: dict, region: dict) -> bool:
    """Does the main text still read in the region above the face (unknown templates: yes)?"""
    px = hero_px(template, params, region, "top")
    return px is None or px >= min_hero_px(template)


# --- re-timing ---------------------------------------------------------------------------------

def spec_of(sidecar: dict) -> tuple[str, dict]:
    """(template, the editor's params) from a rendered animation's sidecar: everything but FED."""
    params = {k: v for k, v in (sidecar.get("params") or {}).items() if k not in FED}
    return str(sidecar.get("template") or ""), params


def resolve(ctx, item: dict, sidecar: dict, start: Optional[float] = None) -> dict:
    """The params the animation needs on the current cut: the editor's params, the beats re-timed
    to its anchor words and the free region above the face over its new window. `start` (output s):
    when the clip comes on, if not its first word minus its lead-in (a card before it held on)."""
    from .broll import LEAD, anim_context
    from .compose_util import word_start
    template, params = spec_of(sidecar)
    anc = item.get("anchor") or {}
    a, b = anc.get("from"), anc.get("to") or anc.get("from")
    lead = float(item["leadIn"]) if item.get("leadIn") is not None else LEAD
    s = word_start(ctx, a) if start is not None else None
    if s is not None:
        lead = s - start
    # the same window the editor asked anim-context about (ai/src/tools.ts makeAnimation): --duration
    # only when the editor set one
    duration = params.get("duration")
    ac = anim_context(ctx, a, b, float(duration) if duration else None, lead)
    # a word already said when a late clip comes on lands at once
    words = [{**w, "t": max(0.0, w["t"]), "e": max(0.0, w["e"])} for w in ac["words"]]
    out = {**params, **beats(template, params, words)}
    # the editor's choice stays; otherwise full screen when the room above the face is too small for
    # anything, or for this text to read (as make_animation decides)
    layout = params.get("layout") or ac["layout"]
    if not params.get("layout") and layout == "top" and not readable_above_face(template, out, ac["region"]):
        layout = "full"
    if layout == "full":
        out["layout"] = "full"
    else:
        out["region"] = ac["region"]
    return out


def same(a, b) -> bool:
    """Equal params, numbers within rounding noise."""
    if isinstance(a, bool) or isinstance(b, bool):
        return a == b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return abs(a - b) <= _TOL
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(same(a[k], b[k]) for k in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(same(x, y) for x, y in zip(a, b))
    return a == b


def _rendered_with(sidecar: dict) -> dict:
    """The params a clip was rendered with, as resolve() would write them (a `top` clip without a
    layout param is the same as one with it)."""
    p = dict(sidecar.get("params") or {})
    if p.get("layout") == "top":
        p.pop("layout")
    return p


def project_fps(ctx) -> float:
    """The rate a re-timed clip is rendered at: the project's, as make_animation renders the first one
    (ai/src/tools.ts). Not ctx.fmt, which a draft lowers to the preview rate (render.preview_fps)."""
    return float(((ctx.project or {}).get("format") or {}).get("fps") or 30)


def at_project_rate(ctx):
    """ctx on the project's frame clock. A card's start can snap to a beat on the frame grid
    (music.accent_time), and a draft runs on the preview grid (render.preview_fps), so a draft and the
    final could place one animation a frame apart and name two different re-timed clips. A re-timed clip is
    worked out wholly on the project's clock: every render then asks for the clip anim-jobs listed. A draft
    plays it at most one preview frame from where it places the layer."""
    fps = project_fps(ctx)
    if float((ctx.fmt or {}).get("fps") or 30) == fps:
        return ctx
    view = copy.copy(ctx)
    view.fmt = dict(ctx.fmt, fps=fps)
    view._lint_snap_requests = None      # a lint pass records the render's own snaps, not these
    return view


def starts(ctx) -> dict:
    """{b-roll id: output second it comes on, on the project's clock} (see at_project_rate)."""
    from .broll import plan_windows
    return {w["id"]: w["t0"] for w in plan_windows(at_project_rate(ctx))}


def key(template: str, params: dict, fps: float = 30.0) -> str:
    # the rate is in the key: a clip made for another rate is a different clip, never reused
    blob = json.dumps([VERSION, template, params, float(fps)], sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha1(blob.encode()).hexdigest()[:12]


def retimed_path(ctx, template: str, params: dict) -> Path:
    return Path(ctx.work) / "animations" / f"{template}-{key(template, params, project_fps(ctx))}.mov"


def plan(ctx, item: dict, sidecar: dict, start: Optional[float] = None) -> Optional[dict]:
    """None when the item's clip (rendered with `sidecar`) still fits the cut, coming on at `start`;
    else {template, params, out, ready}: the clip to play instead (`ready` once it has been rendered)."""
    from .compose_util import EngineError
    template, _ = spec_of(sidecar)
    if not template:
        return None
    try:
        params = resolve(ctx, item, sidecar, start)
    except EngineError:                  # anchor not in the cut: the item is skipped anyway
        return None
    want = {k: v for k, v in params.items() if not (k == "layout" and v == "top")}
    if same(want, _rendered_with(sidecar)):
        return None
    out = retimed_path(ctx, template, params)
    return {"template": template, "params": params, "fps": project_fps(ctx), "out": out,
            "ready": out.exists() and out.with_suffix(".anim.json").exists()}


def rendered_clips(project_dir: Path) -> dict:
    """{work/animations/<file>: [size, mtime_ns]} of the re-timed clips on disk: part of a version's
    fingerprint, so a clip rendered after a version was saved (a re-time that failed then) starts a
    new version instead of changing the saved one."""
    d = Path(project_dir) / "work" / "animations"
    if not d.is_dir():
        return {}
    return {f"work/animations/{f.name}": [f.stat().st_size, f.stat().st_mtime_ns] for f in sorted(d.glob("*.mov"))}


def jobs(ctx) -> list[dict]:
    """Every animation clip the current cut needs that is not rendered yet:
    [{id, template, params, fps, out}] (out is an absolute path for the renderer)."""
    from .broll import _anim_of, plan_windows
    out, seen = [], set()
    ctx = at_project_rate(ctx)
    for w in plan_windows(ctx):                  # where each card actually comes on
        sc = _anim_of(ctx, w["item"])
        if sc is None:
            continue
        p = plan(ctx, w["item"], sc, w["t0"])
        if p is None or p["ready"] or str(p["out"]) in seen:
            continue
        seen.add(str(p["out"]))
        out.append({"id": w["id"], "template": p["template"], "params": p["params"], "fps": p["fps"],
                    "out": str(p["out"])})
    return out
