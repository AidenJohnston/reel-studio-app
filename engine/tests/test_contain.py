"""The Windows Job Object setup (contain.py), against a stand-in kernel32: these are the calls and
their failure handling. That Windows then ends ffmpeg with the engine needs a Windows machine."""
import ctypes
import io
import json
import sys
import wave

import pytest

from reelengine import cli, contain, proto
from reelengine.contain import KILL_ON_JOB_CLOSE, contain_children


class Kernel32:
    """Plain functions, like ctypes' foreign functions, so contain.py can set restype/argtypes."""

    def __init__(self, assign_ok=True):
        self.flags = self.assigned = None
        self.closed = []

        def create(attrs, name):
            return 7

        def current():
            return -1

        def limit(job, kind, info, size):
            self.flags = info._obj.BasicLimitInformation.LimitFlags
            return 1

        def assign(job, process):
            self.assigned = (job, process)
            return 1 if assign_ok else 0

        def close(handle):
            self.closed.append(handle)
            return 1

        self.CreateJobObjectW, self.GetCurrentProcess = create, current
        self.SetInformationJobObject, self.AssignProcessToJobObject = limit, assign
        self.CloseHandle = close


def test_the_engine_joins_a_job_that_ends_its_children_with_it():
    k32 = Kernel32()
    contain_children(k32)
    assert k32.flags == KILL_ON_JOB_CLOSE
    assert k32.assigned == (7, -1)
    assert k32.closed == []        # closing the handle would end the job, and the engine with it


def test_an_engine_windows_will_not_contain_logs_why_and_runs_anyway(monkeypatch, capsys):
    monkeypatch.setattr(ctypes, "get_last_error", lambda: 5, raising=False)    # Windows-only in ctypes
    k32 = Kernel32(assign_ok=False)
    contain_children(k32)
    assert k32.closed == [7]
    assert "no Job Object (Windows error 5)" in capsys.readouterr().err


@pytest.mark.skipif(sys.platform != "win32", reason="the real kernel32 calls and the engine's own start-up")
def test_on_windows_a_command_finishes_when_the_engine_cannot_join_its_job(monkeypatch, capsys, tmp_path):
    """A real Job Object is made and set up; only joining it is refused, as Windows may refuse it."""
    real = ctypes.WinDLL("kernel32", use_last_error=True)

    class Refusing:
        def __getattr__(self, name):
            return getattr(real, name)

        @staticmethod
        def AssignProcessToJobObject(job, process):
            ctypes.set_last_error(5)
            return 0

    monkeypatch.setattr(contain, "contain_children", lambda: contain_children(Refusing()))
    song = tmp_path / "tone.wav"
    with wave.open(str(song), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(8000)
        w.writeframes(b"\0\0" * 8000)
    out = io.StringIO()
    proto.set_stream(out)
    try:
        code = cli.main(["probe", str(song)])
    finally:
        proto.set_stream(None)
    assert code == 0, out.getvalue()
    assert json.loads(out.getvalue().splitlines()[-1])["event"] == "done"
    assert "no Job Object (Windows error 5)" in capsys.readouterr().err
