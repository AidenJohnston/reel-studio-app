"""`import-reference <file> [--output F]`: read a Final Cut Pro (.fcpxml, .fcpxmld) or Premiere
FCP7 (.xml) export through OpenTimelineIO into an evidence-only timeline record.

Nothing here writes project.json or My style.json. A clean parse is not proof the edit survived:
whatever the adapter keeps only as raw metadata, and every FCPXML element the fcpx_xml adapter never
reads (titles, transitions, volume, media-rep), is listed in `losses`.
"""
from __future__ import annotations

import hashlib
import json
from collections import Counter
from pathlib import Path
from xml.parsers import expat

import opentimelineio as otio

from .proto import EngineError

MAX_FILE_BYTES = 64 * 1024 * 1024
MAX_BUNDLE_BYTES = 256 * 1024 * 1024
MAX_BUNDLE_FILES = 4096

# Elements otio-fcpx-xml-adapter 1.0.0 looks at (fcpx_xml.py FcpxXml). Anything else in the
# source never reaches OTIO.
FCPX_READ = frozenset({
    "fcpxml", "resources", "format", "asset", "media", "library", "event", "project", "sequence",
    "spine", "asset-clip", "ref-clip", "clip", "gap", "video", "audio", "marker", "metadata", "md",
    "note", "keyword",
})

_AGAIN = "Export it again from your editor and try once more."
_USER = {
    "BAD_INPUT": "Choose a Final Cut Pro (.fcpxml or .fcpxmld) or Premiere (.xml) export.",
    "UNSAFE_INPUT": f"This export links to files outside its own folder. {_AGAIN}",
    "UNSAFE_XML": f"This export has extra XML declarations Reel Studio won't read. {_AGAIN}",
    "BAD_XML": f"This file isn't a readable edit export. {_AGAIN}",
    "INPUT_TOO_LARGE": "This export is too large to import.",
    "ADAPTER_MISSING": "Reel Studio is missing a part it needs to read edit files. Please reinstall the app.",
    "OTIO_READ_FAILED": f"Reel Studio couldn't read this edit. {_AGAIN}",
}


def _fail(code: str, detail: str) -> EngineError:
    return EngineError(code, detail, _USER[code])


def _regular(path: Path, root: Path) -> None:
    if path.is_symlink():
        raise _fail("UNSAFE_INPUT", f"symlink is not allowed: {path}")
    try:
        path.resolve().relative_to(root.resolve())
    except ValueError:
        raise _fail("UNSAFE_INPUT", f"path escapes input folder: {path}")


def _read_bounded(path: Path, root: Path) -> bytes:
    _regular(path, root)
    if not path.is_file():
        raise _fail("BAD_INPUT", f"input is not a file: {path}")
    try:
        size = path.stat().st_size
        if size > MAX_FILE_BYTES:
            raise _fail("INPUT_TOO_LARGE", f"input exceeds {MAX_FILE_BYTES} bytes: {path}")
        return path.read_bytes()
    except OSError as exc:
        raise _fail("BAD_INPUT", f"cannot read {path}: {exc}")


def _load(path: Path) -> tuple[bytes, str, str]:
    """The XML bytes to parse, the adapter name, and a sha256 of the whole input."""
    suffix = path.suffix.lower()
    if suffix == ".fcpxmld":
        if path.is_symlink() or not path.is_dir():
            raise _fail("BAD_INPUT", f"FCPXML bundle is not a folder: {path}")
        digest = hashlib.sha256()
        files = []
        for item in sorted(path.rglob("*")):
            _regular(item, path)
            if item.is_file():
                files.append(item)
        if len(files) > MAX_BUNDLE_FILES:
            raise _fail("INPUT_TOO_LARGE", f"bundle has more than {MAX_BUNDLE_FILES} files")
        if sum(f.stat().st_size for f in files) > MAX_BUNDLE_BYTES:
            raise _fail("INPUT_TOO_LARGE", f"bundle exceeds {MAX_BUNDLE_BYTES} bytes")
        for f in files:
            digest.update(f.relative_to(path).as_posix().encode())
            digest.update(_read_bounded(f, path))
        info = path / "Info.fcpxml"
        if not info.is_file():
            candidates = sorted(path.glob("*.fcpxml"))
            info = candidates[0] if len(candidates) == 1 else info
        return _read_bounded(info, path), "fcpx_xml", digest.hexdigest()
    if suffix not in {".fcpxml", ".xml"}:
        raise _fail("BAD_INPUT", f"unsupported input: {path}")
    data = _read_bounded(path, path.parent)
    return data, "fcpx_xml" if suffix == ".fcpxml" else "fcp_xml", hashlib.sha256(data).hexdigest()


def _scan(data: bytes, path: Path) -> tuple[Counter, str | None]:
    """Element counts and the root's version attribute.

    Both adapters parse with ElementTree, which expands entities declared in a DOCTYPE's internal
    subset. Expat here reads the same bytes with the same encoding detection, so such a DOCTYPE is
    refused before an adapter sees it. A bare `<!DOCTYPE fcpxml>` or `<!DOCTYPE xmeml>`, which
    every real export starts with, is fine."""
    tags: Counter = Counter()
    root: dict = {}
    parser = expat.ParserCreate()

    def doctype(_name, _system_id, _public_id, has_internal_subset):
        if has_internal_subset:
            raise _fail("UNSAFE_XML", f"DOCTYPE declarations are not allowed: {path}")

    def element(name, attrs):
        root.setdefault("version", attrs.get("version"))
        tags[name] += 1

    parser.StartDoctypeDeclHandler = doctype
    parser.StartElementHandler = element
    try:
        parser.Parse(data, True)
    except expat.ExpatError as exc:
        raise _fail("BAD_XML", f"{path}: {exc}")
    return tags, root.get("version")


