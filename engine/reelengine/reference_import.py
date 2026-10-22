"""Read edit interchange files into a bounded, evidence-only timeline record."""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any

from .proto import EngineError

MAX_FILE_BYTES = 64 * 1024 * 1024
MAX_BUNDLE_BYTES = 256 * 1024 * 1024
MAX_BUNDLE_FILES = 4096


def _fail(code: str, detail: str) -> EngineError:
    return EngineError(code, detail, detail)


def _regular(path: Path, root: Path) -> None:
    if path.is_symlink():
        raise _fail("UNSAFE_INPUT", f"symlink is not allowed: {path}")
    try:
        path.resolve().relative_to(root.resolve())
    except ValueError:
        raise _fail("UNSAFE_INPUT", f"path escapes input folder: {path}")


def _check_xml(data: bytes, path: Path) -> None:
    # OTIO's XML adapters use their own parser. Reject declarations that can
    # enable entity expansion before handing bytes to the adapter.
    if re.search(br"<!DOCTYPE|<!ENTITY", data, re.IGNORECASE):
        raise _fail("UNSAFE_XML", f"XML entity declaration is not allowed: {path}")


def _read_bounded(path: Path, root: Path, limit: int = MAX_FILE_BYTES) -> bytes:
    _regular(path, root)
    if not path.is_file():
        raise _fail("BAD_INPUT", f"input is not a file: {path}")
    try:
        size = path.stat().st_size
    except OSError as exc:
        raise _fail("BAD_INPUT", f"cannot stat {path}: {exc}")
    if size > limit:
        raise _fail("INPUT_TOO_LARGE", f"input exceeds {limit} bytes: {path}")
    try:
        data = path.read_bytes()
    except OSError as exc:
        raise _fail("BAD_INPUT", f"cannot read {path}: {exc}")
    if len(data) != size:
        raise _fail("BAD_INPUT", f"input changed while reading: {path}")
    return data


def safe_input(path: Path) -> Path:
    """Validate an XML file or FCPXML bundle and return the XML file to parse."""
    path = Path(path)
    if path.suffix.lower() == ".fcpxmld":
        if not path.is_dir() or path.is_symlink():
            raise _fail("BAD_INPUT", f"FCPXML bundle is not a directory: {path}")
        total = 0
        count = 0
        for item in sorted(path.rglob("*")):
            _regular(item, path)
            if item.is_file():
                count += 1
                if count > MAX_BUNDLE_FILES:
                    raise _fail("INPUT_TOO_LARGE", f"bundle has more than {MAX_BUNDLE_FILES} files")
                total += item.stat().st_size
                if total > MAX_BUNDLE_BYTES:
                    raise _fail("INPUT_TOO_LARGE", f"bundle exceeds {MAX_BUNDLE_BYTES} bytes")
        info = path / "Info.fcpxml"
        if not info.is_file():
            candidates = sorted(path.glob("*.fcpxml"))
            info = candidates[0] if len(candidates) == 1 else info
        data = _read_bounded(info, path, MAX_FILE_BYTES)
        _check_xml(data, info)
        return info
    if path.suffix.lower() not in {".fcpxml", ".xml"}:
        raise _fail("BAD_INPUT", "input must end in .fcpxml, .fcpxmld, or .xml")
    data = _read_bounded(path, path.parent, MAX_FILE_BYTES)
    _check_xml(data, path)
    return path


def _adapter_for(path: Path) -> str:
    return "fcpx_xml" if path.suffix.lower() == ".fcpxml" else "fcp_xml"


def _xml_version(path: Path) -> str | None:
    data = _read_bounded(path, path.parent)
    match = re.search(br'<fcpxml[^>]*version="([^"]+)', data)
    if match:
        return match.group(1).decode("ascii", "replace")
    match = re.search(br'<xmeml[^>]*version="([^"]+)', data)
    return match.group(1).decode("ascii", "replace") if match else None


def _read_otio(path: Path, adapter: str):
    try:
        import opentimelineio as otio
    except ImportError as exc:
        raise _fail("OTIO_MISSING", f"OpenTimelineIO is required: {exc}")
    try:
        return otio.adapters.read_from_file(str(path), adapter_name=adapter)
    except Exception as exc:
        raise _fail("OTIO_READ_FAILED", f"{adapter} could not read {path}: {exc}")


def _hash_paths(path: Path) -> str:
    digest = hashlib.sha256()
    if path.is_file():
        digest.update(_read_bounded(path, path.parent))
    else:
        for item in sorted(path.rglob("*")):
            if item.is_file():
                digest.update(str(item.relative_to(path)).encode())
                digest.update(_read_bounded(item, path))
    return digest.hexdigest()


