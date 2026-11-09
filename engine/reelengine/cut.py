"""The cut: word-id ranges and clips -> source segments on the output clock.

`cut.keep` holds inclusive word-id ranges and source-time clips in output order. A range covers every transcript
word between its two ends (by position in transcript.words). This module turns that into
Segments (source, src_start, src_end, out_start) and answers "where does word wN land in the
output?" -- the one mapping that b-roll, zooms, music automation and captions all go through, so a
re-cut moves all of them together.

Dead air is handled here, measured from the AUDIO, not the transcript (ported from a working
deadspace pass): transcribe.py stores each word's measured edges, so `e` already includes the
word's release. Between two kept words, a pause longer than gapCap + minSaving is cut down to
gapCap: AFTER_SHARE of it stays with the outgoing word, the rest leads into the next one. A word
is never split, and only silence is ever removed.

Cut points are snapped to the SOURCE frame grid, so each segment's picture (whole frames) and sound
(sample-exact) have the same length and the concat cannot drift the picture against the sound.
Pure functions; no ffmpeg in here.
"""
from __future__ import annotations

import bisect
import math
from dataclasses import dataclass, field
from typing import Optional

from .proto import EngineError
from .render_ctx import Segment

GAP_CAP = 0.25          # max dead air kept between words
MIN_SAVING = 0.08       # never splice for less than this
AFTER_SHARE = 0.08      # of the kept air, at most this much stays with the OUTGOING word
HEAD_LEAD = 0.10        # air before the very first word of the video
TAIL_KEEP = 0.35        # ring-out after the very last word
EPS = 1e-6
TRANSITIONS = ("hard", "j", "l", "smash", "match", "flash")
MATCH_HOLD = 0.3        # seconds either side of a match cut where a framing change would undo it


def snap(t: float, fps: float) -> float:
    if not fps:
        return round(t, 6)
    return round(round(t * fps) / fps, 6)


@dataclass
class Timeline:
    segments: list                      # [Segment] in output order
    duration: float
    words_out: list                     # every kept word occurrence: {id,w,s,e,source} on the output clock
    first_pos: dict                     # word id -> (out_s, out_e) of its first occurrence
    kept_index: list = field(default_factory=list)   # sorted transcript positions that are kept
    index: dict = field(default_factory=dict)        # word id -> transcript position
    words: list = field(default_factory=list)        # the transcript words
    # one row per match join: {keep, out, in, word, prevWord, played: "match" | "hard" | "none", matched?, why?}
    # (match.py fills in matched/look/move/why; "none" = no cut there, the take runs on)
    match_joins: list = field(default_factory=list)

    def is_kept(self, wid: str) -> bool:
        return wid in self.first_pos

    def word_out_time(self, wid: str) -> float:
        """Output start of a word. A word that was cut maps to the next kept word (so an anchor that
        starts on a removed word starts where the speech resumes), else to the end of the last one."""
        if wid in self.first_pos:
            return self.first_pos[wid][0]
        pos = self._pos(wid)
        k = bisect.bisect_left(self.kept_index, pos)
        if k < len(self.kept_index):
            return self.first_pos[self.words[self.kept_index[k]]["id"]][0]
        if self.kept_index:
            return self.first_pos[self.words[self.kept_index[-1]]["id"]][1]
        return 0.0

    def word_out_end(self, wid: str) -> float:
        """Output end of a word. A cut word maps to the end of the previous kept word."""
        if wid in self.first_pos:
            return self.first_pos[wid][1]
        pos = self._pos(wid)
        k = bisect.bisect_right(self.kept_index, pos) - 1
        if k >= 0:
            return self.first_pos[self.words[self.kept_index[k]]["id"]][1]
        if self.kept_index:
            return self.first_pos[self.words[self.kept_index[0]]["id"]][0]
        return 0.0

    def _pos(self, wid: str) -> int:
        if wid not in self.index:
            raise EngineError("BAD_ANCHOR", f"unknown word id {wid!r}",
                              "Part of this edit points at words that are no longer in the "
                              "transcript. Try undoing the last change.")
        return self.index[wid]

    def out_to_src(self, t: float):
        """(source id, source seconds) shown at output time t."""
        for seg in self.segments:
            if t <= seg.out_end + EPS:
                return seg.source, seg.src_start + max(0.0, t - seg.out_start)
        if not self.segments:
            return None, 0.0
        last = self.segments[-1]
        return last.source, last.src_end

    def src_to_out(self, source: str, t: float) -> Optional[float]:
        """First output time that shows source time t, or None if that moment was cut."""
        for seg in self.segments:
            if seg.source == source and seg.src_start - EPS <= t <= seg.src_end + EPS:
                return seg.out_start + (t - seg.src_start)
        return None


