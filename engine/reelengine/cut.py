"""The cut: word-id ranges -> source segments on the output clock, and every time mapping.

`cut.keep` is a list of inclusive word-id ranges in OUTPUT order. A range covers every transcript
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


def plan_run(words: list, i0: int, i1: int, gap_cap: float, min_saving: float, fps: float,
             src_dur: float, is_first: bool, is_last: bool) -> list:
    """Source pieces [(s, e)] that play words[i0..i1] with their pauses capped."""
    ws = words[i0:i1 + 1]
    src = ws[0]["source"]
    prev = words[i0 - 1] if i0 > 0 and words[i0 - 1]["source"] == src else None
    nxt = words[i1 + 1] if i1 + 1 < len(words) and words[i1 + 1]["source"] == src else None
    lead_cap = HEAD_LEAD if is_first else max(0.0, gap_cap - AFTER_SHARE)
    tail_cap = TAIL_KEEP if is_last else min(AFTER_SHARE, gap_cap)
    lo = prev["e"] if prev else 0.0
    hi = nxt["s"] if nxt else (src_dur or ws[-1]["e"] + tail_cap)
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
    for s, e in pieces:
        s2, e2 = snap(s, fps), snap(e, fps)
        if src_dur:
            e2 = min(e2, math.floor(src_dur * (fps or 30.0) + EPS) / (fps or 30.0))
        if e2 - s2 >= frame - EPS:
            if out and abs(out[-1][1] - s2) < EPS:
                out[-1][1] = e2           # snapped shut: merge
            else:
                out.append([s2, e2])
    return [(round(s, 6), round(e, 6)) for s, e in out]


def build_timeline(words: list, keep: list, sources: dict, gap_cap: float = GAP_CAP,
                   min_saving: float = MIN_SAVING) -> Timeline:
    """sources: {sid: {"duration": float, "fps": float}}."""
    runs = merge_contiguous(words, resolve_ranges(words, keep))
    segments, words_out, first_pos = [], [], {}
    out = 0.0
    for n, (i0, i1) in enumerate(runs):
        src = words[i0]["source"]
        meta = sources.get(src) or {}
        fps = float(meta.get("fps") or 30.0)
        pieces = plan_run(words, i0, i1, gap_cap, min_saving, fps, float(meta.get("duration") or 0.0),
                          is_first=(n == 0), is_last=(n == len(runs) - 1))
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

        for i in range(i0, i1 + 1):
            w = words[i]
            os_, oe = map_t(w["s"]), map_t(w["e"])
            oe = max(oe, os_ + 0.01)
            words_out.append({"id": w["id"], "w": w["w"], "s": round(os_, 4), "e": round(oe, 4),
                              "source": src})
            first_pos.setdefault(w["id"], (round(os_, 4), round(oe, 4)))
        run_segs[0].first_word = words[i0]["id"]
        run_segs[-1].last_word = words[i1]["id"]
        segments.extend(run_segs)
    index = {w["id"]: i for i, w in enumerate(words)}
    kept_index = sorted({index[wid] for wid in first_pos})
    return Timeline(segments=segments, duration=round(out, 6), words_out=words_out,
                    first_pos=first_pos, kept_index=kept_index, index=index, words=words)


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