def _time(value: Any) -> dict[str, Any]:
    if value is None:
        return {}
    result = {"value": float(getattr(value, "value", 0)), "rate": float(getattr(value, "rate", 0))}
    if result["value"].is_integer():
        result["value"] = int(result["value"])
    if result["rate"].is_integer():
        result["rate"] = int(result["rate"])
    result["dropFrame"] = bool(getattr(value, "drop_frame", False))
    return result


def _range(value: Any) -> dict[str, Any] | None:
    if value is None:
        return None
    start = getattr(value, "start_time", None)
    duration = getattr(value, "duration", None)
    result = {"start": _time(start), "duration": _time(duration)}
    if start is not None:
        result["rate"] = _time(start).get("rate")
        result["dropFrame"] = _time(start).get("dropFrame", False)
    return result


def _metadata(value: Any) -> dict:
    data = getattr(value, "metadata", {}) or {}
    return data if isinstance(data, dict) else {}


def _ref(value: Any) -> dict | None:
    if value is None:
        return None
    result = {}
    for name in ("target_url", "name", "available_range"):
        attr = getattr(value, name, None)
        if attr is not None:
            result["targetUrl" if name == "target_url" else ("availableRange" if name == "available_range" else name)] = _range(attr) if name == "available_range" else attr
    return result or None


def _clip(item: Any, losses: list[dict], track_index: int, clip_index: int) -> dict:
    item_name = getattr(item, "name", None) or ""
    metadata = _metadata(item)
    result = {"name": item_name, "sourceRange": _range(getattr(item, "source_range", None)),
              "mediaRef": _ref(getattr(item, "media_reference", None)), "markers": [], "text": None,
              "transitions": [], "transforms": [], "audioGain": None}
    for key, value in metadata.items():
        lowered = key.lower()
        if any(word in lowered for word in ("gain", "volume", "level")):
            result["audioGain"] = {"field": key, "value": value}
        if any(word in lowered for word in ("transform", "scale", "position", "rotation")):
            result["transforms"].append({"field": key, "value": value})
    for marker in getattr(item, "markers", []) or []:
        result["markers"].append({"name": getattr(marker, "name", None), "range": _range(getattr(marker, "marked_range", None)),
                                  "metadata": _metadata(marker)})
    schema = getattr(item, "schema_name", "")
    item_name = getattr(item, "name", None) or ""
    if "Text" in schema or "Title" in schema or item_name.lower().startswith(("title", "text", "caption")):
        result["text"] = {"name": getattr(item, "name", None), "metadata": _metadata(item)}
    for effect in getattr(item, "effects", []) or []:
        name = getattr(effect, "name", None)
        result["transforms" if "transform" in (name or "").lower() else "transitions"].append({"name": name, "metadata": _metadata(effect)})
    for key in metadata:
        losses.append({"path": f"tracks[{track_index}].clips[{clip_index}].metadata", "fields": [key], "reason": "adapter metadata is not represented by the normalized record"})
    return result


def import_reference(path: Path) -> dict:
    original = Path(path)
    xml_path = safe_input(original)
    adapter = _adapter_for(xml_path)
    timeline = _read_otio(xml_path, adapter)
    losses: list[dict] = []
    tracks = []
    for ti, track in enumerate(getattr(timeline, "tracks", []) or []):
        clips = []
        for ci, item in enumerate(getattr(track, "children", []) or []):
            schema = getattr(item, "schema_name", type(item).__name__)
            if "Transition" in schema:
                clips.append({"transition": {"name": getattr(item, "name", None),
                                              "inOffset": _time(getattr(item, "in_offset", None)),
                                              "outOffset": _time(getattr(item, "out_offset", None)),
                                              "metadata": _metadata(item)}})
            elif hasattr(item, "source_range") or hasattr(item, "media_reference"):
                clips.append(_clip(item, losses, ti, ci))
            else:
                losses.append({"path": f"tracks[{ti}].children[{ci}]", "fields": [type(item).__name__], "reason": "unsupported OTIO item"})
        track_metadata = _metadata(track)
        for key in track_metadata:
            losses.append({"path": f"tracks[{ti}].metadata", "fields": [key], "reason": "adapter metadata is not represented by the normalized record"})
        tracks.append({"name": getattr(track, "name", None), "kind": getattr(track, "kind", None), "clips": clips})
    markers = [{"name": getattr(m, "name", None), "range": _range(getattr(m, "marked_range", None)), "metadata": _metadata(m)}
               for m in (getattr(timeline, "markers", []) or [])]
    record = {"source": {"path": str(original), "adapter": adapter, "version": _xml_version(xml_path), "hash": _hash_paths(original)},
              "mediaRefs": [clip["mediaRef"] for track in tracks for clip in track["clips"] if clip["mediaRef"]],
              "tracks": tracks, "markers": markers, "losses": losses, "confidence": {}}
    return record


def run(path: Path, output: Path | None = None) -> dict:
    record = import_reference(path)
    if output:
        Path(output).write_text(json.dumps(record, indent=2, ensure_ascii=False) + "\n")
    return record
