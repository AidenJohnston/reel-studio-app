"""`import-reference <file> [--output F]`: read a Final Cut Pro (.fcpxml, .fcpxmld) or Premiere
FCP7 (.xml) export through OpenTimelineIO into an evidence-only timeline record.

Nothing here writes project.json or My style.json. A clean parse is not proof the edit survived:
`losses` lists the gaps this module knows the pinned adapters have (elements and attributes they
never read, media they can't find, projects they skip, nested sequences they return empty). It is
not proof that nothing else was dropped. `rawMetadata` keeps what the adapters hold only as
metadata, once per source id.

FCPXML timing is computed here from the source in exact fractions of a second, because
otio-fcpx-xml-adapter 1.0.0 rounds frame rates down (29.97 becomes 29) and truncates times to whole
frames, which shifts clips and invents gaps. The adapter still decides which clips exist and on
which lane.

The adapters run in a child process with a time and memory limit: their lookups and copies can grow
far faster than the file, and the cheap size checks here can't model all of it. OpenTimelineIO, its
adapters and psutil are the optional `reference` extra (pyproject.toml).
"""
from __future__ import annotations

import hashlib
import json
import multiprocessing
import os
import stat
import time
import traceback
import xml.etree.ElementTree as ET
from collections import Counter
from fractions import Fraction
from pathlib import Path
from xml.parsers import expat

from .project import write_json
from .proto import EngineError

MAX_FILE_BYTES = 64 * 1024 * 1024
MAX_BUNDLE_BYTES = 256 * 1024 * 1024
MAX_BUNDLE_FILES = 4096
MAX_XML_DEPTH = 256
# Both adapters rebuild a referenced definition (an FCPXML compound clip, a Premiere `<file id>`)
# for every reference, so a small file can expand without bound. These cap what they would build.
MAX_EXPANDED_CLIPS = 50_000
MAX_EXPANDED_ELEMENTS = 2_000_000
MAX_EXPANDED_BYTES = 512 * 1024 * 1024
MAX_EXPANDED_DEPTH = 2 * MAX_XML_DEPTH
ADAPTER_SECONDS = 60.0
ADAPTER_MEMORY_BYTES = 2 * 1024 * 1024 * 1024

# Elements otio-fcpx-xml-adapter 1.0.0 looks at (fcpx_xml.py FcpxXml). Anything else in the
# source never reaches OTIO.
FCPX_READ = frozenset({
    "fcpxml", "resources", "format", "asset", "media", "library", "event", "project", "sequence",
    "spine", "asset-clip", "ref-clip", "clip", "gap", "video", "audio", "marker", "metadata", "md",
    "note", "keyword",
})
_FCPX_COMPOSABLE = ("video", "audio", "ref-clip", "asset-clip")   # fcpx_xml.COMPOSABLE_ELEMENTS
_FCPX_TIMING = ("clip", "asset-clip", "ref-clip")                 # FcpxXml._timing_clip
_FCPX_CLIP_METADATA = ("metadata", "md", "note", "keyword")

_AGAIN = "Export it again from your editor and try once more."
_USER = {
    "BAD_INPUT": "Choose a Final Cut Pro (.fcpxml or .fcpxmld) or Premiere (.xml) export.",
    "UNSAFE_INPUT": f"This Final Cut bundle contains a link to another file or folder. {_AGAIN}",
    "UNSAFE_XML": f"This export has extra XML declarations Reel Studio won't read. {_AGAIN}",
    "BAD_XML": f"This file isn't a readable edit export. {_AGAIN}",
    "INPUT_TOO_LARGE": "This export is too large to import. Export just the one project or sequence "
                       "you want and try again.",
    "NO_TIMELINE": "This export has no timeline in it. In your editor, export the project or sequence "
                   "itself, not just its clips, and try again.",
    "TIMELINE_SKIPPED": "Reel Studio can only read the first event in a Final Cut Pro export, and the "
                        "timeline in this one is somewhere else. In Final Cut Pro, export just the "
                        "project and try again.",
    "ADAPTER_MISSING": "Importing an edit from another app isn't available in this version of Reel Studio.",
    "OTIO_READ_FAILED": f"Reel Studio couldn't read this edit. {_AGAIN}",
}