def resolve_ranges(words: list, keep: list) -> list:
    """keep ranges -> list of transcript-position runs [(i0, i1)], in output order, each inside one
    source. Unknown ids are an error the AI can fix; reversed ranges are taken as written forwards."""
    index = {w["id"]: i for i, w in enumerate(words)}
    runs = []
    for k, rng in enumerate(keep or []):
        try:
            i0, i1 = index[rng["from"]], index[rng["to"]]
        except KeyError as exc:
            raise EngineError("BAD_CUT", f"cut.keep[{k}] names unknown word {exc.args[0]!r}",
                              "The edit points at words that aren't in the transcript. "
                              "Try making the cut again.")
        if i0 > i1:
            i0, i1 = i1, i0
        start = i0
        for i in range(i0 + 1, i1 + 1):
            if words[i]["source"] != words[i - 1]["source"]:
                runs.append((start, i - 1))
                start = i
        runs.append((start, i1))
    return runs


def merge_contiguous(words: list, runs: list) -> list:
    """Join runs that play back to back AND sit back to back in the source ([w0..w2] then [w3..w5]).
    Planned apart, the first kept a little of the pause after w2 and the second started at w2's end,
    so that pause audio played twice: an audible stutter at every such boundary, and every later
    anchor shifted. One run caps that pause like any other."""
    out = []
    for i0, i1 in runs:
        if out and i0 == out[-1][1] + 1 and words[i0]["source"] == words[out[-1][1]]["source"]:
            out[-1] = (out[-1][0], i1)
        else:
            out.append((i0, i1))
    return out


def run_bounds(words: list, i0: int, i1: int, src_dur: float, tail_cap: float) -> tuple:
    """Source handles stop at adjacent transcript words, even when those words were removed."""
    src = words[i0]["source"]
    prev = words[i0 - 1] if i0 > 0 and words[i0 - 1]["source"] == src else None
    nxt = words[i1 + 1] if i1 + 1 < len(words) and words[i1 + 1]["source"] == src else None
    return (prev["e"] if prev else 0.0,
            nxt["s"] if nxt else (src_dur or words[i1]["e"] + tail_cap))


def join_runs(words: list, keep: list, first: int = 0) -> list:
    """Merge the same runs as hard cuts, retaining each declared boundary's occurrence.

    Markers travel with runs rather than word ids: reordered and repeated ranges may
    refer to the same word at different output times. `first`: where `keep` starts in
    cut.keep (the ranges after a clip, multi-source); a join on the range right after a
    clip has no spoken range before it to bridge, so it plays as a hard cut.
    """
    runs = []
    previous_end = None
    index = {w["id"]: i for i, w in enumerate(words)}
    resolved = iter(resolve_ranges(words, keep))
    for k, rng in enumerate(keep or []):
        join = rng.get("join")
        if join is not None:
            if (first + k == 0 or not isinstance(join, dict)
                    or join.get("transition") not in TRANSITIONS
                    or type(join.get("frames")) is not int or join["frames"] < 0):
                raise EngineError("BAD_JOIN", f"cut.keep[{first + k}].join needs a transition and non-negative integer frames after the first range",
                                  "Choose a join after the first range, with a whole number of frames.")
        parts = [next(resolved)]
        end = max(index[rng["from"]], index[rng["to"]])
        while parts[-1][1] != end:
            parts.append(next(resolved))
        for j, (i0, i1) in enumerate(parts):
            markers = ([(i0, previous_end, join, first + k)]
                       if j == 0 and join and join["transition"] != "hard" and previous_end is not None else [])
            if runs and i0 == runs[-1][1] + 1 and words[i0]["source"] == words[runs[-1][1]]["source"]:
                old0, _, old_markers = runs[-1]
                runs[-1] = (old0, i1, old_markers + markers)
            else:
                runs.append((i0, i1, markers))
        if parts:
            previous_end = parts[-1][1]
    return runs


