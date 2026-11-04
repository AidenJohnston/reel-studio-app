import copy
import json

import pytest

from reelengine import project
from reelengine.proto import EngineError


def reel(tmp_path):
    p = project.new_project("Seeded reel")
    p["version"] = 3
    p["cutStyle"] = {"preset": "standard", "seed": 42}
    p["sources"] = [{"id": "s1", "path": "media/take.mp4", "duration": 30}]
    words = [{"id": f"w{i}", "source": "s1", "w": f"word{i}", "s": i * .4 + .1,
              "e": i * .4 + .4} for i in range(60)]
    p["cut"]["keep"] = [{"from": "w0", "to": "w9"}, {"from": "w20", "to": "w59"}]
    p["zooms"] = [{"anchor": {"from": f"w{i}", "to": f"w{i+2}"}, "scale": 1.15,
                    "accentGroup": "payoff"} for i in [30, 40]]
    p["broll"] = [{"id": "b1", "anchor": {"from": "w22", "to": "w25"},
                    "treatment": "text-pop", "asset": None, "params": {"text": "hello"}}]
    project.save(tmp_path, p, touch=False)
    project.write_json(tmp_path / "work" / "transcript.json", {"words": words})
    return p, project.timeline(tmp_path, p, words)


def test_same_seed_has_byte_identical_render_decisions(tmp_path):
    from reelengine import render, zoom
    p, tl = reel(tmp_path)
    original = copy.deepcopy(p)
    contexts = [render.make_ctx(tmp_path, p, tl, draft, tmp_path, tmp_path / "work")
                for draft in [True, False]]
    reports = [json.dumps(c.variation, sort_keys=True) for c in contexts]
    assert reports[0] == reports[1]
    assert contexts[0].variation["seed"] == 42
    assert zoom.build_zooms(contexts[0], with_broll=False) == zoom.build_zooms(contexts[1], with_broll=False)
    assert contexts[0].variation["framing"]
    assert p == original


def test_different_seed_changes_only_allowed_choices(tmp_path):
    from reelengine.variation import resolve
    from reelengine.cut_style import CUT_STYLES
    p, tl = reel(tmp_path)
    settings_before = copy.deepcopy(CUT_STYLES)
    p["cut"]["keep"][1]["join"] = {"transition": "j", "frames": 8}
    p["cut"]["keep"][0]["join"] = None
    a, da = resolve(p, tl)
    other = copy.deepcopy(p)
    other["cutStyle"]["seed"] = 123
    b, db = resolve(other, tl)
    assert da != db
    for result, decisions in [(a, da), (b, db)]:
        assert decisions["framingPair"][0] == 1
        assert abs(decisions["framingPair"][1] - 1.15) <= .03
        assert .10 <= decisions["cardLead"] <= .16
        assert -.5 <= decisions["cadencePhase"] <= .5
        assert decisions["startFraming"] in [0, 1]
        assert len(result["zooms"]) == 1
        assert 6 <= result["cut"]["keep"][1]["join"]["frames"] <= 12
        assert result["cut"]["keep"][0]["join"] is None
        expected = copy.deepcopy(p)
        expected["cutStyle"] = result["cutStyle"]
        expected["zooms"] = result["zooms"]
        expected["broll"][0]["leadIn"] = decisions["cardLead"]
        expected["cut"]["keep"][1]["join"]["frames"] = result["cut"]["keep"][1]["join"]["frames"]
        assert result == expected
    assert CUT_STYLES == settings_before


