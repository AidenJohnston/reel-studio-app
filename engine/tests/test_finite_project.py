"""project.json must stay readable by the app's JSON.parse, which refuses Python's bare NaN."""
import io
import json
import math

import pytest

from reelengine import cli, project, proto
from reelengine.proto import EngineError


def test_autocut_gap_cap_nan_is_refused_and_project_json_stays_readable(tmp_path):
    """Fails if `autocut --gap-cap NaN` (argparse's float() accepts it) writes NaN into project.json, or if
    any later save can: the desktop app then can't open the project."""
    pdir = tmp_path / "p"
    project.save(pdir, project.new_project("NaN"))
    before = (pdir / "project.json").read_bytes()
    buf = io.StringIO()
    proto.set_stream(buf)
    try:
        code = cli.main(["autocut", "--project", str(pdir), "--gap-cap", "NaN"])
    finally:
        proto.set_stream(None)
    events = [json.loads(line) for line in buf.getvalue().splitlines() if line.strip()]
    assert code == 1 and any(e.get("code") == "BAD_ARGS" for e in events), events
    p = project.load(pdir)
    p["cut"]["gapCap"] = math.nan                       # any path that sets a non-finite number
    with pytest.raises(EngineError) as e:
        project.save(pdir, p)
    assert e.value.code == "BAD_PROJECT"
    assert (pdir / "project.json").read_bytes() == before
    assert not list(pdir.glob("*.tmp"))                  # no half-written file left
