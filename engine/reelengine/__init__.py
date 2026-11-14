"""Reel Studio media engine."""
import time as _time

__version__ = "0.1.2"
# When this process started, near enough: a claim on a project records it beside the pid (owner.py), so a pid another
# process reuses later is not taken for this one. Python has no portable way to ask; this module loads first.
STARTED_AT = _time.time()

# Before anything imports faster-whisper: it imports PyAV, which the installers leave out (see nopyav.py).
from . import nopyav as _nopyav

_nopyav.install()
