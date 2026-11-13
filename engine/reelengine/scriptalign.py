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
    spoken word inside a span stays as heard, a gap longer than GAP_MAX words ends the span, and a
    script word nobody said is shown only inside a sentence the speaker did say;
  * scripts without spaces (Chinese, Japanese) are read a character at a time on both sides, and
    drawn back as the script's own runs of characters;
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

VERSION = 2
FILE = "script-align.json"
MATCH, MISMATCH, GAP = 2, -1, -1     # alignment scores
GAP_MAX = 3          # more unmatched words than this in a row (either side) ends a span: off-script
MIN_MATCHES = 2      # a span needs this many exactly matched keys
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


# Only these markdown marks are taken out, so a name keeps its own characters ("C#", "snake_case").
_MARKDOWN = (
    (re.compile(r"\[([^\]\n]+)\]\([^)\n]*\)"), r"\1"),                     # [a link](url): its text
    (re.compile(r"\[[^\]\n]*\]"), " "),                                    # [a stage direction]
    (re.compile(r"^[ \t]*(?:#{1,6}|>+|[-*+])[ \t]+", re.M), ""),           # heading, quote, bullet
    (re.compile(r"(?<![\w*])\*\*(?=\S)([^*\n]+?)(?<=\S)\*\*(?![\w*])"), r"\1"),   # **bold**
    (re.compile(r"(?<![\w*])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![\w*])"), r"\1"),       # *italic*
    (re.compile(r"(?<!\w)_(?=\S)([^_\n]+?)(?<=\S)_(?!\w)"), r"\1"),               # _italic_
    (re.compile(r"`([^`\n]+)`"), r"\1"),                                   # `code`
    (re.compile(r"\s*[—–]\s*"), " "),                                      # a dash between words
)
# Scripts written without spaces: each of these characters is a word of its own
_CJK = re.compile(r"[぀-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ]")
_SENTENCE_END = re.compile(r"[.!?…。！？][\"'”’)\]」』]*$")


def _pieces(token: str) -> list:
    """'使用Neve录音。' -> ['使', '用', 'Neve', '录', '音。']: every CJK character starts a piece, as
    does a letter or digit right after one; punctuation stays on the piece next to it."""
    out, cjk_last = [], False        # cjk_last: the piece's last letter is a CJK character
    for ch in token:
        letter = bool(re.match(r"\w", ch))
        if out and letter and re.search(r"\w", out[-1]) and (_CJK.match(ch) or cjk_last):
            out.append(ch)
        elif out:
            out[-1] += ch
        else:
            out.append(ch)
        if letter:
            cjk_last = bool(_CJK.match(ch))
    return out


def script_units(text: str) -> list:
    """The script as caption words: [(word, glued)], `glued` when it continues the word before without
    a space (the characters of an unspaced script). Markdown marks and [stage directions] dropped,
    words with no letter or digit left out."""
    for pattern, repl in _MARKDOWN:
        text = pattern.sub(repl, text or "")
    out = []
    for token in text.split():
        glued = False
        for piece in _pieces(token):
            if re.search(r"\w", piece):
                out.append((piece, glued))
                glued = True
    return out


