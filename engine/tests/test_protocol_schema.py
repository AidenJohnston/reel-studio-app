import io
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from reelengine import cli, project, proto

ENGINE = Path(__file__).resolve().parents[1]


def run_cli(argv):
    buf = io.StringIO()
    proto.set_stream(buf)
    try:
        code = cli.main(argv)
    finally:
        proto.set_stream(None)
    lines = [json.loads(l) for l in buf.getvalue().splitlines() if l.strip()]
    return code, lines


def test_error_has_code_message_and_user_message(tmp_path):
    code, lines = run_cli(["probe", str(tmp_path / "nope.mp4")])
    assert code == 1
    err = lines[-1]
    assert err["event"] == "error" and err["code"] == "NOT_FOUND"
    assert err["message"] and err["userMessage"]
    assert "—" not in err["userMessage"]          # no em dashes in user copy


def test_bad_args_is_a_protocol_error():
    code, lines = run_cli(["render"])
    assert code == 1 and lines[-1]["event"] == "error" and lines[-1]["userMessage"]


def test_progress_throttle_and_shape():
    buf = io.StringIO()
    proto.set_stream(buf)
    for i in range(200):
        proto.progress("x", i / 2, "Working")
    proto.done({"ok": True})
    proto.set_stream(None)
    lines = [json.loads(l) for l in buf.getvalue().splitlines()]
    assert all(set(l) >= {"event"} for l in lines)
    prog = [l for l in lines if l["event"] == "progress"]
    assert 1 <= len(prog) < 200
    assert all(0 <= l["pct"] <= 100 and l["message"] for l in prog)
    assert lines[-1] == {"event": "done", "result": {"ok": True}}


def test_stdout_is_json_lines_only_in_a_real_process(tmp_path):
    """Library chatter must never reach stdout: run the CLI as the app does."""
    env = dict(os.environ, PYTHONIOENCODING="utf-8")
    weird = tmp_path / "dossier ça marche"
    weird.mkdir()
    proc = subprocess.run([sys.executable, "-m", "reelengine", "probe", str(weird / "missing file.mp4")],
                          cwd=str(ENGINE), capture_output=True, text=True, encoding="utf-8", env=env)
    assert proc.returncode == 1
    for line in proc.stdout.splitlines():
        json.loads(line)
    assert json.loads(proc.stdout.splitlines()[-1])["code"] == "NOT_FOUND"


def test_new_project_is_valid():
    p = project.new_project("Why so many apps?")
    assert project.validate(p) == []
    assert p["slug"] == "why-so-many-apps"


@pytest.mark.parametrize("mutate,where", [
    (lambda p: p["cut"].update(keep=[{"from": "x1", "to": "w2"}]), "cut/keep/0/from"),
    (lambda p: p.pop("format"), "(root)"),
    (lambda p: p["captions"]["style"].update(color="white"), "captions/style/color"),
    (lambda p: p["zooms"].append({"anchor": {"from": "w1", "to": "w2"}, "scale": 9}), "zooms/0/scale"),
])
def test_schema_rejects_bad_projects(mutate, where):
    p = project.new_project("t")
    mutate(p)
    problems = project.validate(p)
    assert problems and any(where in x for x in problems), problems


def test_schema_allows_added_optional_fields():
    p = project.new_project("t")
    p["broll"].append({"id": "b1", "anchor": {"from": "w1", "to": "w3"}, "treatment": "card-above-head",
                       "asset": "Library/Images/x.png", "params": {"tilt": -2}, "futureField": 1})
    p["somethingNew"] = {"a": 1}
    assert project.validate(p) == []


def test_atomic_save_roundtrip_unicode(tmp_path):
    d = tmp_path / "Projets à moi" / "vidéo 1"
    p = project.new_project("Café ☕ talk")
    project.save(d, p)
    q = project.load(d)
    assert q["title"] == "Café ☕ talk"
    raw = (d / "project.json").read_bytes()
    assert b"\r\n" not in raw