def _fail(code: str, detail: str) -> EngineError:
    return EngineError(code, detail, _USER[code])


def _read_file(path: Path) -> bytes:
    try:
        if path.stat().st_size > MAX_FILE_BYTES:
            raise _fail("INPUT_TOO_LARGE", f"input exceeds {MAX_FILE_BYTES} bytes: {path}")
        return path.read_bytes()
    except OSError as exc:
        raise _fail("BAD_INPUT", f"cannot read {path}: {exc}")


def _is_reparse_point(path: Path) -> bool:
    try:
        info = path.lstat()
    except OSError:
        return False
    return bool(getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT)


def _bundle_files(bundle: Path) -> list[Path]:
    files, total, folders = [], 0, [bundle]
    try:
        while folders:
            with os.scandir(folders.pop()) as entries:
                for entry in entries:
                    info = entry.stat(follow_symlinks=False)
                    # Python 3.11 doesn't report a Windows junction as a symlink; it is a reparse point.
                    if entry.is_symlink() or getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT:
                        raise _fail("UNSAFE_INPUT", f"link inside bundle: {entry.path}")
                    if entry.is_dir(follow_symlinks=False):
                        folders.append(Path(entry.path))
                        continue
                    files.append(Path(entry.path))
                    total += info.st_size
                    if len(files) > MAX_BUNDLE_FILES:
                        raise _fail("INPUT_TOO_LARGE", f"bundle has more than {MAX_BUNDLE_FILES} files")
                    if total > MAX_BUNDLE_BYTES:
                        raise _fail("INPUT_TOO_LARGE", f"bundle exceeds {MAX_BUNDLE_BYTES} bytes")
    except OSError as exc:
        raise _fail("BAD_INPUT", f"cannot read bundle {bundle}: {exc}")
    return sorted(files)


def _load(path: Path) -> tuple[bytes, str, str]:
    """The XML bytes to parse, the adapter name, and a sha256 of the whole input."""
    suffix = path.suffix.lower()
    if suffix == ".fcpxmld":
        if path.is_symlink() or _is_reparse_point(path) or not path.is_dir():
            raise _fail("BAD_INPUT", f"FCPXML bundle is not a folder: {path}")
        files = _bundle_files(path)
        info = path / "Info.fcpxml"
        if info not in files:
            candidates = [f for f in files if f.parent == path and f.suffix.lower() == ".fcpxml"]
            if len(candidates) != 1:
                raise _fail("BAD_INPUT", f"bundle has no Info.fcpxml: {path}")
            info = candidates[0]
        digest, data = hashlib.sha256(), b""
        for f in files:
            body = _read_file(f)
            digest.update(f.relative_to(path).as_posix().encode())
            digest.update(body)
            if f == info:
                data = body
        return data, "fcpx_xml", digest.hexdigest()
    if suffix not in {".fcpxml", ".xml"}:
        raise _fail("BAD_INPUT", f"unsupported input: {path}")
    data = _read_file(path)
    return data, "fcpx_xml" if suffix == ".fcpxml" else "fcp_xml", hashlib.sha256(data).hexdigest()


