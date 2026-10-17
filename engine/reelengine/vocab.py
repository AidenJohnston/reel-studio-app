"""Vocabulary correction AFTER transcription: respell misheard names/jargon ("Nave" -> "Neve",
"flowlee" -> "Flowly", "Clodcode" -> "Claude Code") from words this user is known to use.

Why after, not in the prompt: putting the same words in whisper's prompt (`hotwords` /
`initial_prompt`) made it silently SKIP 20-63% of the speech on 2 of 3 measured takes
(status/issues.md item 2). This pass only rewrites the TEXT of words whisper already heard: it never
removes speech and keeps every timestamp (a span of 2-3 heard words that becomes one name is merged
into one word covering the same time).

Vocabulary sources, strongest first:
  * corrected  - caption corrections the user made in THIS project ("from" -> "to")
  * vocabulary - captions.vocabulary in project.json: terms the user or the AI supplied
  * title / script / style - this project's title, optional script, words quoted in My style
  * library    - caption corrections the user made in OTHER projects
A term matches a heard span when their sound keys (a small metaphone-style key, below) are equal, or
one edit apart for longer keys with similar spelling. Guardrails:
  * a span made only of everyday dictionary words ("flatly", "meal", "cloud code") is only respelled
    by a term from THIS project (corrected / vocabulary / title / script), never from the library:
    a name corrected in an old video must not eat the word "flatly" in every new one;
  * longer terms and exact sound matches win; a span that already spells a term is left alone;
  * case-only changes of dictionary words come only from the user's own corrections/vocabulary.
Pure Python, no third-party code.
"""
from __future__ import annotations

import re
from typing import Callable, Iterable, Optional

STRONG = ("corrected", "vocabulary", "title", "script", "style")   # this project's own words
MAX_TERM_WORDS = 3
# An everyday word is only respelled when whisper itself was unsure of it. Measured on the flowly take:
# the misheard "flatly" (Flowly) came out at p=0.64, real "times"/"said" at 0.83-1.0.
DICT_MAX_P = 0.75
MAX_GAP = 0.6           # s; a name is said in one breath: never join words across a longer pause

_STRIP = " \t\r\n.,;:!?\"“”'‘’()[]{}"
_WORD_RE = re.compile(r"\w[\w'’.+&-]*[\w+]|\w", re.UNICODE)
_LEAD = re.compile(r"^[^\w]*", re.UNICODE)
_TAIL = re.compile(r"[^\w]*$", re.UNICODE)

# Function words and fillers: never part of a respelled span, never a term.
_STOP = set("""a an and are as at be but by for from had has have he her his i if in into is it its
me my no not of on or our she so that the their them then there they this to too up us was we were
what when where which who will with you your i'm it's don't like um uh just very really""".split())


# --- sound key -----------------------------------------------------------------------------------

def sound_key(text: str) -> str:
    """A metaphone-style consonant skeleton: same key ~ sounds alike. 'Nave'/'Neve' -> NF,
    'flowlee'/'Flowly' -> FLL, 'Clodcode'/'Claude Code' -> KLTKT, 'Orlakwint'/'Orla Quint' ->
    ARLKNT. Vowels (and y/w/h inside a word) only separate consonants; a leading vowel is 'A'."""
    s = re.sub(r"[^a-z]", "", text.lower())
    if not s:
        return ""
    for a, b in (("^kn", "n"), ("^gn", "n"), ("^pn", "n"), ("^wr", "r"), ("^x", "s"), ("^wh", "w"),
                 ("mb$", "m")):
        s = re.sub(a, b, s)
    out = []
    i, n = 0, len(s)
    vowels = "aeiou"

    def at(k):
        return s[k] if 0 <= k < n else ""
    while i < n:
        c, nx = s[i], at(i + 1)
        code, step = "", 1
        if c in vowels:
            code = "A" if i == 0 else ""
        elif c == "y" or c == "w":
            code = c.upper() if i == 0 and nx in vowels else ""
        elif c == "h":
            code = "H" if (i == 0 and nx in vowels) else ""
        elif c == "c":
            if nx == "h":
                code, step = "X", 2
            elif nx == "k":
                code, step = "K", 2
            elif nx in "eiy":
                code = "S"
            else:
                code = "K"
        elif c == "s":
            if nx == "h":
                code, step = "X", 2
            elif s[i:i + 3] in ("sio", "sia"):
                code = "X"
            elif nx == "c" and at(i + 2) == "h":
                code, step = "SK", 3
            else:
                code = "S"
        elif c == "t":
            if nx == "h":
                code, step = "0", 2
            elif s[i:i + 3] in ("tio", "tia"):
                code = "X"
            else:
                code = "T"
        elif c == "p":
            code, step = ("F", 2) if nx == "h" else ("P", 1)
        elif c == "g":
            if nx == "h":
                code, step = ("K", 2) if i == 0 else ("", 2)
            elif nx in "eiy" and at(i + 2) != "t":
                code = "J"
            else:
                code = "K"
        elif c == "d":
            code, step = ("J", 2) if nx == "g" and at(i + 2) in "eiy" else ("T", 1)
        elif c == "q":
            code = "K"
        elif c == "x":
            code = "KS"
        elif c == "z":
            code = "S"
        elif c == "v":
            code = "F"
        else:
            code = c.upper()
        # a doubled letter is one sound ("ll", "ss", "ck" handled above)
        if code and not (c not in vowels and i > 0 and s[i - 1] == c):
            out.append(code)
        i += step
    return "".join(out)