@pytest.mark.parametrize("variable,value,path", [
    ("seed", None, ("cutStyle", "seed")),
    ("hook", {"from": "w10", "to": "w19"}, ("cut", "keep", 0)),
    ("cover", {"atSourceTime": 2, "source": "s1", "text": "Bread"}, ("cover",)),
    ("caption", "Try a slower rise", ("post", "caption")),
    ("brightness", -8, ("exposure",)),
])
def test_variant_changes_exactly_one_variable(tmp_path, variable, value, path):
    from reelengine.variation import make_variant
    p, _ = reel(tmp_path)
    before = copy.deepcopy(p)
    variant = make_variant(p, variable, value=value)
    if variable == "brightness":
        assert variant["exposure"] == .92
    assert p == before
    assert variant != p
    a, b = before, variant
    for key in path[:-1]:
        a, b = a[key], b[key]
    if isinstance(a, list) or path[-1] in a:
        assert a[path[-1]] != b[path[-1]]
        b[path[-1]] = a[path[-1]]
    else:
        b.pop(path[-1])
    assert variant == p


def test_trials_record_changes_and_keep_parent_snapshot(tmp_path):
    from reelengine.variation import create_variant
    p, _ = reel(tmp_path)
    # A pre-existing rendered snapshot must never be repurposed for a trial.
    project.write_json(tmp_path / "versions" / "v3" / "project.json", p)
    identities = []
    cases = [("caption", "A different caption"), ("brightness", 8),
             ("cover", {"atSourceTime": 2, "source": "s1", "text": "Bread"}),
             ("hook", {"from": "w10", "to": "w19"}), ("seed", None)]
    for variable, value in cases:
        before = project.load(tmp_path)
        result = create_variant(tmp_path, variable, value=value)
        trial = result["trial"]
        assert trial["parent_version"] == 3
        assert trial["variable"] == variable
        snapshot = project.read_json(tmp_path / trial.get("parent_snapshot", "versions/v3/project.json"))
        assert snapshot == before
        identities.append(trial.get("parent_id", f"v{trial['parent_version']}"))
        # The exact parent, with only this trial's variable applied, is the child.
        expected = copy.deepcopy(snapshot)
        if variable == "seed":
            expected["cutStyle"]["seed"] = trial["to"]
        elif variable == "hook":
            expected["cut"]["keep"][0] = trial["to"]
        elif variable == "cover":
            expected["cover"] = trial["to"]
        elif variable == "caption":
            expected["post"]["caption"] = trial["to"]
        else:
            expected["exposure"] = trial["to"]
        assert project.load(tmp_path) == expected == result["project"]
        assert project.read_json(tmp_path / "trials.json")[-1] == trial
    assert len(set(identities)) == 5
    assert len(project.read_json(tmp_path / "trials.json")) == 5
    assert project.read_json(tmp_path / "versions" / "v3" / "project.json") == p


def test_old_project_is_unchanged(tmp_path):
    from reelengine.variation import resolve
    p, tl = reel(tmp_path)
    del p["cutStyle"]
    before = json.dumps(p, sort_keys=True)
    effective, decisions = resolve(p, tl)
    assert json.dumps(effective, sort_keys=True) == before
    assert decisions is None


@pytest.mark.parametrize("variable,value", [("preset", "hyper"), ("hook", None),
    ("cover", None), ("caption", ""), ("brightness", 7), ("brightness", True)])
def test_invalid_trial_does_not_write(tmp_path, variable, value):
    from reelengine.variation import create_variant
    reel(tmp_path)
    before = (tmp_path / "project.json").read_bytes()
    with pytest.raises(EngineError):
        create_variant(tmp_path, variable, value=value)
    assert (tmp_path / "project.json").read_bytes() == before
    assert not (tmp_path / "trials.json").exists()


def test_brightness_trial_reaches_video_filter(tmp_path):
    from reelengine import render
    p, tl = reel(tmp_path)
    p["exposure"] = 1.08
    ctx = render.make_ctx(tmp_path, p, tl, True, tmp_path, tmp_path / "work")
    graph = tmp_path / "graph.txt"
    render.build_video_cmd(ctx, tl.segments, {"s1": {"width": 1080, "height": 1920, "fps": 30}},
        {"s1": tmp_path / "take.mp4"}, {}, 540, 960, [], [], None, tmp_path / "audio.wav",
        0, tl.duration, 0, "libx264", tmp_path / "out.mp4", graph, fast=False)
    assert "exposure=exposure=" in graph.read_text()


