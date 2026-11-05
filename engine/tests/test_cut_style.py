from types import SimpleNamespace

import pytest

from reelengine import project


def test_meter_counts_rendered_timeline_events():
    from reelengine.cut_style import visual_change_meter

    segments = [SimpleNamespace(out_start=t) for t in [0, 2, 5, 29, 30]]
    broll = [{"t0": t, "layers": 2} for t in [0, 4, 5, 30]]
    broll += [{"t0": 1, "skipped": "missing asset"}, {"t0": 2, "layers": 0}]
    zooms = [SimpleNamespace(t0=t) for t in [3, 29, 35]]
    meter = visual_change_meter(40, segments, broll, zooms)
    assert meter == {
        "overall": {"seconds": 40, "cuts": 4, "brollStarts": 4, "zoomStarts": 3, "total": 11, "perMinute": 16.5},
        "first5": {"seconds": 5, "cuts": 1, "brollStarts": 2, "zoomStarts": 1, "total": 4, "perMinute": 48},
        "first30": {"seconds": 30, "cuts": 3, "brollStarts": 3, "zoomStarts": 2, "total": 8, "perMinute": 16},
    }
    short = visual_change_meter(2, segments[:1], [], [SimpleNamespace(t0=1)])
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
