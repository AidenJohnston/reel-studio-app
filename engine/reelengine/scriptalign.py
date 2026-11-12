"""Captions follow the locked script: an editor's rule. On screen the words are the SCRIPT's (names,
brand spellings, numbers as written, exact phrasing), at the times the AUDIO says them.

The script's words are aligned to the transcript's words at word level (an edit-distance alignment
over normalised keys: case, punctuation and number words don't count, so "four point oh" and "4.0"
are the same key). The result is a list of groups, each "these transcript words are shown as these
script words":

  * where a stretch of speech matches the script closely (a SPAN), each matched or misheard word is
    shown as the script writes it; when the counts differ ("Clod code" -> "Claude Code", a word whisper
    dropped) the script's words share the transcript words' time;
  * where the speaker went off-script (an ad-lib, a skipped line) the transcript is kept: an extra
    spoken word inside a span stays as heard, and a gap longer than GAP_MAX words ends the span;
  * a line said twice (a retake) is matched each time: whatever speech is left unmatched is aligned
    against the whole script again.

Anchors never move: b-roll, zooms, line edits and corrections stay on transcript word ids, and only
the text drawn for them changes (captions.follow_script). The mapping is a pure function of the
script and the transcript words, stored in work/script-align.json under a hash of both, so the same
script and transcript always give the same captions.
"""
from __future__ import annotations

import difflib
import hashlib
import json
import re
from decimal import Decimal
from pathlib import Path
from typing import Optional

from .vocab import sound_key

VERSION = 1
FILE = "script-align.json"
MATCH, MISMATCH, GAP = 2, -1, -1     # alignment scores
GAP_MAX = 3          # more unmatched words than this in a row (either side) ends a span: off-script
MIN_MATCHES = 2      # a span needs this many exactly matched words
MIN_RATIO = 0.5      # ... and this share of its transcript words matched exactly
ALIKE = 0.5          # spelling similarity that makes a word next to a span its misheard script word


def script_text(project_dir: Optional[Path], proj: dict) -> str:
    """The locked script: the plan's script once the creator locked it (`plan.script`: their rewrite,
    else the draft), else project.json `script` (text, or {text}), else script.txt / script.md in the
    project folder. "" when there is none."""
    plan = (proj.get("plan") or {}).get("script") if isinstance(proj.get("plan"), dict) else None
    if isinstance(plan, dict) and plan.get("locked"):
        locked = plan.get("rewrite") or plan.get("draft")
        if isinstance(locked, str) and locked.strip():
            return locked
    sc = proj.get("script")
    if isinstance(sc, dict):
        sc = sc.get("text") or sc.get("script") or ""
    if isinstance(sc, str) and sc.strip():
        return sc
    if project_dir is None:
        return ""
    for name in ("script.txt", "script.md"):
        f = Path(project_dir) / name
        try:
            if f.is_file() and f.stat().st_size < 200_000:
                return f.read_text(encoding="utf-8", errors="replace")
        except OSError:
            pass
    return ""


def script_words(text: str) -> list:
    """The script as caption words: stage directions in [brackets] and markdown marks dropped, dashes
    between words made spaces, tokens with no letter or digit left out."""
    text = re.sub(r"\[[^\]\n]*\]", " ", text or "")
    text = re.sub(r"[#*_>`|]+", " ", text)
    text = re.sub(r"\s*[—–]\s*", " ", text)
    return [w for w in text.split() if re.search(r"\w", w)]


# --- normalised keys -----------------------------------------------------------------------------

_UNITS = {w: i for i, w in enumerate(
    "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen "
    "sixteen seventeen eighteen nineteen".split())}
_TENS = {w: 10 * (i + 2) for i, w in enumerate("twenty thirty forty fifty sixty seventy eighty ninety".split())}
_SCALES = {"thousand": 10 ** 3, "million": 10 ** 6, "billion": 10 ** 9}
_SUFFIXES = {"k": 10 ** 3, "m": 10 ** 6, "b": 10 ** 9}
_DIGIT_WORDS = dict(_UNITS, oh=0, o=0)
_SAME = {"dollars": "dollar", "bucks": "dollar", "%": "percent"}
_NUMERIC = re.compile(r"([$€£]?)(\d[\d,]*)(\.\d+)?([kmb]?)(%?)")


def _core(word: str) -> str:
    """'"Neve’s,' -> "neves": case, edge punctuation, apostrophes and hyphens don't count."""
    w = word.strip().lower().replace("’", "'")
    w = re.sub(r"^[^\w$€£%]+|[^\w%]+$", "", w)
    return w.replace("'", "").replace("-", "")


