"""`save-version` and `export`: an edit is saved as a version from its draft, and its full-quality file
is made once, when the person exports it (docs/versions.md).

A saved version is complete and never changes. `save-version` writes versions/vN in one step: the project
snapshot, the draft that shows it with that draft's cover, and `inputs.json`, every file that draft was
rendered from as the renderer itself recorded it (reads.py). project.json's `version` becomes N. No
full-quality render runs. `export` rebuilds a version's full-quality file from its own snapshot, so any
version, newest or not, exports the same video. It renders once and hands that file back afterwards, and
it refuses when a file the version was made from has changed since, rather than make a different video
under its number. The draft a save reuses, the version an edit keeps and the files an export accepts are
all judged by that same recorded set, sound included.
"""
from __future__ import annotations

import os
import shutil
from pathlib import Path
from typing import Optional

from . import moments, project as projmod, reads, render, tools
from .probe import probe
from .proto import EngineError, progress

STAGE = "render"
INPUTS = "inputs.json"


def _link_or_copy(src: Path, dst: Path) -> None:
    """dst becomes src's file: a hard link (it costs nothing), else a copy. Only for files nothing writes
    into, since a write into either name changes both."""
    try:
        os.link(src, dst)
    except OSError:
        shutil.copyfile(src, dst)


def fresh_draft(project_dir: Path, proj: dict, root: Optional[Path] = None) -> Optional[Path]:
    """versions/preview/draft.mp4 when it shows this edit: its snapshot has the edit's signature, its
    manifest (written after the mp4) carries the picture key (the engine that drew it), and every file it
    was rendered from, the song included, is unchanged."""
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
    made = render.render_manifest(video)
    if made.get("pictureKey") != render.picture_key(project_dir, proj, root):
        return None
    if made.get("inputs") is None or not reads.unchanged(made["inputs"], project_dir, root):
        return None               # an older engine's draft, or a file it read has changed
    return video


def _same_video(vdir: Path, proj: dict, made_from: dict, project_dir: Path, root: Optional[Path]) -> bool:
    """vdir is a saved version of this very video: the same edit, drawn from exactly the same files as the
    draft that shows the edit now (`made_from`, its recorded inputs: what it read, and what it looked for
    and did not find)."""
    try:
        if projmod.edit_signature(projmod.read_json(vdir / "project.json")) != projmod.edit_signature(proj):
            return False
        if (vdir / INPUTS).exists():
            return projmod.read_json(vdir / INPUTS) == made_from
        # saved by an earlier build, as a full render: it recorded only the takes, song and pictures
        return (vdir / "assets.json").exists() and \
            projmod.read_json(vdir / "assets.json") == render.asset_fingerprint(project_dir, proj, root)
    except (OSError, ValueError):
        return False


def save(project_dir: Path, root: Optional[Path] = None) -> dict:
    """Saves the edit as it is now as a version, from its draft (rendered here when the preview shows
    another edit or was made from files that have changed). The current version when it already is this
    video, else a new one. Returns the version and the file to play."""
    project_dir = Path(project_dir).resolve()
    root = tools.root_dir(str(root) if root else None)
    proj = projmod.load(project_dir)
    draft = fresh_draft(project_dir, proj, root)
    if draft is None:
        draft = Path(render.run(project_dir, draft=True, root=root)["file"])
    shown = projmod.read_json(draft.with_name("project.json"))     # exactly what the draft shows
    made = render.render_manifest(draft)
    cur = int(proj.get("version") or 0)
    vdir = project_dir / "versions" / f"v{cur}"
    if cur and _same_video(vdir, shown, made["inputs"], project_dir, root):
        moments.mark(project_dir)
        exported = _exported(vdir)
        return {"version": cur, "file": str(vdir / ("export.mp4" if exported else "draft.mp4")),
                "draft": not exported, "versionDir": str(vdir)}
    n = cur + 1
    vdir = project_dir / "versions" / f"v{n}"
    part = vdir.with_name(f".v{n}.part")
    for stale in (vdir, part):     # above `version`: an attempt that never finished, not a version
        if stale.exists():
            shutil.rmtree(stale)
    part.mkdir(parents=True)
    projmod.write_json(part / "project.json", dict(shown, version=n))
    projmod.write_json(part / INPUTS, made["inputs"])          # what the draft was really made from
    # Copies, never links: the preview's files are rewritten in place (a cached cover is copied over
    # preview/cover.png), and a saved version must never change with them.
    if made.get("cover") and Path(made["cover"]).exists():     # only when that draft made it
        shutil.copy2(made["cover"], part / "cover.png")
    shutil.copy2(draft, part / "draft.mp4")
    os.replace(part, vdir)        # the version appears whole, or not at all
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


def _rebuild_work(project_dir: Path, vdir: Path, made_from: dict) -> Path:
    """A work folder of the rebuild's own, holding exactly the work files the version was made from
    (`made_from`, its inputs.json): a file made since (a face track, an animation) is not there to be
    found. The rebuild writes its reports and scratch here, never over the current edit's. Big media is
    hard-linked (the engine never writes into it); the rest is copied, so nothing written here can reach
    the project."""
    view = vdir / ".rebuild"
    shutil.rmtree(view, ignore_errors=True)
    src = Path(project_dir) / "work"
    for key, was in sorted(made_from.items()):
        if was is None or not key.startswith("project/work/"):
            continue
        rel = key[len("project/work/"):]
        f = src / rel
        dst = view / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        if f.stat().st_size > reads.HASH_UP_TO:
            _link_or_copy(f, dst)
        else:
            shutil.copy2(f, dst)
    view.mkdir(parents=True, exist_ok=True)
    return view


def _inputs_changed(version: int) -> EngineError:
    return EngineError("VERSION_INPUTS_CHANGED", f"the files v{version} was made from have changed",
                       f"A picture, song, animation or take used in Version {version} has changed since it was "
                       "saved, so I can't make that exact video any more. Export a newer version instead.")


def export(project_dir: Path, root: Optional[Path] = None, version: Optional[int] = None) -> dict:
    """Version `version`'s full-quality file, rebuilt from its own snapshot the first time and handed
    back after that. Without `version`: the edit as it is now, saved as a version first."""
    project_dir = Path(project_dir).resolve()
    root = tools.root_dir(str(root) if root else None)
    if version is None:
        version = save(project_dir, root)["version"]
    vdir = project_dir / "versions" / f"v{version}"
    if not (vdir / "project.json").exists():
        raise EngineError("NO_VERSION", f"no {vdir}", f"I couldn't find Version {version}. Pick another version and export again.")
    reused = _exported(vdir)
    if not reused:
        made_from = projmod.read_json(vdir / INPUTS) if (vdir / INPUTS).exists() else None
        if made_from is not None and not reads.unchanged(made_from, project_dir, root):
            raise _inputs_changed(version)
        view = _rebuild_work(project_dir, vdir, made_from or {})
        try:
            render.run(project_dir, root=root, version=version, work=view)
        finally:
            shutil.rmtree(view, ignore_errors=True)
    else:
        progress(STAGE, 100, "Your video is ready", force=True)
    cover = vdir / "cover.png"
    return {"version": version, "file": str(vdir / "export.mp4"), "cover": str(cover) if cover.exists() else None,
            "reused": reused, "facts": facts(vdir / "export.mp4", projmod.read_json(vdir / "project.json")["format"])}
