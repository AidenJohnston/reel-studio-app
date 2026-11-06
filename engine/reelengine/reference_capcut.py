"""A CapCut project (its draft_content.json, or draft_info.json on a Mac) read into the timeline record
reference_import.py returns for FCPXML (same keys; times are `{value, rate}` in microseconds, rate 1000000).

CapCut publishes no format. This follows the layout the open readers and writers of these files agree on
(pyCapCut, capcut-cli's draft-schema notes), not a real export read here:
  tracks[]            lanes in draw order, the first at the bottom; type video, audio, text, sticker, effect, filter
  tracks[].segments[] material_id, target_timerange {start, duration} on the timeline and source_timerange in the
                      clip, both in microseconds; extra_material_refs to its speed, transition and other companions
  materials.videos[]  clips and pictures (type video or photo) with path and material_name
  materials.audios[]  music, voice and sound with path and name
  materials.texts[]   content, a JSON string holding {"text": ...}; type subtitle for CapCut's auto captions
  materials.transitions[] name and duration, between a segment and the next
The first video track is the main one, as Final Cut's primary storyline is. Effects, filters and stickers are
listed in `losses`, not read.

JianYing (CapCut's Chinese edition) 6.0 and later saves the file encrypted; that is refused as LOCKED_DRAFT
rather than read wrong.
"""
from __future__ import annotations

import json
import re
from pathlib import PurePosixPath, PureWindowsPath

from .proto import EngineError

RATE = 1_000_000
_BAD = ("This CapCut project isn't one Reel Studio can read. Open it in CapCut so it saves again, then try once "
        "more.")
_LOCKED = "This project is saved in a locked format only CapCut can open, so Reel Studio can't read it."
_SKIPPED = {"effect": "effects", "filter": "filters", "sticker": "stickers", "adjust": "adjustments"}


def _bad(detail: str) -> EngineError:
    return EngineError("BAD_DRAFT", detail, _BAD)


def parse(data: bytes, where: str) -> dict:
    """The draft as JSON, or LOCKED_DRAFT for an encrypted one (it doesn't start with `{`), BAD_DRAFT otherwise."""
    head = data.lstrip(b"\xef\xbb\xbf \t\r\n")[:1]
    if head != b"{":
        raise EngineError("LOCKED_DRAFT", f"{where} is not plain JSON (encrypted?)", _LOCKED)
    try:
        draft = json.loads(data.decode("utf-8-sig"))
    except (UnicodeDecodeError, ValueError, RecursionError) as exc:
        raise _bad(f"{where}: {type(exc).__name__}: {str(exc)[:200]}")
    if not isinstance(draft, dict) or not isinstance(draft.get("tracks"), list) or not isinstance(draft.get("materials"), dict):
        raise _bad(f"{where} has no tracks list and materials table")
    return draft


def _us(value, what: str) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0:
        raise _bad(f"{what} is not a time in microseconds: {value!r}")
    return int(value)


def _range(r, what: str) -> dict | None:
    if r is None:
        return None
    if not isinstance(r, dict):
        raise _bad(f"{what} is not a time range")
    return {"start": {"value": float(_us(r.get("start", 0), f"{what}.start")), "rate": RATE},
            "duration": {"value": float(_us(r.get("duration"), f"{what}.duration")), "rate": RATE}}


def _url(path) -> str | None:
    if not isinstance(path, str) or not path:
        return None
    for cls in (PurePosixPath, PureWindowsPath):
        p = cls(path)
        if p.is_absolute():
            return p.as_uri()
    return None  # a template's "##_draftpath_placeholder_…" or a relative path: named, not located


def _text(material: dict) -> str:
    content = material.get("content")
    if isinstance(content, str):
        try:
            body = json.loads(content)
            if isinstance(body, dict) and isinstance(body.get("text"), str):
                return body["text"]
        except ValueError:
            pass
        # older builds keep rich text as markup: <font ...>[Hello]</font>
        return re.sub(r"<[^>]*>|^\[|\]$", "", content).strip()
    return str(material.get("text") or "")


def _table(draft: dict, kind: str) -> dict:
    rows = draft["materials"].get(kind) or []
    if not isinstance(rows, list):
        raise _bad(f"materials.{kind} is not a list")
    return {m["id"]: m for m in rows if isinstance(m, dict) and isinstance(m.get("id"), str)}