def _word_value(core: str):
    """'three' -> (3, "unit"), 'twenty' -> (20, "tens"), 'twentyfive' -> (25, "unit"), else None."""
    if core in _UNITS:
        return _UNITS[core], "unit"
    if core in _TENS:
        return _TENS[core], "tens"
    for tens, v in _TENS.items():
        if core.startswith(tens) and 0 < _UNITS.get(core[len(tens):], 0) < 10:
            return v + _UNITS[core[len(tens):]], "unit"
    return None


def _value_text(value: str, scale: int) -> str:
    """'1.5' x 1,000,000 -> '1500000'. Unscaled, a number keeps its written decimals: '4.0' stays."""
    if scale == 1:
        return value
    d = Decimal(value) * scale
    return str(d.to_integral_value()) if d == d.to_integral_value() else format(d.normalize(), "f")


def _written_number(words: list, cores: list, i: int):
    """'$3,000' / '3' ',000' / '1.5M' / '25%' / '1.5 million' at words[i] -> (keys, next index)."""
    m = _NUMERIC.fullmatch(cores[i])
    if not m:
        return None
    cur, digits, frac, suffix, pct = m.groups()
    value, j = digits.replace(",", ""), i + 1
    while j < len(words) and re.fullmatch(r",\d{3}[.,!?]*", words[j].strip()):   # whisper's "3" ",000"
        value += words[j].strip()[1:4]
        j += 1
    scale = _SUFFIXES.get(suffix, 1)
    if scale == 1 and j < len(cores) and cores[j] in _SCALES:
        scale, j = _SCALES[cores[j]], j + 1
    out = [_value_text(value + (frac or ""), scale)]
    if cur:
        out.append("dollar" if cur == "$" else cur)
    if pct:
        out.append("percent")
    return out, j


def _spoken_number(cores: list, i: int):
    """A number said in words from cores[i]: "four point oh" -> "4.0", "three thousand" -> "3000",
    "a hundred and five" -> "105". -> (keys, next index) or None."""
    total, cur, last, j = 0, 0, None, i
    while j < len(cores):
        c, wv = cores[j], _word_value(cores[j])
        nxt = cores[j + 1] if j + 1 < len(cores) else ""
        if c == "a" and last is None and nxt in ("hundred", *_SCALES):
            cur, last = 1, "unit"
        elif wv and wv[1] == "unit" and (last in (None, "hundred", "scale") or (last == "tens" and wv[0] < 10)):
            cur, last = cur + wv[0], "unit"
        elif wv and wv[1] == "tens" and last in (None, "hundred", "scale"):
            cur, last = cur + wv[0], "tens"
        elif c == "hundred" and last in ("unit", "tens"):
            cur, last = cur * 100, "hundred"
        elif c in _SCALES and last in ("unit", "tens", "hundred"):
            total, cur, last = total + cur * _SCALES[c], 0, "scale"
        elif not (c == "and" and last in ("hundred", "scale") and _word_value(nxt)):
            break
        j += 1
    if last is None:
        return None
    value = str(total + cur)
    if j + 1 < len(cores) and cores[j] == "point" and cores[j + 1] in _DIGIT_WORDS and last != "scale":
        frac, j = "", j + 1
        while j < len(cores) and cores[j] in _DIGIT_WORDS:
            frac, j = frac + str(_DIGIT_WORDS[cores[j]]), j + 1
        scale = 1
        if j < len(cores) and cores[j] in _SCALES:
            scale, j = _SCALES[cores[j]], j + 1
        value = _value_text(f"{value}.{frac}", scale)
    return [value], j


def keys(words: list) -> list:
    """Caption words -> [(key, first word, last word)]. One word can give several keys ("$3,000" ->
    "3000", "dollar"; "25%" -> "25", "percent") and several words one key ("four point oh" -> "4.0");
    a key's words are the ones it was read from. Punctuation-only words give none."""
    cores = [_core(w) for w in words]
    out, i = [], 0
    while i < len(words):
        num = _written_number(words, cores, i) or _spoken_number(cores, i)
        if num:
            ks, j = num
            out += [(k, i, j - 1) for k in ks]
            i = j
            continue
        if cores[i]:
            out.append((_SAME.get(cores[i], cores[i]), i, i))
        i += 1
    return out


# --- alignment -----------------------------------------------------------------------------------

def _exact(op: tuple, a: list, b: list) -> bool:
    i, j = op
    return i is not None and j is not None and a[i] == b[j]


