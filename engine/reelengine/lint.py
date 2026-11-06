"""Checkable My style rules: what `render --rules` measures on every render.

A My style rule the engine can measure carries a machine form next to its words, for example
{"kind": "captions.maxWords", "value": 2}. The app sends the active ones in a rules file,
{"version": 1, "rules": [{"id", "text", "check"}], "stopOn": [id, ...]}; `parse_rules` validates it
strictly (an unknown version, kind or field is an error, never skipped). A final render stops before
its encode when a rule in `stopOn` fails, so the editor can fix it first without paying for a video. `lint` measures each rule on what the render
really drew: the caption cue report, the b-roll layer records and the audio mix report. A rule is
met or not; there is no warning level. The result is data only: the app writes every sentence.

The kinds are the notes people send most that a render can measure, each with a setting the editor
can change to meet it:
  captions.maxWords   {value 1-4}    every caption shows at most `value` words (caption maxWords)
  captions.maxSize    {value 80-160} every caption is drawn at most `value` px tall at 1080 wide (caption size)
  captions.minSize    {value 80-160} every caption is drawn at least `value` px tall at 1080 wide (caption size)
  music.underVoiceDb  {value 12-30}  the voice sits at least `value` dB over the music while talking (music level)
  broll.keepOut       {zone}         no picture covers the face ("face") or the eyes-to-chin zone ("eyes"),
                                     counting pictures that hide the speaker on purpose (b-roll treatment)
"""
from __future__ import annotations

import json
from typing import Optional

from .proto import EngineError

VERSION = 1
# kind -> {field: allowed values}: a (lo, hi) number range, or a tuple of strings
KINDS: dict = {
    "captions.maxWords": {"value": (1, 4)},
    "captions.maxSize": {"value": (80, 160)},
    "captions.minSize": {"value": (80, 160)},
    "music.underVoiceDb": {"value": (12, 30)},
    "broll.keepOut": {"zone": ("face", "eyes")},
}
INTEGER_FIELDS = {("captions.maxWords", "value")}
# The mixer aims the voice-over-music gap at its level's target and the measured median lands
# near it, not on it: a rule asking for exactly the "quiet" level's 24 dB should not fail at 23.6.
# No measured distribution backs this 1 dB; tests/compositing/test_lint_render.py shows the quiet
# level meeting a 24 dB rule on a synthetic take, nothing more.
GAP_TOLERANCE_DB = 1.0
MAX_PLACES = 5          # the first few places a rule fails, enough to find and fix them


def _bad(msg: str) -> EngineError:
    return EngineError("BAD_RULE", msg, "A rule in My style can't be checked by this version of Reel Studio. "
                                        "Pause it in My style, or update Reel Studio.")


def parse_check(check, where: str = "check") -> dict:
    """One machine form, validated strictly. Raises BAD_RULE naming the problem."""
    if not isinstance(check, dict):
        raise _bad(f"{where}: expected an object")
    kind = check.get("kind")
    if not isinstance(kind, str) or kind not in KINDS:
        raise _bad(f"{where}.kind: unknown kind {kind!r}; known kinds: {', '.join(sorted(KINDS))}")
    fields = KINDS[kind]
    extra = set(check) - {"kind"} - set(fields)
    if extra:
        raise _bad(f"{where}: unknown field(s) {', '.join(sorted(extra))} for {kind}")
    out = {"kind": kind}
    for name, allowed in fields.items():
        if name not in check:
            raise _bad(f"{where}.{name}: missing for {kind}")
        val = check[name]
        if isinstance(allowed[0], str):
            if val not in allowed:
                raise _bad(f"{where}.{name}: must be one of {', '.join(allowed)}")
        else:
            lo, hi = allowed
            integer = (kind, name) in INTEGER_FIELDS
            if isinstance(val, bool) or not isinstance(val, (int, float)) or (integer and int(val) != val):
                raise _bad(f"{where}.{name}: expected {'a whole number' if integer else 'a number'}")
            if not lo <= val <= hi:
                raise _bad(f"{where}.{name}: must be between {lo} and {hi}")
            val = int(val) if integer else float(val)
        out[name] = val
    return out


def parse_rules(raw) -> tuple:
    """The rules file (a JSON string or already parsed) -> ([{"id", "text", "check"}], stop-on ids).
    Raises BAD_RULE."""
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError as exc:
            raise _bad(f"rules: not JSON ({exc})") from None
    if not isinstance(raw, dict) or not {"version", "rules"} <= set(raw) <= {"version", "rules", "stopOn"}:
        raise _bad("rules: expected {version, rules, stopOn?}")
    if raw["version"] != VERSION:
        raise _bad(f"rules.version: expected {VERSION}, got {raw['version']!r}")
    if not isinstance(raw["rules"], list):
        raise _bad("rules.rules: expected a list")
    out = []
    for i, r in enumerate(raw["rules"]):
        if not isinstance(r, dict) or set(r) != {"id", "text", "check"} \
                or not isinstance(r["id"], str) or not isinstance(r["text"], str):
            raise _bad(f"rules[{i}]: expected {{id, text, check}}")
        out.append({"id": r["id"], "text": r["text"], "check": parse_check(r["check"], f"rules[{i}].check")})
    stop = raw.get("stopOn", [])
    ids = {r["id"] for r in out}
    if not isinstance(stop, list) or not all(isinstance(s, str) and s in ids for s in stop):
        raise _bad("rules.stopOn: expected ids of the rules listed")
    return out, set(stop)