def _display(units: list, chosen: list) -> list:
    """Script units `chosen` (sorted indices) as the words to draw: characters glued to the one right
    before them join it into one word; after a left-out stretch a new word starts."""
    out: list = []
    for n, k in enumerate(chosen):
        word, glued = units[k]
        if out and glued and chosen[n - 1] == k - 1:
            out[-1] += word
        else:
            out.append(word)
    return out


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
    """'"Neve’s,' -> "neves": case, edge punctuation, apostrophes and hyphens don't count. A name's
    own marks do ("C#", "C++" are not "C")."""
    w = word.strip().lower().replace("’", "'")
    w = re.sub(r"^[^\w$€£%]+|(?<=[\w#+])[^\w%#+]+$|(?<![\w#+])[^\w%]+$", "", w)
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
    a key's words are the ones it was read from. A word with CJK characters gives one key per piece
    ("今天" -> "今", "天"), so heard words line up with a script written without spaces. Punctuation-only
    words give none."""
    cores = [_core(w) for w in words]
    out, i = [], 0
    while i < len(words):
        if _CJK.search(words[i]):
            out += [(_core(p), i, i) for p in _pieces(words[i].strip()) if _core(p)]
            i += 1
            continue
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
    alone = a heard word not in the script. Ties go to the latest end (an alignment that reaches on
    through a mishearing to the next match beats one that stops before it), then diagonal, up, left: the
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
            if cur[j] >= best > 0 or cur[j] > best:
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


def _words_of(key_ids, keys_: list) -> set:
    """The words some keys were read from: one key can stand for several ("four point oh")."""
    return {w for x in key_ids for w in range(keys_[x][1], keys_[x][2] + 1)}


def _spans(ops: list, a: list, b: list, sk: list, tk: list) -> list:
    """Split an alignment where the speaker left the script (more than GAP_MAX unmatched words in a
    row on either side). Each span starts and ends on an exact match."""
    spans, cur, gap_s, gap_t = [], [], [], []
    for op in ops:
        if _exact(op, a, b):
            if len(_words_of(gap_s, sk)) > GAP_MAX or len(_words_of(gap_t, tk)) > GAP_MAX:
                spans.append(cur)
                cur = []
            cur.append(op)
            gap_s, gap_t = [], []
            continue
        if op[0] is not None:
            gap_s.append(op[0])
        if op[1] is not None:
            gap_t.append(op[1])
        if cur:
            cur.append(op)
    spans.append(cur)
    for sp in spans:
        while sp and not _exact(sp[-1], a, b):
            sp.pop()
    return [sp for sp in spans if sp]


def _accepted(span: list, a: list, b: list, tk: list) -> bool:
    """MIN_MATCHES exact keys, and MIN_RATIO of the span's heard words matched exactly."""
    exact = [op[1] for op in span if _exact(op, a, b)]
    heard = _words_of([j for _, j in span if j is not None], tk)
    return len(exact) >= MIN_MATCHES and len(_words_of(exact, tk)) >= MIN_RATIO * len(heard)


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


def _key_groups(span: list, a: list, b: list, sentence: list) -> list:
    """A span -> [(script key indices, heard key indices)]. Each exact match is a group. The unmatched
    keys between two matches are one group when both sides have some (a mishearing, or the same words
    split differently). Heard words not in the script stay as heard (an ad-lib) and are in no group.

    `sentence` numbers each script key's sentence. Script words between two matches show only inside
    a sentence the speaker said: a word left out joins the match of its own sentence, before or after
    it, and a whole sentence nobody said ("Skip this line.") is not shown. A mishearing whose script
    side reaches into such a sentence stays as heard."""
    groups: list = []
    gs: list = []
    gt: list = []

    def said(x, nxt):
        prev = max(groups[-1][0]) if groups else None
        return (prev is not None and sentence[x] == sentence[prev]) or (nxt is not None and sentence[x] == sentence[nxt])

    for op in span:
        if not _exact(op, a, b):
            if op[0] is not None:
                gs.append(op[0])
            if op[1] is not None:
                gt.append(op[1])
            continue
        new = ([op[0]], [op[1]])
        if gs and gt:
            if all(said(x, op[0]) for x in gs):
                groups.append((gs, gt))
        else:
            prev = max(groups[-1][0]) if groups else None
            for x in gs:
                if prev is not None and sentence[x] == sentence[prev]:
                    groups[-1][0].append(x)
                elif sentence[x] == sentence[op[0]]:
                    new[0].append(x)
        groups.append(new)
        gs, gt = [], []
    if gs and gt and all(said(x, None) for x in gs):   # a word _extend took in after the last match
        groups.append((gs, gt))
    return groups