def _parse(data: bytes, path: Path) -> ET.Element:
    """Refuse what ElementTree would expand, then parse.

    Both adapters parse with ElementTree, which expands entities declared in a DOCTYPE's internal
    subset. Expat here reads the same bytes with the same encoding detection, so such a DOCTYPE is
    refused before anything expands it. A bare `<!DOCTYPE fcpxml>` or `<!DOCTYPE xmeml>`, which
    real exports start with, is fine. The nesting cap keeps the recursive code here and in the
    adapters far from Python's recursion limit."""
    parser = expat.ParserCreate()
    depth = 0

    def doctype(_name, _system_id, _public_id, has_internal_subset):
        if has_internal_subset:
            raise _fail("UNSAFE_XML", f"DOCTYPE declarations are not allowed: {path}")

    def start(_name, _attrs):
        nonlocal depth
        depth += 1
        if depth > MAX_XML_DEPTH:
            raise _fail("INPUT_TOO_LARGE", f"XML nests deeper than {MAX_XML_DEPTH}: {path}")

    def end(_name):
        nonlocal depth
        depth -= 1

    parser.StartDoctypeDeclHandler = doctype
    parser.StartElementHandler = start
    parser.EndElementHandler = end
    try:
        parser.Parse(data, True)
    except expat.ExpatError as exc:
        raise _fail("BAD_XML", f"{path}: {exc}")
    return ET.fromstring(data)


def _own_bytes(e: ET.Element) -> int:
    return len(e.tag) + len(e.text or "") + len(e.tail or "") + sum(len(k) + len(v) for k, v in e.attrib.items())


def _check_expansion(clips: int, elements: int, size: int) -> None:
    if clips > MAX_EXPANDED_CLIPS or elements > MAX_EXPANDED_ELEMENTS or size > MAX_EXPANDED_BYTES:
        raise _fail("INPUT_TOO_LARGE", f"references expand to {clips} clips, {elements} elements, {size} bytes")


def _fcp7_expanded(root: ET.Element) -> tuple[int, int, int]:
    """(clips, elements, bytes) the fcp_xml adapter would build. It swaps every element that has an
    id for the first element it met with that id (FCP7XMLParser._derefed_element), so each
    `<file id="f"/>` stands for the whole definition. The largest element with an id is charged for
    all of them, which bounds whichever one the adapter happened to meet first."""
    by_id: dict[str, list[ET.Element]] = {}
    for e in root.iter():
        if "id" in e.attrib:
            by_id.setdefault(e.get("id"), []).append(e)
    memo: dict[str, tuple[int, int, int]] = {}
    open_ids: set[str] = set()

    def own(e: ET.Element, depth: int) -> tuple[int, int, int]:
        if depth > MAX_EXPANDED_DEPTH:
            raise _fail("INPUT_TOO_LARGE", "id references nest too deeply")
        clips, elements, size = int(e.tag in ("clipitem", "generatoritem")), 1, _own_bytes(e)
        for child in e:
            c, n, b = resolved(child, depth + 1)
            clips, elements, size = clips + c, elements + n, size + b
        return clips, elements, size

    def resolved(e: ET.Element, depth: int) -> tuple[int, int, int]:
        key = e.get("id")
        if key is None:
            return own(e, depth)
        if key not in memo:
            if key in open_ids:
                raise _fail("BAD_XML", f"element with id {key!r} contains itself")
            open_ids.add(key)
            costs = [own(d, depth) for d in by_id[key]]
            open_ids.discard(key)
            memo[key] = tuple(max(cost[i] for cost in costs) for i in range(3))
        return memo[key]

    return resolved(root, 0)


def _secs(value: str | None) -> Fraction:
    if value is None:
        return Fraction(0)
    try:
        return Fraction(value.removesuffix("s"))
    except (ValueError, ZeroDivisionError):
        raise _fail("BAD_XML", f"bad FCPXML time: {value!r}")


def _frames(seconds: Fraction, rate: Fraction) -> dict:
    return {"value": float(seconds * rate), "rate": float(rate)}


