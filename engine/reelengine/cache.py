"""Stable identities for render inputs copied between project and note folders."""
import hashlib
from pathlib import Path


def file_digest(path: Path) -> str:
    h = hashlib.sha256()
    with Path(path).open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


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
