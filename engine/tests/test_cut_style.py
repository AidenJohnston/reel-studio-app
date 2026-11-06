from types import SimpleNamespace

import pytest

from reelengine import project


def test_meter_counts_each_visible_change_once():
    """Fails if a framing going back to the full frame is not counted, a cut and a picture on the same frame
    count twice, or the opening picture counts as a change."""
    from reelengine.cut_style import visual_change_meter

    segments = [SimpleNamespace(out_start=t) for t in [0, 2, 5, 29, 30]]
    broll = [{"t0": t, "layers": 2} for t in [0, 4, 5, 30]]
    broll += [{"t0": 1, "skipped": "missing asset"}, {"t0": 2, "layers": 0}]
    # a zoom 3-4, a framing 10-20 that the zoom at 20 takes over, a zoom held to the last frame
    zooms = [SimpleNamespace(t0=3, t1=4), SimpleNamespace(t0=10, t1=20), SimpleNamespace(t0=20, t1=25), SimpleNamespace(t0=35, t1=40)]
    meter = visual_change_meter(40, segments, broll, zooms)
    # cuts 2 5 29 30, pictures 4 5 30, zooms start 3 10 20 35 and end 4 25: distinct 2 3 4 5 10 20 25 29 30 35
    assert meter["overall"] == {"seconds": 40, "cuts": 4, "brollStarts": 3, "zoomStarts": 4, "zoomEnds": 2, "total": 10, "perMinute": 15}
    assert meter["first5"] == {"seconds": 5, "cuts": 1, "brollStarts": 1, "zoomStarts": 1, "zoomEnds": 1, "total": 3, "perMinute": 36}
    assert meter["first30"]["total"] == 8
    short = visual_change_meter(2, segments[:1], [], [SimpleNamespace(t0=1, t1=2)])
    assert short["first30"]["seconds"] == 2
    assert short["first5"]["perMinute"] == 30
    assert visual_change_meter(0, [], [], [])["overall"]["perMinute"] == 0


@pytest.mark.parametrize("style", [
    {"preset": "unknown", "seed": 1},
    {"preset": "standard", "seed": 1.5},
    {"preset": "standard"},
])
def test_schema_rejects_invalid_cut_style(style):
    p = project.new_project("t")
    p["cutStyle"] = style
    assert any("cutStyle" in problem for problem in project.validate(p))


def test_receipt_names_a_pace_change():
    """Fails if a version whose only change is its pace or seed has no receipt fact, so it gets no title."""
    before = project.new_project("t")
    after = dict(before, cutStyle={"preset": "hyper", "seed": 4})
    assert project.net_changes(before, after) == [{"kind": "cutStyle", "before": None, "after": {"preset": "hyper", "seed": 4}}]
    reseeded = dict(after, cutStyle={"preset": "hyper", "seed": 5})
    assert [f["kind"] for f in project.net_changes(after, reseeded)] == ["cutStyle"]
    assert project.net_changes(after, dict(after)) == []