def plan_run(words: list, i0: int, i1: int, gap_cap: float, min_saving: float, fps: float,
             src_dur: float, is_first: bool, is_last: bool) -> list:
    """Source pieces [(s, e)] that play words[i0..i1] with their pauses capped."""
    ws = words[i0:i1 + 1]
    lead_cap = HEAD_LEAD if is_first else max(0.0, gap_cap - AFTER_SHARE)
    tail_cap = TAIL_KEEP if is_last else min(AFTER_SHARE, gap_cap)
    lo, hi = run_bounds(words, i0, i1, src_dur, tail_cap)
    # the bounds that are a removed neighbouring word (the frame rounding below never crosses those)
    src = words[i0]["source"]
    word_lo = lo if i0 > 0 and words[i0 - 1]["source"] == src else -math.inf
    word_hi = hi if i1 + 1 < len(words) and words[i1 + 1]["source"] == src else math.inf
    # where those removed neighbours start and end: a nearest-frame edge that reaches past one plays it whole
    gone_s = words[i0 - 1]["s"] if word_lo > -math.inf else -math.inf
    gone_e = words[i1 + 1]["e"] if word_hi < math.inf else math.inf
    first_s, last_e = ws[0]["s"], ws[-1]["e"]
    start = min(first_s, max(lo, first_s - lead_cap, 0.0))
    end = max(last_e, min(hi, last_e + tail_cap))
    if src_dur:
        end = min(end, src_dur)

    cuts = []
    for a, b in zip(ws, ws[1:]):
        gap = b["s"] - a["e"]
        if gap > gap_cap + min_saving:
            after = min(AFTER_SHARE, gap_cap)
            c0, c1 = a["e"] + after, b["s"] - (gap_cap - after)
            if c1 - c0 >= min_saving:
                cuts.append((c0, c1))
    frame = 1.0 / (fps or 30.0)
    for w in ws:
        for qs, qe in w.get("gaps") or []:
            keep = min(gap_cap, qe - qs)
            after = min(AFTER_SHARE, keep)
            c0, c1 = qs + after, qe - (keep - after)
            if c1 - c0 >= max(min_saving, frame):
                cuts.append((c0, c1))
    cuts.sort()

    pieces, cursor = [], start
    for c0, c1 in cuts:
        c0, c1 = max(c0, start), min(c1, end)
        if c0 > cursor:
            pieces.append([cursor, c0])
        cursor = max(cursor, c1)
    if end > cursor:
        pieces.append([cursor, end])

    out = []
    rate = fps or 30.0
    for s, e in pieces:
        # Onto the frame grid: the nearest frame, as always, unless that frame is inside the piece's kept
        # speech (to the nearest frame alone, a word shorter than half a frame right after a cut was lost
        # whole: audit 11 P1). Only then does the edge go outward, to the frame before the speech starts
        # or after it ends, and that outward frame stops at a removed neighbouring word when a clean frame
        # exists between the two; when none does, the kept speech wins and under a frame of the neighbour
        # plays. A nearest frame that would play a whole removed word (one under half a frame long) stops
        # at that word too. Everywhere else the cut lands exactly where nearest-frame rounding put it.
        speech = [(a, b) for a, b in _spoken(ws) if b > s + EPS and a < e - EPS]
        speech_s = min((max(a, s) for a, _ in speech), default=e)
        speech_e = max((min(b, e) for _, b in speech), default=s)
        s2 = round(s * rate) / rate
        if s2 <= gone_s + EPS:                    # a removed word under half a frame long, played whole
            s2 = math.ceil(word_lo * rate - EPS) / rate
        if s2 > speech_s + EPS:
            s2 = math.floor(s * rate + EPS) / rate
            if s2 < word_lo - EPS and math.ceil(word_lo * rate - EPS) / rate <= speech_s + EPS:
                s2 = math.ceil(word_lo * rate - EPS) / rate
        e2 = round(e * rate) / rate
        if e2 >= gone_e - EPS:
            e2 = math.floor(word_hi * rate + EPS) / rate
        if e2 < speech_e - EPS:
            e2 = math.ceil(e * rate - EPS) / rate
            if e2 > word_hi + EPS and math.floor(word_hi * rate + EPS) / rate >= speech_e - EPS:
                e2 = math.floor(word_hi * rate + EPS) / rate
        s2, e2 = round(s2, 6), round(e2, 6)
        if src_dur:
            e2 = min(e2, math.floor(src_dur * rate + EPS) / rate)
        if e2 - s2 >= frame - EPS:
            if out and s2 <= out[-1][1] + EPS:
                out[-1][1] = max(out[-1][1], e2)    # a cut under two frames closes: one piece, no frame twice
            else:
                out.append([s2, e2])
    return [(round(s, 6), round(e, 6)) for s, e in out]


