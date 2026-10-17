"""Song analysis is cached by content: the second pick of a song is instant, from any path."""
import shutil
import time

from reelengine import music

from . import fixtures as fx


def test_analysis_cached_by_content(tmp_path, monkeypatch):
    song = fx.synth_tone_song(tmp_path / "a" / "song.wav", dur=12.0)
    cache = tmp_path / "cache"
    calls = []
    real = music.analyze_track
    monkeypatch.setattr(music, "analyze_track", lambda p, ctx=None: calls.append(p) or real(p, ctx))

    first = music.analyze_track_cached(song, cache_dir=cache)
    assert len(calls) == 1
    t = time.time()
    again = music.analyze_track_cached(song, cache_dir=cache)
    assert len(calls) == 1 and time.time() - t < 1.0
    assert again == first

    # a copy (e.g. dropped into the Library) hits too, and reports its own path
    copy = tmp_path / "b" / "copy.wav"
    copy.parent.mkdir()
    shutil.copy(song, copy)
    r = music.analyze_track_cached(copy, cache_dir=cache)
    assert r["path"] == str(copy) and len(calls) == 1

    # different content: analysed again
    other = fx.synth_tone_song(tmp_path / "c" / "song.wav", dur=8.0)
    music.analyze_track_cached(other, cache_dir=cache)
    assert len(calls) == 2

    # a broken cache file only costs the time
    for f in cache.glob("*.json"):
        f.write_text("{not json", encoding="utf-8")
    assert music.analyze_track_cached(song, cache_dir=cache)["duration"] == first["duration"]
