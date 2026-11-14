"""One writer per project (owner.py): while Reel Studio has a project (work/.owner.lock) a command run by
hand refuses it, and the app's own commands join only with the token the lock holds; a command run by hand
holds the project itself while it runs, so the app can't claim it then (app/src/main/owner.ts)."""
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from reelengine import owner
from reelengine.proto import EngineError

ENGINE = Path(__file__).resolve().parents[1]


def last_event(project: Path, *args: str) -> dict:
    env = dict(os.environ, REELENGINE_ROOT=str(project.parent / "root"), REELENGINE_CACHE=str(project.parent / "cache"))
    env.pop(owner.APP_ENV, None)    # run by hand
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


def test_fails_if_a_token_the_lock_does_not_hold_joins_the_project(tmp_path):
    project = tmp_path / "bread"
    (project / "work").mkdir(parents=True)
    lock = project / "work" / ".owner.lock"
    # the job that held it has let go: no lock, then another job's lock
    assert last_event(project, "render", "--owner", "an old job")["code"] == "NOT_OWNER"
    lock.write_text(json.dumps({"app": "Reel Studio", "token": "the next job"}))
    assert last_event(project, "render", "--owner", "an old job")["code"] == "NOT_OWNER"
    assert last_event(project, "render", "--owner", "the next job")["code"] == "NO_PROJECT"


def test_fails_if_a_command_run_by_hand_lets_another_writer_in_while_it_runs(tmp_path, monkeypatch):
    monkeypatch.delenv(owner.APP_ENV, raising=False)
    project = tmp_path / "bread"
    project.mkdir()
    lock = project / "work" / ".owner.lock"
    with owner.claim(project, None):
        held = json.loads(lock.read_text(encoding="utf-8"))
        # what app/src/main/owner.ts reads to refuse a job's claim: not the app's, and a live process
        assert held["app"] != "Reel Studio" and held["pid"] == os.getpid() and held["token"]
        with pytest.raises(EngineError) as again:
            with owner.claim(project, None):
                pass
        assert again.value.code == "PROJECT_OPEN"
        assert last_event(project, "render")["code"] == "PROJECT_OPEN"
        assert last_event(project, "render", "--owner", "made up")["code"] == "NOT_OWNER"
    # let go when it ends, and the work folder it made for the lock goes with it
    assert not (project / "work").exists()
    # a command that fails lets go too
    assert last_event(project, "render")["code"] == "NO_PROJECT"
    assert not lock.exists()


def test_the_preview_copy_builds_while_reel_studio_has_the_project_open(tmp_path):
    """The app starts `proxy` from inside the import and note jobs, which hold the lock, and lets it run on
    after they end, so it carries no job's token (app/src/main/proxy-builds.ts). That is safe only because it
    writes nothing outside work/proxy/ (compositing/test_proxy.py pins that)."""
    project = tmp_path / "bread"
    (project / "work").mkdir(parents=True)
    (project / "work" / ".owner.lock").write_text(json.dumps({"app": "Reel Studio", "token": "the app's note"}))
    assert last_event(project, "proxy").get("code") != "PROJECT_OPEN"
