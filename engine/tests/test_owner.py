"""One writer per project (owner.py): while Reel Studio has a project (work/.owner.lock) a command run by
hand refuses it, and the app's own commands join only with the token the lock holds; a command run by hand
holds the project itself while it runs, so the app can't claim it then (app/src/main/owner.ts)."""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

from reelengine import owner
from reelengine.proto import EngineError

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


def test_fails_if_a_token_the_lock_does_not_hold_joins_the_project(tmp_path):
    project = tmp_path / "bread"
    (project / "work").mkdir(parents=True)
    lock = project / "work" / ".owner.lock"
    # the job that held it has let go: no lock, then another job's lock
    assert last_event(project, "render", "--owner", "an old job")["code"] == "NOT_OWNER"
    lock.write_text(json.dumps({"app": "Reel Studio", "token": "the next job"}))
    assert last_event(project, "render", "--owner", "an old job")["code"] == "NOT_OWNER"
    assert last_event(project, "render", "--owner", "the next job")["code"] == "NO_PROJECT"


def test_fails_if_a_command_run_by_hand_lets_another_writer_in_while_it_runs(tmp_path):
    project = tmp_path / "bread"
    project.mkdir()
    lock = project / "work" / ".owner.lock"
    with owner.claim(project, None):
        held = json.loads(lock.read_text(encoding="utf-8"))
        # what app/src/main/owner.ts reads to refuse a job's claim: not the app's, and this process, by its pid and
        # when it started, so the pid's next process is not taken for it
        assert held["app"] != "Reel Studio" and held["pid"] == os.getpid() and held["token"]
        assert abs(held["started"] / 1000 - time.time()) < 600
        with pytest.raises(EngineError) as again:
            with owner.claim(project, None):
                pass
        assert again.value.code == "PROJECT_OPEN"
        assert last_event(project, "render")["code"] == "PROJECT_OPEN"
        assert last_event(project, "render", "--owner", "made up")["code"] == "NOT_OWNER"
    assert not lock.exists()        # let go when it ends
    # a command that fails lets go too, and one on a folder that isn't there leaves none behind
    assert last_event(project, "render")["code"] == "NO_PROJECT"
    assert not lock.exists()
    assert last_event(tmp_path / "typo", "render")["code"] == "NO_PROJECT"
    assert not (tmp_path / "typo").exists()


def test_fails_if_a_claim_can_be_seen_before_its_identity_is_in_it(tmp_path, monkeypatch):
    """The app reads a lock it finds to decide whether its writer is alive (docs/ownership.md): one seen empty while
    its writer fills it in could be taken for abandoned. The identity is complete before the lock exists."""
    project = tmp_path / "bread"
    lock = project / "work" / ".owner.lock"
    seen = []
    link = os.link

    def watched(src, dst):
        seen.append((lock.exists(), json.loads(Path(src).read_text(encoding="utf-8"))))
        link(src, dst)
    monkeypatch.setattr(os, "link", watched)
    with owner.claim(project, None):
        assert json.loads(lock.read_text(encoding="utf-8")) == seen[0][1]
    assert seen[0][0] is False and seen[0][1]["pid"] == os.getpid()
    assert [f.name for f in (project / "work").iterdir()] == []      # nothing left of the identity's own file


def test_the_preview_copy_builds_while_reel_studio_has_the_project_open(tmp_path):
    """The app starts `proxy` from inside the import and note jobs, which hold the lock, and lets it run on
    after they end, so it carries no job's token (app/src/main/proxy-builds.ts). That is safe only because it
    writes nothing outside work/proxy/ (compositing/test_proxy.py pins that)."""
    project = tmp_path / "bread"
    (project / "work").mkdir(parents=True)
    (project / "work" / ".owner.lock").write_text(json.dumps({"app": "Reel Studio", "token": "the app's note"}))
    assert last_event(project, "proxy").get("code") != "PROJECT_OPEN"
