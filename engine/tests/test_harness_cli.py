"""CLI refusals and report outcomes, without starting an engine or FFmpeg."""
import copy
import json
from types import SimpleNamespace

import pytest

from harness import cli


@pytest.mark.parametrize("command,takes", [("run", "unknown"), ("run", "held"),
                                          ("setup", "unknown"), ("run", "")])
def test_empty_selection_is_refused_before_setup(monkeypatch, capsys, command, takes):
    cfg = {"corpus": [{"id": "loop"}, {"id": "held"}], "heldOut": ["held"]}
    monkeypatch.setattr(cli, "Ctx", lambda a: SimpleNamespace(cfg=cfg))

    def unexpected_setup(*args):
        pytest.fail("an empty selection must not build the corpus")

    monkeypatch.setattr(cli, "setup", unexpected_setup)
    assert cli.main([command, "--takes", takes]) == 2
    assert "no takes selected" in capsys.readouterr().err


def test_setup_with_empty_ids_builds_no_takes(monkeypatch, tmp_path):
    song = tmp_path / "song"
    song.write_bytes(b"song")
    monkeypatch.setattr(cli.corpus, "ensure_song", lambda root: song)

    def unexpected_take(entry):
        pytest.fail("ids=[] must not select any corpus entry")

    c = SimpleNamespace(root=tmp_path, cfg={"corpus": [{"id": "one"}]}, take_dir=unexpected_take)
    assert cli.setup(c, []) == {"takes": {}, "made": {}, "mediaBytes": {}, "songBytes": 4}


def agreement_reports(tmp_path):
    report = {"split": "loop", "pins": {"engineCommit": "reference", "ffmpeg": {"sha256": "ff"},
                                       "ffprobe": {"sha256": "probe"}},
              "takes": {"one": {"wait": {"median": 10.0}}}, "wait": {"median": 10.0}}
    return report, copy.deepcopy(report), [tmp_path / "a.json", tmp_path / "b.json"]


@pytest.mark.parametrize("difference", ["takes", "split", "engineCommit", "ffmpeg", "ffprobe", "flow", "proxy",
                                        "missing pin"])
def test_agree_refuses_different_work_or_pins(tmp_path, capsys, difference):
    first, second, paths = agreement_reports(tmp_path)
    if difference == "takes":
        second["takes"] = {"other": second["takes"]["one"]}
    elif difference in ("split", "flow", "proxy"):
        second[difference] = True if difference == "proxy" else "other"
    elif difference == "engineCommit":
        second["pins"][difference] = "other"
    elif difference == "missing pin":
        for report in (first, second):
            del report["pins"]["ffmpeg"]
    else:
        second["pins"][difference]["sha256"] = "other"
    for path, report in zip(paths, (first, second)):
        path.write_text(json.dumps(report), encoding="utf-8")
    assert cli.main(["agree", *map(str, paths)]) == 2
    err = capsys.readouterr().err
    field = "take sets" if difference == "takes" else ("ffmpeg" if difference == "missing pin" else difference)
    assert field in err
    if difference == "takes":
        assert "one" in err and "other" in err


def test_agree_compares_hashes_without_requiring_identical_tool_paths(tmp_path, capsys):
    first, second, paths = agreement_reports(tmp_path)
    first["pins"]["ffmpeg"]["path"] = "tools/ffmpeg"
    second["pins"]["ffmpeg"]["path"] = "bin/ffmpeg"
    second["flow"] = "drafts"
    for path, report in zip(paths, (first, second)):
        path.write_text(json.dumps(report), encoding="utf-8")
    assert cli.main(["agree", *map(str, paths)]) == 0
    assert "agree within" in capsys.readouterr().out


@pytest.mark.parametrize("failed", ["draft", "still", "window", "coverage", "final", None])
def test_run_writes_reports_and_returns_failure_for_any_failed_check(monkeypatch, tmp_path, failed):
    def check(name):
        return {"status": "fail" if name == failed else "unset", "metrics": {}, "failures": []}

    cfg = {"corpus": [{"id": "one"}], "heldOut": [], "runs": 1, "thresholds": {}, "sizes": {}}
    c = SimpleNamespace(cfg=cfg, work=tmp_path, scratch=tmp_path / "scratch", python="unused",
                        ffmpeg="unused", ffprobe="unused", pins={"engineCommit": "reference"}, env=lambda p: {})
    take = SimpleNamespace(session=[{"note": "edit"}])
    ref = {"moment": 1.0, "window": [0.0, 2.0], "stills": [1.0]}
    run = {"seconds": {name: [1.0] for name in cli.replay.STEPS}, "final": 1.0,
           "files": [{}], "finalFile": {"final": {"sha256": "final"}}}
    checked = {"steps": [{"draft": check("draft"), "still": [check("still")], "window": check("window"),
                           "coverage": check("coverage")}], "final": check("final")}
    monkeypatch.setattr(cli, "Ctx", lambda a: c)
    monkeypatch.setattr(cli, "setup", lambda *args: {"takes": {"one": (take, [ref])}, "mediaBytes": {}})
    monkeypatch.setattr(cli, "Engine", lambda *args: SimpleNamespace(check_import=lambda: None))
    monkeypatch.setattr(cli, "git_head", lambda: {"commit": "candidate", "engineDirty": False})
    monkeypatch.setattr(cli, "ffmpeg_version", lambda p: "ffmpeg test")
    monkeypatch.setattr(cli, "load_sample", lambda: {})
    monkeypatch.setattr(cli.replay, "replay", lambda *args, **kwargs: run)
    monkeypatch.setattr(cli.replay, "check_take", lambda *args: checked)
    monkeypatch.setattr(cli.replay, "prune_duplicates", lambda runs: None)
    assert cli.main(["run", "--no-warmup"]) == (1 if failed else 0)
    reports = list((tmp_path / "runs").glob("*/report.json"))
    assert len(reports) == 1
    report = json.loads(reports[0].read_text(encoding="utf-8"))
    assert report["takes"]["one"]["steps"][0]["checks"] == checked["steps"][0]
    assert report["takes"]["one"]["final"]["check"] == checked["final"]
    assert reports[0].with_suffix(".md").is_file()
