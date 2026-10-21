"""Stable input identities and private cache copies for staged engine work."""
import hashlib
import json
import os
import re
import sys
from pathlib import Path


def cache_dir() -> Path:
    """Per-user cache (Simple Icons index, search credits). REELENGINE_CACHE_DIR overrides."""
    env = os.environ.get("REELENGINE_CACHE_DIR")
    if env:
        return Path(env)
    if sys.platform == "win32":
        return Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local") / "ReelStudio" / "cache"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Caches" / "ReelStudio"
    return Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache") / "reelstudio"


def file_digest(path: Path) -> str:
    h = hashlib.sha256()
    with Path(path).open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def seed_private_cache(destination: Path) -> None:
    """Copy completed shared cache JSON into private work before redirecting engine writes."""
    from . import tools

    destination = Path(destination)

    def copy_json(source: Path, relative: Path) -> None:
        target = destination / relative
        try:
            if target.exists():
                return
            stamp = source.stat()
            data = source.read_bytes()
            json.loads(data)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            os.utime(target, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
        except (OSError, ValueError):
            pass  # Optional or incomplete caches can be rebuilt privately.

    shared = cache_dir()
    for name in ("simple-icons.json", "wikidata.json", "search-credits.json"):
        copy_json(shared / name, Path(name))
    for source in (shared / "music-analysis").glob("*.json"):
        if re.fullmatch(r"[a-f0-9]{32}\.json", source.name):
            copy_json(source, Path("music-analysis") / source.name)
    copy_json(tools.probe_cache_file(), Path("encoder-probe.json"))
    # yt-dlp stores completed JSON one namespace deep, with temporary files ending in .tmp.
    # Its default root differs from Reel Studio's unless assets supplies an explicit cachedir.
    if os.environ.get("REELENGINE_CACHE_DIR"):
        downloads = shared / "yt-dlp"
    else:
        default = os.path.join(os.environ.get("XDG_CACHE_HOME", "~/.cache"), "yt-dlp")
        downloads = Path(os.path.expandvars(os.path.expanduser(default)))
    for source in downloads.glob("*/*.json"):
        if re.fullmatch(r"[\w.-]+", source.parent.name):
            copy_json(source, Path("yt-dlp") / source.relative_to(downloads))


def cache_input_identity(path: Path, ctx=None) -> list:
    """Use logical input names so copying a project or staging its work keeps cache hits."""
    path = Path(path).resolve()
    roots = [(getattr(ctx, "work", None), "work"),
             (getattr(ctx, "staged_dir", None), ""),
             (getattr(ctx, "project_dir", None), ""), (getattr(ctx, "root", None), "")]
    for root, prefix in roots:
        if root is None:
            continue
        try:
            logical = Path(prefix) / path.relative_to(Path(root).resolve())
        except ValueError:
            continue
        st = path.stat()
        return [logical.as_posix(), st.st_size, st.st_mtime_ns]
    # External inputs have no project-relative name. Their contents identify them across roots.
    return ["sha256", file_digest(path)]
