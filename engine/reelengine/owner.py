"""Reel Studio (the app) is the only writer of a project while it has it open (app/src/main/owner.ts).
It writes <project>/work/.owner.lock and passes its job's token to every engine command it runs
(`--owner`). A command run by hand, without a token, refuses while that file exists; it never takes
a project over. The app removes leftover files when it starts."""
from __future__ import annotations

from pathlib import Path
from typing import Optional

from .proto import EngineError

LOCK = Path("work") / ".owner.lock"


def check(project_dir: Path, owner: Optional[str]) -> None:
    lock = Path(project_dir) / LOCK
    if not owner and lock.exists():
        raise EngineError("PROJECT_OPEN", f"{lock} exists",
                          f"Reel Studio may be using this project. Close it, or delete {lock} if it isn't running.")
