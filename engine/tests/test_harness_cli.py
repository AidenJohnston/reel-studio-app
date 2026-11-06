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


@pytest.mark.parametrize("difference", ["takes", "split", "engineCommit", "ffmpeg", "ffprobe", "flow",
                                        "missing pin"])
def test_agree_refuses_different_work_or_pins(tmp_path, capsys, difference):
    first, second, paths = agreement_reports(tmp_path)
    if difference == "takes":
        second["takes"] = {"other": second["takes"]["one"]}
    elif difference in ("split", "flow"):
        second[difference] = "other"
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
    assert ("ffmpeg" if difference == "missing pin" else difference) in err
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
