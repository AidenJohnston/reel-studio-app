"""The Windows Job Object setup (contain.py), against a stand-in kernel32: these are the calls and
their failure handling. On Windows, the real job is checked to end a crashed engine's child."""
import ctypes
import io
import json
import subprocess
import sys
import wave
from ctypes import wintypes
from pathlib import Path

import pytest

from reelengine import cli, contain, proto
from reelengine.contain import KILL_ON_JOB_CLOSE, contain_children

ENGINE = Path(__file__).resolve().parents[1]


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


def test_a_direct_call_of_the_engine_cli_never_joins_a_job(monkeypatch):
    """Tests call cli.main inside pytest: only the engine process (cli.run) may join the job."""
    joined = []
    monkeypatch.setattr(contain, "contain_children", lambda *a: joined.append(a))
    monkeypatch.setattr(sys, "platform", "win32")
    proto.set_stream(io.StringIO())
    try:
        cli.main(["probe", "missing.mp4"])
    finally:
        proto.set_stream(None)
    assert joined == []


# Runs the engine the way the app does (python -m reelengine), in its own process, with only joining
# the job refused: a real Job Object is made and set up first.
REFUSING_JOIN = r"""
import ctypes, runpy, sys
from reelengine import contain
real = ctypes.WinDLL("kernel32", use_last_error=True)

class Refusing:
    def __getattr__(self, name):
        return getattr(real, name)

    @staticmethod
    def AssignProcessToJobObject(job, process):
        ctypes.set_last_error(5)
        return 0

contain_children = contain.contain_children
contain.contain_children = lambda: contain_children(Refusing())
sys.argv = ["reelengine", *sys.argv[1:]]
runpy.run_module("reelengine", run_name="__main__", alter_sys=True)
"""


@pytest.mark.skipif(sys.platform != "win32", reason="the real kernel32 calls and the engine's own start-up")
def test_on_windows_a_command_finishes_when_the_engine_cannot_join_its_job(tmp_path):
    song = tmp_path / "tone.wav"
    with wave.open(str(song), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(8000)
        w.writeframes(b"\0\0" * 8000)
    proc = subprocess.run([sys.executable, "-c", REFUSING_JOIN, "probe", str(song)], cwd=ENGINE,
                          capture_output=True, text=True, encoding="utf-8", timeout=120)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert json.loads(proc.stdout.splitlines()[-1])["event"] == "done"
    assert "no Job Object (Windows error 5)" in proc.stderr


# An engine that joins its job, starts a child (as a render starts ffmpeg), reports the child's pid, and
# dies without any clean-up once its input closes.
CRASHING_ENGINE = r"""
import os, subprocess, sys
from reelengine import contain
contain.contain_children()
child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
print(child.pid, flush=True)
sys.stdin.readline()
os._exit(1)
"""

# Joins a fresh job without contain.py: exit 0, or the Windows error. A test runner that is itself in a
# job allowing no job inside it (some CI services) makes every engine run without one; that path has
# its own test (test_on_windows_a_command_finishes_when_the_engine_cannot_join_its_job).
NESTED_JOB_PROBE = r"""
import ctypes, sys
k32 = ctypes.WinDLL("kernel32", use_last_error=True)
k32.CreateJobObjectW.restype = ctypes.c_void_p
k32.GetCurrentProcess.restype = ctypes.c_void_p
k32.AssignProcessToJobObject.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
job = k32.CreateJobObjectW(None, None)
sys.exit(0 if job and k32.AssignProcessToJobObject(job, k32.GetCurrentProcess()) else ctypes.get_last_error() or 1)
"""

SYNCHRONIZE, PROCESS_TERMINATE = 0x00100000, 0x0001
WAIT_OBJECT_0, WAIT_TIMEOUT = 0, 0x102


@pytest.mark.skipif(sys.platform != "win32", reason="the real Job Object")
def test_on_windows_a_crashed_engine_takes_its_child_with_it():
    probe = subprocess.run([sys.executable, "-c", NESTED_JOB_PROBE], timeout=60)
    if probe.returncode:
        pytest.skip(f"this test runner's own job allows no job inside it (Windows error {probe.returncode})")
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.OpenProcess.restype = wintypes.HANDLE
    k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    k32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    k32.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
    k32.CloseHandle.argtypes = [wintypes.HANDLE]
    engine = subprocess.Popen([sys.executable, "-c", CRASHING_ENGINE], cwd=ENGINE,
                              stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    try:
        pid = int(engine.stdout.readline())
        # held open, so the child's number can't pass to another process while this test looks at it
        child = k32.OpenProcess(SYNCHRONIZE | PROCESS_TERMINATE, False, pid)
        assert child, ctypes.get_last_error()
        try:
            assert k32.WaitForSingleObject(child, 0) == WAIT_TIMEOUT    # running while the engine is
            engine.stdin.close()
            assert engine.wait(timeout=30) == 1
            assert k32.WaitForSingleObject(child, 10_000) == WAIT_OBJECT_0
        finally:
            k32.TerminateProcess(child, 1)
            k32.CloseHandle(child)
    finally:
        if engine.poll() is None:
            engine.kill()