def _local(a: list, b: list) -> tuple:
    """Best local alignment (Smith-Waterman) of key ids a (script) and b (heard) -> (score, ops), ops
    [(i or None, j or None)]: both = a match or a mishearing, i alone = a script word not heard, j
    alone = a heard word not in the script. Ties go to the earliest end, then diagonal, up, left: the
    result depends on nothing but a and b."""
    n, m = len(a), len(b)
    prev = [0] * (m + 1)
    ptr = [bytearray(m + 1) for _ in range(n + 1)]
    best, bi, bj = 0, 0, 0
    for i in range(1, n + 1):
        cur, ai, row = [0] * (m + 1), a[i - 1], ptr[i]
        for j in range(1, m + 1):
            d = prev[j - 1] + (MATCH if ai == b[j - 1] else MISMATCH)
            u = prev[j] + GAP
            left = cur[j - 1] + GAP
            if d >= u and d >= left and d > 0:
                cur[j], row[j] = d, 1
            elif u >= left and u > 0:
                cur[j], row[j] = u, 2
            elif left > 0:
                cur[j], row[j] = left, 3
            if cur[j] > best:
                best, bi, bj = cur[j], i, j
        prev = cur
    ops, i, j = [], bi, bj
    while i > 0 and j > 0 and ptr[i][j]:
        p = ptr[i][j]
        if p == 1:
            i, j = i - 1, j - 1
            ops.append((i, j))
        elif p == 2:
            i -= 1
            ops.append((i, None))
        else:
            j -= 1
            ops.append((None, j))
    ops.reverse()
    return best, ops


def _spans(ops: list, a: list, b: list) -> list:
    """Split an alignment where the speaker left the script (more than GAP_MAX unmatched words in a
    row on either side). Each span starts and ends on an exact match."""
    spans, cur, gap_s, gap_t = [], [], 0, 0
    for op in ops:
        if _exact(op, a, b):
            if gap_s > GAP_MAX or gap_t > GAP_MAX:
                spans.append(cur)
                cur = []
            cur.append(op)
            gap_s = gap_t = 0
            continue
        gap_s += op[0] is not None
        gap_t += op[1] is not None
        if cur:
            cur.append(op)
    spans.append(cur)
    for sp in spans:
        while sp and not _exact(sp[-1], a, b):
            sp.pop()
    return [sp for sp in spans if sp]


def _accepted(span: list, a: list, b: list) -> bool:
    matched = sum(1 for op in span if _exact(op, a, b))
    heard = sum(1 for _, j in span if j is not None)
    return matched >= MIN_MATCHES and matched >= MIN_RATIO * heard


def _alike(x: str, y: str) -> bool:
    """Two keys that could be one word misheard: they sound alike or are spelled much alike."""
    return (sound_key(x) != "" and sound_key(x) == sound_key(y)) or difflib.SequenceMatcher(None, x, y).ratio() >= ALIKE


def _extend(span: list, a: list, b: list, names: list, lo: int, hi: int) -> list:
    """A span starts and ends on an exact match, so a misheard name opening a sentence ("Nave makes
    mics" for "Neve makes mics") would stay as heard: take in the word just outside each end when
    the script's word there sounds or reads like it. Heard words stay inside [lo, hi)."""
    i, j = span[0]
    if i > 0 and lo < j and _alike(names[a[i - 1]], names[b[j - 1]]):
        span = [(i - 1, j - 1)] + span
    i, j = span[-1]
    if i + 1 < len(a) and j + 1 < hi and _alike(names[a[i + 1]], names[b[j + 1]]):
        span = span + [(i + 1, j + 1)]
    return span


def _key_groups(span: list, a: list, b: list) -> list:
    """A span -> [(script key indices, heard key indices)]. Each exact match is a group; the unmatched
    keys between two matches are one group when both sides have some (a mishearing, or the same words
    split differently); script words not heard join the group before them (the script's phrasing is
    shown); heard words not in the script stay as heard (an ad-lib) and are in no group."""
    groups, gs, gt = [], [], []
    for op in span:
        if _exact(op, a, b):
            if gs and gt:
                groups.append((gs, gt))
            elif gs:
                groups[-1][0].extend(gs)
            groups.append(([op[0]], [op[1]]))
            gs, gt = [], []
            continue
        if op[0] is not None:
            gs.append(op[0])
        if op[1] is not None:
            gt.append(op[1])
    if gs and gt:                # a word _extend took in after the last match
        groups.append((gs, gt))
    return groups


