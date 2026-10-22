"""Word timestamps (output clock) -> the burned-in caption track (.ass).

Caption doctrine (ported from a captions pipeline shipped across 80 reels):
  * up to `maxWords` words per cue, breaking early on a sentence end; commas never break a line
  * a number never opens a line and is never orphaned from its unit ("DAY 1", "3,000 USERS")
  * cues are built per SPEECH RUN: no cue ever spans a long silence
  * gap-hold: a cue stays up until just before the next one, so the rail never blinks in a pause
  * uniform size, shrink-only for over-wide lines

Sizing is MEASURED from the actual font file (not a character budget): libass sizes a face so that
its OS/2 winAscent+winDescent equals the font size, so we read those from the TTF, compute the
width Pillow would draw, and shrink until the line fits the safe width.

The font is resolved to a FILE we ship and the ASS names it exactly; the render copies that file
into the fontsdir it hands libass, and checks libass' own "fontselect" log line afterwards. Without
a fontsdir libass silently substitutes a wider face and captions spill off the frame.
"""
from __future__ import annotations

import re
import struct
from functools import lru_cache
from pathlib import Path
from typing import Optional

from . import tools
from .proto import EngineError

MAX_WORDS = 3
GAP_LEAD = 0.02
MAX_HOLD = 2.0
HOLD_TAIL = 0.15
MIN_CUE = 0.30
RUN_GAP = 0.80          # a silence longer than this splits caption runs
MARGIN_FRAC = 0.065     # left/right safe margin, fraction of width
MIN_SHRINK = 0.62       # below this fraction of the base size, wrap to two lines instead
FADE_IN, FADE_OUT = 60, 40
POP_MS = 120


def pop_in(offset_ms: int) -> str:
    """"pop": the line grows from 80% to full size over its first 120 ms, decelerating (accel 0.5).
    A highlighted line is one event per word, so an event that starts `offset_ms` into the line runs
    the same transform shifted back by that much (libass accepts a negative start)."""
    if offset_ms >= POP_MS:
        return ""
    return f"\\fscx80\\fscy80\\t({-offset_ms},{POP_MS - offset_ms},0.5,\\fscx100\\fscy100)"
DEFAULT_FONT = "Montserrat SemiBold"
DEFAULT_SIZE = 105       # the proven size on a 1080x1920 canvas
DEFAULT_OUTLINE = 8      # solid black; load-bearing on bright walls
DEFAULT_POSITION = 0.75  # line centre at y 1440 -> bottom ~y 1495 (his 425 px margin), clears the chin
BOX_PAD = 18             # padding of the "box" style

UNITS = {
    "day", "days", "hour", "hours", "minute", "minutes", "second", "seconds", "week", "weeks",
    "month", "months", "year", "years", "user", "users", "people", "post", "posts", "follower",
    "followers", "dollar", "dollars", "percent", "match", "matches", "date", "dates", "bucks",
    "k", "times", "views", "likes", "words", "steps", "things", "ways", "reasons", "minutes",
}
_STRIP_LEAD = r"^[\"'(\[¿¡]+"
_STRIP_TAIL = r"[.,!?;:\"')\]…]+$"


def _bare(word: str) -> str:
    return re.sub(_STRIP_TAIL, "", re.sub(_STRIP_LEAD, "", word.strip()))


def is_number(word: str) -> bool:
    return bool(re.fullmatch(r"[$€£]?\d[\d,]*(\.\d+)?[%kKmM]?", _bare(word)))


def is_unit(word: str) -> bool:
    return _bare(word).lower() in UNITS


def is_sentence_end(word: str) -> bool:
    return bool(re.search(r"[.!?…][\"')\]]*$", word.strip()))


# --- transforms -------------------------------------------------------------------------------