class _Fcpx:
    """The source side of an FCPXML document, walked the way otio-fcpx-xml-adapter 1.0.0 walks it."""

    def __init__(self, root: ET.Element):
        self.root = root
        self.parent: dict[ET.Element, ET.Element] = {}
        self.owner: dict[ET.Element, ET.Element | None] = {root: None}
        self.markers: dict[ET.Element, list[ET.Element]] = {}
        for e in root.iter():
            for child in e:
                self.parent[child] = e
            if e is not root:
                self.owner[e] = e if e.tag in _FCPX_TIMING else self.owner[self.parent[e]]
            if e.tag == "marker" and self.owner[e] is not None:
                self.markers.setdefault(self.owner[e], []).append(e)
            if e.get("lane") is not None:
                try:
                    int(e.get("lane"))
                except ValueError:
                    raise _fail("BAD_XML", f"lane is not a whole number: {e.get('lane')!r}")
        self.formats, self.assets, self.media = {}, {}, {}
        for tag, table in (("format", self.formats), ("asset", self.assets), ("media", self.media)):
            for e in root.iterfind(f"resources/{tag}"):
                table.setdefault(e.get("id"), e)

    def projects(self) -> list[ET.Element]:
        """The projects FcpxXml.to_otio reads: those of the first event in a library, of the first
        top-level event, or the first top-level project."""
        if self.root.find("library") is not None:
            event = self.root.find("library/event")
            return [] if event is None else event.findall("project")
        if self.root.find("event") is not None:
            return self.root.find("event").findall("project")
        return self.root.findall("project")[:1]

    def skipped(self, projects: list[ET.Element]) -> list[ET.Element]:
        read = set(projects)
        return [p for p in self.root.iter("project") if p not in read]

    def timing_clip(self, e: ET.Element) -> ET.Element:
        owner = self.owner[e]
        if owner is None:
            raise _fail("BAD_XML", "a video or audio element is outside any clip")
        return owner

    def rate(self, format_id: str | None) -> Fraction:
        fmt = self.formats.get(format_id)
        if fmt is None or fmt.get("frameDuration") is None:
            raise _fail("BAD_XML", f"format {format_id!r} has no frameDuration")
        return 1 / _secs(fmt.get("frameDuration"))

    def format_id(self, e: ET.Element, default: str | None) -> str | None:
        ref = e.get("ref")
        if not ref or e.tag == "gap":
            return default
        resource = self.assets.get(ref)
        if resource is None:
            resource = self.media[ref].find("sequence")
        return resource.get("format", default)

    def _adapter_frames(self, value: str | None, format_id: str | None) -> int:
        """FcpxXml._number_of_frames, float arithmetic and truncation included."""
        if value == "0s" or value is None:
            return 0
        total, rate = self.formats[format_id].get("frameDuration").split("/")
        fps = float(rate.replace("s", "")) / float(total)
        parts = value.split("/")
        if len(parts) > 1:
            return int((float(parts[0]) / float(parts[1].replace("s", ""))) * fps)
        return int(int(parts[0].replace("s", "")) * fps)

    def _adapter_fps(self, format_id: str | None) -> int:
        total, rate = self.formats[format_id].get("frameDuration").split("/")
        return int(float(rate.replace("s", "")) / float(total))

    def expanded(self, projects: list[ET.Element]) -> tuple[int, int, int]:
        """(clips, elements, bytes) the adapter would build. Each ref-clip rebuilds its compound
        clip; each clip copies every marker below its timing clip and the metadata of the event clip
        with the same ref (FcpxXml._build_composable, _reference_from_id)."""
        size: dict[ET.Element, tuple[int, int]] = {}
        marked: dict[ET.Element, tuple[int, int]] = {}

        def measure(e: ET.Element) -> None:
            n, b = 1, _own_bytes(e)
            mn = mb = 0
            for child in e:
                measure(child)
                n, b = n + size[child][0], b + size[child][1]
                mn, mb = mn + marked[child][0], mb + marked[child][1]
            size[e] = (n, b)
            marked[e] = (n, b) if e.tag == "marker" else (mn, mb)

        measure(self.root)
        holder = self.root.find("event")
        copied: dict[str, tuple[int, int]] = {}
        for clip in (self.root if holder is None else holder).findall("asset-clip"):
            copied.setdefault(clip.get("ref"), size[clip])
        memo: dict[str, tuple[int, int, int]] = {}
        open_ids: set[str] = set()

        def sequence(seq: ET.Element, depth: int) -> tuple[int, int, int]:
            clips, (elements, nbytes) = 0, size[seq]
            for c in seq.iter():
                if c.tag not in _FCPX_COMPOSABLE:
                    continue
                m, k = marked[self.timing_clip(c)], copied.get(c.get("ref"), (0, 0))
                clips, elements, nbytes = clips + 1, elements + m[0] + k[0], nbytes + m[1] + k[1]
                if c.tag == "ref-clip":
                    mc, me, mb = compound(c.get("ref"), depth + 1)
                    clips, elements, nbytes = clips + mc, elements + me, nbytes + mb
            return clips, elements, nbytes

        def compound(key: str, depth: int) -> tuple[int, int, int]:
            if key not in memo:
                if key in open_ids:
                    raise _fail("BAD_XML", f"compound clip {key!r} contains itself")
                if depth > MAX_EXPANDED_DEPTH:
                    raise _fail("INPUT_TOO_LARGE", "compound clips nest too deeply")
                seq = self.media[key].find("sequence") if key in self.media else None
                open_ids.add(key)
                memo[key] = (0, 0, 0) if seq is None else sequence(seq, depth)
                open_ids.discard(key)
            return memo[key]

        totals = [sequence(p.find("sequence"), 0) for p in projects if p.find("sequence") is not None]
        return tuple(sum(t[i] for t in totals) for i in range(3))

    def lanes(self, project: ET.Element) -> dict[str, list[dict]]:
        """Each lane's clips in the adapter's order, with exact timing.

        The adapter orders a lane by its own truncated frame offset in each clip's frame rate
        (FcpxXml._offset_and_lane, _sorted_items), which differs from the exact order when rates
        mix; pairing with its clips needs the same order. Positions follow the adapter's rule,
        which is right for the primary storyline and clips connected to it; deeper clips are
        marked `approximate`."""
        seq = project.find("sequence")
        seq_format = seq.get("format")
        seq_rate = self.rate(seq_format)
        primary = seq.find("spine")
        lanes: dict[str, list[dict]] = {}
        for c in seq.iter():
            if c.tag not in _FCPX_COMPOSABLE:
                continue
            clip_format = self.format_id(c, seq_format)
            t = self.timing_clip(c)
            parent = self.parent[t]
            parent_format = self.format_id(parent, seq_format)
            if parent.tag == "spine" and parent.get("lane"):
                lane, anchor, in_spine = parent.get("lane"), self.parent[parent], True
            else:
                lane, anchor, in_spine = t.get("lane", "0"), parent, False
            parent_start = 0 if in_spine else _secs(anchor.get("start"))
            offset = _secs(t.get("offset")) - parent_start + _secs(anchor.get("offset"))
            adapter_frames = (self._adapter_frames(t.get("offset"), clip_format)
                              - (0 if in_spine else self._adapter_frames(anchor.get("start"), parent_format))
                              + self._adapter_frames(anchor.get("offset"), parent_format))
            rate = self.rate(clip_format)
            start, duration = _secs(t.get("start")), _secs(t.get("duration"))
            name = self.media[c.get("ref")].get("name") if c.tag == "ref-clip" else t.get("name")
            lanes.setdefault(lane, []).append({
                "name": name, "offset": offset,
                "adapterOrder": Fraction(adapter_frames, self._adapter_fps(clip_format)),
                "trackRange": {"start": _frames(offset, seq_rate), "duration": _frames(duration, seq_rate)},
                "sourceRange": {"start": _frames(start, rate), "duration": _frames(duration, rate)},
                "markers": [{"name": m.get("value"), "color": None, "comment": m.get("note"),
                             "range": {"start": _frames(_secs(m.get("start")), rate),
                                       "duration": _frames(_secs(m.get("duration")), rate)}}
                            for m in self.markers.get(t, [])],
                "approximate": not (parent is primary or (parent.tag != "spine" and self.parent.get(parent) is primary)),
            })
        for clips in lanes.values():
            clips.sort(key=lambda clip: clip["adapterOrder"])
        return lanes

    def global_start(self, project: ET.Element) -> tuple[dict, bool]:
        seq = project.find("sequence")
        return _frames(_secs(seq.get("tcStart")), self.rate(seq.get("format"))), seq.get("tcFormat") == "DF"

    def losses(self, projects: list[ET.Element]) -> list[dict]:
        out = []
        for tag, count in sorted(Counter(e.tag for e in self.root.iter()).items()):
            if tag not in FCPX_READ:
                out.append({"path": "source", "element": tag, "count": count,
                            "reason": "the fcpx_xml adapter does not read this element"})
        skipped = self.skipped(projects)
        if skipped:
            out.append({"path": "source", "projects": [p.get("name") for p in skipped], "count": len(skipped),
                        "reason": "the fcpx_xml adapter reads only the first event's projects, or the first "
                                  "top-level project; these were skipped"})
        in_projects = [e for p in projects for e in p.iter()]
        for tag, count in sorted(Counter(e.tag for e in in_projects if e.tag in _FCPX_CLIP_METADATA).items()):
            out.append({"path": "source", "element": tag, "count": count,
                        "reason": "the fcpx_xml adapter reads clip metadata only from event clips, "
                                  "not from clips in a project"})
        checks = (('enabled="0"', lambda e: e.get("enabled") == "0",
                   "disabled in the editor but imported as enabled"),
                  ("audioStart/audioDuration", lambda e: "audioStart" in e.attrib or "audioDuration" in e.attrib,
                   "split audio edit (J or L cut); the imported audio follows the video"))
        for attribute, matches, reason in checks:
            count = sum(1 for e in in_projects if matches(e))
            if count:
                out.append({"path": "source", "attribute": attribute, "count": count, "reason": reason})
        return out


