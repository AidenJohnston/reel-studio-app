"""Stream quality2: parallel-safe downloads and credit books, the music analysis cache + mood, and
the cover's "exact" window (the AI looked at the frame)."""
import json
import threading
from types import SimpleNamespace

import numpy as np
import pytest
from PIL import Image

from reelengine import assets, cli, cover, music


def _png(tmp_path, name="p.png"):
    buf = tmp_path / name
    Image.new("RGB", (40, 30), "red").save(buf)
    return buf


def test_parallel_fetches_never_share_a_name_and_keep_every_credit(tmp_path, monkeypatch):
    monkeypatch.setenv("REELENGINE_CACHE_DIR", str(tmp_path / "cache"))
    buf = _png(tmp_path)
    monkeypatch.setattr(assets, "_get", lambda url, **kw: (buf.read_bytes(), "image/png"))
    urls = [f"https://example.com/{i}.png" for i in range(8)]
    # the credits for all 8 were remembered by 8 searches running at once
    threads = [threading.Thread(target=assets._remember, args=([{"url": u, "attributionRequired": True, "attribution": u}],)) for u in urls]
    [t.start() for t in threads]; [t.join() for t in threads]
    book = json.loads((tmp_path / "cache" / "search-credits.json").read_text(encoding="utf-8"))
    assert set(urls) <= set(book)
    outs = []
    threads = [threading.Thread(target=lambda u=u: outs.append(assets.fetch_image(u, tmp_path / "assets", name="same"))) for u in urls]
    [t.start() for t in threads]; [t.join() for t in threads]
    assert len({o.name for o in outs}) == 8 and all(o.stat().st_size > 0 for o in outs)
    credits = json.loads((tmp_path / "assets" / "credits.json").read_text(encoding="utf-8"))
    assert set(credits) == {o.name for o in outs}
    assert not list((tmp_path / "assets").glob("*.lock"))


def test_a_failed_save_releases_the_claimed_name(tmp_path, monkeypatch):
    monkeypatch.setenv("REELENGINE_CACHE_DIR", str(tmp_path / "cache"))
    buf = _png(tmp_path)
    monkeypatch.setattr(assets, "_get", lambda url, **kw: (buf.read_bytes(), "image/png"))
    monkeypatch.setattr(Image.Image, "save", lambda *a, **k: (_ for _ in ()).throw(OSError("disk full")))
    with pytest.raises(OSError):
        assets.fetch_image("https://example.com/x.png", tmp_path / "assets", name="x")
    assert not list((tmp_path / "assets").iterdir())


def test_a_stale_lock_is_taken(tmp_path):
    book = tmp_path / "credits.json"
    lock = tmp_path / "credits.json.lock"
    lock.write_text("")
    import os, time
    old = time.time() - 60
    os.utime(lock, (old, old))
    with assets._FileLock(book) as lk:
        assert lk.held
    assert not lock.exists()


@pytest.mark.parametrize("energy,bright,dyn,bpm,mood", [
    ("energetic", "bright", False, 100, "hype"), ("energetic", "dark", True, 90, "driving"),
    ("energetic", "warm", True, 130, "hype"), ("medium", "bright", False, 95, "upbeat"),
    ("medium", "dark", True, 92, "dramatic"), ("medium", "warm", False, 86, "steady groove"),
    ("calm", "dark", False, 70, "melancholic"), ("calm", "warm", False, 70, "gentle"),
    ("calm", "bright", True, 70, "dreamy"), ("calm", "bright", False, 70, "light"),
])
def test_mood_words(energy, bright, dyn, bpm, mood):
    assert music.mood_of(energy, bright, dyn, bpm) == mood


def test_music_analysis_is_cached_per_file(tmp_path, monkeypatch):
    monkeypatch.setenv("REELENGINE_CACHE_DIR", str(tmp_path / "cache"))
    song = tmp_path / "a.wav"
    song.write_bytes(b"x")
    calls = []
    monkeypatch.setattr(music, "analyze_track", lambda p, ctx=None: calls.append(p) or {"energy": "calm", "mood": "gentle", "beats": [1, 2]})
    a = cli._music_features(song)
    b = cli._music_features(song)
    assert a == b and len(calls) == 1
    song.write_bytes(b"xy")              # a changed file is listened to again
    cli._music_features(song)
    assert len(calls) == 2


def test_analyze_music_library_lists_every_song(tmp_path, monkeypatch):
    monkeypatch.setenv("REELENGINE_CACHE_DIR", str(tmp_path / "cache"))
    lib = tmp_path / "Library" / "Music"
    lib.mkdir(parents=True)
    for n in ("b.mp3", "a.wav", "notes.txt"):
        (lib / n).write_bytes(b"x")
    monkeypatch.setattr(music, "analyze_track", lambda p, ctx=None: {"energy": "medium", "mood": "upbeat", "bpm": 101.4, "curve": [[0, -20]], "duration": 60})
    r = cli.cmd_analyze_music(SimpleNamespace(library=True, root=str(tmp_path), file=None, track=None, project=None, no_beats=True, curve=False))
    assert [s["track"] for s in r["songs"]] == ["Library/Music/a.wav", "Library/Music/b.mp3"]
    assert r["songs"][0]["mood"] == "upbeat" and "curve" not in r["songs"][0]


def test_exact_cover_stays_on_the_frame_the_ai_saw(monkeypatch):
    monkeypatch.setattr(cover, "probe", lambda p, ctx=None: {"duration": 60.0})
    monkeypatch.setattr(cover, "source_path", lambda ctx, sid: "x.mp4")
    ctx = SimpleNamespace(draft=False)
    wide = cover.candidate_times(ctx, "s1", 20.0)
    exact = cover.candidate_times(ctx, "s1", 20.0, cover.EXACT_HALF)
    assert min(wide) == pytest.approx(18.5) and max(wide) == pytest.approx(21.5)
    assert min(exact) >= 19.8 - 1e-6 and max(exact) <= 20.2 + 1e-6 and len(exact) >= 5
