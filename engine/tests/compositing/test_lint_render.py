"""`render --rules`: every checkable My style rule measured on a real render. One render breaks
every kind, one meets them all, a final render stops before its encode on a rule it was asked to
stop on, and a bad rules file stops the render before it does any work."""
from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

import fixtures as fx
from reelengine import render
from reelengine.proto import EngineError

W, H = 1080, 1920
FACE = [330.0, 560.0, 420.0, 520.0]


@pytest.fixture(scope="module")
def media(tmp_path_factory):
    d = tmp_path_factory.mktemp("lint media")
    return {"video": fx.synth_video(d / "talk.mp4", dur=9.0), "song": fx.synth_tone_song(d / "song.wav"),
            **fx.synth_images(d / "img")}


def _project(pdir: Path, media, captions: dict, level: str, broll: bool) -> Path:
    fx.make_project(pdir, media["video"], keep=((0.5, 7.5),))
    p = json.loads((pdir / "project.json").read_text(encoding="utf-8"))
    p["captions"]["style"].update(captions)
    # project.json refers to files by project-relative paths only
    assets = pdir / "work" / "assets"
    assets.mkdir(parents=True, exist_ok=True)
    for name in ("song", "portrait"):
        shutil.copy2(media[name], assets / Path(media[name]).name)
    p["music"] = {"enabled": True, "track": f"work/assets/{Path(media['song']).name}", "startAt": 1.0, "level": level,
                  "automation": [], "fadeOut": 1.0}
    if broll:
        words = json.loads((pdir / "work" / "transcript.json").read_text(encoding="utf-8"))["words"]
        near = lambda sec: min(words, key=lambda w: abs(w["s"] - sec))["id"]
        p["broll"] = [{"id": "b1", "anchor": {"from": near(2.5), "to": near(3.5)}, "leadIn": 0.13,
                       "treatment": "full-frame", "asset": f"work/assets/{Path(media['portrait']).name}", "params": {}}]
    (pdir / "project.json").write_text(json.dumps(p, indent=1), encoding="utf-8")
    samples = [{"t": t / 2, "box": FACE, "core": [FACE[0] + 40, FACE[1] + 120, FACE[2] - 80, FACE[3] - 160]}
               for t in range(0, 19)]
    (pdir / "work" / "face-s1.json").write_text(json.dumps(
        {"width": W, "height": H, "detector": "test", "samples": samples}), encoding="utf-8")
    return pdir


def _rules(path: Path, checks: list, stop=()) -> str:
    path.write_text(json.dumps({"version": 1, "stopOn": list(stop),
                                "rules": [{"id": f"r{i}", "text": f"Rule {i}.", "check": c} for i, c in enumerate(checks)]}),
                    encoding="utf-8")
    return str(path)


def test_a_render_that_breaks_each_kind_names_every_rule(tmp_path, media):
    pdir = _project(tmp_path / "bad", media, {"maxWords": 3, "size": 140}, "under-voice", broll=True)
    rules = _rules(tmp_path / "bad-rules.json", [
        {"kind": "captions.maxWords", "value": 2}, {"kind": "captions.maxSize", "value": 80},
        {"kind": "captions.minSize", "value": 160},
        {"kind": "music.underVoiceDb", "value": 26}, {"kind": "broll.keepOut", "zone": "eyes"}], stop=["r0"])
    # a draft always encodes: the editor needs its frames to see what to fix
    res = render.run(pdir, draft=True, root=tmp_path, verify=False, cover=False, rules=rules)
    lint = res["lint"]
    assert res["encoded"] and Path(res["file"]).exists()
    assert not lint["ok"] and lint["checked"] == 5
    assert [f["id"] for f in lint["failures"]] == ["r0", "r1", "r2", "r3", "r4"]
    hidden = lint["failures"][4]["places"][0]
    assert hidden["item"] == "b1" and hidden["hides"] is True
    assert lint["measured"]["music.underVoiceDb"] < 26 - 1


def test_a_render_that_meets_every_kind_passes(tmp_path, media):
    pdir = _project(tmp_path / "good", media, {"maxWords": 1, "size": 100}, "quiet", broll=False)
    rules = _rules(tmp_path / "good-rules.json", [
        {"kind": "captions.maxWords", "value": 2}, {"kind": "captions.maxSize", "value": 100},
        {"kind": "captions.minSize", "value": 100},
        # the "quiet" level aims at 24 dB: a rule asking for exactly that must pass on its own mix
        {"kind": "music.underVoiceDb", "value": 24}, {"kind": "broll.keepOut", "zone": "face"}])
    res = render.run(pdir, draft=True, root=tmp_path, verify=False, cover=False, rules=rules)
    assert res["lint"]["ok"] and res["lint"]["failures"] == [] and res["lint"]["checked"] == 5


def test_a_final_render_stops_before_its_encode_on_a_rule_it_was_asked_to_stop_on(tmp_path, media):
    pdir = _project(tmp_path / "stop", media, {"maxWords": 3}, "under-voice", broll=False)
    words = {"kind": "captions.maxWords", "value": 2}
    res = render.run(pdir, root=tmp_path, verify=False, cover=False, rules=_rules(tmp_path / "stop.json", [words], stop=["r0"]))
    assert res["encoded"] is False and res["lint"]["failures"][0]["id"] == "r0"
    assert not (pdir / "versions" / f"v{res['version']}").exists()
    assert json.loads((pdir / "project.json").read_text(encoding="utf-8"))["version"] == 0
    # the same failure, not asked to stop on (it was failing before this note): the video is made
    res = render.run(pdir, root=tmp_path, verify=False, cover=False, rules=_rules(tmp_path / "go.json", [words]))
    assert res["encoded"] and Path(res["file"]).exists() and not res["lint"]["ok"]


def test_a_bad_rules_file_stops_the_render_before_any_work(tmp_path, media):
    pdir = _project(tmp_path / "x", media, {}, "under-voice", broll=False)
    rules = _rules(tmp_path / "x-rules.json", [{"kind": "captions.color", "value": "#fff"}])
    with pytest.raises(EngineError) as e:
        render.run(pdir, draft=True, root=tmp_path, verify=False, cover=False, rules=rules)
    assert e.value.code == "BAD_RULE"
    assert not (pdir / "versions").exists()
