import shutil

import pytest

import fixtures as fx
from reelengine import frames, project, render, render_identity, verify
from reelengine.proto import EngineError


@pytest.fixture
def pdir(tmp_path):
    video = fx.synth_video(tmp_path / "take.mp4", dur=3, w=360, h=640)
    pdir = tmp_path / "project"
    fx.make_project(pdir, video, keep=((0.1, 2.6),), extra={
        "format": {"width": 360, "height": 640, "fps": 30},
        "cover": {"atSourceTime": 0.5, "source": "s1", "text": None}})
    return pdir


def edit(pdir, change):
    p = project.load(pdir)
    change(p)
    project.save(pdir, p)
    return p


def test_frames_refuse_a_preview_that_a_newer_one_replaced(pdir):
    """Fails if frames shows the newest video when asked for an earlier render."""
    first = render.run(pdir, draft=True, cover=False)
    edit(pdir, lambda p: p["cut"].update(gapCap=0.1))
    second = render.run(pdir, draft=True, cover=False)
    with pytest.raises(EngineError) as err:
        frames.run(pdir, [0.5], render_id=first["renderId"])
    assert err.value.code == "RENDER_MISMATCH"
    assert frames.run(pdir, [0.5], render_id=second["renderId"])["renderId"] == second["renderId"]
    assert render_identity.inspect(pdir, second["renderId"])["timeline"]["words"][0]["id"] == "w0"


def test_a_manifest_names_its_video_without_a_machine_path(pdir):
    """Fails if a manifest written on Windows names a video a Mac (or a moved folder) cannot resolve."""
    result = render.run(pdir, draft=True, cover=False)
    assert project.read_json(pdir / "versions" / "preview" / "render_draft.json")["file"] == "draft.mp4"
    assert result["file"].endswith("draft.mp4") and result["file"] != "draft.mp4"


def test_a_verify_report_left_from_another_render_is_refused(pdir):
    """Fails if a newer video is checked or inspected against an older render's verify report."""
    render.run(pdir, draft=True, cover=False)
    preview = pdir / "versions" / "preview"
    shutil.copy(preview / "verify.json", pdir / "old-verify.json")
    edit(pdir, lambda p: p["cut"].update(gapCap=0.1))
    second = render.run(pdir, draft=True, cover=False)
    shutil.copy(pdir / "old-verify.json", preview / "verify.json")
    for check in (lambda: verify.run(second["file"]), lambda: frames.run(pdir, [0.5], render_id=second["renderId"])):
        with pytest.raises(EngineError) as err:
            check()
        assert err.value.code == "RENDER_MISMATCH"


def test_an_export_copy_verifies_against_the_render_it_was_copied_from(pdir):
    """Fails if `verify --project` refuses the Library copy the installed-app e2e checks."""
    result = render.run(pdir, cover=False)
    copy = pdir.parent / "Exports" / "My video - Version 1.mp4"
    copy.parent.mkdir()
    shutil.copy(result["file"], copy)
    assert verify.run(copy, project_dir=pdir)["renderId"] == result["renderId"]


def test_a_new_version_records_what_changed_since_the_last(pdir):
    """Fails if a version's receipt misses the cut or caption change, or a re-render with no change adds one."""
    render.run(pdir, cover=False)
    before = project.load(pdir)
    after = edit(pdir, lambda p: (p["cut"].update(keep=[{"from": "w1", "to": "w5"}]),
                                  p["captions"]["style"].update(size=84)))
    result = render.run(pdir, cover=False, job_id="job-7")
    receipts = project.read_json(pdir / "versions" / "v2" / "receipts.json")
    assert receipts == [result["receipt"]]
    assert receipts[0]["jobId"] == "job-7" and receipts[0]["renderId"] == result["renderId"]
    assert receipts[0]["facts"] == [
        {"kind": "cut.keep", "before": before["cut"]["keep"], "after": after["cut"]["keep"]},
        {"kind": "captions.style", "field": "size", "before": before["captions"]["style"]["size"], "after": 84},
    ]
    again = render.run(pdir, cover=False, job_id="job-8")
    assert again["version"] == 2 and again["receipt"]["facts"] == []
    assert project.read_json(pdir / "versions" / "v2" / "receipts.json") == receipts
