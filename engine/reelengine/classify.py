"""`classify --root <ReelStudioRoot> <file>...`: sort dropped files into the Library.

The Library is human-readable on purpose (the user may open it in Finder/Explorer):
  Raw takes/   someone talking to the camera (what a new video is made from)
  B-roll/      other video clips (silent, or short)
  Music/       audio files
  Images/      stills
Files are COPIED by default (the user's original stays where it was); --move moves them. A file
that is already inside the right Library folder is left alone. Names are kept, de-duplicated with
" (2)" rather than overwriting.
"""
from __future__ import annotations

import shutil
from pathlib import Path
from typing import Optional

from . import probe as probemod, tools
from .proto import EngineError, progress

FOLDERS = {"talking_head": "Raw takes", "broll_video": "B-roll", "music": "Music", "image": "Images"}
LIBRARY_DIRS = ["Raw takes", "B-roll", "Music", "Images", "Exports"]


def ensure_library(root: Path) -> Path:
    lib = Path(root) / "Library"
    for d in LIBRARY_DIRS:
        (lib / d).mkdir(parents=True, exist_ok=True)
    return lib


def _inside(p: Path, folder: Path) -> bool:
    try:
        p.resolve().relative_to(folder.resolve())
        return True
    except ValueError:
        return False


def run(root: Optional[Path], files: list, move: bool = False) -> dict:
    root = tools.root_dir(str(root) if root else None)
    lib = ensure_library(root)
    results = []
    for n, f in enumerate(files):
        f = Path(f)
        progress("classify", 100 * n / max(1, len(files)), "Sorting your files")
        entry = {"file": str(f)}
        try:
            if not f.is_file():
                raise EngineError("NOT_FOUND", f"{f} is not a file", "I couldn't find that file.")
            info = probemod.probe(f)
            kind = info["kind"]
            entry["kind"] = kind
            folder = FOLDERS.get(kind)
            if folder is None:
                entry.update(status="skipped", userMessage=f"\"{f.name}\" isn't a video, song or picture, so I left it alone.")
            elif _inside(f, lib / folder):
                entry.update(status="already", dest=str(f), folder=folder)
            else:
                dest = tools.unique_path(lib / folder / f.name)
                if move:
                    shutil.move(str(f), str(dest))
                else:
                    shutil.copy2(f, dest)
                entry.update(status="moved" if move else "copied", dest=str(dest), folder=folder,
                             relative=str(dest.relative_to(root)).replace("\\", "/"))
            entry["duration"] = info.get("duration")
        except EngineError as exc:
            if exc.code == "UNREADABLE":
                entry.update(status="skipped", code=exc.code,
                             userMessage=f"\"{f.name}\" isn't a video, song or picture, so I left it alone.")
            else:
                entry.update(status="error", code=exc.code, userMessage=exc.user_message)
        results.append(entry)
    progress("classify", 100, "Sorted", force=True)
    return {"root": str(root), "files": results}
