"""The per-computer thread count (transcribe.choose_threads): fastest among identical transcripts,
measured on every computer that will transcribe on the CPU."""
import sys
import types

import pytest

from reelengine import transcribe

SAME = [("And", 0.3, 0.5), ("so,", 0.5, 0.8)]


def run(threads, seconds, words=SAME):
    return {"threads": threads, "seconds": seconds, "words": words}


def test_fastest_count_with_the_same_words_and_times_wins():
    assert transcribe.choose_threads([run(8, 2.6), run(4, 1.4), run(2, 2.2)]) == 4


def test_a_faster_count_that_hears_anything_differently_is_never_chosen():
    moved = [("And", 0.3, 0.5), ("so,", 0.52, 0.8)]                 # one word edge 20 ms later
    assert transcribe.choose_threads([run(8, 2.6), run(4, 1.4, moved), run(2, 2.2)]) == 2
    assert transcribe.choose_threads([run(8, 2.6), run(4, 1.4, moved)]) == 8


@pytest.mark.parametrize("asked, gpu_passes, device", [
    ("cpu", True, "cpu"),      # REELENGINE_ASR_DEVICE=cpu: load_model never tries the GPU
    (None, False, "cpu"),      # the GPU fails its self-test: load_model falls back to the CPU
    (None, True, "cuda"),      # a working GPU ignores the thread count
])
def test_the_speech_check_measures_threads_wherever_load_model_will_use_the_cpu(asked, gpu_passes, device, tmp_path, monkeypatch):
    built = []

    class FakeModel:
        def __init__(self, path, device, compute_type, cpu_threads=0):
            built.append(device)

    monkeypatch.setitem(sys.modules, "faster_whisper", types.SimpleNamespace(WhisperModel=FakeModel))
    monkeypatch.setitem(sys.modules, "faster_whisper.vad", types.SimpleNamespace(get_vad_model=lambda: None))
    monkeypatch.setattr(transcribe, "require_model", lambda name: tmp_path)
    monkeypatch.setattr(transcribe, "cuda_available", lambda: True)
    monkeypatch.setattr(transcribe, "cuda_selftest", lambda path: gpu_passes)
    monkeypatch.setattr(transcribe, "fast_cores", lambda: None)
    monkeypatch.setattr(transcribe, "_transcribe_one", lambda *a: ([{"w": "And", "s": 0.3, "e": 0.5}], None, None))
    if asked:
        monkeypatch.setenv("REELENGINE_ASR_DEVICE", asked)
    else:
        monkeypatch.delenv("REELENGINE_ASR_DEVICE", raising=False)
    r = transcribe.speech_check("small.en")
    assert r["device"] == device
    if device == "cpu":
        assert r["threads"] is not None and built and set(built) == {"cpu"}
    else:
        assert r["threads"] is None and built == []
