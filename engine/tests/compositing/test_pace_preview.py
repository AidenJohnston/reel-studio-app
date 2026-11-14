"""The Pace panel's counts (`reelengine pace-preview`) are the render's own."""
from __future__ import annotations

import argparse

import pytest

import fixtures as fx
from reelengine import cli, project, render


@pytest.fixture(scope="module")
def video(tmp_path_factory):
    return fx.synth_video(tmp_path_factory.mktemp("media") / "take.mp4", dur=12.0)


@pytest.mark.needs_libass
def test_each_pace_previews_the_changes_its_render_makes(tmp_path, video):
    """Fails if the panel shows a pace changing the picture more or less often than its draft does."""
    pdir = tmp_path / "p"
    fx.make_project(pdir, video, keep=((0.1, 11.9),), extra={
        "zooms": [{"anchor": {"from": f"w{word}", "to": f"w{word + 1}"}, "kind": "snap"} for word in [6, 20]],
    })
    preview = cli.cmd_pace_preview(argparse.Namespace(project=str(pdir), root=str(tmp_path)))["paces"]
    assert set(preview) == {"none", "clean", "standard", "hyper", "punchline"}
    for preset in ("standard", "hyper"):
        p = project.load(pdir)
        p["cutStyle"] = {"preset": preset, "seed": 1}
        project.save(pdir, p)
        meter = render.run(pdir, draft=True, root=tmp_path, verify=False, cover=False)["visualChanges"]
        assert (preview[preset]["perMinute"], preview[preset]["opening"]) == (meter["overall"]["perMinute"], meter["first5"]["total"]), preset
    # a faster pace changes the picture more often on the same cut
    assert preview["hyper"]["perMinute"] > preview["standard"]["perMinute"] > preview["none"]["perMinute"]


def test_fails_if_a_preview_finishes_a_trial_a_note_may_be_publishing_over(tmp_path, video):
    """The app's pace and match previews run joined to a note's claim (app/src/main/jobs.ts withOwner). One that
    finished a pending trial would write that trial's project.json over what the note publishes meanwhile
    (variation.recover_transaction), so they read project.json as it is (docs/ownership.md)."""
    import json
    pdir = tmp_path / "p"
    fx.make_project(pdir, video, keep=((0.1, 11.9),), extra={"captions": {"enabled": False}})
    proj = json.loads((pdir / "project.json").read_text(encoding="utf-8"))
    (pdir / ".trial-transaction.json").write_text(json.dumps({
        "version": 1, "before_project": proj, "after_project": dict(proj, title="after the trial"),
        "before_trials": [], "after_trials": []}), encoding="utf-8")
    before = {f: (pdir / f).read_bytes() for f in ("project.json", ".trial-transaction.json")}
    cli.cmd_pace_preview(argparse.Namespace(project=str(pdir), root=str(tmp_path)))
    cli.cmd_match_joins(argparse.Namespace(project=str(pdir), project_file=None, keep=None, every=False))
    assert {f: (pdir / f).read_bytes() for f in before} == before
    assert not (pdir / "trials.json").exists()