def stitch_numbers(words: list) -> list:
    """["3", ",000"] -> ["3,000"] spanning both timestamps."""
    out, i = [], 0
    while i < len(words):
        cur = words[i]
        if i + 1 < len(words):
            nxt = words[i + 1]
            if re.fullmatch(r"\$?\d+", cur["w"].strip()) and re.match(r"^,\d{3}", nxt["w"].strip()):
                merged = dict(cur)
                merged.update(e=nxt["e"], w=cur["w"].strip() + nxt["w"].strip(),
                              ids=cur.get("ids", [cur.get("id")]) + nxt.get("ids", [nxt.get("id")]))
                out.append(merged)
                i += 2
                continue
        c = dict(cur)
        c.setdefault("ids", [cur.get("id")])
        out.append(c)
        i += 1
    return out


_NUM_WORDS = {w: i for i, w in enumerate(
    "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen "
    "sixteen seventeen eighteen nineteen".split())}
_TENS = {w: 10 * (i + 2) for i, w in enumerate("twenty thirty forty fifty sixty seventy eighty ninety".split())}
# "one" is a pronoun far more often than a number ("the best one"): only these make it a count
_ONE_AFTER = {"number", "step", "day", "part", "rule", "tip", "chapter", "level", "round", "reason", "top",
              "season", "episode", "week", "phase", "lesson", "page"}


def _num_value(core: str):
    """'three' -> 3, 'twenty-five' -> 25, else None."""
    c = core.lower()
    if c in _NUM_WORDS:
        return _NUM_WORDS[c]
    if c in _TENS:
        return _TENS[c]
    m = re.fullmatch(r"([a-z]+)-([a-z]+)", c)
    if m and m.group(1) in _TENS and m.group(2) in _NUM_WORDS and 0 < _NUM_WORDS[m.group(2)] < 10:
        return _TENS[m.group(1)] + _NUM_WORDS[m.group(2)]
    return None


def _split(word: str):
    m = re.match(r"^([^\w$%]*)([\w$][\w$%,.'’-]*?)([^\w$%]*)$", word.strip(), flags=re.U)
    return m.groups() if m else ("", word.strip(), "")


def digits_for_numbers(words: list) -> list:
    """Numbers on screen are digits: "three" -> "3", "twenty five" -> "25", "64 %" / "64 percent" ->
    "64%", "Number one" -> "Number 1". "one" stays a word unless it is clearly a count (after
    "number"/"step"/..., or a list item opening a sentence: "One, ..."), so "the best one" is safe."""
    out: list = []
    i = 0
    while i < len(words):
        w = dict(words[i])
        lead, core, tail = _split(w["w"])
        val = _num_value(core)
        prev = out[-1] if out else None
        if val is not None and core.lower() == "one":
            prev_core = _bare(prev["w"]).lower() if prev else ""
            opens = prev is None or is_sentence_end(prev["w"])
            nxt = _bare(words[i + 1]["w"]).lower() if i + 1 < len(words) else ""
            if not (prev_core in _ONE_AFTER or (opens and tail[:1] in (",", ".", ":"))) or nxt == "of":
                val = None
        if val is not None:
            # "twenty five" said as two words
            if val in _TENS.values() and i + 1 < len(words) and not tail:
                l2, c2, t2 = _split(words[i + 1]["w"])
                v2 = _num_value(c2)
                if not l2 and v2 is not None and 0 < v2 < 10:
                    val += v2
                    tail = t2
                    w["e"] = words[i + 1]["e"]
                    w["ids"] = w.get("ids", [w.get("id")]) + words[i + 1].get("ids", [words[i + 1].get("id")])
                    i += 1
            w["w"] = f"{lead}{val}{tail}"
            core = str(val)
        # "64 %" / "64 percent" -> "64%"
        if re.fullmatch(r"[$€£]?\d[\d,.]*", core) and not tail and i + 1 < len(words):
            l2, c2, t2 = _split(words[i + 1]["w"])
            if (c2 == "%" or c2.lower() == "percent" or words[i + 1]["w"].strip().startswith("%")) and not l2:
                rest = words[i + 1]["w"].strip()
                t2 = rest[1:] if rest.startswith("%") else t2
                w["w"] = f"{lead}{core}%{t2}"
                w["e"] = words[i + 1]["e"]
                w["ids"] = w.get("ids", [w.get("id")]) + words[i + 1].get("ids", [words[i + 1].get("id")])
                i += 1
        w.setdefault("ids", [w.get("id")])
        out.append(w)
        i += 1
    return out