def _fcp7_losses(root: ET.Element) -> list[dict]:
    disabled = sum(1 for e in root.iter() if e.tag in ("clipitem", "generatoritem")
                   and (e.findtext("enabled") or "").upper() == "FALSE")
    if not disabled:
        return []
    return [{"path": "source", "attribute": "<enabled>FALSE</enabled>", "count": disabled,
             "reason": "disabled in the editor but imported as enabled"}]


def _time(t) -> dict | None:
    return None if t is None else {"value": t.value, "rate": t.rate}


def _range(r) -> dict | None:
    return None if r is None else {"start": _time(r.start_time), "duration": _time(r.duration)}


class _Record:
    def __init__(self, otio):
        self.otio = otio
        self.losses: list[dict] = []
        self.raw: list[dict] = []
        self.raw_by_id: dict[str, dict] = {}

    def keep_raw(self, obj, where: str) -> None:
        metadata = obj.metadata
        if not metadata:
            return
        source_id = metadata.get("fcp_xml", {}).get("@id")
        if source_id in self.raw_by_id:
            self.raw_by_id[source_id]["paths"].append(where)
            return
        plain = json.loads(self.otio.core.serialize_json_to_string(metadata))
        plain = {namespace: value for namespace, value in plain.items() if value != {}}
        if not plain:
            return
        entry = {"id": source_id, "paths": [where], "metadata": plain}
        self.raw.append(entry)
        if source_id is not None:
            self.raw_by_id[source_id] = entry

    def markers(self, owner, where: str) -> list[dict]:
        out = []
        for i, m in enumerate(owner.markers):
            self.keep_raw(m, f"{where}.markers[{i}]")
            out.append({"name": m.name, "color": m.color, "comment": m.comment, "range": _range(m.marked_range)})
        return out

    def media(self, ref, where: str) -> dict:
        self.keep_raw(ref, where)
        schema = self.otio.schema
        if isinstance(ref, schema.ExternalReference):
            return {"kind": "file", "url": ref.target_url, "name": ref.name,
                    "availableRange": _range(ref.available_range)}
        if isinstance(ref, schema.GeneratorReference):
            return {"kind": "generator", "generator": ref.generator_kind, "name": ref.name}
        self.losses.append({"path": where, "reason": "the adapter found no media for this clip"})
        return {"kind": "missing", "name": ref.name or None}

    def items(self, track, where: str, timing: list[dict] | None) -> list[dict]:
        schema = self.otio.schema
        ranges = track.range_of_all_children()
        kept = [item for item in track if not isinstance(item, schema.Gap)]
        if timing is None:
            pairs = [(item, None) for item in kept]
        else:
            if [t["name"] for t in timing] != [item.name for item in kept]:
                raise _fail("OTIO_READ_FAILED", f"{where}: the FCPXML walk and the fcpx_xml adapter disagree on clips")
            pairs = sorted(zip(kept, timing), key=lambda pair: pair[1]["offset"])
        out = []
        for n, (item, source) in enumerate(pairs):
            iw = f"{where}.items[{n}]"
            self.keep_raw(item, iw)
            if isinstance(item, schema.Transition):
                out.append({"type": "transition", "name": item.name, "transitionType": item.transition_type,
                            "inOffset": _time(item.in_offset), "outOffset": _time(item.out_offset)})
                continue
            entry = {"type": "clip" if isinstance(item, schema.Clip) else "stack", "name": item.name}
            if source is None:
                entry.update(trackRange=_range(ranges[item]), sourceRange=_range(item.source_range),
                             markers=self.markers(item, iw))
            else:
                entry.update(trackRange=source["trackRange"], sourceRange=source["sourceRange"],
                             markers=source["markers"])
                if source["approximate"]:
                    self.losses.append({"path": iw, "reason": "clip sits deeper than one connection from the "
                                        "primary storyline; its position follows the adapter's rule and may be off"})
            entry["effects"] = []
            for k, e in enumerate(item.effects):
                self.keep_raw(e, f"{iw}.effects[{k}]")
                entry["effects"].append({"name": e.name, "effect": e.effect_name})
            if isinstance(item, schema.Clip):
                entry["media"] = self.media(item.media_reference, f"{iw}.media")
            elif len(item) == 0:
                self.losses.append({"path": iw, "reason": "the adapter returned this nested sequence with nothing in it"})
            else:
                self.losses.append({"path": iw, "reason": "nested compound clip is not flattened"})
            out.append(entry)
        return out

    def timeline(self, tl, where: str, fcpx: _Fcpx | None = None, project: ET.Element | None = None) -> dict:
        self.keep_raw(tl, where)
        self.keep_raw(tl.tracks, f"{where}.stack")
        tracks = list(tl.tracks)
        lanes = None
        if fcpx is None:
            global_start, drop_frame = _time(tl.global_start_time), None
        else:
            tracks.sort(key=lambda track: int(track.name))
            lanes = fcpx.lanes(project)
            global_start, drop_frame = fcpx.global_start(project)
        out = []
        for k, track in enumerate(tracks):
            tw = f"{where}.tracks[{k}]"
            self.keep_raw(track, tw)
            out.append({"name": track.name, "kind": track.kind,
                        "items": self.items(track, tw, None if lanes is None else lanes[track.name])})
        return {"name": tl.name, "globalStart": global_start, "dropFrame": drop_frame,
                "markers": self.markers(tl.tracks, where), "tracks": out}


