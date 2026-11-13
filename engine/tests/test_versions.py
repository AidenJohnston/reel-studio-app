"""save-version and export (versions.py) on a real 2.5 s take. A saved version is its draft, never a full
render, and once saved it is complete and never changes. Export rebuilds any version from its own
snapshot, renders it once, hands the same file back after that, and reports what the file really is."""
from __future__ import annotations

import hashlib
import json
import subprocess

import pytest

from conftest import sentence_words
from reelengine import compose_util, init, project as projmod, render, versions
from reelengine.proto import EngineError


def make_take(path, hue=0):
    subprocess.run([compose_util.ffmpeg_bin(), "-y", "-v", "error",
                    "-f", "lavfi", "-i", "testsrc2=size=360x640:rate=30:duration=2.5",
                    "-f", "lavfi", "-i", "sine=frequency=220:duration=2.5",
                    "-vf", f"hue=h={hue}", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
                    "-c:a", "aac", "-shortest", str(path)], check=True, capture_output=True)


def make_project(tmp_path, name="p"):
    take = tmp_path / f"{name}-take.mp4"
    make_take(take)
    dir_ = tmp_path / name
    init.run(dir_, "Test", [str(take)])
    proj = projmod.load(dir_)
    words = sentence_words("one two three four five six", 0.2, source=proj["sources"][0]["id"])
    (dir_ / "work").mkdir(exist_ok=True)
    (dir_ / "work" / "transcript.json").write_text(json.dumps({"words": words}), encoding="utf-8")
    proj["cut"]["keep"] = [{"from": words[0]["id"], "to": words[-1]["id"]}]
    proj["captions"]["enabled"] = False      # no font work: this is about the files, not the look
    projmod.save(dir_, proj)
    return dir_


@pytest.fixture
def project(tmp_path):
    return make_project(tmp_path)


@pytest.fixture
def renders(monkeypatch):
    """Every render.run call, as (draft, version)."""
    calls = []
    real = render.run

    def spy(project_dir, draft=False, version=None, **kw):
        calls.append((draft, version))
        return real(project_dir, draft=draft, version=version, **kw)
    monkeypatch.setattr(render, "run", spy)
    return calls


def edit(project_dir, **changes):
    proj = projmod.load(project_dir)
    proj.update(changes)
    projmod.save(project_dir, proj)


def shorter(project_dir, last="w3"):
    edit(project_dir, cut=dict(projmod.load(project_dir)["cut"], keep=[{"from": "w0", "to": last}]))


def sha(f) -> str:
    return hashlib.sha256(f.read_bytes()).hexdigest()


def files_of(vdir) -> dict:
    return {f.name: (sha(f), f.stat().st_mtime_ns) for f in sorted(vdir.iterdir())}


# --- save-version -------------------------------------------------------------------------------

def test_a_saved_edit_is_a_complete_version_and_no_full_render(project, renders):
    r = versions.save(project)
    v1 = project / "versions" / "v1"
    assert r == {"version": 1, "file": str(v1 / "draft.mp4"), "draft": True, "versionDir": str(v1)}
    assert renders == [(True, None)]
    assert sorted(f.name for f in v1.iterdir()) == ["assets.json", "cover.png", "draft.mp4", "inputs.json", "project.json"]
    assert not list((project / "versions").glob(".v*"))      # written whole, under its own name at the end
    assert projmod.load(project)["version"] == 1
    assert projmod.edit_signature(projmod.read_json(v1 / "project.json")) == projmod.edit_signature(projmod.load(project))
    assert projmod.read_json(v1 / "inputs.json") == versions.inputs(project, projmod.load(project))
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


def test_a_saved_version_never_changes(project):
    versions.save(project)
    v1 = project / "versions" / "v1"
    before = files_of(v1)
    assert versions.save(project)["version"] == 1                 # the same video: the same version, untouched
    edit(project, post={"caption": "only the post text", "hashtags": [], "keywords": []})
    assert versions.save(project)["version"] == 1                 # nothing in the video changed
    shorter(project)
    assert versions.save(project)["version"] == 2
    assert files_of(v1) == before


def test_a_take_replaced_under_the_same_name_is_a_new_version_and_the_old_draft_stays(project):
    versions.save(project)
    v1 = project / "versions" / "v1"
    before = files_of(v1)
    take = project / projmod.load(project)["sources"][0]["path"]
    make_take(take, hue=120)                  # same file name, different picture
    r = versions.save(project)
    assert r["version"] == 2
    assert files_of(v1) == before


