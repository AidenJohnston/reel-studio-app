"""Which render a report, a frame or a verification belongs to.

Every render gets a random `renderId` and an `inputFingerprint` (a hash of what it was made from).
Its manifest (`render.json` / `render_draft.json`, next to the video) carries both, the SHA-256 of
the video, and that render's own caption, layer and timeline reports. `verify.json` repeats the id
and fingerprint. A newer render in the same folder replaces all of them, so an older id stops
resolving instead of silently pointing at the newer video (docs/versions.md).
"""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

from . import project as projmod
from .proto import EngineError

MANIFESTS = ("render.json", "render_draft.json")


def fingerprint(value) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()


def video_digest(path: Path) -> str:
    with open(path, "rb") as fh:
        return hashlib.file_digest(fh, "sha256").hexdigest()


def mismatch(detail: str) -> EngineError:
    return EngineError("RENDER_MISMATCH", detail,
                       "That preview was replaced by a newer one. Make a new preview and look again.")


def bind(manifest_path: Path) -> dict:
    """The manifest, its video and its verify report, refused unless all three are one render."""
    folder = manifest_path.parent
    try:
        man = projmod.read_json(manifest_path)
        rid, fp = man["renderId"], man["inputFingerprint"]
        video = folder / Path(man["file"]).name
        if video_digest(video) != man["videoSha256"]:
            raise mismatch(f"{video.name} is not the video of render {rid}")
        rep = projmod.read_json(folder / "verify.json")
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise mismatch(f"{manifest_path} has no complete render record: {exc!r}") from exc
    if rep.get("renderId") != rid or rep.get("inputFingerprint") != fp:
        raise mismatch(f"verify.json belongs to render {rep.get('renderId')}, not {rid}")
    return {"manifest": man, "video": video, "verify": rep}


def _manifests(project_dir: Path):
    for path in sorted((Path(project_dir) / "versions").glob("*/render*.json")):
        if path.name not in MANIFESTS:
            continue
        try:
            yield path, projmod.read_json(path)
        except (OSError, ValueError):
            continue


def resolve(project_dir: Path, render_id: str) -> dict:
    if not re.fullmatch(r"r_[0-9a-f]{32}", render_id or ""):
        raise mismatch(f"not a render id: {render_id!r}")
    for path, man in _manifests(project_dir):
        if man.get("renderId") == render_id:
            return bind(path)
    raise mismatch(f"render {render_id} is no longer on disk")


def for_file(video: Path, project_dir: Path | None = None) -> dict:
    """The render a video file is: the manifest beside it, or for a copy (an export in the Library)
    the project's render whose video has the same SHA-256."""
    video = Path(video)
    for name in MANIFESTS:
        path = video.parent / name
        try:
            if Path(projmod.read_json(path)["file"]).name == video.name:
                return bind(path)
        except (OSError, ValueError, KeyError, TypeError):
            continue
    if project_dir is not None:
        digest = video_digest(video)
        for path, man in _manifests(project_dir):
            if man.get("videoSha256") == digest:
                return bind(path)
    raise mismatch(f"{video} has no render record")


def inspect(project_dir: Path, render_id: str) -> dict:
    """`inspect-render`: one render's own reports, never the project's latest ones."""
    b = resolve(project_dir, render_id)
    m = b["manifest"]
    return {"renderId": m["renderId"], "inputFingerprint": m["inputFingerprint"], "version": m["version"],
            "draft": m["draft"], "duration": m["duration"], "fps": m["fps"], "size": m["size"],
            "verify": {k: b["verify"].get(k) for k in ("ok", "fails", "warns", "checks")},
            "captions": m["captionsReport"], "layers": m["layerItems"],
            "timeline": {"segments": m["segmentsDetail"], "words": m["words"]}}