def _build(data: bytes, adapter: str) -> dict:
    """Read with the adapter and normalize. Runs in the child process."""
    import opentimelineio as otio
    try:
        result = otio.adapters.read_from_string(
            data, adapter_name=adapter,
            media_linker_name=otio.media_linker.MediaLinkingPolicy.DoNotLinkMedia)
    except Exception as exc:
        raise _fail("OTIO_READ_FAILED", f"{adapter}: {type(exc).__name__}: {exc}")
    timelines = ([result] if isinstance(result, otio.schema.Timeline)
                 else list(result.find_children(descended_from_type=otio.schema.Timeline)))
    root = ET.fromstring(data)
    record = _Record(otio)
    if adapter == "fcp_xml":
        records = [record.timeline(tl, f"timelines[{i}]") for i, tl in enumerate(timelines)]
        record.losses.extend(_fcp7_losses(root))
    else:
        fcpx = _Fcpx(root)
        projects = fcpx.projects()
        if len(timelines) != len(projects):
            raise _fail("OTIO_READ_FAILED", f"fcpx_xml returned {len(timelines)} timelines for {len(projects)} projects")
        records = [record.timeline(tl, f"timelines[{i}]", fcpx, project)
                   for i, (tl, project) in enumerate(zip(timelines, projects))]
        record.losses.extend(fcpx.losses(projects))
    return {"timelines": records, "losses": record.losses, "rawMetadata": record.raw}


