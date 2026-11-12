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


# --- re-timing ---------------------------------------------------------------------------------

def spec_of(sidecar: dict) -> tuple[str, dict]:
    """(template, the editor's params) from a rendered animation's sidecar: everything but FED."""
    params = {k: v for k, v in (sidecar.get("params") or {}).items() if k not in FED}
    return str(sidecar.get("template") or ""), params


def resolve(ctx, item: dict, sidecar: dict) -> dict:
    """The params the animation needs on the current cut: the editor's params, the beats re-timed
    to its anchor words and the free region above the face over its new window."""
    from .broll import LEAD, anim_context
    template, params = spec_of(sidecar)
    anc = item.get("anchor") or {}
    a, b = anc.get("from"), anc.get("to") or anc.get("from")
    lead = float(item["leadIn"]) if item.get("leadIn") is not None else LEAD
    # the same window the editor asked anim-context about (ai/src/tools.ts makeAnimation): --duration
    # only when the editor set one
    duration = params.get("duration")
    ac = anim_context(ctx, a, b, float(duration) if duration else None, lead)
    out = {**params, **beats(template, params, ac["words"])}
    # the editor's "full" stays full; otherwise full only when no readable room is left above the face
    layout = params.get("layout") or ac["layout"]
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


def key(template: str, params: dict) -> str:
    blob = json.dumps([VERSION, template, params], sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha1(blob.encode()).hexdigest()[:12]


def retimed_path(ctx, template: str, params: dict) -> Path:
    return Path(ctx.work) / "animations" / f"{template}-{key(template, params)}.mov"


def plan(ctx, item: dict, sidecar: dict) -> Optional[dict]:
    """None when the item's clip (rendered with `sidecar`) still fits the cut; else {template,
    params, out, ready}: the clip to play instead (`ready` once it has been rendered)."""
    from .compose_util import EngineError
    template, _ = spec_of(sidecar)
    if not template:
        return None
    try:
        params = resolve(ctx, item, sidecar)
    except EngineError:                  # anchor not in the cut: the item is skipped anyway
        return None
    want = {k: v for k, v in params.items() if not (k == "layout" and v == "top")}
    if same(want, _rendered_with(sidecar)):
        return None
    out = retimed_path(ctx, template, params)
    return {"template": template, "params": params, "out": out,
            "ready": out.exists() and out.with_suffix(".anim.json").exists()}


def jobs(ctx) -> list[dict]:
    """Every animation clip the current cut needs that is not rendered yet:
    [{id, template, params, out}] (out is an absolute path for the renderer)."""
    from .broll import _anim_of
    out, seen = [], set()
    for i, it in enumerate((ctx.project or {}).get("broll") or []):
        sc = _anim_of(ctx, it)
        if sc is None:
            continue
        p = plan(ctx, it, sc)
        if p is None or p["ready"] or str(p["out"]) in seen:
            continue
        seen.add(str(p["out"]))
        out.append({"id": it.get("id", f"b{i + 1}"), "template": p["template"], "params": p["params"],
                    "out": str(p["out"])})
    return out
