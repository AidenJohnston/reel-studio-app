"""`analyze` / `autocut`: everything the AI needs to pick takes, and a decent cut without it.

Writes work/analysis.json:
  phrases   the transcript split at pauses and sentence ends, each with word-id range + verdict
  retakes   lines said more than once: {id, text, takes:[{from,to,s,e,text,complete,chosen}]}
  pauses    dead air between words (measured edges)
  defaultCut {keep, gapCap, dropped:[{from,to,reason,text}]}
plus work/envelope.json (10 ms RMS per source) and work/face-<sid>.json (A2's placement, if present).

The default cut (the "red thread" without a model) follows these auto-cut rules:
  * people redo a line until it lands, so the LAST complete take of a repeated line wins
  * false starts (a restart that matches the beginning of the next take) are dropped
  * an abandoned take (a short restart that trails off) loses to the complete one, even if earlier
  * meta-talk (camera/teleprompter/"let me do that again"/"cut this out") is dropped
  * standalone ums are dropped; everything else is kept ("when unsure, keep")
Pauses are not cut here: cut.gapCap caps them at render time, measured from the audio.
"""
from __future__ import annotations

import re
import time
from difflib import SequenceMatcher
from pathlib import Path
from typing import Optional

from . import audio_env, cut as cutmod, project as projmod, transcribe
from .proto import EngineError, log, progress

STAGE = "analyze"
PHRASE_GAP = 0.45            # a pause this long ends a phrase
WINDOW_PHRASES = 10          # how far ahead a retake of a line is looked for
WINDOW_SECONDS = 75.0
COMPLETE_FRAC = 0.55         # a take shorter than this share of the group's longest is a fragment
FRAGMENT_MAX = 4             # an isolated phrase this short between long pauses is a false start
FRAGMENT_PAUSE = 1.0

FILLERS = {"um", "uh", "umm", "uhh", "erm", "er", "hmm", "mm", "mhm", "ah"}
LEADERS = {"so", "and", "but", "okay", "ok", "alright", "right", "now", "well", "yeah", "like"}
DANGLING = {"and", "the", "a", "an", "to", "of", "i", "i've", "i'm", "my", "so", "but", "because",
            "that", "with", "for", "in", "on", "is", "was", "we", "you", "it's", "this", "like",
            "or", "if", "your", "their", "his", "her", "our", "at", "from", "about", "just"}
FUNCTION_WORDS = DANGLING | {"it", "he", "she", "they", "be", "are", "do"}

META_PATTERNS = [
    r"\b(let me|lemme|let's|i'?ll|i'?m gonna|i'?m going to|i need to|gotta|have to)\s+(do|try|say|start|redo|record|take|film|shoot)\s+(that|this|it)(\s+one)?\s+(again|over)\b",
    r"\b(do|try|say|start)\s+(that|this|it)\s+(again|over)\b",
    r"\b(one more time|start(ing)? over|from the top|take (two|three|four|2|3|4)|redo|do[- ]over|let me restart|restart)\b",
    r"\b(cut (this|that|it) (out|part)|we'?ll cut (this|that|it)|edit (this|that|it) out|you can cut|cut here)\b",
    r"\b(teleprompter|camera angle|tripod|is (it|this) recording|am i recording|are we recording|still recording)\b",
    r"\b(close to|away from|closer to|look at) the camera\b",
    r"\b(back (this|it) up a bit|move (this|it) back)\b",
    r"\b(i messed (that|it) up|i screwed (that|it) up|i keep messing up|that was (bad|terrible|awful)|dang it|god damn it|ugh)\b",
    r"\bfiller words\b",
    r"\b(my |the )?(mic|microphone|phone|camera|tripod) (just )?(fell|fell off|dropped|died|is dying|moved|slipped)\b",
    r"^(oh )?(shoot|crap|oops|whoops|my bad|darn|dang)\b",
    r"\b(hold on|wait wait|sorry,? sorry|oh my god|oh my lord)\b",
]
_META = [re.compile(p) for p in META_PATTERNS]
_ONLY_JUNK = re.compile(r"^(wait|hold on|sorry|okay|ok|alright|all right|um+|uh+|so|yeah|hmm|right|anyway|anyways)"
                        r"(\s+(wait|hold on|sorry|okay|ok|alright|all right|um+|uh+|so|yeah|hmm|right|anyway|anyways))*$")