def _spoken(ws: list) -> list:
    """[(start, end)] of speech in these words: each word's span less its internal `gaps` (silences
    inside one transcript word, which plan_run may cut)."""
    out = []
    for w in ws:
        a = w["s"]
        for qs, qe in sorted(w.get("gaps") or []):
            if qs > a:
                out.append((a, min(qs, w["e"])))
            a = max(a, qe)
        if w["e"] > a:
            out.append((a, w["e"]))
    return out


def clip_span(item: dict, sources: dict) -> tuple[float, float]:
    """Validate a clip and snap its bounds to the source frame grid without removing silence."""
    src = item["source"]
    if src not in sources:
        raise EngineError("BAD_CUT", f"clip {item['clip']}: unknown source {src!r}",
                          "A clip points at a source that is no longer in this project.")
    start, end = float(item["in"]), float(item["out"])
    meta = sources[src]
    duration = float(meta.get("duration") or 0.0)
    fps = float(meta.get("fps") or 30.0)
    if not math.isfinite(start) or not math.isfinite(end) or start < 0 or end <= start or (duration and end > duration + EPS):
        raise EngineError("BAD_CUT", f"clip {item['clip']}: invalid bounds {start}..{end}",
                          "A clip's start and end must be inside its source video.")
    start, end = snap(start, fps), snap(end, fps)
    if duration:
        end = min(end, math.floor(duration * fps + EPS) / fps)
    if end - start < 1 / fps - EPS:
        raise EngineError("BAD_CUT", f"clip {item['clip']}: shorter than one source frame",
                          "A clip must contain at least one frame.")
    return round(start, 6), round(end, 6)