# --- the measurements, and the places each rule fails -------------------------------------------

def _size(c: dict, fmt: tuple) -> float:
    """A cue's drawn size in the rule's units: px at 1080 wide."""
    return c["size"] * 1080.0 / fmt[0]


def _cue(c: dict, **value) -> dict:
    return {"t0": round(float(c["s"]), 2), "t1": round(float(c["e"]), 2), "text": c["text"], **value}


def measure(cues: list, fmt: tuple, mix: Optional[dict], broll: list) -> dict:
    """The numbers the kinds are about, for this render (None when there is nothing to measure).
    The app fills in a new rule's value from these, so the version the person approves meets it."""
    words = [len(c["text"].split()) for c in cues]
    sizes = [_size(c, fmt) for c in cues]
    music = (mix or {}).get("music")
    return {"captions.maxWords": max(words) if words else None,
            "captions.maxSize": round(max(sizes), 1) if sizes else None,
            "captions.minSize": round(min(sizes), 1) if sizes else None,
            "music.underVoiceDb": music.get("measuredGapDb") if music else None,
            # pictures over the face / the eyes-to-chin zone
            "broll.keepOut.face": len(broll_places({"zone": "face"}, broll)),
            "broll.keepOut.eyes": len(broll_places({"zone": "eyes"}, broll))}


def caption_places(check: dict, cues: list, fmt: tuple) -> list:
    kind, limit = check["kind"], check["value"]
    if kind == "captions.maxWords":
        return [_cue(c, words=len(c["text"].split())) for c in cues if len(c["text"].split()) > limit]
    # half a pixel: sizes are whole pixels at the video's own width
    if kind == "captions.maxSize":
        return [_cue(c, px=round(_size(c, fmt))) for c in cues if _size(c, fmt) > limit + 0.5]
    return [_cue(c, px=round(_size(c, fmt))) for c in cues if _size(c, fmt) < limit - 0.5]


def music_places(check: dict, mix: Optional[dict], duration: float) -> list:
    """The measured median voice-over-music gap while talking (music.build_audio's mix report)."""
    whole = {"t0": 0.0, "t1": round(float(duration), 2)}
    if mix is None:
        return [{**whole, "unmeasured": True}]
    music = mix.get("music")
    if not music or music.get("measuredGapDb") is None:
        return []                       # no music, or no speech for it to sit under
    gap = float(music["measuredGapDb"])
    return [{**whole, "db": round(gap, 1)}] if gap + GAP_TOLERANCE_DB < check["value"] else []


def _overlaps(bbox, box) -> bool:
    """bbox (x0, y0, x1, y1) vs box (x, y, w, h)."""
    x0, y0, x1, y1 = bbox
    bx, by, bw, bh = box
    return x0 < bx + bw and x1 > bx and y0 < by + bh and y1 > by


def broll_places(check: dict, records: list) -> list:
    """layers.json records of what was shown. A treatment that hides the speaker covers the face."""
    out = []
    for r in records:
        if r.get("skipped") or r.get("t0") is None:
            continue
        zone = r.get("protected") if check["zone"] == "eyes" else r.get("face")
        hides = bool(r.get("faceHiding"))
        if hides or (r.get("bbox") and zone and _overlaps(r["bbox"], zone)):
            out.append({"t0": round(float(r["t0"]), 2), "t1": round(float(r["t1"]), 2), "item": r.get("id"),
                        "treatment": r.get("treatment"), "hides": hides})
    return out


def lint(rules: list, *, cues: list, fmt: tuple, mix: Optional[dict], broll: list, duration: float) -> dict:
    """Every parsed rule measured on one render. `cues` is the caption cue report (empty when the
    captions are off), `broll` the shown b-roll's layer records, `mix` the audio mix report, or None
    when the render could not say which mix it used."""
    failures = []
    for r in rules:
        c = r["check"]
        if c["kind"].startswith("captions."):
            places = caption_places(c, cues, fmt)
        elif c["kind"] == "music.underVoiceDb":
            places = music_places(c, mix, duration)
        else:
            places = broll_places(c, broll)
        if places:
            failures.append({"id": r["id"], "kind": c["kind"], "count": len(places), "places": places[:MAX_PLACES]})
    # checkedIds: a rule with no failure passed only if it is listed here. The app reads this from the version a
    # note starts from, so a rule saved or resumed after that render is not taken for one it passed.
    return {"ok": not failures, "checked": len(rules), "checkedIds": [r["id"] for r in rules], "failures": failures,
            "measured": measure(cues, fmt, mix, broll)}
