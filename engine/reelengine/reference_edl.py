"""A CMX 3600 edit list (.edl), as DaVinci Resolve, Premiere Pro and Avid export one, read into the timeline record
reference_import.py returns for FCPXML (same keys, same `{value, rate}` times).

Written from the published CMX 3600 layout, not from a real Resolve export: event lines are
`NNN  REEL  TRACK  TRANS [DUR]  SRC-IN SRC-OUT REC-IN REC-OUT`, followed by `* FROM CLIP NAME:` comments, after a
`TITLE:` line and an `FCM:` line that says whether timecode drops frames. A dissolve is two lines with one event
number: the outgoing clip's last frame (no length) and the incoming clip with `D` and the dissolve's length in
frames.

An EDL never says its frame rate. Drop-frame timecode is 29.97; otherwise the rate is the smallest common one
above every frame number the list uses (frames 0-23 read as 24 fps, a 24 makes it 25, 25-29 make it 30), and
`losses` says so. On a short list that never reaches a high frame number this can read a 30 fps edit as 24 fps,
which makes every shot 25% longer than it was.
"""
from __future__ import annotations

import re
from fractions import Fraction
from pathlib import PurePosixPath, PureWindowsPath

from .proto import EngineError

_TC = r"(\d{2}):(\d{2}):(\d{2})([:;.])(\d{2})"
_EVENT = re.compile(
    rf"^(\d{{1,6}})\s+(\S+)\s+(\S+)\s+(C|D|W\d{{3}}|K[BO]?)\s+(?:(\d{{1,4}})\s+)?{_TC}\s+{_TC}\s+{_TC}\s+{_TC}\s*$")
_RATES = (24, 25, 30, 50, 60)
_USER = ("This edit list (EDL) isn't one Reel Studio can read. Export it again from your editor as a CMX 3600 EDL "
         "and try once more.")


def _fail(detail: str) -> EngineError:
    return EngineError("BAD_EDL", detail, _USER)


def _url(path: str) -> str | None:
    for cls in (PurePosixPath, PureWindowsPath):
        p = cls(path)
        if p.is_absolute():
            return p.as_uri()
    return None


