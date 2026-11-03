"""PyAV stays out of the bundle (GPL x264/x265 in its wheels); faster-whisper must still import and listen."""
import os
import subprocess
import sys
from pathlib import Path

import pytest

from reelengine import nopyav

ENGINE = Path(__file__).resolve().parents[1]


def test_stand_in_replaces_a_missing_pyav(monkeypatch):
    monkeypatch.setitem(sys.modules, "av", None)   # what `import av` sees when PyAV isn't installed
    assert nopyav.install() is True
    av = sys.modules["av"]
    assert getattr(av, "__file__", None) is None
    assert not hasattr(av, "open")
    with pytest.raises(AttributeError, match="not part of Reel Studio"):
        av.open("take.mov")
    assert nopyav.install() is False               # already in place


def test_faster_whisper_imports_without_pyav():
    code = (
        "import sys\n"
        "sys.modules['av'] = None\n"
        "import reelengine\n"
        "import numpy as np\n"
        "from faster_whisper import WhisperModel\n"
        "from faster_whisper.audio import pad_or_trim\n"
        "assert pad_or_trim(np.zeros(10, dtype=np.float32), 20).shape == (20,)\n"
        "try:\n"
        "    from faster_whisper.audio import decode_audio\n"
        "    decode_audio('take.wav')\n"
        "except AttributeError as exc:\n"
        "    assert 'not part of Reel Studio' in str(exc), exc\n"
        "else:\n"
        "    raise SystemExit('decode_audio worked without PyAV')\n"
        "print('ok')\n")
    env = {**os.environ, "PYTHONPATH": str(ENGINE)}
    r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, env=env, cwd=str(ENGINE))
    assert r.returncode == 0 and r.stdout.strip() == "ok", r.stderr


def test_requirements_pin_no_pyav():
    pins = [ln.split("==")[0].strip().lower() for ln in (ENGINE / "requirements.txt").read_text().splitlines()
            if ln and not ln.startswith((" ", "#"))]
    assert "av" not in pins
    assert "faster-whisper" in pins