def normalize_corrections(corrections) -> dict:
    """project.json's [{from, to}] -> {"single": {...}, "spans": [...]}"""
    single, spans = {}, []
    for c in corrections or []:
        heard, meant = str(c.get("from", "")).strip(), str(c.get("to", "")).strip()
        if not heard:
            continue
        hw, mw = heard.split(), meant.split()
        if len(hw) == 1 and len(mw) == 1:
            single[_bare(hw[0]).lower()] = mw[0]
        else:
            spans.append({"from": hw, "to": mw})
    return {"single": single, "spans": spans}


def apply_corrections(words: list, corrections: dict, stats: Optional[dict] = None) -> list:
    """Phrase corrections first, then single words, and a word a phrase already produced is never
    corrected again: with "script" -> "TypeScript" AND "type script" -> "TypeScript", the single
    word applied first used to leave "type TypeScript" on screen."""
    words = [dict(w) for w in words]
    single = corrections.get("single") or {}
    spans = corrections.get("spans") or []
    if spans:
        norm = [([_bare(x).lower() for x in sp["from"]], list(sp["to"])) for sp in spans]
        if stats is not None:
            for sp in spans:
                stats.setdefault(" ".join(sp["from"]), 0)
        i = 0
        while i < len(words):
            for idx, (src, dst) in enumerate(norm):
                n = len(src)
                if n and [_bare(x["w"]).lower() for x in words[i:i + n]] == src:
                    s, e = words[i]["s"], words[i + n - 1]["e"]
                    ids = [x for w in words[i:i + n] for x in w.get("ids", [w.get("id")])]
                    tail = re.search(_STRIP_TAIL, words[i + n - 1]["w"])
                    step = (e - s) / max(1, len(dst))
                    repl = [{"s": round(s + step * k, 3), "e": round(s + step * (k + 1), 3),
                             "w": dst[k], "ids": ids, "_fixed": True} for k in range(len(dst))]
                    if repl and tail and not re.search(_STRIP_TAIL, repl[-1]["w"]):
                        repl[-1]["w"] += tail.group(0)
                    words[i:i + n] = repl
                    i += max(0, len(dst) - 1)
                    if stats is not None:
                        stats[" ".join(spans[idx]["from"])] += 1
                    break
            i += 1
    if stats is not None:
        for key in single:
            stats.setdefault(key, 0)
    if single:
        for w in words:
            if w.get("_fixed"):
                continue
            m = re.match(r"^([^\w]*)([\w]+(?:['’][\w]+)?)(.*)$", w["w"], flags=re.U)
            if not m:
                continue
            lead, core, tail = m.groups()
            if core.lower() in single:
                w["w"] = lead + single[core.lower()] + tail
                if stats is not None:
                    stats[core.lower()] += 1
            else:
                base = re.split(r"['’]", core)[0]
                if base.lower() in single and base != core:
                    w["w"] = lead + single[base.lower()] + core[len(base):] + tail
                    if stats is not None:
                        stats[base.lower()] += 1
    for w in words:
        w.pop("_fixed", None)
    return words


def split_runs(words: list, max_gap: float = RUN_GAP) -> list:
    if not words:
        return []
    runs, cur = [], [words[0]]
    for prev, w in zip(words, words[1:]):
        if w["s"] - prev["e"] > max_gap:
            runs.append(cur)
            cur = [w]
        else:
            cur.append(w)
    runs.append(cur)
    return runs


