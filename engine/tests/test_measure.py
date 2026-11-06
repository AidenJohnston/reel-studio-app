"""measure-reel: the numbers My style's reference readout is built from."""
from pathlib import Path

import pytest

from reelengine import measure, tools, transcribe


def w(text, s, e):
    return {"w": text, "s": s, "e": e}


@pytest.mark.parametrize("words, seconds, count", [
    # a full stop ends the opening line
    ([w("Stop", .5, .8), w("doing", .8, 1.1), w("this.", 1.1, 1.5), w("Here's", 1.6, 1.9), w("why", 1.9, 2.2)], 1.0, 3),
    # so does a pause long enough to end a phrase, with no full stop at all
    ([w("Stop", 0, .3), w("doing", .3, .6), w("this", .6, .9), w("here's", 1.6, 1.9)], 0.9, 3),
    # a run whisper never closed stops at the word cap
    ([w(f"w{i}", i * .2, i * .2 + .15) for i in range(40)], round(24 * .2 + .15, 2), measure.HOOK_MAX_WORDS),
])
def test_hook_ends_at_the_first_sentence_end_pause_or_cap(words, seconds, count):
    hook = measure.hook_of(words)
    assert (hook["seconds"], hook["words"]) == (seconds, count)
    assert hook["text"] == " ".join(x["w"] for x in words[:count])


def test_pace_leaves_out_silence_before_talking_and_long_pauses():
    # 3 s of silence before the first word, and one held beat of 1.3 s, must not read as slow talking
    words = [w("one", 3.0, 3.4), w("two", 3.5, 3.9), w("three", 5.2, 5.6), w("four.", 5.6, 6.0)]
    s = measure.speech_stats(words)
    assert s["talkingSeconds"] == round(3.0 - 1.3, 2)
    assert s["wordsPerSecond"] == round(4 / 1.7, 2)
    assert s["firstWordAt"] == 3.0
    # the 0.1 s gap is not a pause
    assert s["pausesPerMinute"] == round(60 / 3.0, 1)
    assert measure.speech_stats([]) is None


def test_measure_reel_counts_cuts_in_real_footage_and_says_why_speech_is_missing(tmp_path, monkeypatch):
    clip = tmp_path / "two shots.mp4"
    tools.text_run([
        tools.ffmpeg(), "-y", "-nostdin", "-v", "error",
        "-f", "lavfi", "-i", "color=red:s=64x112:r=10:d=2",
        "-f", "lavfi", "-i", "color=blue:s=64x112:r=10:d=2",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
        "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]",
        "-map", "[v]", "-map", "2:a", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(clip),
    ], 60, "generate measure fixture")
    monkeypatch.setattr(transcribe, "model_present", lambda name: False)
    out = measure.measure(clip, tmp_path / "posters" / "p.jpg")
    assert out["shots"]["count"] == 2 and out["shots"]["cutsFirst5"] == 1
    assert out["shots"]["medianSeconds"] == pytest.approx(2.0, abs=0.15)
    assert out["speech"] is None and out["speechMissing"] == "no-model"
    assert Path(out["poster"]).is_file()


def test_measure_reel_refuses_a_missing_file_in_plain_words(tmp_path):
    with pytest.raises(Exception) as e:
        measure.measure(tmp_path / "gone.mp4")
    assert e.value.code == "NOT_FOUND" and "Add the file again" in e.value.user_message