def norm_token(w: str) -> str:
    t = w.lower().replace("’", "'")
    t = re.sub(r"[^\w']+", "", t)
    return t.strip("'")


def tokens_of(words: list) -> list:
    return [t for t in (norm_token(w["w"]) for w in words) if t and t not in FILLERS]


def is_sentence_end(w: str) -> bool:
    return bool(re.search(r"[.!?…][\"')\]]*$", w.strip()))


# --- phrases ------------------------------------------------------------------------------------

def split_phrases(words: list) -> list:
    """[{i0, i1, s, e, text, toks, gap_before, gap_after}] over transcript positions."""
    phrases, start = [], 0
    for i in range(1, len(words) + 1):
        end_here = i == len(words)
        if not end_here:
            prev, w = words[i - 1], words[i]
            gap = w["s"] - prev["e"]
            end_here = (w["source"] != prev["source"] or gap >= PHRASE_GAP
                        or (is_sentence_end(prev["w"]) and gap >= 0.12)
                        or _restart_marker(words, start, i))
        if end_here:
            phrases.append({"i0": start, "i1": i - 1})
            start = i
    for k, p in enumerate(phrases):
        ws = words[p["i0"]:p["i1"] + 1]
        p["s"], p["e"] = ws[0]["s"], ws[-1]["e"]
        p["text"] = " ".join(w["w"] for w in ws)
        p["toks"] = tokens_of(ws)
        prev = phrases[k - 1] if k > 0 else None
        p["gap_before"] = round(p["s"] - words[p["i0"] - 1]["e"], 3) if k > 0 and \
            words[p["i0"] - 1]["source"] == ws[0]["source"] else 99.0
        p["gap_after"] = 99.0
        if prev is not None:
            prev["gap_after"] = p["gap_before"]
    return phrases


def _restart_marker(words: list, start: int, i: int) -> bool:
    """True when words[i-1] closes a spoken restart marker ("... all right | so everyone knows")
    in the middle of a phrase: people say "okay"/"all right" between logistics and the real take."""
    if i - start < 3:
        return False
    a = norm_token(words[i - 1]["w"])
    b = norm_token(words[i - 2]["w"]) if i >= 2 else ""
    nxt = norm_token(words[i]["w"])
    marker = (b == "all" and a == "right") or a in ("alright", "okay", "ok")
    return marker and nxt in ("so", "now", "today", "hey", "hi", "everyone", "everybody", "what", "this")


def _strip_leaders(toks: list) -> list:
    k = 0
    while k < len(toks) - 1 and k < 2 and toks[k] in LEADERS:
        k += 1
    return toks[k:]


def same_line(a: list, b: list) -> float:
    """How strongly two token lists are takes of the same line (0 = no). Order: a earlier."""
    a2, b2 = _strip_leaders(a), _strip_leaders(b)
    if not a2 or not b2:
        return 0.0
    short = min(len(a2), len(b2))
    sm = SequenceMatcher(None, a2, b2, autojunk=False)
    matched = sum(m.size for m in sm.get_matching_blocks())
    longest = max((m.size for m in sm.get_matching_blocks()), default=0)
    head = a2[:2] == b2[:2] or (len(a2) >= 1 and len(b2) >= 1 and a2[0] == b2[0] and short <= 2)
    prefix = len(a2) < len(b2) and a2 == b2[:len(a2)]          # a false start: said again, longer
    # same opening, different ending ("you don't need money / you don't need connections") is a
    # rhetorical list, not a retake -- unless nearly every word matches
    if not prefix and a2[-1] != b2[-1] and matched < 0.8 * short:
        return 0.0
    if short >= 2 and head and matched >= 0.6 * short:
        return matched / short
    # one take split across a pause vs. said in one breath: the shorter must sit almost wholly
    # inside the longer (a shared 3-word phrase like "he went to" is not a retake)
    if short >= 5 and matched >= 0.85 * short and longest >= 4:
        return matched / short
    return 0.0


def is_meta(p: dict) -> Optional[str]:
    text = " ".join(p["toks"])
    if not text:
        return "filler"
    if _ONLY_JUNK.match(text):
        return "filler"
    for rx in _META:
        if rx.search(text):
            if len(p["toks"]) <= 14:
                return "meta"
    return None


RUN_GAP = 0.80                # phrases closer than this are one fluent attempt


