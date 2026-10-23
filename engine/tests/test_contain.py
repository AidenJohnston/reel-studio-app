"""The Windows Job Object setup (contain.py), against a stand-in kernel32: these are the calls and
their failure handling. That Windows then ends ffmpeg with the engine needs a Windows machine."""
import ctypes

import pytest

from reelengine.contain import KILL_ON_JOB_CLOSE, contain_children
from reelengine.proto import EngineError


class Kernel32:
    """Plain functions, like ctypes' foreign functions, so contain.py can set restype/argtypes."""

    def __init__(self, assign_ok=True):
        self.flags = self.assigned = None

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

        self.CreateJobObjectW, self.GetCurrentProcess = create, current
        self.SetInformationJobObject, self.AssignProcessToJobObject = limit, assign


def test_the_engine_joins_a_job_that_ends_its_children_with_it():
    k32 = Kernel32()
    contain_children(k32)
    assert k32.flags == KILL_ON_JOB_CLOSE
    assert k32.assigned == (7, -1)


def test_an_engine_windows_will_not_contain_refuses_to_start(monkeypatch):
    monkeypatch.setattr(ctypes, "get_last_error", lambda: 5, raising=False)    # Windows-only in ctypes
    with pytest.raises(EngineError) as e:
        contain_children(Kernel32(assign_ok=False))
    assert e.value.code == "NO_JOB_OBJECT" and "error 5" in e.value.message
