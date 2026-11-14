"""Saved renders and cached covers are reusable only while what made them is unchanged."""
from types import SimpleNamespace

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


def test_a_changed_face_track_cannot_reuse_a_saved_render(tmp_path):
    # Fails if a regenerated face track (another face centre, so another crop) lets an export hand back the old
    # video as reused (Astra engine review 3).
    proj, vdir = saved_project(tmp_path)
    face = tmp_path / "work" / "face-s1.json"
    face.parent.mkdir()
    face.write_text('{"track": [[0, 400, 600, 200, 260]]}', encoding="utf-8")
    projmod.write_json(vdir / "assets.json", render.asset_fingerprint(tmp_path, proj))
    assert render.pick_version(tmp_path, proj) == 1
    face.write_text('{"track": [[0, 700, 900, 200, 260]]}', encoding="utf-8")
    assert render.pick_version(tmp_path, proj) == 2


def test_a_replaced_caption_font_cannot_reuse_a_saved_render(tmp_path, monkeypatch):
    # Fails if the font file every subtitle is drawn in is replaced under the same name and an export hands back
    # the old video as reused (Astra engine review 3).
    from reelengine import captions
    proj, vdir = saved_project(tmp_path)
    proj["captions"] = {"enabled": True, "style": {"font": "Test Sans"}}
    font = tmp_path / "fonts" / "TestSans.ttf"
    font.parent.mkdir()
    font.write_bytes(b"first font")
    monkeypatch.setattr(captions, "resolve_font", lambda name: (name, font, {}, None))
    projmod.write_json(vdir / "assets.json", render.asset_fingerprint(tmp_path, proj))
    assert render.pick_version(tmp_path, proj) == 1
    font.write_bytes(b"another font, longer")
    assert render.pick_version(tmp_path, proj) == 2


def test_an_edited_script_file_cannot_reuse_a_saved_render(tmp_path):
    # Fails if script.txt, which the captions follow when project.json has no script, is edited and an export
    # hands back the old video as reused, or frames takes the old render for the edit's picture (architecture
    # review 5).
    proj, vdir = saved_project(tmp_path)
    script = tmp_path / "script.txt"
    script.write_text("Hello and welcome to the show.", encoding="utf-8")
    projmod.write_json(vdir / "assets.json", render.asset_fingerprint(tmp_path, proj))
    key = render.picture_key(tmp_path, proj)
    assert render.pick_version(tmp_path, proj) == 1
    script.write_text("Hello, and welcome back to the show.", encoding="utf-8")
    assert render.pick_version(tmp_path, proj) == 2
    assert render.picture_key(tmp_path, proj) != key


def test_the_engine_version_is_the_release_version():
    # Fails if a release ships engine code under an older version: its renders carry that version in their
    # fingerprint, so a saved render made by different code could be handed back as reused.
    import json
    from pathlib import Path
    repo = Path(reelengine.__file__).resolve().parents[2]
    release = json.loads((repo / "package.json").read_text(encoding="utf-8"))["version"]
    pyproject = (repo / "engine" / "pyproject.toml").read_text(encoding="utf-8")
    assert reelengine.__version__ == release
    assert f'version = "{release}"' in pyproject


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


def test_replacing_the_source_video_in_place_makes_a_new_cover(tmp_path, monkeypatch):
    # Fails if the cover cache serves the old video's cover after the source file is replaced while
    # project.json, the transcript and the face track stay the same.
    proj, _ = saved_project(tmp_path)
    proj["sources"][0]["id"] = "s1"
    source = tmp_path / "media" / "take.mp4"

    def render_cover(ctx, proj, tl, src_meta, src_paths, faces, out_png, warnings):
        out_png.parent.mkdir(parents=True, exist_ok=True)
        out_png.write_bytes(src_paths["s1"].read_bytes())    # the cover shows what the source holds
        return out_png
    monkeypatch.setattr(render, "render_cover", render_cover)
    ctx = SimpleNamespace(project_dir=tmp_path, work=tmp_path / "work", draft=False)

    def cover() -> bytes:
        out = tmp_path / "out" / "cover.png"
        render.CoverJob(ctx, proj, None, {}, {"s1": source}, {}, out, []).result()
        return out.read_bytes()

    assert cover() == b"unchanged source"
    source.write_bytes(b"replacement footage")      # a different size, so mtime resolution cannot hide it
    assert cover() == b"replacement footage"
