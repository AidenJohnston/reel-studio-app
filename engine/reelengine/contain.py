"""Windows: the engine's children (ffmpeg) end when the engine does, even when it crashes.

The engine puts itself in a Job Object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE. Its children join the
job when they start, and Windows ends every process in the job when the job's last handle closes,
which is when the engine exits for any reason. macOS and Linux need none of this: there Reel Studio
runs the engine as its own process group and stops the whole group (app/src/main/engine.ts).

When Windows will not make or join the job, the engine logs why and runs anyway. Stop still ends its
whole tree (taskkill /T), and only a crash of the engine itself can then leave an ffmpeg running.
Refusing instead would leave Reel Studio unable to edit at all on such a machine.
"""
from __future__ import annotations

import ctypes
from ctypes import wintypes

from . import proto

KILL_ON_JOB_CLOSE = 0x2000
EXTENDED_LIMIT_INFORMATION = 9


class _Basic(ctypes.Structure):
    _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD), ("SchedulingClass", wintypes.DWORD)]


class _Extended(ctypes.Structure):
    _fields_ = [("BasicLimitInformation", _Basic), ("IoInfo", ctypes.c_uint64 * 6),
                ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]


def contain_children(kernel32=None) -> None:
    k32 = kernel32 or ctypes.WinDLL("kernel32", use_last_error=True)
    k32.CreateJobObjectW.restype = wintypes.HANDLE
    k32.GetCurrentProcess.restype = wintypes.HANDLE
    k32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    k32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    k32.CloseHandle.argtypes = [wintypes.HANDLE]
    info = _Extended()
    info.BasicLimitInformation.LimitFlags = KILL_ON_JOB_CLOSE
    job = k32.CreateJobObjectW(None, None)
    if job and k32.SetInformationJobObject(job, EXTENDED_LIMIT_INFORMATION, ctypes.byref(info), ctypes.sizeof(info)) \
            and k32.AssignProcessToJobObject(job, k32.GetCurrentProcess()):
        # the handle stays open for the engine's whole life on purpose: closing it ends the job
        return
    error = ctypes.get_last_error()
    if job:
        k32.CloseHandle(job)
    proto.log(f"[contain] no Job Object (Windows error {error}), so ffmpeg may outlive a crash of this engine")