def _word_ranges(groups: list, sk: list, tk: list) -> list:
    """Key groups -> [(script words, t0, t1)]: the script words a group draws (sorted) over heard words
    t0..t1. Groups that share a word on either side (one word gave keys to both, or one heard word
    holds a whole unspaced phrase) become one, keeping only the script words they chose: a sentence
    _key_groups left out between them stays out."""
    out: list = []
    for gs, gt in groups:
        words = _words_of(gs, sk)
        t0, t1 = min(tk[x][1] for x in gt), max(tk[x][2] for x in gt)
        if out and (t0 <= out[-1][2] or words & out[-1][0]):
            last = out[-1]
            out[-1] = (last[0] | words, min(last[1], t0), max(last[2], t1))
        else:
            out.append((words, t0, t1))
    return [(sorted(w), t0, t1) for w, t0, t1 in out]


def align(script: list, heard: list) -> tuple:
    """Script words and heard words -> (ranges, spans): each range (script word indices, t0, t1) shows
    heard words t0..t1 as those script words; spans [[t0, t1]] are the heard words that follow the script. Speech
    left unmatched around and between matches (a retake, a line said twice) is aligned against the
    whole script again."""
    sk, tk = keys(script), keys(heard)
    ends = [0]
    for w in script:
        ends.append(ends[-1] + bool(_SENTENCE_END.search(w)))
    sentence = [ends[s0] for _, s0, _ in sk]        # the sentence each script key is in
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
        for sp in _spans(ops, a, b, sk, tk):
            if not _accepted(sp, a, b, tk):
                continue
            sp = _extend(sp, a, b, names, free, hi)
            t0 = next(j for _, j in sp if j is not None)
            t1 = next(j for _, j in reversed(sp) if j is not None)
            todo.append((free, t0))
            free = t1 + 1
            ranges += _word_ranges(_key_groups(sp, a, b, sentence), sk, tk)
            spans.append([tk[t0][1], tk[t1][2]])
        if free > lo:            # something matched: look again in what is left after it
            todo.append((free, hi))
    ranges.sort(key=lambda r: r[1])
    spans.sort()
    # a heard word whose keys landed in two separate matches keeps the first
    kept = [r for k, r in enumerate(ranges) if not k or r[1] > ranges[k - 1][2]]
    return kept, spans


# --- the stored mapping --------------------------------------------------------------------------

def build(script: str, words: list) -> dict:
    """Transcript words -> {"script", "groups": [{"ids", "words"}], "spans": [[first id, last id]]}.
    A group draws transcript words `ids` as script words `words`, also where both read the same: a
    word drawn from the script keeps the script's spelling (captions.follow_script). Spans are the
    stretches of speech that follow the script."""
    units = script_units(script)
    heard = [str(w["w"]).strip() for w in words]
    ranges, spans = align([u for u, _ in units], heard)
    groups = [{"ids": [words[t]["id"] for t in range(t0, t1 + 1)], "words": _display(units, chosen)}
              for chosen, t0, t1 in ranges]
    return {"script": script, "groups": groups,
            "spans": [[words[t0]["id"], words[t1]["id"]] for t0, t1 in spans]}


def _key(script: str, words: list) -> str:
    material = [VERSION, script, [[w["id"], str(w["w"]).strip()] for w in words]]
    return hashlib.sha256(json.dumps(material, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()


def mapping(project_dir: Optional[Path], proj: dict, words: list) -> Optional[dict]:
    """The script mapping for these transcript words, or None when captions don't follow a script
    (there is none, or captions.followScript is false). Read from work/script-align.json while its
    key (this version, the script, the words) still matches, else built and stored there. With no
    script or no words any stored mapping is removed, so nothing reads a script that is gone."""
    if (proj.get("captions") or {}).get("followScript") is False:
        return None
    path = Path(project_dir) / "work" / FILE if project_dir is not None else None
    text = script_text(project_dir, proj)
    if not text.strip() or not words:
        if path is not None:
            path.unlink(missing_ok=True)
        return None
    key = _key(text, words)
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