def chunk(words: list, max_words: int = MAX_WORDS) -> list:
    cues, cur = [], []

    def flush():
        if cur:
            cues.append({"s": cur[0]["s"], "e": cur[-1]["e"], "words": [w["w"] for w in cur],
                         "starts": [w["s"] for w in cur],
                         "ids": [x for w in cur for x in w.get("ids", [w.get("id")]) if x]})
            cur.clear()

    i = 0
    while i < len(words):
        w = words[i]
        cur.append(w)
        i += 1
        if is_sentence_end(w["w"]):
            flush()
            continue
        if len(cur) < max_words:
            continue
        nxt = words[i] if i < len(words) else None
        if nxt is not None and len(cur) < max_words + 1:
            if is_number(nxt["w"]):
                continue
            if is_number(cur[-1]["w"]) and is_unit(nxt["w"]):
                continue
        flush()
    flush()
    return cues


def hold(cues: list) -> list:
    """Gap-hold: a cue holds until just before the next one (within one speech run)."""
    for k, c in enumerate(cues):
        if k + 1 < len(cues):
            held = cues[k + 1]["s"] - GAP_LEAD
            if held > c["e"]:
                c["e"] = held if (held - c["s"]) <= MAX_HOLD else c["e"] + HOLD_TAIL
                c["e"] = min(c["e"], cues[k + 1]["s"] - GAP_LEAD)
        if c["e"] - c["s"] < MIN_CUE:
            nxt_s = cues[k + 1]["s"] - GAP_LEAD if k + 1 < len(cues) else None
            c["e"] = c["s"] + MIN_CUE if nxt_s is None else max(c["e"], min(c["s"] + MIN_CUE, nxt_s))
    return cues


def apply_case(text: str, case: str) -> str:
    if case == "upper":
        return text.upper()
    if case == "lower":
        return text.lower()
    if case == "title":
        return " ".join(t[:1].upper() + t[1:] for t in text.split(" "))
    return text


def cue_text(words: list, case: str) -> str:
    text = " ".join(words).strip()
    text = re.sub(r"^[(\[{\"¿¡]+", "", text)
    text = re.sub(r"[.,!?;:)\]}\"…]+$", "", text)
    return apply_case(text, case)


# --- fonts ------------------------------------------------------------------------------------

def _ttf_metrics(path: Path) -> dict:
    """unitsPerEm + OS/2 win metrics + name strings, straight from the font tables."""
    data = Path(path).read_bytes()
    num = struct.unpack(">H", data[4:6])[0]
    tables = {}
    for i in range(num):
        tag, _, off, ln = struct.unpack(">4sIII", data[12 + 16 * i: 28 + 16 * i])
        tables[tag.decode("latin-1")] = (off, ln)
    off = tables["head"][0]
    upem = struct.unpack(">H", data[off + 18: off + 20])[0]
    win_a = win_d = None
    if "OS/2" in tables:
        o = tables["OS/2"][0]
        win_a, win_d = struct.unpack(">HH", data[o + 74: o + 78])
    if not win_a and "hhea" in tables:
        o = tables["hhea"][0]
        asc, desc = struct.unpack(">hh", data[o + 4: o + 8])
        win_a, win_d = asc, -desc
    names = set()
    if "name" in tables:
        o = tables["name"][0]
        _, count, string_off = struct.unpack(">HHH", data[o: o + 6])
        for i in range(count):
            pid, eid, lid, nid, ln, so = struct.unpack(">HHHHHH", data[o + 6 + 12 * i: o + 18 + 12 * i])
            if nid not in (1, 4, 6, 16):
                continue
            raw = data[o + string_off + so: o + string_off + so + ln]
            try:
                s = raw.decode("utf-16-be") if pid in (0, 3) else raw.decode("latin-1")
            except UnicodeDecodeError:
                continue
            names.add(s.strip())
    return {"upem": upem, "winA": win_a or upem, "winD": win_d or 0, "names": names}


@lru_cache(maxsize=None)
def font_index() -> dict:
    idx = {}
    for d in tools.font_dirs():
        for p in sorted(d.iterdir()):
            if p.suffix.lower() not in (".ttf", ".otf"):
                continue
            try:
                m = _ttf_metrics(p)
            except Exception:
                continue
            for n in m["names"] | {p.stem}:
                idx.setdefault(n.lower(), (p, m))
    return idx