class _Clock:
    def __init__(self, drop: bool, frames_seen: int):
        self.drop = drop
        if drop:
            self.rate, self.base = Fraction(30000, 1001), 30
        else:
            self.base = next((r for r in _RATES if r > frames_seen), None)
            if self.base is None:
                raise _fail(f"frame number {frames_seen} is past every rate an EDL is cut at")
            self.rate = Fraction(self.base)

    def frames(self, h: int, m: int, s: int, f: int) -> int:
        if f >= self.base:
            raise _fail(f"frame {f} at {self.base} fps")
        n = (h * 3600 + m * 60 + s) * self.base + f
        if self.drop:
            # 29.97 drop-frame skips frame numbers 0 and 1 each minute except every tenth
            minutes = h * 60 + m
            n -= 2 * (minutes - minutes // 10)
        return n


def _time(n: int, rate: Fraction) -> dict:
    return {"value": float(n), "rate": float(rate)}


def read(data: bytes) -> dict:
    """{timelines, losses, rawMetadata} with one timeline, or BAD_EDL / NO_TIMELINE."""
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = data.decode("latin-1")
    title, drop, events, losses = None, None, [], []
    for n, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line:
            continue
        upper = line.upper()
        if upper.startswith("TITLE:"):
            title = line[6:].strip() or None
        elif upper.startswith("FCM:"):
            drop = "NON" not in upper and "DROP" in upper
        elif line.startswith("*"):
            body = line[1:].strip()
            key, _, value = body.partition(":")
            key, value = key.strip().upper(), value.strip()
            if events and key in ("FROM CLIP NAME", "TO CLIP NAME", "SOURCE FILE"):
                group = [e for e in events if e["event"] == events[-1]["event"]]
                target = group[0] if key == "FROM CLIP NAME" else group[-1]
                target["file" if key == "SOURCE FILE" else "name"] = value
        elif upper.startswith("M2 "):
            losses.append({"path": f"line {n}", "reason": "a speed change (M2) is not read; the clip keeps its length on the timeline"})
        elif _EVENT.match(line):
            m = _EVENT.match(line)
            tcs = [tuple(int(x) for x in m.group(i, i + 1, i + 2, i + 4)) for i in (6, 11, 16, 21)]
            sep = {m.group(i) for i in (9, 14, 19, 24)}
            events.append({"event": m.group(1), "reel": m.group(2), "track": m.group(3).upper(), "trans": m.group(4),
                           "dur": int(m.group(5)) if m.group(5) else 0, "tcs": tcs, "semicolon": ";" in sep, "line": n})
        elif re.match(r"^\d", line):
            raise _fail(f"line {n} starts like an event but isn't one: {line[:80]!r}")
        elif events:
            losses.append({"path": f"line {n}", "reason": f"not read: {line[:60]}"})
    if not events:
        raise EngineError("NO_TIMELINE", "no events in the EDL",
                          "This edit list has no clips in it. Export the timeline itself and try again.")
    drop = drop if drop is not None else any(e["semicolon"] for e in events)
    clock = _Clock(drop, max(tc[3] for e in events for tc in e["tcs"]))
    if not drop:
        losses.append({"path": "timelines[0]", "reason": f"an EDL does not say its frame rate; read as {clock.base} fps, "
                       "the lowest common rate its frame numbers allow"})
    rate = clock.rate
    for e in events:
        e["src"], e["rec"] = [clock.frames(*tc) for tc in e["tcs"][:2]], [clock.frames(*tc) for tc in e["tcs"][2:]]
        if e["rec"][1] < e["rec"][0] or e["src"][1] < e["src"][0]:
            raise _fail(f"line {e['line']}: an out point before its in point")
    start = min(e["rec"][0] for e in events)
    tracks: dict[str, dict] = {}
    for e in events:
        if e["rec"][1] == e["rec"][0]:
            continue  # the outgoing side of a dissolve: its frames are the incoming line's
        field = e["track"]
        video, audio = "V" in field or field == "B", "A" in field or field == "B"
        kinds = (["Video"] if video else []) + (["Audio"] if audio else [])
        if not kinds:
            losses.append({"path": f"line {e['line']}", "reason": f"track {e['track']!r} is not video or audio; skipped"})
            continue
        if e["trans"].startswith("K"):
            losses.append({"path": f"line {e['line']}", "reason": "a key (K) layers one clip over another; the layer is not read"})
            continue
        for kind in kinds:
            # V2 is a second video track; A2 a second audio one; AA, B and A/V put the clip on both
            name = (field if re.fullmatch(r"V\d*", field) else "V") if kind == "Video" else (field if re.fullmatch(r"A\d*", field) else "A")
            track = tracks.setdefault(f"{kind}:{name}", {"name": name, "kind": kind, "items": []})
            if e["trans"] != "C" and e["dur"]:
                track["items"].append({"type": "transition", "name": "Dissolve" if e["trans"] == "D" else "Wipe",
                                       "transitionType": "SMPTE_Dissolve" if e["trans"] == "D" else e["trans"],
                                       "inOffset": _time(0, rate), "outOffset": _time(e["dur"], rate)})
            black = e["reel"].upper() in ("BL", "BLK", "BLACK")
            clip_name = e.get("name") or e["reel"]
            media = ({"kind": "generator", "generator": "Black", "name": clip_name} if black else
                     {"kind": "file", "url": _url(e["file"]) if e.get("file") else None, "name": clip_name})
            if not black and media["url"] is None:
                losses.append({"path": f"line {e['line']}", "reason": "an EDL names the clip, not the file it came from"})
            track["items"].append({
                "type": "clip", "name": clip_name, "effects": [], "markers": [], "media": media,
                "trackRange": {"start": _time(e["rec"][0] - start, rate), "duration": _time(e["rec"][1] - e["rec"][0], rate)},
                "sourceRange": {"start": _time(e["src"][0], rate), "duration": _time(e["src"][1] - e["src"][0], rate)},
            })
    order = sorted(tracks.values(), key=lambda t: (t["kind"] != "Video", t["name"]))
    losses.append({"path": "timelines[0]", "reason": "an EDL holds cuts, dissolves and wipes: titles, effects and "
                   "markers are not in it"})
    end = max(e["rec"][1] for e in events)
    timeline = {"name": title, "duration": _time(end - start, rate), "globalStart": _time(start, rate),
                "dropFrame": drop, "markers": [], "tracks": order}
    return {"timelines": [timeline], "losses": losses, "rawMetadata": []}