def test_hook_trial_rejects_unknown_and_repeated_speech(tmp_path):
    from reelengine.variation import create_variant
    reel(tmp_path)
    before = (tmp_path / "project.json").read_bytes()
    for value in [{"from": "w999", "to": "w19"}, {"from": "w20", "to": "w25"}]:
        with pytest.raises(EngineError, match="hook"):
            create_variant(tmp_path, "hook", value=value)
        assert (tmp_path / "project.json").read_bytes() == before
    assert not (tmp_path / "trials.json").exists()


def test_variant_cli_writes_trial(tmp_path):
    from reelengine.cli import build_parser
    reel(tmp_path)
    args = build_parser().parse_args(["make-variant", "--project", str(tmp_path),
                                     "--variable", "caption", "--value", '"New caption"'])
    result = args.fn(args)
    assert result["trial"]["to"] == "New caption"
    assert project.load(tmp_path)["post"]["caption"] == "New caption"


def test_seeded_render_without_authored_zooms(tmp_path):
    import subprocess
    from reelengine import render, tools
    p = project.new_project("Tiny seeded render")
    p["format"] = {"width": 64, "height": 96, "fps": 10}
    p["cutStyle"] = {"preset": "standard", "seed": 0}
    p["exposure"] = 1.08
    p["captions"]["enabled"] = False
    p["sources"] = [{"id": "s1", "path": "media/take.mp4", "duration": 2,
                      "width": 64, "height": 96, "fps": 10}]
    p["cut"]["keep"] = [{"from": "w0", "to": "w1"}]
    project.save(tmp_path, p, touch=False)
    project.write_json(tmp_path / "work" / "transcript.json", {"words": [
        {"id": "w0", "source": "s1", "w": "Hello", "s": .1, "e": .9},
        {"id": "w1", "source": "s1", "w": "world", "s": 1, "e": 1.8}]})
    (tmp_path / "media").mkdir()
    subprocess.run([tools.ffmpeg(), "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=64x96:r=10:d=2",
                    "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:v", "libx264",
                    "-c:a", "aac", "-shortest", str(tmp_path / "media" / "take.mp4")], check=True)
    a = render.run(tmp_path, draft=True, root=tmp_path, verify=False, cover=False)
    b = render.run(tmp_path, draft=True, root=tmp_path, verify=False, cover=False)
    assert a["zooms"] > 0
    assert a["variation"] == b["variation"]
    assert project.read_json(tmp_path / "versions" / "preview" / "render_draft.json")["variation"] == a["variation"]


def test_exposure_validation_rejects_unrenderable_values(tmp_path):
    p, _ = reel(tmp_path)
    for value in [.1, 0, -1, "bright", 20]:
        p["exposure"] = value
        assert any("exposure" in problem for problem in project.validate(p))
    for value in [.125, 8]:
        p["exposure"] = value
        assert not project.validate(p)


def test_caption_trial_gets_its_own_render_version(tmp_path):
    from reelengine.variation import create_variant
    from reelengine.render import pick_version
    p, _ = reel(tmp_path)
    create_variant(tmp_path, "caption", value="Another caption")
    assert pick_version(tmp_path, project.load(tmp_path), tmp_path) == p["version"] + 1


def test_accent_ties_only_choose_kept_moments(tmp_path):
    from reelengine.variation import resolve
    p, tl = reel(tmp_path)
    p["zooms"][0]["anchor"] = {"from": "w10", "to": "w12"}
    for seed in [0, 1, 2, 3]:
        p["cutStyle"]["seed"] = seed
        effective, _ = resolve(p, tl)
        assert all(tl.is_kept(z["anchor"]["from"]) and tl.is_kept(z["anchor"]["to"])
                   for z in effective["zooms"])


