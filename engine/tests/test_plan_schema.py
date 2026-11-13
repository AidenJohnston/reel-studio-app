"""project.json `plan` (docs/plan.md): the schema accepts the Plan document the AI layer writes and refuses a
malformed one, only the plan's script counts as a change to the video, and a re-transcription moves the plan's
rows with the b-roll they built."""
import copy

from reelengine import project


def with_plan(**changes):
    proj = project.new_project("Baking bread", "baking-bread")
    proj["plan"] = {
        "script": {"draft": "Nobody tells you this.\nIt takes time.", "rewrite": None, "locked": True,
                   "lockedAt": "2026-11-12T22:00:00.000Z", "hook": "Nobody tells you this.", "onScreenText": ["Bread"]},
        "beats": [{"line": "Nobody tells you this.", "visual": "close-up", "sound": "soft piano"}, {"line": "It takes time."}],
        "broll": [
            {"id": "p1", "words": "fancy flour", "anchor": {"from": "w33", "to": "w34"}, "visual": "a bag of flour",
             "source": "library", "asset": "Library/Images/flour.png", "treatment": "card-above-head",
             "status": "approved", "hold": 2, "note": "their own photo", "broll": "p1"},
            {"id": "p2", "words": "eighteen hours", "visual": "18 HOURS", "source": "card", "status": "proposed"},
            {"id": "p3", "visual": "a brick", "source": "fetched", "asset": None, "status": "rejected"},
        ],
        "music": "warm acoustic",
        "cover": "the brick loaf, text BREAD",
        "buildProposed": False,
    }
    for path, value in changes.items():
        node = proj["plan"]
        *parents, last = path.split(".")
        for key in parents:
            node = node[int(key)] if key.isdigit() else node[key]
        node[int(last) if last.isdigit() else last] = value
    return proj


def test_a_full_plan_is_valid():
    assert project.validate(with_plan()) == []


def test_every_source_and_status_is_valid():
    for source in ["own-file", "library", "fetched", "card", "animation", "screen-recording"]:
        assert project.validate(with_plan(**{"broll.1.source": source})) == []
    for status in ["proposed", "approved", "rejected"]:
        assert project.validate(with_plan(**{"broll.1.status": status})) == []


def test_a_malformed_plan_is_refused():
    for change in [
        {"broll.0.status": "maybe"},
        {"broll.0.source": "stock"},
        {"broll.0.id": "b1"},
        {"broll.0.hold": 120},
        {"broll.0.asset": "../outside.png"},
        {"broll.0.anchor": {"from": "w1"}},
        {"script.locked": "yes"},
        {"beats.0.line": None},
    ]:
        assert project.validate(with_plan(**change)), change


def test_a_plan_without_a_script_is_refused():
    proj = with_plan()
    del proj["plan"]["script"]
    assert any("script" in p for p in project.validate(proj))


def test_only_the_plan_script_changes_the_edit_signature():
    base = with_plan()
    sig = project.edit_signature(base)
    rows_changed = copy.deepcopy(base)
    rows_changed["plan"]["broll"][1]["status"] = "approved"
    rows_changed["plan"]["music"] = "something else"
    rows_changed["plan"]["beats"] = []
    assert project.edit_signature(rows_changed) == sig
    script_changed = copy.deepcopy(base)
    script_changed["plan"]["script"]["rewrite"] = "My own words."
    assert project.edit_signature(script_changed) != sig


def test_a_retranscription_moves_plan_rows_with_their_broll():
    old = [{"id": f"w{i}", "source": "s1", "s": i * 0.5, "e": i * 0.5 + 0.4, "w": "x"} for i in range(6)]
    new = [dict(w) for w in old if w["id"] != "w3"] + [{"id": "w9", "source": "s1", "s": 1.52, "e": 1.9, "w": "y"}]
    new.sort(key=lambda w: w["s"])
    proj = with_plan(**{"broll.0.anchor": {"from": "w3", "to": "w4"}})
    proj["broll"] = [{"id": "p1", "anchor": {"from": "w3", "to": "w4"}, "treatment": "card-above-head"}]
    project.remap_anchors(proj, old, new)
    assert proj["broll"][0]["anchor"] == {"from": "w9", "to": "w4"}
    assert proj["plan"]["broll"][0]["anchor"] == proj["broll"][0]["anchor"]
