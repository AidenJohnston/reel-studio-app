"""One writer per project at a time (the same rules as ai/src/owner.ts).

<project>/work/.owner.lock holds the owner's token. Reel Studio's job lane takes it and passes the token
to every engine command it runs (`--owner`), which then joins instead of taking it again. A command run
by hand without a token takes the project for itself while it runs, and refuses while someone else
has it. The owner touches the file every BEAT_S; a lock untouched for STALE_S has no live owner.
Liveness is the file's timestamp because a PID check is not portable (os.kill(pid, 0) sends Ctrl-C on
Windows) and a PID can be reused.
"""
from __future__ import annotations

import os
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator, Optional

from .proto import EngineError

LOCK = Path("work") / ".owner.lock"
BEAT_S = 5.0
STALE_S = 30.0
OPEN_ELSEWHERE = "This project is open in Reel Studio. Wait until it finishes there, then try again."


def token(project_dir: Path) -> Optional[str]:
    try:
        return (Path(project_dir) / LOCK).read_text(encoding="utf-8").strip()
    except OSError:
        return None


def _live(lock: Path) -> bool:
    try:
        return time.time() - lock.stat().st_mtime < STALE_S
    except FileNotFoundError:
        return False


@contextmanager
def owned(project_dir: Path, joining: Optional[str]) -> Iterator[None]:
    lock = Path(project_dir) / LOCK
    if joining:
        if token(project_dir) != joining:
            raise EngineError("NOT_OWNER", f"{lock} is not held by {joining}",
                              "This video is being edited somewhere else right now. Try again when that finishes.")
        yield
        return
    lock.parent.mkdir(parents=True, exist_ok=True)
    mine = uuid.uuid4().hex
    for attempt in (0, 1):
        try:
            fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            if attempt or _live(lock):
                raise EngineError("PROJECT_BUSY", f"{lock} has a live owner", OPEN_ELSEWHERE) from None
            lock.unlink(missing_ok=True)        # nobody has touched it for STALE_S: its owner is gone
            continue
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(mine)
        break
    stop = threading.Event()

    def beat():
        while not stop.wait(BEAT_S):
            try:
                os.utime(lock)
            except OSError:
                pass

    threading.Thread(target=beat, name="owner", daemon=True).start()
    try:
        yield
    finally:
        stop.set()
        if token(project_dir) == mine:
            lock.unlink(missing_ok=True)