def run_tokens(phrases: list, k: int, cap: int = 60) -> int:
    """Tokens in the fluent attempt starting at phrase k: a take that keeps going without a real
    pause is a finished take; one that stops after three words and restarts is not."""
    total = len(phrases[k]["toks"])
    j = k
    while (j + 1 < len(phrases) and phrases[j]["gap_after"] < RUN_GAP and total < cap
           and not phrases[j + 1].get("drop")):
        j += 1
        total += len(phrases[j]["toks"])
    return total


def complete(phrases: list, k: int, longest_run: int) -> bool:
    p = phrases[k]
    n = run_tokens(phrases, k)
    if len(p["toks"]) < 2 or n < max(2, COMPLETE_FRAC * longest_run):
        return False
    last = p["toks"][-1] if p["toks"] else ""
    if p["gap_after"] >= RUN_GAP and last in DANGLING and not is_sentence_end(p["text"]):
        return False
    return True


def find_retakes(phrases: list) -> list:
    """Groups of phrase indices that are takes of the same line, in time order."""
    parent = list(range(len(phrases)))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for i, a in enumerate(phrases):
        if len(a["toks"]) < 2 or a.get("drop"):
            continue
        for j in range(i + 1, min(len(phrases), i + 1 + WINDOW_PHRASES)):
            b = phrases[j]
            if b["s"] - a["e"] > WINDOW_SECONDS:
                break
            if len(b["toks"]) < 2 or b.get("drop"):
                continue
            score = same_line(a["toks"], b["toks"])
            if score <= 0:
                continue
            # a pair of short phrases needs a pause between them: fluent repetition is emphasis;
            # and a finished sentence followed fluently by a similar one is delivery, not a redo
            if j == i + 1 and b["gap_before"] < 0.35 and (
                    min(len(a["toks"]), len(b["toks"])) <= 3 or is_sentence_end(a["text"])):
                continue
            parent[find(j)] = find(i)
    groups = {}
    for i in range(len(phrases)):
        groups.setdefault(find(i), []).append(i)
    return [g for g in groups.values() if len(g) > 1]


def stutters(words: list, i0: int, i1: int) -> list:
    """Positions of an immediately repeated 1-3 word run's FIRST copy ("this dude this dude")."""
    toks = [(i, norm_token(words[i]["w"])) for i in range(i0, i1 + 1)]
    toks = [(i, t) for i, t in toks if t and t not in FILLERS]
    drop = []
    k = 0
    while k < len(toks):
        hit = False
        for n in (3, 2, 1):
            if k + 2 * n > len(toks):
                continue
            a = [t for _, t in toks[k:k + n]]
            b = [t for _, t in toks[k + n:k + 2 * n]]
            if a != b:
                continue
            if n == 1 and a[0] not in FUNCTION_WORDS:
                continue
            if len(set(a)) == 1 and n > 1:      # "no no, no no" is emphasis, not a stumble
                continue
            first_end = words[toks[k + n - 1][0]]["e"]
            second_start = words[toks[k + n][0]]["s"]
            if second_start - first_end > 1.0:
                continue
            drop.extend(i for i, _ in toks[k:k + n])
            k += n
            hit = True
            break
        if not hit:
            k += 1
    return drop


