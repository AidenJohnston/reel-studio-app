"""Reel Studio media engine."""
__version__ = "0.1.2"

# Before anything imports faster-whisper: it imports PyAV, which the installers leave out (see nopyav.py).
from . import nopyav as _nopyav

_nopyav.install()
