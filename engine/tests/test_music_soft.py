"""Soft, dark material is "calm" whatever the beat tracker guesses; loud bright material is not."""
import numpy as np

from reelengine import music


def _song(tmp_path, name, freqs, amp, sr=music.SR, seconds=24.0, pulse_hz=1.6):
    t = np.arange(int(seconds * sr)) / sr
    x = sum(np.sin(2 * np.pi * f * t) for f in freqs) / len(freqs)
    # a soft note every ~0.6 s, like piano arpeggios (what the tempo guess reads as 90-150 bpm)
    env = 0.55 + 0.45 * np.exp(-((t * pulse_hz) % 1.0) * 6)
    y = (amp * x * env).astype(np.float32)
    return music.write_wav(tmp_path / name, np.stack([y, y], axis=1), codec="pcm_s16le")


def test_quiet_dark_song_is_calm(tmp_path):
    a = music.analyze_track(_song(tmp_path, "soft.wav", [196, 247, 294], 0.04))
    assert a["energy"] == "calm"
    assert a["mood"] in ("melancholic", "gentle", "dreamy")


def test_loud_bright_song_is_not_calm(tmp_path):
    rng = np.random.default_rng(0)
    sr = music.SR
    t = np.arange(int(24 * sr)) / sr
    hits = (np.sin(2 * np.pi * 2.2 * t) > 0.9).astype(np.float32)
    y = (0.5 * rng.standard_normal(len(t)) * (0.3 + hits) + 0.3 * np.sin(2 * np.pi * 3000 * t)).astype(np.float32)
    y = np.clip(y, -0.95, 0.95)
    a = music.analyze_track(music.write_wav(tmp_path / "loud.wav", np.stack([y, y], axis=1), codec="pcm_s16le"))
    assert a["energy"] != "calm"