def resolve_font(name: str):
    """(family name to write in the ASS, font file, metrics, warning or None)."""
    idx = font_index()
    key = (name or DEFAULT_FONT).lower()
    if key in idx:
        p, m = idx[key]
        return name, p, m, None
    if DEFAULT_FONT.lower() in idx:
        p, m = idx[DEFAULT_FONT.lower()]
        return DEFAULT_FONT, p, m, f"font {name!r} not found; used {DEFAULT_FONT}"
    raise EngineError("FONT_MISSING", f"no caption font: wanted {name!r}, searched {tools.font_dirs()}",
                      "Reel Studio is missing its caption font. Please reinstall the app.")


class Measurer:
    def __init__(self, font_path: Path, metrics: dict):
        from PIL import ImageFont
        self.path = font_path
        self.m = metrics
        self._cache = {}
        self._font = ImageFont

    def width(self, text: str, fs: float, outline: float) -> float:
        ppem = fs * self.m["upem"] / (self.m["winA"] + self.m["winD"])
        key = round(ppem * 4) / 4
        f = self._cache.get(key)
        if f is None:
            f = self._font.truetype(str(self.path), max(1, int(round(key * 4))) )
            self._cache[key] = f
        # measured at 4x for sub-pixel accuracy
        return f.getlength(text) / 4.0 + 2 * outline


def fit(text: str, base: float, safe_w: float, outline: float, meas: Measurer):
    """(size, lines). Shrink-only; wrap to two lines rather than shrink below MIN_SHRINK."""
    w = meas.width(text, base, outline)
    if w <= safe_w:
        return int(base), [text]
    fs = base * safe_w / w
    if fs >= base * MIN_SHRINK or " " not in text:
        return max(10, int(fs)), [text]
    parts = text.split(" ")
    best = None
    for k in range(1, len(parts)):
        a, b = " ".join(parts[:k]), " ".join(parts[k:])
        widest = max(meas.width(a, base, outline), meas.width(b, base, outline))
        if best is None or widest < best[0]:
            best = (widest, [a, b])
    widest, lines = best
    fs = base if widest <= safe_w else base * safe_w / widest
    return max(10, int(fs)), lines


# --- ASS --------------------------------------------------------------------------------------

def ts(x: float) -> str:
    x = max(0.0, x)
    cs = int(round(x * 100))
    h, rem = divmod(cs, 360000)
    m, rem = divmod(rem, 6000)
    s, c = divmod(rem, 100)
    return f"{h:d}:{m:02d}:{s:02d}.{c:02d}"


_HEXCOL = re.compile(r"^#?[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$")
_CTRL = re.compile(r"[\x00-\x1f\x7f]+")


def ass_color(hexcol: str, alpha: int = 0) -> str:
    # Only hex digits may reach the Style line: a comma would shift every field after it.
    h = str(hexcol or "").strip()
    h = h.lstrip("#") if _HEXCOL.match(h) else "FFFFFF"
    r, g, b = h[0:2], h[2:4], h[4:6]
    if len(h) == 8:
        alpha = 255 - int(h[6:8], 16)
    return f"&H{alpha:02X}{b}{g}{r}".upper()


def ass_escape(text: str) -> str:
    """Caption text -> ASS event text. Transcript words and AI corrections are untrusted: braces
    would open override tags, and a newline would end the Dialogue line and start a new one."""
    text = _CTRL.sub(" ", str(text))
    return text.replace("\\", "\\\\").replace("{", "(").replace("}", ")")


def inline_color(hexcol: str) -> str:
    """'#FFD60A' -> '&H0AD6FF&', the colour override form of ass_color (alpha left to the style)."""
    return f"&H{ass_color(hexcol)[4:]}&"