def _child(conn, data: bytes, adapter: str) -> None:
    try:
        conn.send(("ok", _build(data, adapter)))
    except EngineError as exc:
        conn.send(("error", exc.code, exc.message))
    except Exception:
        conn.send(("crash", traceback.format_exc()))


def _read_bounded(data: bytes, adapter: str) -> dict:
    """Run _build in a child process; kill it past ADAPTER_SECONDS or ADAPTER_MEMORY_BYTES."""
    try:
        import opentimelineio as otio
        import psutil
    except ImportError as exc:
        raise _fail("ADAPTER_MISSING", f"install reelengine[reference]: {exc}")
    try:
        otio.adapters.from_name(adapter)
    except otio.exceptions.NotSupportedError as exc:
        raise _fail("ADAPTER_MISSING", f"OTIO adapter {adapter} is not installed: {exc}")
    ctx = multiprocessing.get_context("spawn")
    receiver, sender = ctx.Pipe(duplex=False)
    child = ctx.Process(target=_child, args=(sender, data, adapter), daemon=True)
    child.start()
    sender.close()
    deadline = time.monotonic() + ADAPTER_SECONDS
    try:
        watched = psutil.Process(child.pid)
        while True:
            if time.monotonic() > deadline:
                raise _fail("INPUT_TOO_LARGE", f"the {adapter} adapter ran longer than {ADAPTER_SECONDS} s")
            try:
                rss = watched.memory_info().rss
            except psutil.NoSuchProcess:
                rss = 0
            if rss > ADAPTER_MEMORY_BYTES:
                raise _fail("INPUT_TOO_LARGE", f"the {adapter} adapter used more than {ADAPTER_MEMORY_BYTES} bytes")
            if receiver.poll(0.05):
                break
        try:
            message = receiver.recv()
        except EOFError:
            child.join()
            raise _fail("OTIO_READ_FAILED", f"the {adapter} adapter process exited with code {child.exitcode}")
    finally:
        child.kill()
        child.join()
        receiver.close()
    if message[0] == "error":
        raise _fail(message[1], message[2])
    if message[0] == "crash":
        raise RuntimeError(f"reference import child failed:\n{message[1]}")
    return message[1]


def import_reference(path: Path) -> dict:
    path = Path(path)
    data, adapter, sha256 = _load(path)
    root = _parse(data, path)
    if adapter == "fcpx_xml":
        fcpx = _Fcpx(root)
        projects = fcpx.projects()
        if not projects:
            code = "TIMELINE_SKIPPED" if fcpx.skipped(projects) else "NO_TIMELINE"
            raise _fail(code, f"no project the fcpx_xml adapter reads: {path}")
        _check_expansion(*fcpx.expanded(projects))
    else:
        if root.find("sequence") is None and root.find(".//children/sequence") is None:
            raise _fail("NO_TIMELINE", f"no top-level sequence: {path}")
        _check_expansion(*_fcp7_expanded(root))
    record = _read_bounded(data, adapter)
    urls = {item["media"]["url"] for tl in record["timelines"] for track in tl["tracks"] for item in track["items"]
            if item.get("media", {}).get("kind") == "file"}
    return {"source": {"path": str(path), "adapter": adapter, "version": root.get("version"), "sha256": sha256},
            "mediaRefs": sorted(urls), **record}


def run(path: Path, output: Path | None = None) -> dict:
    record = import_reference(path)
    if output:
        write_json(Path(output), record)
    return record