def _lev(a, b) -> int:
    if a == b:
        return 0
    if len(a) < len(b):
        a, b = b, a
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def _letters(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", text.lower())


def _bare(w: str) -> str:
    return w.strip(_STRIP)


# --- dictionary test ---------------------------------------------------------------------------

def make_is_common(tok: Optional[Callable] = None) -> Callable[[str], bool]:
    """-> f(word) True for an everyday English word. With whisper's tokenizer: the lower-case word is
    ONE token (GPT-2 BPE keeps the ~30k most frequent words whole; "flatly", "meal", "cloud" are one,
    "flowly", "neve", "zorblax" are not). Without it: stop words and short plain words."""
    cache = {}

    def f(word: str) -> bool:
        w = _bare(word).lower()
        if not w:
            return True
        if w in cache:
            return cache[w]
        w = re.sub(r"['’](s|t|re|ve|ll|d|m)$", "", w)     # a contraction is as common as its base
        if w in _STOP:
            r = True
        elif not w.replace("'", "").replace("’", "").isalpha():
            r = False
        elif tok is not None:
            try:
                r = len(tok(" " + w)) == 1
            except Exception:  # noqa: BLE001 - a tokenizer hiccup must never stop transcription
                r = len(w) <= 5
        else:
            r = len(w) <= 5
        cache[w] = r
        return r
    return f


# --- building the vocabulary ---------------------------------------------------------------------

_POSS = re.compile(r"['’]s$", re.I)


def _term(text: str, source: str, heard: Optional[str] = None) -> Optional[dict]:
    words = [_bare(w) for w in text.split()]
    words = [w for w in words if w]
    if not words or len(words) > MAX_TERM_WORDS:
        return None
    letters = _letters("".join(words))
    if len(letters) < 3 or letters.isdigit():
        return None
    return {"text": " ".join(words), "words": words, "source": source, "key": sound_key("".join(words)),
            "heard": (heard or "").lower() or None}


def _name_runs(text: str, is_common) -> list:
    """Distinctive words of free text, and runs of consecutive Capitalised words (2-3) as one term
    ("Mae Lin", "Claude Code", "Orla Quint"). A capital at a sentence start says nothing by itself."""
    out, run = [], []

    def flush():
        if len(run) >= 2 and any(d for _, d in run):
            out.append(" ".join(w for w, _ in run[:MAX_TERM_WORDS]))
        run.clear()
    for m in _WORD_RE.finditer(text or ""):
        w = _bare(m.group(0))
        before = text[:m.start()].rstrip(" \t")
        initial = not before.strip() or before[-1] in ".!?:\n-*#>"
        if initial or (before[-1:] in ",;()\"“”" if before else False):
            flush()                     # a name never runs across a sentence or clause break
        if not w or w.lower() in _STOP or w.isdigit():
            flush()
            continue
        cap = w[:1].isupper()
        # a rare word, an inner capital (iPhone, TAMS), or a capital mid-sentence (a name: "Orla's")
        distinct = not is_common(w) or any(c.isupper() for c in w[1:]) or (cap and not initial)
        if cap:
            run.append((w, distinct))
        else:
            flush()
        if distinct and not (initial and is_common(w.lower())):
            if cap or not initial:
                out.append(w)
    flush()
    return out


def build(material: dict, is_common: Callable[[str], bool]) -> list:
    """material: {"corrected": [{from,to}], "vocabulary": [str], "title": str, "script": str,
    "style": [str], "library": [{from,to}]} -> terms, strongest source first, each text once."""
    terms, seen = [], set()

    def add(t):
        if t and t["text"].lower() not in seen:
            seen.add(t["text"].lower())
            terms.append(t)
            if _POSS.search(t["text"]):        # "Orla's" also teaches "Orla"
                add(_term(_POSS.sub("", t["text"]), t["source"]))

    def from_corrections(cs, source):
        for c in cs or []:
            if not isinstance(c, dict):
                continue
            heard = " ".join(_bare(x) for x in str(c.get("from", "")).split()).strip()
            to = [_bare(x) for x in str(c.get("to", "")).split()]
            to = [x for x in to if x]
            if not to or _letters(heard) == _letters(" ".join(to)) and not any(
                    any(ch.isupper() for ch in w[1:]) for w in to):
                continue          # pure reformatting (case at a sentence start, punctuation)
            def distinct(w):
                return not is_common(w) or any(ch.isupper() for ch in w[1:])
            if len(to) <= MAX_TERM_WORDS and not all(w.lower() in _STOP or w.isdigit() for w in to):
                # this project's fix is taken whole; another project's only when every word in it is
                # a name/jargon word ("Claude Code", not "6 billion AI")
                if source == "corrected" or all(distinct(w) for w in to):
                    add(_term(" ".join(to), source, heard))
            for w in to:          # single distinctive words of a longer fix ("Orla Quint Rizz.")
                if distinct(w):
                    add(_term(w, source))
    from_corrections(material.get("corrected"), "corrected")
    for v in material.get("vocabulary") or []:
        add(_term(str(v), "vocabulary"))
    for w in _name_runs(material.get("title") or "", is_common):
        add(_term(w, "title"))
    script = re.sub(r"[#*_>`|\[\]]+", " ", material.get("script") or "")
    for w in _name_runs(script, is_common):
        add(_term(w, "script"))
    for phrase in material.get("style") or []:
        for w in _name_runs(phrase, is_common):
            add(_term(w, "style"))
    from_corrections(material.get("library"), "library")
    return terms


# --- matching ----------------------------------------------------------------------------------

def _match(span_words: list, term: dict) -> Optional[int]:
    """-> 0 for an exact sound match, 1 for a near one, None for no match."""
    heard = "".join(span_words)
    hl, tl = _letters(heard), _letters(term["text"])
    if not hl:
        return None
    if hl == tl:                        # same letters: only a join/split ("Code Rabbit" -> CodeRabbit)
        return 0 if len(span_words) != len(term["words"]) else None
    if re.sub(r"\D", "", hl) != re.sub(r"\D", "", tl):
        return None                     # numbers are never respelled ("8 billion" is not "6 billion")
    if term.get("heard") and " ".join(w.lower() for w in span_words) == term["heard"]:
        return 0                        # the user corrected exactly this hearing before
    if hl.rstrip("s") == tl.rstrip("s"):
        return None                     # plural/singular only ("SAT" / "SATs"): whisper heard that right
    hk, tk = sound_key(heard), term["key"]
    if not hk or not tk or hk[0] != tk[0]:
        return None                     # names keep their first sound ("eve" is not "Neve")
    spell = 1 - _lev(hl, tl) / max(len(hl), len(tl))
    if hk == tk:
        return 0 if spell >= 0.45 else None
    if len(span_words) != len(term["words"]):
        return None                     # splitting/joining words needs an exact sound match
    # near: one sound swapped or one extra ("Tans"/TAMS, "flatly"/Flowly), never one MISSING: a
    # heard word with fewer sounds than the term is a fragment ("Flo" of "Flo Lee")
    if len(tk) >= 3 and _lev(hk, tk) == 1 and spell >= 0.55 and len(tk) <= len(hk) <= len(tk) + 1:
        return 1
    return None


def correct(words: list, terms: list, is_common: Callable[[str], bool]) -> tuple:
    """Respell spans of `words` ([{s, e, w, ...}], one source, time order) that sound like a term.
    -> (new_words, replacements). A respelled word keeps its timing and gets "heard" (the original
    text) and "vocab" (the term's source). Never drops speech: N heard words become one word over
    the same span only when they are one term."""
    if not words or not terms:
        return list(words), []
    out, reps = [], []
    i, n = 0, len(words)
    by_len = sorted(terms, key=lambda t: -len(t["words"]))
    case_terms = {t["text"].lower(): t for t in terms if len(t["words"]) == 1}
    spelled = {_letters(t["text"]) for t in terms}
    while i < n:
        best = None
        for span in range(MAX_TERM_WORDS, 0, -1):
            seg = words[i:i + span]
            if len(seg) < span:
                continue
            if any(seg[k + 1]["s"] - seg[k]["e"] > MAX_GAP for k in range(span - 1)):
                continue
            bare = [_bare(w["w"]) for w in seg]
            if not all(bare):
                continue
            poss = _POSS.search(bare[-1])
            if poss:                    # match "flatly's" as "flatly", give the 's back after
                bare[-1] = bare[-1][:poss.start()]
            if not all(bare) or (span == 1 and _letters(bare[0]) in spelled):
                continue                # already spells a term ("flowly" is Flowly, not Flowly's)
            if span > 1 and any(b.lower() in _STOP or not sound_key(b) for b in bare):
                continue                # "oh", "a", "the" never hide inside a name
            if span > 1 and len({w.get("_seg") for w in seg}) > 1:
                continue                # never join across whisper's segments
            if span > 1 and re.search(r"[.!?,;:]$", seg[0]["w"].strip()):
                continue                # a sentence/clause break inside the span: not one name
            dictionary = all(is_common(b) for b in bare)
            if dictionary and min(float(w.get("p", 0.0)) for w in seg) >= DICT_MAX_P:
                continue                # whisper was sure of an everyday word: it is that word
            # whisper wrote a Name mid-sentence ("Georgia"): only another Name may replace it
            prev = words[i - 1]["w"].strip() if i else "."
            named = bare[0][:1].isupper() and not re.search(r"[.!?]$", prev)
            for t in by_len:
                if abs(len(t["words"]) - span) > 1:
                    continue
                if named and not any(c.isupper() for c in t["text"]):
                    continue
                if span == 1 and len(t["words"]) == 1 and bare[0].lower() in _STOP:
                    continue
                if any(b.lower() == t["text"].lower() for b in bare) and span > 1:
                    continue            # one of the heard words already IS the term
                q = _match(bare, t)
                if q is None:
                    continue
                if dictionary and t["source"] not in STRONG:
                    continue            # library terms never respell everyday words
                if dictionary and (len(t["key"]) < 3 or not any(c.isupper() for c in t["text"])):
                    continue            # an everyday word only becomes a NAME, and not a short one
                    #                     ("said" is not "SAT")
                # exact sound first, then the longest term, then the FEWEST heard words (a word
                # that adds nothing to the match stays its own word)
                rank = (q, -len(t["words"]), span, STRONG.index(t["source"]) if t["source"] in STRONG else 9)
                if best is None or rank < best[0]:
                    best = (rank, span, t, poss.group(0) if poss else "")
        if best is None:
            # case-only: "notion" -> "Notion" only from the user's own corrections / vocabulary
            w = words[i]
            b = _bare(w["w"])
            t = case_terms.get(b.lower())
            if t and b != t["text"] and t["source"] in ("corrected", "vocabulary") and len(b) > 1:
                nw = dict(w)
                nw["w"] = _LEAD.match(w["w"]).group(0) + t["text"] + _TAIL.search(w["w"]).group(0)
                nw["heard"], nw["vocab"] = w["w"], t["source"]
                out.append(nw)
                reps.append({"heard": b, "written": t["text"], "source": t["source"], "s": w["s"], "e": w["e"],
                             "words": 1})
            else:
                out.append(words[i])
            i += 1
            continue
        _, span, t, poss = best
        seg = words[i:i + span]
        nw = dict(seg[0])
        lead = _LEAD.match(seg[0]["w"]).group(0)
        tail = _TAIL.search(seg[-1]["w"]).group(0)
        nw["w"] = lead + t["text"] + poss + tail
        nw["e"] = seg[-1]["e"]
        if "p" in seg[0]:
            nw["p"] = min(float(x.get("p", 1.0)) for x in seg)
        nw["heard"] = " ".join(x["w"] for x in seg)
        nw["vocab"] = t["source"]
        out.append(nw)
        reps.append({"heard": " ".join(_bare(x["w"]) for x in seg), "written": t["text"], "source": t["source"],
                     "s": seg[0]["s"], "e": seg[-1]["e"], "words": span})
        i += span
    return out, reps


def summarize(terms: Iterable[dict]) -> dict:
    counts = {}
    for t in terms:
        counts[t["source"]] = counts.get(t["source"], 0) + 1
    return counts
