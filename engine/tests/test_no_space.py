"""A full disk says what to do (NO_SPACE), on the way to a first reel: the video's encode, a picture step and a write
of the engine's own. Before, they read "Something went wrong" or "Something unexpected went wrong"."""
import errno
import io
import json
import sys

import pytest

from reelengine import cli, compose_util, proto, tools


FULL = [sys.executable, "-c", "import sys; sys.stderr.write('av_interleaved_write_frame(): No space left on device'); sys.exit(1)"]


def test_an_encode_that_runs_out_of_space_says_to_free_some_up():
    # the final and draft encodes run through ffmpeg_progress (render.py)
    with pytest.raises(proto.EngineError) as e:
        tools.ffmpeg_progress(FULL, 1.0, lambda _pct: None, 30, "final encode")
    assert (e.value.code, e.value.user_message) == ("NO_SPACE", proto.NO_SPACE_MESSAGE)


def test_a_picture_step_that_runs_out_of_space_says_to_free_some_up():
    with pytest.raises(proto.EngineError) as e:
        compose_util.run(FULL, what="picture layer")
    assert (e.value.code, e.value.user_message) == ("NO_SPACE", proto.NO_SPACE_MESSAGE)


def test_any_other_ffmpeg_failure_is_not_called_a_full_disk():
    cmd = [sys.executable, "-c", "import sys; sys.stderr.write('Invalid data found when processing input'); sys.exit(1)"]
    with pytest.raises(proto.EngineError) as e:
        compose_util.run(cmd, what="probe")
    assert e.value.code == "FFMPEG_FAILED"


@pytest.mark.parametrize("err,code", [(errno.ENOSPC, "NO_SPACE"), (errno.EACCES, "INTERNAL"), (None, "INTERNAL")])
def test_a_write_that_fails_reports_a_full_disk_only_when_it_is_one(monkeypatch, tmp_path, err, code):
    def full(_args):
        raise OSError(err, "write failed") if err is not None else OSError("write failed")
    monkeypatch.setattr(cli, "cmd_probe", full)
    buf = io.StringIO()
    proto.set_stream(buf)
    try:
        assert cli.main(["probe", str(tmp_path / "take.mp4")]) == 1
    finally:
        proto.set_stream(None)
    events = [json.loads(line) for line in buf.getvalue().splitlines() if line.strip()]
    assert events[-1]["event"] == "error" and events[-1]["code"] == code
    if code == "NO_SPACE":
        assert events[-1]["userMessage"] == proto.NO_SPACE_MESSAGE
