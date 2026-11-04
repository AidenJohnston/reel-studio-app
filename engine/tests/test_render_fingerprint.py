"""Saved renders are reusable only with the engine that made them."""
import pytest

import reelengine
from reelengine import project as projmod, render


def saved_project(tmp_path):
    media = tmp_path / "media"
    media.mkdir()
    (media / "take.mp4").write_bytes(b"unchanged source")
    proj = {"version": 1, "sources": [{"path": "media/take.mp4"}]}
    vdir = tmp_path / "versions" / "v1"
    vdir.mkdir(parents=True)
    projmod.write_json(vdir / "project.json", proj)
    return proj, vdir


def test_engine_upgrade_changes_fingerprint_and_selects_a_new_version(tmp_path, monkeypatch):
    proj, vdir = saved_project(tmp_path)
    monkeypatch.setattr(reelengine, "__version__", "0.1.2")
    original = render.asset_fingerprint(tmp_path, proj)
    projmod.write_json(vdir / "assets.json", original)

    assert render.asset_fingerprint(tmp_path, proj) == original
    assert render.pick_version(tmp_path, proj) == 1

    monkeypatch.setattr(reelengine, "__version__", "0.1.3")
    assert render.asset_fingerprint(tmp_path, proj) != original
    assert render.pick_version(tmp_path, proj) == 2
    assert projmod.read_json(vdir / "assets.json") == original


@pytest.mark.parametrize("legacy_fingerprint", [True, False], ids=["unversioned", "missing"])
def test_unknown_engine_version_cannot_reuse_a_saved_render(tmp_path, legacy_fingerprint):
    proj, vdir = saved_project(tmp_path)
    if legacy_fingerprint:
        source = tmp_path / "media" / "take.mp4"
        stat = source.stat()
        projmod.write_json(vdir / "assets.json", {
            "media/take.mp4": [stat.st_size, stat.st_mtime_ns], "work/transcript.json": None,
        })

    assert render.pick_version(tmp_path, proj) == 2