def word_spans(c: dict, text_lines: list):
    """[(start, end)] of each spoken word of a cue, for the word-by-word highlight: a word is lit from
    its start until the next one starts, the last one until the cue ends. None when the cue's text no
    longer has one token per word (a word that was only punctuation was stripped from the line)."""
    starts = c.get("starts") or []
    tokens = [tok for t in text_lines for tok in t.split(" ")]
    if len(tokens) != len(starts) or "" in tokens:
        return None
    ends = starts[1:] + [c["e"]]
    return [(c["s"] if k == 0 else s, e) for k, (s, e) in enumerate(zip(starts, ends))]


def line_text(text_lines: list, active: int, marks: tuple) -> str:
    """The cue's lines with word number `active` in the highlight colour. Every event of a cue has
    the same text and size, so libass lays it out identically and only the colour moves."""
    on, off = marks
    out, k = [], 0
    for line in text_lines:
        toks = []
        for tok in line.split(" "):
            toks.append(f"{{\\1c{on}}}{ass_escape(tok)}{{\\1c{off}}}" if k == active else ass_escape(tok))
            k += 1
        out.append(" ".join(toks))
    return "\\N".join(out)


def build_cues(words_out: list, cap: dict, hidden_ids: Optional[set] = None, stats=None) -> list:
    style = cap.get("style") or {}
    max_words = int(style.get("maxWords") or MAX_WORDS)
    words = [{"s": w["s"], "e": w["e"], "w": w["w"], "id": w["id"]} for w in words_out]
    words = stitch_numbers(words)
    words = apply_corrections(words, normalize_corrections(cap.get("corrections")), stats)
    if cap.get("digits", True):
        words = digits_for_numbers(words)
    cues = []
    for run in split_runs(words):
        cues.extend(hold(chunk(run, max_words)))
    if hidden_ids:
        cues = [c for c in cues if not set(c["ids"]) <= hidden_ids]
    case = style.get("case") or "upper"
    for c in cues:
        c["t"] = cue_text(c["words"], case)
    return [c for c in cues if c["t"]]


def cue_position(c: dict, pos_y: float, spans) -> float:
    """Caption height for one cue: the style's, unless the cue sits (mostly) inside a span that
    asks for another one, e.g. a split view whose speaker is framed so close that captions at the
    usual height would cross their face (A2 puts the seam height in layers.json `captionHintY`)."""
    d = max(1e-6, c["e"] - c["s"])
    for t0, t1, y in spans or ():
        if min(c["e"], t1) - max(c["s"], t0) >= 0.5 * d:
            return float(y)
    return pos_y