def _word_ranges(groups: list, sk: list, tk: list) -> list:
    """Key groups -> [[s0, s1, t0, t1]] word ranges (inclusive). Groups that share a word on either
    side (one word gave keys to both) become one."""
    out: list = []
    for gs, gt in groups:
        r = [min(sk[x][1] for x in gs), max(sk[x][2] for x in gs),
             min(tk[x][1] for x in gt), max(tk[x][2] for x in gt)]
        if out and (r[0] <= out[-1][1] or r[2] <= out[-1][3]):
            last = out[-1]
            out[-1] = [min(last[0], r[0]), max(last[1], r[1]), min(last[2], r[2]), max(last[3], r[3])]
        else:
            out.append(r)
    return out


def align(script: list, heard: list) -> tuple:
    """Script words and heard words -> (ranges, spans): each range [s0, s1, t0, t1] shows heard words
    t0..t1 as script words s0..s1; spans [[t0, t1]] are the heard words that follow the script. Speech
    left unmatched around and between matches (a retake, a line said twice) is aligned against the
    whole script again."""
    sk, tk = keys(script), keys(heard)
    ids: dict = {}
    a = [ids.setdefault(k, len(ids)) for k, _, _ in sk]
    b = [ids.setdefault(k, len(ids)) for k, _, _ in tk]
    names = list(ids)
    ranges, spans, todo = [], [], [(0, len(b))]
    while todo:
        lo, hi = todo.pop()
        if hi - lo < MIN_MATCHES:
            continue
        score, ops = _local(a, b[lo:hi])
        if score < MATCH * MIN_MATCHES:
            continue
        ops = [(i, None if j is None else j + lo) for i, j in ops]
        free = lo
        for sp in _spans(ops, a, b):
            if not _accepted(sp, a, b):
                continue
            sp = _extend(sp, a, b, names, free, hi)
            t0 = next(j for _, j in sp if j is not None)
            t1 = next(j for _, j in reversed(sp) if j is not None)
            todo.append((free, t0))
            free = t1 + 1
            ranges += _word_ranges(_key_groups(sp, a, b), sk, tk)
            spans.append([tk[t0][1], tk[t1][2]])
        if free > lo:            # something matched: look again in what is left after it
            todo.append((free, hi))
    ranges.sort(key=lambda r: r[2])
    spans.sort()
    # a heard word whose keys landed in two separate matches keeps the first
    kept = [r for k, r in enumerate(ranges) if not k or r[2] > ranges[k - 1][3]]
    return kept, spans


# --- the stored mapping --------------------------------------------------------------------------

def build(script: str, words: list) -> dict:
    """Transcript words -> {"script", "groups": [{"ids", "words"}], "spans": [[first id, last id]]}.
    A group draws transcript words `ids` as script words `words`; groups where both read the same are
    left out. Spans are the stretches of speech that follow the script."""
    sw = script_words(script)
    heard = [str(w["w"]).strip() for w in words]
    ranges, spans = align(sw, heard)
    groups = [{"ids": [words[t]["id"] for t in range(t0, t1 + 1)], "words": sw[s0:s1 + 1]}
              for s0, s1, t0, t1 in ranges if sw[s0:s1 + 1] != heard[t0:t1 + 1]]
    return {"script": script, "groups": groups,
            "spans": [[words[t0]["id"], words[t1]["id"]] for t0, t1 in spans]}


def _key(script: str, words: list) -> str:
    material = [VERSION, script, [[w["id"], str(w["w"]).strip()] for w in words]]
    return hashlib.sha256(json.dumps(material, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()


def mapping(project_dir: Optional[Path], proj: dict, words: list) -> Optional[dict]:
    """The script mapping for these transcript words, or None when captions don't follow a script
    (there is none, or captions.followScript is false). Read from work/script-align.json while its
    key (this version, the script, the words) still matches, else built and stored there."""
    if (proj.get("captions") or {}).get("followScript") is False:
        return None
    text = script_text(project_dir, proj)
    if not text.strip() or not words:
        return None
    key = _key(text, words)
    path = Path(project_dir) / "work" / FILE if project_dir is not None else None
    if path is not None and path.is_file():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if data.get("key") == key:
                return data
        except (OSError, ValueError):
            pass
    data = {"version": VERSION, "key": key, **build(text, words)}
    if path is not None:
        from . import project as projmod
        try:
            projmod.write_json(path, data, indent=1)
        except OSError:
            pass                 # a read-only project still gets its captions
    return data

