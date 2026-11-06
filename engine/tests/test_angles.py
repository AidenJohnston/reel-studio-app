"""Cameras of one recording (angles.py): lining them up by sound, and which one the picture shows."""
from __future__ import annotations

import subprocess

import pytest

from reelengine import angles
from reelengine.compose_util import ffmpeg_bin
from reelengine.proto import EngineError

# speech-like sound: pink noise in bursts, so the lag has one clear answer
BURSTS = "volume='if(lt(mod(t*1.7,1),0.55),1,0.05)':eval=frame"


def _sound(path, seed: int, start: float = 0.0, extra: str = ""):
    subprocess.run([ffmpeg_bin(), "-y", "-v", "error", "-f", "lavfi", "-i", f"anoisesrc=d=24:c=pink:seed={seed}:r=48000",
                    "-ss", f"{start}", "-af", BURSTS + extra, "-ac", "1", str(path)], check=True)
    return path


def test_a_second_camera_is_lined_up_to_the_millisecond(tmp_path):
    """Fails if the offset's sign is flipped or it is off by more than a millisecond, when the other camera
    started 1.25 s later, through a duller mic and a quieter level."""
    main = _sound(tmp_path / "main.wav", 7)
    other = _sound(tmp_path / "other.wav", 7, start=1.25, extra=",lowpass=f=2500,volume=0.5")
    got = angles.sync_offset(ffmpeg_bin(), main, other)
    assert got["offset"] == pytest.approx(-1.25, abs=1e-3)       # main's second t is the other's t - 1.25
    assert got["confidence"] >= angles.SYNC_MIN_CONFIDENCE


def test_two_different_recordings_are_never_lined_up(tmp_path):
    """Fails if sound from another recording gets an offset instead of a refusal."""
    with pytest.raises(EngineError) as e:
        angles.sync_offset(ffmpeg_bin(), _sound(tmp_path / "a.wav", 7), _sound(tmp_path / "b.wav", 8))
    assert e.value.code == "ANGLE_NO_SYNC"


def _stretch(scores, dur=1.0, locked=False, forced=None):
    return {"dur": dur, "scores": scores, "main": "s1", "locked": locked, "forced": forced}


def test_the_closer_camera_holds_then_gives_way_then_comes_back():
    """Fails if the picture sits on one camera past HOLD_MAX, changes before MIN_HOLD, or comes back to
    the closer face as soon as the hold allows."""
    picks = angles.choose([_stretch({"s1": 0.2, "s2": 0.4}) for _ in range(12)])
    assert picks == ["s2"] * 7 + ["s1"] * 2 + ["s2"] * 3


def test_a_match_cut_keeps_its_camera_and_a_camera_without_a_face_is_left():
    """Fails if a match cut or a cut on action changes camera (it was judged on the main take's frames),
    or the picture stays on a camera that has lost the face."""
    picks = angles.choose([_stretch({"s1": 0.2, "s2": 0.4}, dur=8.0), _stretch({"s1": 0.2, "s2": 0.4}, locked=True),
                           _stretch({"s1": 0.2, "s2": None})])
    assert picks == ["s2", "s2", "s1"]


def test_a_keep_items_own_camera_wins():
    """Fails if a range the editor set to one camera shows another."""
    assert angles.choose([_stretch({"s1": 0.5, "s2": 0.1}, forced="s2")]) == ["s2"]