def render_ass(cues: list, cap: dict, width: int, height: int, position_spans=None) -> tuple:
    """(ass text, cue report, warnings). position_spans: [(t0, t1, fraction of height)] overrides."""
    style = cap.get("style") or {}
    family, fpath, metrics, warn = resolve_font(style.get("font") or DEFAULT_FONT)
    base = float(style.get("size") or DEFAULT_SIZE)  # sizes are in 1080-wide units, scaled below
    outline = float(style.get("outline") if style.get("outline") is not None else DEFAULT_OUTLINE)
    shadow = float(style.get("shadow") if style.get("shadow") is not None else 0)
    pos_y = float(style.get("position") or DEFAULT_POSITION)
    color = ass_color(style.get("color") or "#FFFFFF")
    ocolor = ass_color(style.get("outlineColor") or "#000000")
    # "box": the words sit on a solid box (libass BorderStyle 3 draws it in the outline colour and
    # the outline width is its padding). Otherwise a plain solid outline.
    box = bool(style.get("box"))
    border_style = 3 if box else 1
    if box:
        outline, shadow = max(outline, BOX_PAD), 0.0
    scale = width / 1080.0
    base *= scale
    outline *= scale
    shadow *= scale
    margin = MARGIN_FRAC * width
    safe_w = width - 2 * margin
    meas = Measurer(fpath, metrics)
    head = (
        "[Script Info]\n"
        "ScriptType: v4.00+\n"
        f"PlayResX: {width}\n"
        f"PlayResY: {height}\n"
        "WrapStyle: 2\n"
        "ScaledBorderAndShadow: yes\n"
        "YCbCr Matrix: TV.709\n"
        "\n"
        "[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, "
        "BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, "
        "BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n"
        # Bold 0 on purpose: the weight comes from the face itself; synthetic bold muddies the outline.
        # BackColour (the shadow) is opaque black: no grey, see-through halo around the words.
        f"Style: Cap,{family},{int(base)},{color},{color},{ocolor},&H00000000,"
        f"0,0,0,0,100,100,0,0,{border_style},{outline:.1f},{shadow:.1f},5,{int(margin)},{int(margin)},0,1\n"
        "\n"
        "[Events]\n"
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )
    lines = [head.rstrip("\n")]
    report = []
    highlight = style.get("highlight")
    marks = (inline_color(highlight), inline_color(style.get("color") or "#FFFFFF")) if highlight else None
    pop = bool(style.get("pop"))
    for c in cues:
        cx, cy = width / 2.0, height * cue_position(c, pos_y, position_spans)
        fs, text_lines = fit(c["t"], base, safe_w, outline, meas)
        spans = word_spans(c, text_lines) if marks else None
        lit = spans is not None
        spans = spans or [(c["s"], c["e"])]
        last = len(spans) - 1
        for k, (t0, t1) in enumerate(spans):
            text = line_text(text_lines, k, marks) if lit else "\\N".join(ass_escape(t) for t in text_lines)
            lines.append(f"Dialogue: 0,{ts(t0)},{ts(t1)},Cap,,0,0,0,,"
                         f"{{\\an5\\pos({cx:.0f},{cy:.0f})\\fs{fs}\\fad({FADE_IN if k == 0 else 0},{FADE_OUT if k == last else 0})"
                         f"{pop_in(10 * (round(t0 * 100) - round(c['s'] * 100))) if pop else ''}}}{text}")
        wpx = max(meas.width(t, fs, outline) for t in text_lines)
        hpx = fs * len(text_lines) + 2 * outline
        report.append({"s": round(c["s"], 3), "e": round(c["e"], 3), "text": c["t"], "size": fs,
                       "lines": len(text_lines), "ids": c["ids"],
                       "box": [round(cx - wpx / 2), round(cy - hpx / 2), round(wpx), round(hpx)]})
    return "\n".join(lines) + "\n", report, ([warn] if warn else []), (family, fpath)


def hidden_set(tl, cap: dict) -> set:
    out = set()
    for rng in cap.get("hidden") or []:
        try:
            i0, i1 = tl.index[rng["from"]], tl.index[rng["to"]]
        except KeyError:
            continue
        for i in range(min(i0, i1), max(i0, i1) + 1):
            out.add(tl.words[i]["id"])
    return out


def build_for_timeline(tl, proj: dict, width: int, height: int, words_out=None, position_spans=None):
    """-> (ass_text, report, warnings, (family, font_path), stats)"""
    cap = proj.get("captions") or {}
    stats = {}
    cues = build_cues(words_out if words_out is not None else tl.words_out, cap,
                      hidden_set(tl, cap), stats)
    ass, report, warns, font = render_ass(cues, cap, width, height, position_spans)
    unused = [k for k, v in stats.items() if v == 0]
    if unused:
        warns.append("caption corrections that matched nothing: " + ", ".join(unused))
    return ass, report, warns, font, stats


def write_for_project(project_dir: Path) -> dict:
    from . import project as projmod
    proj = projmod.load(project_dir)
    tl = projmod.timeline(project_dir, proj)
    fmt = proj["format"]
    ass, report, warns, font, stats = build_for_timeline(tl, proj, fmt["width"], fmt["height"])
    out = Path(project_dir) / "work" / "captions.ass"
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(ass)
    projmod.write_json(Path(project_dir) / "work" / "captions.json", {"cues": report})
    return {"file": str(out), "cues": len(report), "warnings": warns, "font": str(font[1]),
            "corrections": stats}
