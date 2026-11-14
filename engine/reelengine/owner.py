"""One writer per project, shared by Reel Studio (the app) and commands run by hand (docs/ownership.md).

<project>/work/.owner.lock names the one writer. The app claims it for a job, a manual edit or one of its own
commands, and passes the claim's token to every engine command it runs (`--owner`): such a command goes ahead only
while the lock holds that token. A command run by hand claims the lock itself for as long as it runs, so it refuses a
project the app or another command has, and the app refuses to claim one it has (app/src/main/owner.ts). A claim
appears whole or not at all: the identity is written to a file of its own, which then becomes the lock by a hard
link that fails if a lock exists."""
from __future__ import annotations

import json
import os
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator, Optional

from . import STARTED_AT
from .proto import EngineError

LOCK = Path("work") / ".owner.lock"


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


def create(lock: Path, identity: dict) -> bool:
    """Makes `lock` hold `identity`, whole. False when a lock exists."""
    text = json.dumps(identity)
    tmp = lock.with_name(f"{lock.name}.{uuid.uuid4().hex}.tmp")
    with open(tmp, "x", encoding="utf-8") as fh:
        fh.write(text)
        fh.flush()
        os.fsync(fh.fileno())
    try:
        try:
            os.link(tmp, lock)
            return True
        except FileExistsError:
            return False
        except OSError:
            # A disk with no hard links (FAT, exFAT; each system names it differently): an exclusive create instead,
            # whose identity follows a moment later. The app never takes a lock it can't read, and a real failure
            # fails this create too.
            pass
        try:
            with open(lock, "x", encoding="utf-8") as fh:
                fh.write(text)
            return True
        except FileExistsError:
            return False
    finally:
        tmp.unlink(missing_ok=True)


@contextmanager
def claim(project_dir: Path, owner: Optional[str]) -> Iterator[None]:
    lock = Path(project_dir) / LOCK
    if owner:
        # a stale or made-up token never joins: the claim that held it has let go, or never existed
        if _token(lock) != owner:
            raise EngineError("NOT_OWNER", f"--owner does not match the token in {lock}",
                              "Reel Studio no longer has this video open for this step, so it stopped. Try again.")
        yield
        return
    # folders this claim makes go again when the command fails: one on a mistyped path leaves nothing behind
    made = [d for d in (lock.parent, *lock.parent.parents) if not d.exists()]
    lock.parent.mkdir(parents=True, exist_ok=True)
    token = uuid.uuid4().hex
    if not create(lock, {"app": "reelengine", "pid": os.getpid(), "started": round(STARTED_AT * 1000), "token": token}):
        raise _open(lock)
    failed = True
    try:
        yield
        failed = False
    finally:
        if _token(lock) == token:
            lock.unlink(missing_ok=True)
        for d in made if failed else ():
            try:
                d.rmdir()
            except OSError:
                break       # the command put something there: it stays