def test_inputs_follow_files_rewritten_in_place(project):
    proj = projmod.load(project)
    anim = project / "work" / "animations" / "card-1.mov"
    anim.parent.mkdir(parents=True)
    anim.write_bytes(b"first take of the animation")
    proj["broll"] = [{"id": "b1", "anchor": {"from": "w1", "to": "w2"}, "treatment": "full", "asset": "card-1"}]
    first = versions.inputs(project, proj)
    assert first["animations"] == {"card-1.mov": sha(anim)}
    (project / "work" / "animations" / "other.mov").write_bytes(b"an animation this edit does not use")
    assert versions.inputs(project, proj) == first
    anim.write_bytes(b"remade under the same name")
    assert versions.inputs(project, proj) != first
    (project / "work" / "transcript.json").write_text('{"words": []}', encoding="utf-8")
    assert versions.inputs(project, proj)["transcript"] != first["transcript"]


# --- export -------------------------------------------------------------------------------------

def test_export_renders_once_then_hands_back_the_same_file(project, renders):
    versions.save(project)
    renders.clear()
    first = versions.export(project, version=1)
    v1 = project / "versions" / "v1"
    assert first["version"] == 1 and first["file"] == str(v1 / "export.mp4") and first["reused"] is False
    assert renders == [(False, 1)]
    assert first["cover"] == str(v1 / "cover.png")
    mtime = (v1 / "export.mp4").stat().st_mtime_ns
    again = versions.export(project, version=1)
    assert again["reused"] is True and again["file"] == first["file"] and renders == [(False, 1)]
    assert (v1 / "export.mp4").stat().st_mtime_ns == mtime
    # saving the same edit again keeps pointing at the export
    assert versions.save(project) == {"version": 1, "file": first["file"], "draft": False, "versionDir": str(v1)}


def made(vdir) -> dict:
    """What a full render drew: its length and its cut, from its manifest."""
    m = projmod.read_json(vdir / "render.json")
    return {"duration": m["duration"], "segments": m["segmentsDetail"]}


def test_an_earlier_preview_only_version_exports_the_video_it_would_have_had(project):
    versions.save(project)
    v1 = project / "versions" / "v1"
    versions.export(project, version=1)
    at_the_time = made(v1)
    for f in ("export.mp4", "render.json"):     # as if v1 had only ever been a preview
        (v1 / f).unlink()
    shorter(project)
    versions.save(project)                     # v2, the newest: a shorter cut
    r = versions.export(project, version=1)
    assert r["version"] == 1 and r["reused"] is False
    # rebuilt from v1's own snapshot, not from the project as it is now
    assert made(v1) == at_the_time
    assert r["facts"]["duration"] == pytest.approx(at_the_time["duration"], abs=0.05)
    assert projmod.load(project)["version"] == 2               # exporting an old version changes nothing else
    assert not (project / "versions" / "v2" / "export.mp4").exists()


def test_a_version_whose_files_changed_is_refused_not_made_differently(project, renders):
    versions.save(project)
    shorter(project)
    versions.save(project)
    (project / "work" / "transcript.json").write_text(json.dumps({"words": sentence_words(
        "uno dos tres cuatro cinco seis", 0.2, source=projmod.load(project)["sources"][0]["id"])}), encoding="utf-8")
    renders.clear()
    with pytest.raises(EngineError) as e:
        versions.export(project, version=1)
    assert e.value.code == "VERSION_INPUTS_CHANGED" and "Version 1" in e.value.user_message
    assert renders == []


def test_export_without_a_version_saves_the_edit_first(project, renders):
    r = versions.export(project)
    assert r["version"] == 1 and renders == [(True, None), (False, 1)]
    assert (project / "versions" / "v1" / "draft.mp4").exists()


def test_a_final_that_stopped_before_its_manifest_is_made_again(project, renders):
    versions.save(project)
    versions.export(project, version=1)
    (project / "versions" / "v1" / "render.json").unlink()
    renders.clear()
    assert versions.export(project, version=1)["reused"] is False and renders == [(False, 1)]


def test_export_facts_come_from_the_file(project):
    versions.save(project)
    f = versions.export(project, version=1)["facts"]
    video = project / "versions" / "v1" / "export.mp4"
    assert (f["width"], f["height"]) == (1080, 1920) and f["fullResolution"] is True
    assert f["fps"] == pytest.approx(30, abs=0.01)
    assert f["bytes"] == video.stat().st_size
    assert f["duration"] > 1.0


def test_facts_say_when_a_file_is_not_full_resolution(project):
    draft = render.run(project, draft=True)
    f = versions.facts(draft["file"], projmod.load(project)["format"])
    assert f["fullResolution"] is False and f["width"] < 1080
