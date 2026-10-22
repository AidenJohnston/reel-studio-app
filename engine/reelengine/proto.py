"""The engine's stdout protocol (docs/architecture.md section 4): JSON lines only, one object per line.

    {"event":"progress","stage":"transcribe","pct":42,"message":"Listening to your video"}
    {"event":"done","result":{...}}
    {"event":"error","code":"NO_AUDIO","message":"<dev detail>","userMessage":"..."}

Anything a library prints to stdout would corrupt the stream, so `capture_stdout()` points
sys.stdout at stderr for the life of a command and keeps the real stdout for protocol lines only.
"""
from __future__ import annotations

import io
import json
import sys
import threading
import time
from typing import Optional

_OUT = None            # the real stdout, set by capture_stdout()
_LOCK = threading.Lock()
_LAST = {"t": 0.0, "pct": -1.0, "stage": None}


class EngineError(Exception):
    """An error the app can show. `user_message` is plain, warm, tells the user what to do."""

    def __init__(self, code: str, message: str, user_message: str):
        super().__init__(message)
        self.code = code
        self.message = message
        self.user_message = user_message


def capture_stdout():
    """Route print() and library chatter to stderr; keep the real stdout for protocol lines."""
    global _OUT
    if _OUT is None:
        raw = sys.stdout
        try:
            # utf-8, LF only: Windows' default console code page cannot encode every title.
            _OUT = io.TextIOWrapper(raw.buffer, encoding="utf-8", newline="\n", line_buffering=True)
        except AttributeError:          # already a StringIO (tests)
            _OUT = raw
        sys.stdout = sys.stderr
    return _OUT


def set_stream(stream):
    """Tests: send protocol lines into a StringIO."""
    global _OUT
    _OUT = stream
    _LAST.update(t=0.0, pct=-1.0, stage=None)


def emit(obj: dict) -> None:
    out = _OUT or sys.stdout
    line = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    with _LOCK:
        out.write(line + "\n")
        out.flush()


def progress(stage: str, pct: float, message: str, force: bool = False, version: Optional[int] = None) -> None:
    """Throttled to ~10 lines a second per stage so a fast loop cannot flood the app. `version`: the
    version a render makes (the app's status line names it)."""
    pct = max(0.0, min(100.0, float(pct)))
    now = time.monotonic()
    if not force and stage == _LAST["stage"] and now - _LAST["t"] < 0.1 and pct < 100.0 \
            and abs(pct - _LAST["pct"]) < 5.0:
        return
    _LAST.update(t=now, pct=pct, stage=stage)
    emit({"event": "progress", "stage": stage, "pct": round(pct, 1), "message": message,
          **({"version": version} if version is not None else {})})


def done(result) -> None:
    emit({"event": "done", "result": result})


def error(code: str, message: str, user_message: str) -> None:
    emit({"event": "error", "code": code, "message": message, "userMessage": user_message})


def log(msg: str) -> None:
    """Free-form developer log line, to stderr."""
    print(msg, file=sys.stderr, flush=True)