def _read_otio(data: bytes, adapter: str) -> list:
    try:
        otio.adapters.from_name(adapter)
    except otio.exceptions.NotSupportedError as exc:
        raise _fail("ADAPTER_MISSING", f"OTIO adapter {adapter} is not installed: {exc}")
    try:
        result = otio.adapters.read_from_string(
            data, adapter_name=adapter,
            media_linker_name=otio.media_linker.MediaLinkingPolicy.DoNotLinkMedia)
    except Exception as exc:
        raise _fail("OTIO_READ_FAILED", f"{adapter}: {type(exc).__name__}: {exc}")
    if isinstance(result, otio.schema.Timeline):
        return [result]
    if isinstance(result, otio.schema.SerializableCollection):
        return list(result.find_children(descended_from_type=otio.schema.Timeline))
    raise _fail("OTIO_READ_FAILED", f"{adapter} found no timeline")


def _time(t) -> dict | None:
    return None if t is None else {"value": t.value, "rate": t.rate}


def _range(r) -> dict | None:
    return None if r is None else {"start": _time(r.start_time), "duration": _time(r.duration)}


class _Normalizer:
    def __init__(self):
        self.losses: list[dict] = []

    def raw(self, obj, where: str) -> None:
        if obj.metadata:
            self.losses.append({"path": where, "reason": "adapter metadata",
                                "metadata": json.loads(otio.core.serialize_json_to_string(obj.metadata))})

    def markers(self, owner, where: str) -> list[dict]:
        out = []
        for i, m in enumerate(owner.markers):
            self.raw(m, f"{where}.markers[{i}]")
            out.append({"name": m.name, "color": m.color, "comment": m.comment, "range": _range(m.marked_range)})
        return out

    def media(self, ref, where: str) -> dict:
        self.raw(ref, where)
        if isinstance(ref, otio.schema.ExternalReference):
            return {"kind": "file", "url": ref.target_url, "name": ref.name,
                    "availableRange": _range(ref.available_range)}
        if isinstance(ref, otio.schema.GeneratorReference):
            return {"kind": "generator", "generator": ref.generator_kind, "name": ref.name}
        self.losses.append({"path": where, "reason": "the adapter found no media for this clip"})
        return {"kind": "missing", "name": ref.name or None}

    def item(self, track, i: int, where: str) -> dict:
        item = track[i]
        self.raw(item, where)
        if isinstance(item, otio.schema.Transition):
            return {"type": "transition", "name": item.name, "transitionType": item.transition_type,
                    "inOffset": _time(item.in_offset), "outOffset": _time(item.out_offset)}
        out = {"type": type(item).__name__.lower(), "name": item.name,
               "trackRange": _range(track.range_of_child_at_index(i)),
               "sourceRange": _range(item.source_range)}
        if isinstance(item, otio.schema.Gap):
            return out
        out["markers"] = self.markers(item, where)
        out["effects"] = []
        for k, e in enumerate(item.effects):
            self.raw(e, f"{where}.effects[{k}]")
            out["effects"].append({"name": e.name, "effect": e.effect_name})
        if isinstance(item, otio.schema.Clip):
            out["media"] = self.media(item.media_reference, f"{where}.media")
        else:
            self.losses.append({"path": where, "reason": "nested compound clip is not flattened"})
        return out

    def timeline(self, tl, where: str) -> dict:
        self.raw(tl, where)
        self.raw(tl.tracks, f"{where}.stack")
        tracks = []
        for k, track in enumerate(tl.tracks):
            tw = f"{where}.tracks[{k}]"
            self.raw(track, tw)
            tracks.append({"name": track.name, "kind": track.kind,
                           "items": [self.item(track, i, f"{tw}.items[{i}]") for i in range(len(track))]})
        return {"name": tl.name, "globalStart": _time(tl.global_start_time),
                "markers": self.markers(tl.tracks, where), "tracks": tracks}


def import_reference(path: Path) -> dict:
    path = Path(path)
    data, adapter, sha256 = _load(path)
    tags, version = _scan(data, path)
    timelines = _read_otio(data, adapter)
    norm = _Normalizer()
    records = [norm.timeline(tl, f"timelines[{i}]") for i, tl in enumerate(timelines)]
    if adapter == "fcpx_xml":
        for tag, count in sorted(tags.items()):
            if tag not in FCPX_READ:
                norm.losses.append({"path": "source", "element": tag, "count": count,
                                    "reason": "the fcpx_xml adapter does not read this element"})
    urls = {item["media"]["url"] for tl in records for track in tl["tracks"] for item in track["items"]
            if item.get("media", {}).get("kind") == "file"}
    return {"source": {"path": str(path), "adapter": adapter, "version": version, "sha256": sha256},
            "mediaRefs": sorted(urls), "timelines": records, "losses": norm.losses}


def run(path: Path, output: Path | None = None) -> dict:
    record = import_reference(path)
    if output:
        Path(output).write_text(json.dumps(record, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return record