def plan(words: list) -> dict:
    phrases = split_phrases(words)
    reasons = {}           # phrase index -> reason

    for k, p in enumerate(phrases):
        r = is_meta(p)
        if r:
            reasons[k] = r
            p["drop"] = r

    groups = find_retakes(phrases)
    retakes = []
    chosen_set = set()
    for gi, g in enumerate(groups):
        longest_run = max(run_tokens(phrases, k) for k in g)
        comp = [k for k in g if complete(phrases, k, longest_run)]
        chosen = comp[-1] if comp else max(g, key=lambda k: (run_tokens(phrases, k), k))
        chosen_set.add(chosen)
        for k in g:
            if k != chosen:
                reasons.setdefault(k, "retake")
                phrases[k]["drop"] = reasons[k]
        retakes.append({
            "id": f"r{gi + 1}",
            "text": phrases[chosen]["text"],
            "takes": [{"from": words[phrases[k]["i0"]]["id"], "to": words[phrases[k]["i1"]]["id"],
                       "s": phrases[k]["s"], "e": phrases[k]["e"], "text": phrases[k]["text"],
                       "complete": k in comp, "chosen": k == chosen} for k in g],
        })

    # isolated short fragments next to dropped material = abandoned false starts
    for k, p in enumerate(phrases):
        if k in reasons or k in chosen_set or not p["toks"] or len(p["toks"]) > FRAGMENT_MAX:
            continue
        if is_sentence_end(p["text"]):
            continue
        near1 = any(j in reasons for j in (k - 1, k + 1) if 0 <= j < len(phrases))
        near2 = any(j in reasons for j in (k - 2, k + 2) if 0 <= j < len(phrases))
        pause = min(p["gap_before"], p["gap_after"])
        if (near1 and pause >= 0.8) or (near2 and pause >= FRAGMENT_PAUSE):
            reasons[k] = "false start"
            p["drop"] = "false start"

    dropped_pos = set()
    dropped = []
    for k, p in enumerate(phrases):
        if k in reasons:
            dropped_pos.update(range(p["i0"], p["i1"] + 1))
            dropped.append({"from": words[p["i0"]]["id"], "to": words[p["i1"]]["id"],
                            "reason": reasons[k], "text": p["text"]})
            continue
        for i in stutters(words, p["i0"], p["i1"]):
            dropped_pos.add(i)
            dropped.append({"from": words[i]["id"], "to": words[i]["id"], "reason": "stutter",
                            "text": words[i]["w"]})
        for i in range(p["i0"], p["i1"] + 1):
            if norm_token(words[i]["w"]) in FILLERS:
                dropped_pos.add(i)
                dropped.append({"from": words[i]["id"], "to": words[i]["id"], "reason": "filler",
                                "text": words[i]["w"]})
    kept = [i for i in range(len(words)) if i not in dropped_pos]
    if not kept:                      # never hand back an empty cut
        kept = list(range(len(words)))
        dropped = []
    keep = cutmod.keep_from_positions(words, kept)
    out_phrases = [{"id": f"p{k + 1}", "from": words[p["i0"]]["id"], "to": words[p["i1"]]["id"],
                    "source": words[p["i0"]]["source"], "s": p["s"], "e": p["e"], "text": p["text"],
                    "pauseBefore": p["gap_before"] if p["gap_before"] < 99 else None,
                    "drop": reasons.get(k)} for k, p in enumerate(phrases)]
    pos = {w["id"]: i for i, w in enumerate(words)}
    dropped.sort(key=lambda d: pos[d["from"]])
    return {"phrases": out_phrases, "retakes": retakes, "keep": keep, "dropped": dropped,
            "keptWords": len(kept), "totalWords": len(words)}


# --- commands -----------------------------------------------------------------------------------

def faces_cached(project_dir: Path, proj: dict) -> Optional[dict]:
    """{"found": ...} from work/face.json when it covers every source and is newer than each, else None."""
    fp = project_dir / "work" / "face.json"
    try:
        tracks = (projmod.read_json(fp) or {}).get("sources") or {}
        t = fp.stat().st_mtime
        for src in proj["sources"]:
            if src["id"] not in tracks or projmod.source_path(project_dir, src).stat().st_mtime > t:
                return None
    except (OSError, ValueError, AttributeError):
        return None
    return {"found": {k: (v or {}).get("found") for k, v in tracks.items()}}


def detect_faces(project_dir: Path, proj: dict, p0: float = 0, p1: float = 100) -> dict:
    face = {"found": None}
    try:
        from . import placement            # A2 owns it; optional until merged
    except ImportError:
        placement = None
    if placement is not None and hasattr(placement, "detect_faces"):
        tracks = {}
        for n, src in enumerate(proj["sources"]):
            progress(STAGE, p0 + (p1 - p0) * n / len(proj["sources"]), "Finding your face in the video")
            out = project_dir / "work" / f"face-{src['id']}.json"
            try:
                tracks[src["id"]] = placement.detect_faces(projmod.source_path(project_dir, src), out)
            except Exception as exc:   # noqa: BLE001 -- a missing face track only costs smart framing
                log(f"# face detection failed for {src['id']}: {exc!r}")
        if tracks:
            projmod.write_json(project_dir / "work" / "face.json", {"sources": tracks}, indent=None)
            face = {"found": {k: v.get("found") for k, v in tracks.items()}}
    return face


def faces_only(project_dir: Path) -> dict:
    """Face tracks alone (no transcript needed): runs beside `transcribe` to save its time later."""
    project_dir = Path(project_dir)
    t0 = time.time()
    proj = projmod.load(project_dir)
    face = faces_cached(project_dir, proj) or detect_faces(project_dir, proj, 0, 100)
    progress(STAGE, 100, "Found your face", force=True)
    return {"face": face, "seconds": round(time.time() - t0, 2)}


