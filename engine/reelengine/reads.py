"""Every file a render reads, recorded in one place, so the list of what a video is made from can't
drift from what the renderer really opens.

Python's audit hook sees each file the engine opens for reading (`open`, in any thread) and each
program it starts (`subprocess.Popen`, whose existing file arguments are ffmpeg's inputs). The project
resolver notes every path it resolves for reading too (safepath.safe_resolve). While a render records
(`start`), the files under the project or the Reel Studio root are kept, except what the engine itself
writes (GENERATED) and project.json, which the snapshot holds. `stop()` returns them as
{key: digest}: a key relative to the project ("project/...") or the root ("root/..."), so a moved
Reel Studio folder keeps its keys, and a digest that changes when the file does.
"""
from __future__ import annotations

import hashlib
import os
import shlex
import sys
import threading
from pathlib import Path
from typing import Optional

# What the engine writes into a project: never an input, even when a later step reads it back.
GENERATED = ("versions", "work/render", "work/layers", "work/audio", "work/moments", "work/live",
             "work/frames", "work/cover-candidates", "work/captions.json", "work/captions.ass", "work/cover.json",
             "project.json")
HASH_UP_TO = 16 * 1024 * 1024       # larger files (the takes) by size and time: hashing them costs seconds

_lock = threading.Lock()
_rec: Optional[dict] = None


def generated(rel: str) -> bool:
    """`rel` (relative to the project, with /) is something the engine writes, never an input."""
    return any(rel == g or rel.startswith(g + "/") for g in GENERATED)


def _keep(path) -> None:
    rec = _rec
    if rec is None or not isinstance(path, (str, os.PathLike)):
        return
    p = os.fspath(path)
    if not os.path.isfile(p):
        return
    p = os.path.realpath(p)
    # compared without case where the file system ignores it (normcase); the key keeps the file's own case
    for alias, real in rec["aliases"]:
        if os.path.normcase(p) == alias or os.path.normcase(p).startswith(alias + os.sep):
            p = real + p[len(alias):]
    for base, prefix in rec["bases"]:
        if os.path.normcase(p).startswith(base + os.sep):
            rel = p[len(base) + 1:].replace(os.sep, "/")
            if not (prefix == "project" and generated(rel)):
                with _lock:
                    rec["files"][f"{prefix}/{rel}"] = p
            return


def _hook(event: str, args) -> None:
    if _rec is None:
        return
    if event == "open":
        path, mode, flags = args
        writes = (mode and any(c in mode for c in "wax+")) or (flags or 0) & (os.O_WRONLY | os.O_RDWR | os.O_CREAT)
        if not writes:
            _keep(path)
    elif event == "subprocess.Popen":
        _exe, argv, cwd, _env = args
        for a in _arguments(argv)[1:]:
            _keep(a if os.path.isabs(a) else os.path.join(cwd or os.getcwd(), a))


def _arguments(argv) -> list:
    """A started program's arguments. On Windows the event carries the command line subprocess built
    (list2cmdline: an argument with a space is in double quotes), elsewhere the list itself."""
    if isinstance(argv, (str, bytes)):
        line = argv.decode() if isinstance(argv, bytes) else argv
        return [a[1:-1] if len(a) > 1 and a[0] == a[-1] == '"' else a for a in shlex.split(line, posix=False)]
    return [os.fspath(a) for a in argv if isinstance(a, (str, os.PathLike))]


sys.addaudithook(_hook)


def start(project_dir: Path, root: Optional[Path], aliases: Optional[dict] = None) -> None:
    """From now on, keep what is read from `project_dir` and `root`. `aliases`: {folder: project folder}
    for files read through a stand-in folder of hard links (a saved version's rebuild)."""
    global _rec
    norm = lambda p: os.path.normcase(os.path.realpath(os.fspath(p)))  # noqa: E731
    bases = [(norm(project_dir), "project")] + ([(norm(root), "root")] if root else [])
    _rec = {"bases": sorted(bases, key=lambda b: -len(b[0])), "files": {},
            "aliases": [(norm(a), os.path.realpath(os.fspath(r))) for a, r in (aliases or {}).items()]}


def note(path) -> None:
    """A file the engine will read, from code that names it without opening it here (the resolver)."""
    _keep(path)


def stop() -> dict:
    """Stops recording; {key: digest} of everything read since start()."""
    global _rec
    rec, _rec = _rec, None
    return {} if rec is None else {k: digest(Path(p)) for k, p in sorted(rec["files"].items())}


def digest(f: Path) -> Optional[str]:
    try:
        st = f.stat()
        if st.st_size > HASH_UP_TO:
            return f"size {st.st_size} mtime {st.st_mtime_ns}"
        return hashlib.sha256(f.read_bytes()).hexdigest()
    except OSError:
        return None


def path_of(key: str, project_dir: Path, root: Optional[Path]) -> Optional[Path]:
    prefix, _, rel = key.partition("/")
    base = Path(project_dir) if prefix == "project" else Path(root) if prefix == "root" and root else None
    return base / rel if base is not None else None


def unchanged(recorded: dict, project_dir: Path, root: Optional[Path]) -> bool:
    """Every file in `recorded` (a stop() result) is still there, as it was."""
    for key, was in recorded.items():
        p = path_of(key, project_dir, root)
        if p is None or digest(p) != was:
            return False
    return True