def build_timeline(words: list, keep: list, sources: dict, gap_cap: float = GAP_CAP,
                   min_saving: float = MIN_SAVING, join_fps: float = 30.0,
                   match_points: Optional[dict] = None) -> Timeline:
    """sources: {sid: {"duration": float, "fps": float}}. A keep item with `clip` plays that source span
    whole (multi-source); the word ranges between clips are merged and joined as before.

    match_points: {keep index: match.plan verdict}. A matched verdict moves that join's bounds to the
    frames that line up; without one a match join plays as a hard cut (project.timeline asks match.py)."""
    runs, pending, first = [], [], 0
    clip_ids = set()
    for k, item in enumerate(keep or []):
        if "clip" in item:
            runs.extend(join_runs(words, pending, first))
            pending = []
            if item["clip"] in clip_ids:
                raise EngineError("BAD_CUT", f"duplicate clip id {item['clip']!r}",
                                  "Each clip in the edit needs its own id.")
            clip_ids.add(item["clip"])
            runs.append(item)
        else:
            if not pending:
                first = k
            pending.append(item)
    runs.extend(join_runs(words, pending, first))
    segments, words_out, first_pos = [], [], {}
    joins, unmoved = [], []
    out = 0.0
    for n, run in enumerate(runs):
        if isinstance(run, dict):
            # a clip: its whole span, and the words heard in it
            src = run["source"]
            pieces = [clip_span(run, sources)]
            s, e = pieces[0]
            positions = [i for i, w in enumerate(words)
                         if w["source"] == src and w["s"] < e and w["e"] > s]
            markers = []
        else:
            i0, i1, markers = run
            src = words[i0]["source"]
            meta = sources.get(src) or {}
            fps = float(meta.get("fps") or 30.0)
            pieces = plan_run(words, i0, i1, gap_cap, min_saving, fps, float(meta.get("duration") or 0.0),
                              is_first=(n == 0), is_last=(n == len(runs) - 1))
            positions = range(i0, i1 + 1)
            point = next(((match_points or {}).get(kk) for wi, _, join, kk in markers
                          if wi == i0 and join["transition"] == "match"), None)
            if point and point.get("matched") and segments and pieces:
                # the frames that line up, found inside the air around the join (match.windows): the
                # outgoing side only gains or loses silence, so its words keep their output times
                out += point["outEnd"] - segments[-1].src_end
                segments[-1].src_end = point["outEnd"]
                pieces[0] = (point["inStart"], pieces[0][1])
        run_segs = []
        for s, e in pieces:
            seg = Segment(source=src, src_start=s, src_end=e, out_start=round(out, 6))
            run_segs.append(seg)
            out += e - s
        if not run_segs:
            continue

        def map_t(t: float) -> float:
            for seg in run_segs:
                if t < seg.src_start:
                    return seg.out_start
                if t <= seg.src_end:
                    return seg.out_start + (t - seg.src_start)
            return run_segs[-1].out_end

        for i in positions:
            w = words[i]
            os_, oe = map_t(w["s"]), map_t(w["e"])
            oe = max(oe, os_ + 0.01)
            words_out.append({"id": w["id"], "w": w["w"], "s": round(os_, 4), "e": round(oe, 4),
                              "source": src})
            first_pos.setdefault(w["id"], (round(os_, 4), round(oe, 4)))
        if positions:
            run_segs[0].first_word = words[positions[0]]["id"]
            run_segs[-1].last_word = words[positions[-1]]["id"]
        # Split a merged contiguous range only at a declared join. The two pieces
        # still show exactly the same source frames and have the same total length.
        for wi, previous_end, join, kk in markers:
            # the piece that holds the word takes the join, split at the word's nearest frame, or the frame
            # before it when the nearest one is past the word's start (a split there put a short word whole
            # on the outgoing side); a nearest frame past that piece's end (a one-frame piece) puts the join
            # at the piece's start
            ws_ = words[wi]["s"]
            t = snap(ws_, fps)
            if t > ws_ + EPS:
                t = round(math.floor(ws_ * (fps or 30.0) + EPS) / (fps or 30.0), 6)
            for si, seg in enumerate(run_segs):
                if seg.src_start - EPS <= ws_ < seg.src_end:
                    if not seg.src_start <= t < seg.src_end:
                        t = seg.src_start
                    prior_word_in_piece = any(w["e"] > seg.src_start + EPS and w["s"] < t
                                              for w in words[i0:wi])
                    if seg.src_start + EPS < t and prior_word_in_piece:
                        # There is no picture discontinuity here. A J/L handle would
                        # replay the same samples; clamp to zero without adding fades.
                        # A match has nothing to line up: the take simply runs on.
                        if join["transition"] == "match":
                            unmoved.append({"keep": kk, "word": wi, "prevWord": previous_end, "played": "none",
                                            "matched": False, "why": "there is no cut here: both sides are one continuous stretch of the take"})
                        if join["transition"] in ("j", "l", "match"):
                            break
                        right = Segment(src, t, seg.src_end, seg.out_start + t - seg.src_start,
                                        first_word=words[wi]["id"], last_word=seg.last_word)
                        seg.src_end, seg.last_word = t, words[previous_end]["id"]
                        run_segs.insert(si + 1, right)
                    else:
                        right = seg
                    right.first_word = words[wi]["id"]
                    joins.append((right, wi, previous_end, join, kk))
                    break
                if ws_ < seg.src_start:
                    seg.first_word = words[wi]["id"]
                    joins.append((seg, wi, previous_end, join, kk))
                    break
        segments.extend(run_segs)
    match_joins = list(unmoved)
    for incoming, wi, previous_end, join, kk in joins:
        si = next(i for i, seg in enumerate(segments) if seg is incoming)
        if si == 0:
            continue
        outgoing = segments[si - 1]
        incoming.join_transition = join["transition"]
        incoming.join_requested_frames = join["frames"]
        if join["transition"] == "match":
            point = (match_points or {}).get(kk) or {}
            matched = point.get("matched") is True and abs(incoming.src_start - float(point.get("inStart", -1))) < EPS
            if point.get("matched") is True and not matched:
                # a cut made by shortening a pause inside one kept stretch: the bounds are only moved at a range start
                point = {**point, "matched": False, "why": "this cut sits inside one kept stretch, where a pause was shortened, and can't be moved"}
            # an unmatched join is labelled what it is: a plain cut
            incoming.join_transition = "match" if matched else "hard"
            match_joins.append({"keep": kk, "out": si - 1, "in": si, "word": wi, "prevWord": previous_end,
                                "played": incoming.join_transition, **point})
            continue
        if join["transition"] == "j":
            meta = sources.get(incoming.source) or {}
            lo, _ = run_bounds(words, wi, wi, float(meta.get("duration") or 0), TAIL_KEEP)
            room = min(incoming.src_start - lo, outgoing.duration)
        elif join["transition"] == "l":
            meta = sources.get(outgoing.source) or {}
            _, hi = run_bounds(words, previous_end, previous_end, float(meta.get("duration") or 0), TAIL_KEEP)
            if meta.get("duration"):
                hi = min(hi, float(meta["duration"]))
            room = min(hi - outgoing.src_end, incoming.duration)
        else:
            continue
        # A boundary inside one continuous source span has no alternate audio to
        # bridge. Mixing its handle with itself would double the same samples.
        if outgoing.source == incoming.source and abs(outgoing.src_end - incoming.src_start) < EPS:
            room = 0.0
        frames = min(join["frames"], max(0, math.floor(room * join_fps + 1e-4)))
        incoming.join_frames = frames
        if join["transition"] == "j":
            incoming.audio_lead = frames / join_fps
        else:
            outgoing.audio_tail = frames / join_fps
    index = {w["id"]: i for i, w in enumerate(words)}
    kept_index = sorted({index[wid] for wid in first_pos})
    return Timeline(segments=segments, duration=round(out, 6), words_out=words_out,
                    first_pos=first_pos, kept_index=kept_index, index=index, words=words,
                    match_joins=sorted(match_joins, key=lambda m: m["keep"]))


