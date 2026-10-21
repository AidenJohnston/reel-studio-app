"""Path containment for every path that comes out of project.json.

project.json is written by the AI, and the AI reads text it does not control (the transcript,
image-search titles), so every path in it is untrusted. A path may only reach a file inside:

  read:  <project>/media, <project>/work, <Reel Studio root>/Library
  write: <project>/work, <project>/versions

`safe_resolve` resolves symlinks and `..` FIRST and then checks the real location, so neither a
`Library/../../x`, an absolute path, a UNC share (`\\\\server\\x`, `//server/x`), a Windows device
path (`\\\\?\\C:\\x`) nor a symlink planted inside `work/` can point the engine at another file.

`REELENGINE_EXTRA_READ_DIRS` (os.pathsep-separated absolute folders) adds READ roots. It is for the
test suite and dev runs only; the app never sets it, and project.json cannot set an env var.
"""
from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Iterable, Optional

from .proto import EngineError

_DRIVE = re.compile(r"^[A-Za-z]:")
USER_MESSAGE = "A file in this edit points outside your project folder, so I left it out."


def unsafe_reason(p: str) -> Optional[str]:
    """Why a project.json path string is refused before it is even resolved (None = acceptable)."""
    if not isinstance(p, str) or not p.strip():
        return "empty path"
    if "\x00" in p:
        return "NUL byte in path"
    s = p.replace("\\", "/")
    if s.startswith("//"):
        return "UNC or device path"
    if s.startswith("/") or _DRIVE.match(s):
        return "absolute path"
    if any(part == ".." for part in s.split("/")):
        return "'..' in path"
    return None


def _extra_read_dirs() -> list[Path]:
    raw = os.environ.get("REELENGINE_EXTRA_READ_DIRS") or ""
    out = []
    for d in raw.split(os.pathsep):
        d = d.strip()
        if d and os.path.isabs(d):
            out.append(Path(d))
    return out


def _real(p: Path) -> Path:
    return Path(os.path.realpath(p))


def _inside(path: Path, bases: Iterable[Path]) -> bool:
    for b in bases:
        try:
            path.relative_to(_real(b))       # PureWindowsPath compares case-insensitively
            return True
        except ValueError:
            continue
    return False


def read_bases(project_dir: Path, root: Optional[Path] = None) -> list[Path]:
    pd = Path(project_dir)
    bases = [pd / "media", pd / "work"]
    if root is not None:
        bases.append(Path(root) / "Library")
    return bases + _extra_read_dirs()


def write_bases(project_dir: Path) -> list[Path]:
    pd = Path(project_dir)
    return [pd / "work", pd / "versions"]


def safe_resolve(project_dir: Path, p, root: Optional[Path] = None, write: bool = False,
                 what: str = "file") -> Path:
    """project.json path -> real absolute path inside the allowed folders, else UNSAFE_PATH.

    Relative `Library/...` resolves against `root`; any other relative path against the project.
    An ABSOLUTE path is accepted only when it already lies inside an allowed folder (the schema
    refuses absolute paths in project.json; this keeps engine-internal absolute paths working)."""
    if isinstance(p, Path):
        p = str(p)
    if not isinstance(p, str) or not p.strip() or "\x00" in p:
        raise EngineError("UNSAFE_PATH", f"{what}: empty or invalid path {p!r}", USER_MESSAGE)
    s = p.replace("\\", "/")
    if s.startswith("//"):
        raise EngineError("UNSAFE_PATH", f"{what}: UNC/device path refused: {p}", USER_MESSAGE)
    pd = Path(project_dir)
    if s.startswith("/") or _DRIVE.match(s):
        cand = Path(p)
    elif s.startswith("Library/") and root is not None:
        cand = Path(root) / s
    else:
        cand = pd / s
    real = _real(cand)
    bases = write_bases(pd) if write else read_bases(pd, root)
    if not _inside(real, bases):
        raise EngineError("UNSAFE_PATH", f"{what}: {p!r} resolves to {real}, outside "
                          + ", ".join(str(b) for b in bases), USER_MESSAGE)
    return real


def safe_child(base: Path, name: str, what: str = "file") -> Path:
    """`base / name` for a single file NAME (no separators, no `..`), checked to stay in `base`."""
    if not name or any(c in name for c in "/\\\x00") or name in (".", "..") or _DRIVE.match(name):
        raise EngineError("UNSAFE_PATH", f"{what}: bad file name {name!r}", USER_MESSAGE)
    out = Path(base) / name
    if not _inside(_real(out), [Path(base)]):
        raise EngineError("UNSAFE_PATH", f"{what}: {name!r} escapes {base}", USER_MESSAGE)
    return out


def resolve_input(project_dir: Path, p, root: Optional[Path] = None,
                  staged_dir: Optional[Path] = None) -> Path:
    """Read new staged work assets first, then existing media/work/Library inputs."""
    if staged_dir is not None and isinstance(p, (str, Path)):
        name = str(p).replace("\\", "/")
        if name.startswith("work/"):
            staged = safe_resolve(staged_dir, p, root=root, what="staged asset")
            if staged.exists():
                return staged
    return safe_resolve(project_dir, p, root=root, what="asset")
