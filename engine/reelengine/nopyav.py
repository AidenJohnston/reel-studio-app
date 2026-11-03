"""Stand in for PyAV (`av`), which Reel Studio does not ship.

faster-whisper imports `av` when it is imported, but only uses it to decode audio FILES. The engine always hands it
decoded samples (audio_env.read_wav), and PyAV's wheels carry GPL x264/x265 libraries the engine never uses, so the
installers leave it out. When `av` is not installed, an empty module takes its place: importing faster-whisper
works, and anything that does reach for PyAV fails with a message that says why.
"""
from __future__ import annotations

import importlib.util
import sys
import types

_UNSET = object()


def _missing(name: str):
    # AttributeError (not ImportError) so getattr(av, "__file__", None) and hasattr() stay safe.
    raise AttributeError(f"PyAV is not part of Reel Studio (av.{name} was used): decode the audio with ffmpeg "
                         "and pass faster-whisper the samples")


def install() -> bool:
    """Put the stand-in in sys.modules unless a real PyAV is importable. True when it did."""
    current = sys.modules.get("av", _UNSET)
    if current is _UNSET:
        if importlib.util.find_spec("av") is not None:
            return False
    elif current is not None:
        return False
    stub = types.ModuleType("av", __doc__)
    stub.__getattr__ = _missing   # PEP 562: called for any name the module doesn't have
    sys.modules["av"] = stub
    return True