def window_segments(segments: list, w0: float, w1: float) -> list:
    """The sub-segments that make up output seconds [w0, w1), re-based so w0 is 0."""
    out = []
    for seg in segments:
        lo, hi = max(seg.out_start, w0), min(seg.out_end, w1)
        if hi > lo + EPS:
            out.append(Segment(source=seg.source, src_start=round(seg.src_start + (lo - seg.out_start), 6),
                               src_end=round(seg.src_start + (hi - seg.out_start), 6),
                               out_start=round(lo - w0, 6), first_word=seg.first_word,
                               last_word=seg.last_word))
    return out


def keep_from_positions(words: list, kept: list) -> list:
    """Sorted transcript positions -> maximal word-id ranges (in source order)."""
    keep, run = [], None
    for i in sorted(set(kept)):
        if run and i == run[1] + 1 and words[i]["source"] == words[run[1]]["source"]:
            run[1] = i
        else:
            if run:
                keep.append({"from": words[run[0]]["id"], "to": words[run[1]]["id"]})
            run = [i, i]
    if run:
        keep.append({"from": words[run[0]]["id"], "to": words[run[1]]["id"]})
    return keep


def positions_from_keep(words: list, keep: list) -> list:
    """Every transcript position covered by keep, in output order (duplicates kept)."""
    out = []
    for i0, i1 in resolve_ranges(words, keep):
        out.extend(range(i0, i1 + 1))
    return out