def read(draft: dict, name: str | None) -> dict:
    """{timelines, losses, rawMetadata} with the draft's one timeline; `name` is the project folder's name."""
    videos, audios, texts = _table(draft, "videos"), _table(draft, "audios"), _table(draft, "texts")
    transitions = _table(draft, "transitions")
    losses, tracks, counts = [], [], {"video": 0, "audio": 0, "text": 0}
    end = 0
    for t, track in enumerate(draft["tracks"]):
        if not isinstance(track, dict) or not isinstance(track.get("segments"), list):
            raise _bad(f"tracks[{t}] has no segments list")
        kind = track.get("type")
        if kind in _SKIPPED:
            if track["segments"]:
                losses.append({"path": f"tracks[{t}]", "reason": f"CapCut {_SKIPPED[kind]} are not read"})
            continue
        if kind not in ("video", "audio", "text", "subtitle"):
            losses.append({"path": f"tracks[{t}]", "reason": f"a {kind!r} track is not read"})
            continue
        out_kind = "Audio" if kind == "audio" else "Video"
        items = []
        segments = []
        for s, seg in enumerate(track["segments"]):
            sw = f"tracks[{t}].segments[{s}]"
            if not isinstance(seg, dict):
                raise _bad(f"{sw} is not an object")
            target = _range(seg.get("target_timerange"), f"{sw}.target_timerange")
            if target is None:
                raise _bad(f"{sw} has no target_timerange")
            segments.append((sw, seg, target))
        segments.sort(key=lambda x: x[2]["start"]["value"])
        for k, (sw, seg, target) in enumerate(segments):
            if seg.get("visible") is False:
                losses.append({"path": sw, "reason": "hidden in CapCut; left out"})
                continue
            end = max(end, int(target["start"]["value"] + target["duration"]["value"]))
            mid = seg.get("material_id")
            if kind == "video":
                m = videos.get(mid)
                media = ({"kind": "missing", "name": None} if m is None else
                         {"kind": "file", "url": _url(m.get("path")), "name": m.get("material_name") or None})
            elif kind == "audio":
                m = audios.get(mid)
                media = ({"kind": "missing", "name": None} if m is None else
                         {"kind": "file", "url": _url(m.get("path")), "name": m.get("name") or None})
            else:
                m = texts.get(mid)
                said = _text(m) if m else ""
                # auto captions are not a title the person put on screen
                caption = kind == "subtitle" or (m or {}).get("type") in ("subtitle", "lyrics")
                media = ({"kind": "missing", "name": None} if m is None else
                         {"kind": "generator", "generator": "Captions" if caption else "Text",
                          "name": "Captions" if caption else said[:80] or None})
            if m is None:
                losses.append({"path": f"{sw}.material_id", "reason": "no material with this id; the clip's media is unknown"})
            elif media["kind"] == "file" and media["url"] is None:
                losses.append({"path": f"{sw}.media", "reason": "the clip's file is not a full path"})
            items.append({"type": "clip", "name": media.get("name"), "effects": [], "markers": [], "media": media,
                          "trackRange": target, "sourceRange": _range(seg.get("source_timerange"), f"{sw}.source_timerange")})
            refs = seg.get("extra_material_refs") if isinstance(seg.get("extra_material_refs"), list) else []
            joined = next((transitions[r] for r in refs if r in transitions), None)
            if joined is not None and k < len(segments) - 1:
                half = float(_us(joined.get("duration", 0), f"{sw} transition duration")) / 2
                items.append({"type": "transition", "name": joined.get("name") or "Transition", "transitionType": None,
                              "inOffset": {"value": half, "rate": RATE}, "outOffset": {"value": half, "rate": RATE}})
            if isinstance(seg.get("speed"), (int, float)) and seg["speed"] != 1:
                losses.append({"path": sw, "reason": f"played at {seg['speed']}x; its source range covers that"})
        # video lanes are "0", "1"... so the first is the main one (learn-style.ts mainTrack); text lanes "T1"...
        lane = "video" if kind == "video" else "audio" if kind == "audio" else "text"
        tracks.append({"name": {"video": str(counts[lane]), "audio": f"A{counts[lane] + 1}", "text": f"T{counts[lane] + 1}"}[lane],
                       "kind": out_kind, "items": items})
        counts[lane] += 1
    duration = draft.get("duration")
    duration = _us(duration, "duration") if duration is not None else end
    timeline = {"name": (draft.get("name") or name or None), "duration": {"value": float(duration), "rate": RATE},
                "globalStart": None, "dropFrame": None, "markers": [], "tracks": tracks}
    return {"timelines": [timeline], "losses": losses, "rawMetadata": []}


def writer(draft: dict) -> str:
    return "JianYing" if (draft.get("platform") or {}).get("app_source") == "lv" else "CapCut"


def version(draft: dict) -> str | None:
    v = draft.get("new_version") or draft.get("version")
    return None if v is None else str(v)
