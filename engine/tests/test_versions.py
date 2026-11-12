"""save-version and export (versions.py) on a real 2 s take: a saved edit is its draft, never a full
render; Export renders once, hands back the same file while nothing changed, and reports what the file
really is."""
from __future__ import annotations

import json
import subprocess

import pytest

from conftest import sentence_words
from reelengine import compose_util, init, project as projmod, render, versions
from reelengine.proto import EngineError


@pytest.fixture
def project(tmp_path):
    take = tmp_path / "take.mp4"
    subprocess.run([compose_util.ffmpeg_bin(), "-y", "-v", "error",
                    "-f", "lavfi", "-i", "testsrc2=size=360x640:rate=30:duration=2.5",
                    "-f", "lavfi", "-i", "sine=frequency=220:duration=2.5",
                    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
                    str(take)], check=True, capture_output=True)
    dir_ = tmp_path / "p"
    init.run(dir_, "Test", [str(take)])
    proj = projmod.load(dir_)
    sid = proj["sources"][0]["id"]
    words = sentence_words("one two three four five six", 0.2, source=sid)
    (dir_ / "work").mkdir(exist_ok=True)
    (dir_ / "work" / "transcript.json").write_text(json.dumps({"words": words}), encoding="utf-8")
    proj["cut"]["keep"] = [{"from": words[0]["id"], "to": words[-1]["id"]}]
    proj["captions"]["enabled"] = False      # no font work: this is about the files, not the look
    projmod.save(dir_, proj)
    return dir_


@pytest.fixture
def renders(monkeypatch):
    """Every render.run call, as (draft, window)."""
    calls = []
    real = render.run

    def spy(project_dir, draft=False, window=None, **kw):
        calls.append((draft, window))
        return real(project_dir, draft=draft, window=window, **kw)
    monkeypatch.setattr(render, "run", spy)
    return calls


def edit(project_dir, **changes):
    proj = projmod.load(project_dir)
    proj.update(changes)
    projmod.save(project_dir, proj)


def test_a_saved_edit_is_its_draft_and_no_full_render(project, renders):
    r = versions.save(project)
    v1 = project / "versions" / "v1"
    assert r["version"] == 1 and r["draft"] is True and r["file"] == str(v1 / "draft.mp4")
    assert renders == [(True, None)]
    assert (v1 / "draft.mp4").exists() and (v1 / "cover.png").exists()
    assert not (v1 / "export.mp4").exists()
    assert projmod.load(project)["version"] == 1
    assert projmod.edit_signature(projmod.read_json(v1 / "project.json")) == projmod.edit_signature(projmod.load(project))
    # the screen shows this version now: the next edit's moments are measured from it
    base = projmod.read_json(project / "work" / "moments" / "base.json")
    assert projmod.edit_signature(base["project"]) == projmod.edit_signature(projmod.load(project))


def test_saving_uses_the_draft_already_made_for_this_edit(project, renders):
    render.run(project, draft=True)          # what moments or render_draft left in versions/preview
    renders.clear()
    versions.save(project)
    assert renders == []
    # a sound-only change is not on screen, but the draft has sound: it is drawn again
    edit(project, music=dict(projmod.load(project)["music"], level="quiet"))
    r = versions.save(project)
    assert renders == [(True, None)] and r["version"] == 2


def test_an_unchanged_edit_keeps_its_version_and_a_changed_one_gets_the_next(project):
    assert versions.save(project)["version"] == 1
    assert versions.save(project)["version"] == 1
    edit(project, post={"caption": "only the post text", "hashtags": [], "keywords": []})
    assert versions.save(project)["version"] == 1       # nothing in the video changed
    edit(project, cut=dict(projmod.load(project)["cut"], keep=[{"from": "w0", "to": "w3"}]))
    assert versions.save(project)["version"] == 2
    assert (project / "versions" / "v1" / "draft.mp4").exists()   # the earlier version still plays


def test_export_renders_once_then_hands_back_the_same_file(project, renders):
    versions.save(project)
    renders.clear()
    first = versions.export(project)
    v1 = project / "versions" / "v1"
    assert first["version"] == 1 and first["file"] == str(v1 / "export.mp4") and first["reused"] is False
    assert renders == [(False, None)]
    assert not (v1 / "draft.mp4").exists()      # the full-quality file is this version now
    assert first["cover"] == str(v1 / "cover.png")
    mtime = (v1 / "export.mp4").stat().st_mtime_ns

    again = versions.export(project)
    assert again["reused"] is True and again["file"] == first["file"] and renders == [(False, None)]
    assert (v1 / "export.mp4").stat().st_mtime_ns == mtime
    # saving the same edit again keeps pointing at the export
    assert versions.save(project) == {"version": 1, "file": first["file"], "draft": False, "versionDir": str(v1)}


def test_export_after_a_change_makes_the_next_version(project, renders):
    versions.save(project)
    versions.export(project)
    edit(project, cut=dict(projmod.load(project)["cut"], keep=[{"from": "w0", "to": "w3"}]))
    renders.clear()
    r = versions.export(project)
    assert r["version"] == 2 and r["reused"] is False and renders == [(False, None)]
    assert (project / "versions" / "v1" / "export.mp4").exists()


def test_a_final_that_stopped_before_its_manifest_is_made_again(project, renders):
    versions.save(project)
    versions.export(project)
    v1 = project / "versions" / "v1"
    (v1 / "render.json").unlink()
    renders.clear()
    assert versions.export(project)["reused"] is False and renders == [(False, None)]


def test_export_facts_come_from_the_file(project):
    versions.save(project)
    f = versions.export(project)["facts"]
    video = project / "versions" / "v1" / "export.mp4"
    assert (f["width"], f["height"]) == (1080, 1920) and f["fullResolution"] is True
    assert f["fps"] == pytest.approx(30, abs=0.01)
    assert f["bytes"] == video.stat().st_size
    assert f["duration"] > 1.0


def test_facts_say_when_a_file_is_not_full_resolution(project):
    draft = render.run(project, draft=True)
    f = versions.facts(draft["file"], projmod.load(project)["format"])
    assert f["fullResolution"] is False and f["width"] < 1080


def test_an_earlier_version_hands_back_its_own_export_or_says_it_has_none(project, renders):
    versions.save(project)
    versions.export(project)                                        # v1 has its full-quality file
    edit(project, cut=dict(projmod.load(project)["cut"], keep=[{"from": "w0", "to": "w3"}]))
    versions.save(project)                                          # v2 is only a preview
    edit(project, cut=dict(projmod.load(project)["cut"], keep=[{"from": "w0", "to": "w4"}]))
    versions.save(project)                                          # v3, the newest
    renders.clear()
    old = versions.export(project, version=1)
    assert old["version"] == 1 and old["reused"] is True and renders == []
    assert old["file"] == str(project / "versions" / "v1" / "export.mp4")
    with pytest.raises(EngineError) as e:
        versions.export(project, version=2)
    assert e.value.code == "ONLY_A_PREVIEW" and "Version 2" in e.value.user_message
    assert versions.export(project, version=3)["version"] == 3       # the newest is made as usual
