"""While Reel Studio has a project open (work/.owner.lock), a command run by hand refuses it, and the
app's own commands, which carry its job's token, go ahead (owner.py). Through the CLI the app calls."""
import json
import os
import subprocess
import sys
from pathlib import Path

ENGINE = Path(__file__).resolve().parents[1]


def last_event(project: Path, *args: str) -> dict:
    env = dict(os.environ, REELENGINE_ROOT=str(project.parent / "root"), REELENGINE_CACHE=str(project.parent / "cache"))
    r = subprocess.run([sys.executable, "-m", "reelengine", *args, "--project", str(project)],
                       cwd=ENGINE, env=env, capture_output=True, text=True, timeout=120)
    return json.loads(r.stdout.strip().splitlines()[-1])


def test_a_render_run_by_hand_refuses_a_project_reel_studio_has_open(tmp_path):
    project = tmp_path / "bread"
    (project / "work").mkdir(parents=True)
    lock = project / "work" / ".owner.lock"
    lock.write_text(json.dumps({"app": "Reel Studio", "token": "the app's note"}))

    refused = last_event(project, "render")
    assert refused["event"] == "error" and refused["code"] == "PROJECT_OPEN"
    assert str(lock) in refused["userMessage"]

    # the app's own render gets past the check (and then finds this folder has no project yet)
    assert last_event(project, "render", "--owner", "the app's note")["code"] == "NO_PROJECT"