def test_trial_does_not_overwrite_a_concurrent_render_version(tmp_path, monkeypatch):
    from reelengine import variation
    p, _ = reel(tmp_path)
    original = variation.make_variant

    def interleaved(parent, variable, *, value=None):
        result = original(parent, variable, value=value)
        rendered = project.load(tmp_path)
        rendered["version"] = 4
        project.save(tmp_path, rendered, touch=False)
        return result

    monkeypatch.setattr(variation, "make_variant", interleaved)
    with pytest.raises(EngineError, match="changed"):
        variation.create_variant(tmp_path, "caption", value="Trial caption")
    assert project.load(tmp_path)["version"] == 4
    assert project.load(tmp_path)["post"]["caption"] == p["post"]["caption"]
    assert not (tmp_path / "trials.json").exists()


@pytest.mark.parametrize("kill_after", ["project.json", "trials.json"])
def test_interrupted_trial_recovers_project_and_log_and_releases_lock(tmp_path, kill_after):
    import subprocess
    import sys
    from reelengine import variation
    before, _ = reel(tmp_path)
    code = r"""
import os, sys
from pathlib import Path
from reelengine import project, variation
folder = Path(sys.argv[1])
original = project.write_json
def interrupt(path, data, *args, **kwargs):
    original(path, data, *args, **kwargs)
    if Path(path) == folder / sys.argv[2]:
        os._exit(73)
project.write_json = interrupt
variation.create_variant(folder, 'caption', value='Interrupted caption')
"""
    child = subprocess.run([sys.executable, '-c', code, str(tmp_path), kill_after], timeout=20)
    assert child.returncode == 73
    # Opening the project completes the durable transaction before another edit starts.
    recovered = project.load(tmp_path)
    trials = project.read_json(tmp_path / 'trials.json')
    assert recovered['post']['caption'] == 'Interrupted caption'
    assert len(trials) == 1 and trials[0]['to'] == 'Interrupted caption'
    again = variation.create_variant(tmp_path, 'brightness', value=8)
    assert again['project']['post']['caption'] == 'Interrupted caption'
    assert len(project.read_json(tmp_path / 'trials.json')) == 2
    assert project.read_json(tmp_path / trials[0]['parent_snapshot']) == before


@pytest.mark.skipif(__import__('os').name == 'nt', reason='Uses POSIX nonblocking lock probe')
def test_trial_owner_excludes_a_second_engine_process(tmp_path):
    import subprocess
    import sys
    reel(tmp_path)
    trial_code = r"""
import sys
from pathlib import Path
from reelengine import variation
original = variation.make_variant
def pause(parent, variable, *, value=None):
    print('parent-loaded', flush=True)
    sys.stdin.readline()
    return original(parent, variable, value=value)
variation.make_variant = pause
variation.create_variant(Path(sys.argv[1]), 'caption', value='Serialized trial')
"""
    writer_code = r"""
import fcntl, sys
from pathlib import Path
from reelengine import project
original = fcntl.flock
def no_wait(fd, operation):
    return original(fd, operation | fcntl.LOCK_NB if operation & fcntl.LOCK_EX else operation)
fcntl.flock = no_wait
folder = Path(sys.argv[1])
try:
    p = project.load(folder)
    p['version'] = 4
    project.save(folder, p, touch=False)
    print('wrote')
except BlockingIOError:
    print('blocked')
"""
    child = subprocess.Popen([sys.executable, '-c', trial_code, str(tmp_path)],
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        assert child.stdout.readline().strip() == 'parent-loaded'
        writer = subprocess.run([sys.executable, '-c', writer_code, str(tmp_path)],
                                capture_output=True, text=True, timeout=20, check=True)
        assert writer.stdout.strip() == 'blocked'
    finally:
        _, errors = child.communicate(input='continue\n', timeout=20)
        assert child.returncode == 0, errors
    # Once the trial commits, the renderer's version patch sees that new edit.
    project.update_version(tmp_path, 4)
    final = project.load(tmp_path)
    assert final['version'] == 4
    assert final['post']['caption'] == 'Serialized trial'
