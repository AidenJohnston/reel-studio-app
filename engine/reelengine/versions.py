"""`save-version` and `export`: an edit is saved as a version from its draft, and its full-quality file
is made once, when the person exports it (docs/versions.md).

A note or a hand edit ends with `save-version`: versions/vN gets the project snapshot, the draft that
shows it and that draft's cover, and project.json's `version` becomes N. No full-quality render runs.
`export` makes versions/vN/export.mp4 with one full render, or hands back the one already made when
nothing changed since (render.pick_version), and reports what the file really is, read with ffprobe.
"""
from __future__ import annotations

import os
import shutil
from pathlib import Path
from typing import Optional

from . import moments, project as projmod, render, tools
from .probe import probe
from .proto import EngineError, progress

STAGE = "render"


def _link_or_copy(src: Path, dst: Path) -> None:
    """dst becomes src's file. A hard link costs nothing, and the engine replaces the preview's files
    (never writes into them), so the version keeps what it linked. A copy where links don't work."""
    tmp = dst.with_name(dst.name + ".part")
    tmp.unlink(missing_ok=True)
    try:
        os.link(src, tmp)
    except OSError:
        shutil.copyfile(src, tmp)
    os.replace(tmp, dst)


def fresh_draft(project_dir: Path, proj: dict, root: Optional[Path] = None) -> Optional[Path]:
    """versions/preview/draft.mp4 when it shows this edit: its snapshot has the edit's signature (music
    included, a draft has sound), and its manifest, written after the mp4, carries the picture key."""
    video = render.preview_dir(project_dir) / "draft.mp4"
    manifest = video.with_name("render_draft.json")
    try:
        if manifest.stat().st_mtime_ns < video.stat().st_mtime_ns:
            return None           # stopped before its last step
        shown = projmod.read_json(video.with_name("project.json"))
    except (OSError, ValueError):
        return None
    if projmod.edit_signature(shown) != projmod.edit_signature(proj):
        return None
    if render.render_manifest(video).get("pictureKey") != render.picture_key(project_dir, proj, root):
        return None
    return video


def save(project_dir: Path, root: Optional[Path] = None) -> dict:
    """Saves the edit as it is now as a version, from its draft (rendered here when the preview shows
    another edit). Returns the version and the file to play."""
    project_dir = Path(project_dir).resolve()
    root = tools.root_dir(str(root) if root else None)
    proj = projmod.load(project_dir)
    draft = fresh_draft(project_dir, proj, root)
    if draft is None:
        made = render.run(project_dir, draft=True, root=root)
        draft = Path(made["file"])
    shown = projmod.read_json(draft.with_name("project.json"))     # exactly what the draft shows
    cur = int(proj.get("version") or 0)
    n = render.pick_version(project_dir, dict(shown, version=cur), root)
    vdir = project_dir / "versions" / f"v{n}"
    if n == cur and _exported(vdir):
        # this very edit is already exported: the version is that file
        moments.mark(project_dir)
        return {"version": n, "file": str(vdir / "export.mp4"), "draft": False, "versionDir": str(vdir)}
    if n > cur and vdir.exists():
        shutil.rmtree(vdir)       # above `version`: an attempt that never finished, not a version
    vdir.mkdir(parents=True, exist_ok=True)
    projmod.write_json(vdir / "project.json", dict(shown, version=n))
    cover = render.render_manifest(draft).get("cover")      # only when that draft made it
    if cover and Path(cover).exists():
        _link_or_copy(Path(cover), vdir / "cover.png")
    _link_or_copy(draft, vdir / "draft.mp4")
    if n != cur:
        # Re-read: patch the one field this command owns, as render does.
        fresh = projmod.load(project_dir)
        fresh["version"] = n
        projmod.save(project_dir, fresh)
    moments.mark(project_dir)     # the screen now shows this version: the next edit's moments start here
    progress(STAGE, 100, "Your change is saved", force=True)
    return {"version": n, "file": str(vdir / "draft.mp4"), "draft": True, "versionDir": str(vdir)}


def facts(video: Path, fmt: dict) -> dict:
    """What the exported file is, read from the file: the questions people ask before they post it."""
    info = probe(video, quick=True)
    w, h = info["displayWidth"], info["displayHeight"]
    return {"width": w, "height": h, "fps": round(float(info["fps"] or 0.0), 3), "bytes": info["sizeBytes"],
            "duration": info["duration"],
            "fullResolution": (w, h) == (int(fmt["width"]), int(fmt["height"]))}


def _exported(vdir: Path) -> bool:
    """vdir has a whole full-quality file: a final whose manifest is older than its mp4 stopped before
    its last step."""
    try:
        return (vdir / "render.json").stat().st_mtime_ns >= (vdir / "export.mp4").stat().st_mtime_ns
    except OSError:
        return False


def _result(n: int, vdir: Path, reused: bool) -> dict:
    video, cover = vdir / "export.mp4", vdir / "cover.png"
    return {"version": n, "file": str(video), "cover": str(cover) if cover.exists() else None,
            "reused": reused, "facts": facts(video, projmod.read_json(vdir / "project.json")["format"])}


def export(project_dir: Path, root: Optional[Path] = None, version: Optional[int] = None) -> dict:
    """The full-quality file of the edit as it is now: the one already made when the edit and the files
    it reads have not changed since (render.pick_version), else one full render. With `version`, an
    earlier version's: only one exported before has that file."""
    project_dir = Path(project_dir).resolve()
    root = tools.root_dir(str(root) if root else None)
    proj = projmod.load(project_dir)
    n = render.pick_version(project_dir, proj, root)
    if version is not None and version != n:
        vdir = project_dir / "versions" / f"v{version}"
        if not _exported(vdir):
            raise EngineError("ONLY_A_PREVIEW", f"v{version} has no export.mp4",
                              f"Version {version} was saved as a quick preview, so it has no full-quality file. "
                              "Export your newest version, or send a note to change it back first.")
        progress(STAGE, 100, "Your video is ready", force=True)
        return _result(version, vdir, True)
    vdir = project_dir / "versions" / f"v{n}"
    if n == int(proj.get("version") or 0) and _exported(vdir):
        progress(STAGE, 100, "Your video is ready", force=True)
        return _result(n, vdir, True)
    made = render.run(project_dir, root=root)
    vdir = Path(made["versionDir"])
    (vdir / "draft.mp4").unlink(missing_ok=True)       # the full-quality file is this version now
    return _result(int(made["version"]), vdir, False)