def run(project_dir: Path) -> dict:
    project_dir = Path(project_dir)
    t0 = time.time()
    proj = projmod.load(project_dir)
    tr = projmod.load_transcript(project_dir, proj)
    words = tr["words"]
    progress(STAGE, 5, "Looking for your best takes", force=True)

    # envelope (reused by the AI's tools and by anyone measuring pauses)
    env_out = {}
    for src in proj["sources"]:
        wav = transcribe.audio_path(project_dir, src["id"])
        if not wav.exists():
            transcribe.extract_audio(projmod.source_path(project_dir, src), wav)
        env = audio_env.envelope(audio_env.read_wav(wav))
        env_out[src["id"]] = {"hop": audio_env.HOP_MS / 1000.0,
                              "threshold": round(audio_env.noise_threshold(env), 5),
                              "rms": [round(float(x), 4) for x in env]}
    projmod.write_json(project_dir / "work" / "envelope.json", env_out, indent=None)
    progress(STAGE, 25, "Looking for your best takes")

    pauses = audio_env.pause_list(words)
    p = plan(words)
    progress(STAGE, 45, "Picking your best takes")

    # face track (A2's placement module), per source. `analyze --faces-only` may already have made it
    # while the speech model was still listening (it needs no transcript): reuse it when it is fresh.
    face = faces_cached(project_dir, proj)
    if face is None:
        face = detect_faces(project_dir, proj, 50, 90)

    gap_cap = float((proj.get("cut") or {}).get("gapCap", cutmod.GAP_CAP))
    analysis = {
        "version": 1, "createdAt": projmod.now_iso(),
        "phrases": p["phrases"], "retakes": p["retakes"], "pauses": pauses,
        "defaultCut": {"keep": p["keep"], "gapCap": gap_cap, "dropped": p["dropped"]},
        "stats": {"words": p["totalWords"], "keptWords": p["keptWords"],
                  "phrases": len(p["phrases"]), "retakeGroups": len(p["retakes"]),
                  "longPauses": sum(1 for x in pauses if x["dur"] >= 1.0)},
        "face": face,
    }
    # how long would the default cut run?
    try:
        tl = cutmod.build_timeline(words, p["keep"], projmod.source_meta(proj), gap_cap=gap_cap)
        analysis["stats"]["defaultCutDuration"] = tl.duration
    except EngineError:
        pass
    projmod.write_json(project_dir / "work" / "analysis.json", analysis)
    progress(STAGE, 100, "Found your best takes", force=True)
    return {"file": str(project_dir / "work" / "analysis.json"), "stats": analysis["stats"],
            "retakes": len(p["retakes"]), "dropped": len(p["dropped"]),
            "seconds": round(time.time() - t0, 2)}


def autocut(project_dir: Path, gap_cap: Optional[float] = None) -> dict:
    """Write the deterministic baseline cut into project.json (runs analyze first if needed)."""
    project_dir = Path(project_dir)
    af = project_dir / "work" / "analysis.json"
    tp = project_dir / "work" / "transcript.json"
    if not af.exists() or (tp.exists() and af.stat().st_mtime < tp.stat().st_mtime):
        run(project_dir)
    analysis = projmod.read_json(af)
    proj = projmod.load(project_dir)
    proj.setdefault("cut", {})
    proj["cut"]["keep"] = analysis["defaultCut"]["keep"]
    if gap_cap is not None:
        proj["cut"]["gapCap"] = float(gap_cap)
    proj["cut"].setdefault("gapCap", cutmod.GAP_CAP)
    proj["cut"].setdefault("minSaving", cutmod.MIN_SAVING)
    proj["cut"]["source"] = "autocut"
    projmod.save(project_dir, proj)
    tl = projmod.timeline(project_dir, proj)
    progress("autocut", 100, "Your first cut is ready", force=True)
    src_total = sum(float(s.get("duration") or 0) for s in proj["sources"])
    return {"keep": proj["cut"]["keep"], "ranges": len(proj["cut"]["keep"]),
            "duration": tl.duration, "sourceDuration": round(src_total, 3),
            "dropped": len(analysis["defaultCut"]["dropped"]), "retakes": len(analysis["retakes"])}
