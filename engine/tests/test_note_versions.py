"""A saved version folder is never rewritten (docs/versions.md). Real renders of a 3-second clip
through the CLI the app calls."""
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ENGINE = Path(__file__).resolve().parents[1]
pytestmark = pytest.mark.skipif(not shutil.which("ffmpeg"), reason="needs ffmpeg")


def last_event(project: Path, *args: str) -> dict:
    env = dict(os.environ, REELENGINE_ROOT=str(project.parent / "root"), REELENGINE_CACHE=str(project.parent / "cache"))
    r = subprocess.run([sys.executable, "-m", "reelengine", *args, "--project", str(project)],
                       cwd=ENGINE, env=env, capture_output=True, text=True, timeout=300)
    return json.loads(r.stdout.strip().splitlines()[-1])


def engine(project: Path, *args: str) -> dict:
    last = last_event(project, *args)
    assert last["event"] == "done", last
    return last["result"]


@pytest.fixture
def project(tmp_path):
    clip = tmp_path / "take.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=360x640:rate=30:duration=3",
                    "-f", "lavfi", "-i", "sine=frequency=300:duration=3", "-shortest", "-c:v", "libx264",
                    "-pix_fmt", "yuv420p", "-c:a", "aac", str(clip)], check=True)
    pdir = tmp_path / "bread"
    engine(pdir, "init", "--title", "Bread", str(clip))
    words = [{"id": f"w{i}", "source": "s1", "s": 0.2 + i * 0.5, "e": 0.6 + i * 0.5, "w": w}
             for i, w in enumerate("we bake bread every single day".split())]
    (pdir / "work" / "transcript.json").write_text(json.dumps({"words": words}))
    p = json.loads((pdir / "project.json").read_text())
    p["format"] = {"width": 360, "height": 640, "fps": 30}
    p["cut"]["keep"] = [{"from": "w0", "to": "w5"}]
    p["captions"]["enabled"] = False
    (pdir / "project.json").write_text(json.dumps(p))
    return pdir


def test_the_same_edit_gets_its_saved_version_back_untouched(project):
    first = engine(project, "render")
    assert first["version"] == 1
    v1 = project / "versions" / "v1"
    before = {f.name: f.read_bytes() for f in v1.iterdir() if f.is_file()}
    p = json.loads((project / "project.json").read_text())
    p["post"]["caption"] = "A new caption changes no picture"
    (project / "project.json").write_text(json.dumps(p))

    again = engine(project, "render")
    assert again["version"] == 1 and again["reused"] is True
    assert {f.name: f.read_bytes() for f in v1.iterdir() if f.is_file()} == before


def test_changed_words_make_a_new_version_with_their_subtitles(project):
    p = json.loads((project / "project.json").read_text())
    p["captions"]["enabled"] = True
    (project / "project.json").write_text(json.dumps(p))
    assert engine(project, "render")["version"] == 1
    t = json.loads((project / "work" / "transcript.json").read_text())
    t["words"][2]["w"] = "loaves"          # the words were heard again; the edit is the same
    (project / "work" / "transcript.json").write_text(json.dumps(t))

    again = engine(project, "render")
    assert again["version"] == 2 and not again.get("reused")
    shown = lambda v: " ".join(c["text"] for c in json.loads((project / "versions" / v / "captions.json").read_text())["cues"]).lower()
    assert "loaves" in shown("v2") and "loaves" not in shown("v1")


def test_a_leftover_attempt_above_the_saved_version_is_replaced(project):
    stale = project / "versions" / "v1"           # a note that crashed before it was saved
    stale.mkdir(parents=True)
    (stale / "notes.md").write_text("# v1\n\nNote: the crashed note\n")

    assert engine(project, "render")["version"] == 1
    assert not (stale / "notes.md").exists()
