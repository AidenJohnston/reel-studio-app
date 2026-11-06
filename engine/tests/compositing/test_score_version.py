"""score.run on a saved version: it reads only the reports beside it, leaves out what it can't measure, and counts
My style rules and the double-check when they ran."""
import json

from reelengine import project as projmod, score

from . import fixtures as fx


def test_a_saved_version_is_scored_from_its_reports(tmp_path):
    pdir = tmp_path / "p"
    video = fx.synth_video(tmp_path / "talk.mp4", dur=6.0)
    proj = fx.make_project(pdir, video, keep=((0.5, 5.5),))
    vdir = pdir / "versions" / "v1"
    vdir.mkdir(parents=True)
    (vdir / "project.json").write_text(json.dumps(proj), encoding="utf-8")
    tl = projmod.timeline(pdir, projmod.load(pdir, file=vdir / "project.json"))
    ids = [w["id"] for w in tl.words_out]
    # every kept word drawn but the last, in boxes clear of the buttons
    (vdir / "captions.json").write_text(json.dumps({"cues": [{"box": [300, 1300, 480, 120], "ids": ids[:-1]}]}), encoding="utf-8")
    (vdir / "verify.json").write_text(json.dumps({"lufs": -14.1, "checks": [{"name": "loudness", "status": "PASS"},
                                                                         {"name": "duration", "status": "PASS"}]}), encoding="utf-8")
    # the words as the render saved them (render.py manifest `words`)
    (vdir / "render.json").write_text(json.dumps({"words": tl.words_out, "ruleChecks": {"checked": 2, "failures": [{"id": "r1"}]}}), encoding="utf-8")

    rep = score.run(pdir, 1)
    by = {c["id"]: c for c in rep["checks"]}
    assert set(by) == {"deadAir", "subtitleCoverage", "subtitleSafeZone", "loudness", "videoFile", "myStyle"}
    assert by["subtitleCoverage"]["count"] == 1 and not by["subtitleCoverage"]["ok"]
    assert by["subtitleSafeZone"]["ok"] and by["loudness"]["ok"] and by["videoFile"]["ok"]
    assert by["myStyle"] == {"id": "myStyle", "ok": False, "count": 1, "rules": 2}
    assert rep["measured"] == 6 and rep["passed"] == sum(c["ok"] for c in rep["checks"])

    # the transcript made again since, with other ids: this version is still scored on the words it saved
    (pdir / "work" / "transcript.json").write_text(json.dumps({"words": [{"id": "x1", "source": "s1", "s": 0.1, "e": 0.4, "w": "new"}]}), encoding="utf-8")
    assert {c["id"]: c for c in score.run(pdir, 1)["checks"]}["subtitleCoverage"]["count"] == 1

    # subtitles off: nothing about subtitles is measured, so nothing about them passes either
    proj["captions"]["enabled"] = False
    (vdir / "project.json").write_text(json.dumps(proj), encoding="utf-8")
    (vdir / "check.json").write_text(json.dumps({"verdict": "pass", "repairs": 1}), encoding="utf-8")
    ids_off = {c["id"] for c in score.run(pdir, 1)["checks"]}
    assert "subtitleCoverage" not in ids_off and "subtitleSafeZone" not in ids_off and "doubleCheck" in ids_off
