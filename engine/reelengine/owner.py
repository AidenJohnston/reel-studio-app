"""One writer per project, shared by Reel Studio (the app) and commands run by hand.

<project>/work/.owner.lock names the one writer. The app writes it for a job (app/src/main/owner.ts) and
passes the job's token to every engine command the job runs (`--owner`): such a command goes ahead only
while the lock holds that token. A command run by hand claims the lock itself for as long as it runs,
created exclusively, so it refuses a project the app or another command has, and the app refuses to
claim one it has. The app's own commands outside a job (REELENGINE_APP, set by app/src/main/paths.ts
engineEnv) are ordered by its job lane instead, as before."""
from __future__ import annotations

import json
import os
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator, Optional

from .proto import EngineError

LOCK = Path("work") / ".owner.lock"
APP_ENV = "REELENGINE_APP"


def _token(lock: Path) -> Optional[str]:
    try:
        held = json.loads(lock.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    token = held.get("token") if isinstance(held, dict) else None
    return token if isinstance(token, str) else None


def _open(lock: Path) -> EngineError:
    return EngineError("PROJECT_OPEN", f"{lock} exists",
                       f"Reel Studio may be using this project. Close it, or delete {lock} if it isn't running.")


@contextmanager
def claim(project_dir: Path, owner: Optional[str]) -> Iterator[None]:
    lock = Path(project_dir) / LOCK
    if owner:
        # a stale or made-up token never joins: the job that held it has let go, or never held it
        if _token(lock) != owner:
            raise EngineError("NOT_OWNER", f"--owner does not match the token in {lock}",
                              "Reel Studio no longer has this video open for this step, so it stopped. Try again.")
        yield
        return
    if os.environ.get(APP_ENV) == "1":
        yield
        return
    # folders this claim makes are taken away with it: a command on a mistyped path leaves nothing behind
    made = [d for d in (lock.parent, *lock.parent.parents) if not d.exists()]
    lock.parent.mkdir(parents=True, exist_ok=True)
    token = uuid.uuid4().hex
    try:
        fd = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    except FileExistsError:
        raise _open(lock) from None
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump({"app": "reelengine", "pid": os.getpid(), "token": token}, fh)
    try:
        yield
    finally:
        if _token(lock) == token:
            lock.unlink(missing_ok=True)
        for d in made:
            try:
                d.rmdir()
            except OSError:
                break       # the command put something there: it stays
