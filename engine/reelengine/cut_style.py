"""Shared cut-style vocabulary and render-time visual-change meter."""
from __future__ import annotations

CUT_STYLES = {
    # These values are lead decisions and have not been tested on Reel Studio output yet.
    # openingMax: the most visible changes the first OPENING seconds may hold (lint_edit opening-busy). A proposal
    # with no measurement behind it; harness/pace_survey.py reports each pace's first-5-second count on a real take.
    "clean": {"secondsPerVisualChange": [6, 10], "framingPair": [1.0, 1.1], "jlBridges": 3, "smashes": 0, "sfxOnCuts": 0, "beatAccents": False, "extraVisualsFirst5s": False, "openingMax": 1},
    "standard": {"secondsPerVisualChange": [3, 5], "framingPair": [1.0, 1.15], "jlBridges": 3, "smashes": 1, "sfxOnCuts": 2, "beatAccents": False, "extraVisualsFirst5s": False, "openingMax": 2},
    "hyper": {"secondsPerVisualChange": [1.5, 3], "framingPair": [1.0, 1.3], "jlBridges": 0, "smashes": 2, "sfxOnCuts": 8, "beatAccents": True, "extraVisualsFirst5s": True, "openingMax": 4},
    "punchline": {"secondsPerVisualChange": None, "framingPair": [1.0, 1.25], "jlBridges": 0, "smashes": 4, "sfxOnCuts": 4, "beatAccents": False, "extraVisualsFirst5s": False, "openingMax": 2},
}

OPENING = 5.0
OPENING_MAX_UNSTYLED = 3   # the same check with no pace set


def visual_change_meter(duration, segments, broll, zooms, *, visual_offset=0.0, fps=30.0):
    """Segments are render-relative; b-roll and zooms use the full output clock.

    A change is something the eye sees switch: a cut, a picture appearing, a zoom or a seeded framing
    starting or ending (a framing that goes back to the full frame is as visible as one that pushes in;
    the release that lands on the video's last frame is not). Changes inside one frame of each other
    are one change, as lint_edit's cadence counts them. The opening picture is not a change, so only
    times after 0 count; each window holds the changes in (0, seconds).
    """
    duration = max(0.0, float(duration or 0.0))
    frame = 1.0 / float(fps or 30.0)
    events = {
        "cuts": [float(s.out_start) for s in list(segments)[1:]],
        "brollStarts": [float(x.get("t0")) - visual_offset for x in broll if isinstance(x, dict) and x.get("t0") is not None and not x.get("skipped") and int(x.get("layers", 1) or 0) > 0],
        "zoomStarts": [float(z.t0) - visual_offset for z in zooms],
        "zoomEnds": [float(z.t1) - visual_offset for z in zooms if getattr(z, "t1", None) is not None],
    }
    # a zoom that ends where the next begins is one switch, counted at the start
    starts = events["zoomStarts"]
    events["zoomEnds"] = [t for t in events["zoomEnds"] if t < duration - frame and not any(abs(t - u) <= frame for u in starts)]

    def window(seconds):
        end = min(duration, seconds)
        inside = {k: [t for t in ts if 0 < t < end] for k, ts in events.items()}
        distinct = []
        for t in sorted(t for ts in inside.values() for t in ts):
            if not distinct or t - distinct[-1] > frame:
                distinct.append(t)
        total = len(distinct)
        return {"seconds": round(end, 3), **{k: len(v) for k, v in inside.items()}, "total": total,
                "perMinute": round(total * 60 / end, 3) if end else 0}
    return {"overall": window(duration), "first5": window(5), "first30": window(30)}
