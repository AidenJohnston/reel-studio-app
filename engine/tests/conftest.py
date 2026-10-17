import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def mkwords(spec, source="s1", start_id=0):
    """[(start, end, text), ...] -> transcript words with ids."""
    return [{"id": f"w{start_id + i}", "source": source, "s": s, "e": e, "w": w}
            for i, (s, e, w) in enumerate(spec)]


def sentence_words(text, t0, source="s1", start_id=0, word_dur=0.30, gap=0.05):
    out, t = [], t0
    for i, tok in enumerate(text.split()):
        out.append({"id": f"w{start_id + i}", "source": source, "s": round(t, 3),
                    "e": round(t + word_dur, 3), "w": tok})
        t += word_dur + gap
    return out


# --- test-only escape hatches ------------------------------------------
# The engine refuses project paths outside <project>/{media,work} and <root>/Library, and refuses
# to fetch from loopback/private hosts. The compositing tests read shared generated assets from
# pytest's temp folder and serve images from 127.0.0.1, so the suite opts in through two env vars
# the app never sets. The security tests in test_secfix.py switch them OFF explicitly.
import os as _os

import pytest as _pytest


@_pytest.fixture(autouse=True, scope="session")
def _engine_test_hatches(tmp_path_factory):
    repo = Path(__file__).resolve().parents[2]
    dirs = [str(tmp_path_factory.getbasetemp()), str(repo / "testdata")]
    for env in ("REELENGINE_TEST_TAKES", "REELENGINE_TEST_MUSIC"):
        if _os.environ.get(env):
            dirs.append(_os.environ[env])
    old = {k: _os.environ.get(k) for k in ("REELENGINE_EXTRA_READ_DIRS", "REELENGINE_ALLOW_PRIVATE_FETCH")}
    _os.environ["REELENGINE_EXTRA_READ_DIRS"] = _os.pathsep.join(dirs)
    _os.environ["REELENGINE_ALLOW_PRIVATE_FETCH"] = "1"
    yield
    for k, v in old.items():
        if v is None:
            _os.environ.pop(k, None)
        else:
            _os.environ[k] = v


@_pytest.fixture(autouse=True, scope="session")
def _engine_test_cache(tmp_path_factory):
    """The song-analysis cache (music.analyze_track_cached) goes to a temp folder, never the user's."""
    old = _os.environ.get("REELENGINE_CACHE_DIR")
    _os.environ["REELENGINE_CACHE_DIR"] = str(tmp_path_factory.mktemp("engine-cache"))
    yield
    if old is None:
        _os.environ.pop("REELENGINE_CACHE_DIR", None)
    else:
        _os.environ["REELENGINE_CACHE_DIR"] = old
