"""CLI refusals and report outcomes, without starting an engine or FFmpeg."""
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
