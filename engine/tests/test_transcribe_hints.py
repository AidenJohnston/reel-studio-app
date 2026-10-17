"""Vocabulary hints for whisper (known issue: "Neve" heard as "Nave", "Flowly" as "flatly").

transcribe.gather_vocab collects the title, an optional script and every caption correction the user
has made in ANY project (+ words quoted in My style); build_hints turns that into faster-whisper
`hotwords` (every 30 s window) and an `initial_prompt` (first window), keeping only distinctive words.
"""
from __future__ import annotations

import json
from pathlib import Path

from reelengine import transcribe


def _tok(text):
    """Stand-in for whisper's tokenizer: common words are one piece, rare ones split."""
    common = {"claude", "mae", "lin", "the", "do", "solo", "reel", "would", "music", "piano", "so", "why"}
    w = text.strip(" ,").lower()
    return [1] if w in common else [1, 2]


def _project(d: Path, title="My video", corrections=(), **extra):
    d.mkdir(parents=True, exist_ok=True)
    p = {"schemaVersion": 1, "id": d.name, "title": title, "slug": d.name, "format": {}, "sources": [], "cut": {},
         "captions": {"corrections": [dict(c) for c in corrections]}, **extra}
    (d / "project.json").write_text(json.dumps(p), encoding="utf-8")
    return p


def test_distinctive_keeps_names_and_jargon_not_common_words():
    for w in ["Neve", "Flowly", "TAMS", "yt-dlp", "CodeRabbit", "mogs"]:
        assert transcribe._distinctive(w, _tok), w
    for w in ["the", "do", "solo", "reel", "3", "6th", "14%", "$13", "a", "Video"]:   # numbers are not vocabulary
        assert not transcribe._distinctive(w, _tok), w


def test_correction_targets_skip_pure_reformatting():
    cs = [{"from": "Nave", "to": "Neve"}, {"from": "three", "to": "3"}, {"from": "one engineering", "to": "1. Engineering."},
          {"from": "tail scale", "to": "Tailscale"}, {"from": "flatly", "to": "Flowly"}]
    assert transcribe._correction_targets(cs) == ["Neve", "Tailscale", "Flowly"]


def test_gather_vocab_reads_the_whole_library_style_and_script(tmp_path, monkeypatch):
    monkeypatch.setattr(transcribe, "USE_LIBRARY", True)
    monkeypatch.delenv("REELSTUDIO_ROOT", raising=False)
    root = tmp_path / "Reel Studio"
    other = root / "Projects" / "older"
    _project(other, corrections=[{"from": "Nave", "to": "Neve"}, {"from": "cloud", "to": "Claude"}])
    here = root / "Projects" / "today"
    proj = _project(here, title="Why Flowly will win", corrections=[{"from": "tams", "to": "TAMS"}])
    (here / "script.txt").write_text("So everyone knows Mae Lin. His cofounder Neve went to TAMS.", encoding="utf-8")
    (root / "My style.json").write_text(json.dumps({"version": 1, "rules": [
        {"id": "1", "text": 'Always spell my app "Zorblax" and my name "Dara".', "createdAt": "x"}]}), encoding="utf-8")
    v = transcribe.gather_vocab(here, proj)
    assert v["corrected"] == ["TAMS"] and set(v["library"]) == {"Neve", "Claude"}
    assert v["title"] == "Why Flowly will win" and "cofounder Neve" in v["script"]
    assert v["style"] == ["Zorblax", "Dara"]

    h = transcribe.build_hints(v, _tok)
    words = h["words"]
    # this project's own corrections first, then style, title, script, then the rest of the library
    assert words[0] == "TAMS" and words.index("Zorblax") < words.index("Flowly") < words.index("Claude")
    for w in ["Neve", "Flowly", "Dara", "Mae", "Lin", "cofounder"]:
        assert w in words, w
    for w in ["So", "Why", "My", "the"]:
        assert w not in words, w            # a capital at the start of a sentence is not a name
    assert h["hotwords"] == ", ".join(words)
    assert h["initialPrompt"].startswith("Why Flowly will win. So everyone knows Mae Lin.")


def test_library_words_are_opt_in(monkeypatch):
    """Measured: other projects' corrections made whisper skip stretches of speech; off by default."""
    v = {"library": ["Claude", "WakaTime"], "title": "Why Flowly will win", "script": ""}
    off = transcribe.build_hints(v, _tok)["words"]
    assert "Flowly" in off and "Claude" not in off and "WakaTime" not in off
    monkeypatch.setattr(transcribe, "USE_LIBRARY", True)
    assert {"Claude", "WakaTime"} <= set(transcribe.build_hints(v, _tok)["words"])


def test_hints_stay_inside_the_token_budget(monkeypatch):
    monkeypatch.setattr(transcribe, "USE_LIBRARY", True)
    v = {"library": [f"Brand{chr(97 + i % 26)}{chr(97 + i // 26)}x" for i in range(200)], "script": "", "title": ""}
    h = transcribe.build_hints(v, _tok)
    assert sum(len(_tok(" " + w + ",")) for w in h["words"]) <= transcribe.HOTWORDS_MAX_TOKENS
    assert h["words"][0] == "Brandaax"       # most recent first


def test_script_gets_room_even_with_a_big_library(monkeypatch):
    monkeypatch.setattr(transcribe, "USE_LIBRARY", True)
    v = {"library": [f"Brand{chr(97 + i % 26)}{chr(97 + i // 26)}x" for i in range(200)], "script": "Neve and Flowly and Tailscale.", "title": ""}
    words = transcribe.build_hints(v, _tok)["words"]
    assert {"Neve", "Flowly", "Tailscale"} <= set(words)


def test_default_title_and_no_material_give_no_hints(tmp_path):
    proj = _project(tmp_path / "solo", title="My video")
    h = transcribe.build_hints(transcribe.gather_vocab(tmp_path / "solo", proj), _tok)
    assert h == {"hotwords": None, "initialPrompt": None, "words": []}


def test_run_passes_hotwords_and_prompt_to_whisper(tmp_path, monkeypatch):
    """run() hands the hints to faster-whisper on every source; only with REELENGINE_HINTS=1 (off by default)."""
    seen = []

    class Model:
        hf_tokenizer = None

    def fake_one(model, wav, lang, prompt, dur, p0, p1, hotwords=None):
        seen.append((prompt, hotwords))
        return [{"s": 0.1, "e": 0.4, "w": "hi", "p": 0.9}], [{"s": 0.1, "e": 0.4, "text": "hi", "n": 1}], "en"

    from reelengine import project as projmod
    pdir = tmp_path / "Projects" / "p"
    src = tmp_path / "take.wav"
    import numpy as np
    from reelengine import audio_env
    audio_env_wav = (np.zeros(16000, dtype=np.int16)).tobytes()
    import wave
    with wave.open(str(src), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(audio_env_wav)
    proj = projmod.new_project("Why Flowly will win")
    proj["sources"] = [{"id": "s1", "path": "media/take.wav", "duration": 1.0}]
    proj["captions"]["corrections"] = [{"from": "Nave", "to": "Neve"}]
    (pdir / "media").mkdir(parents=True)
    (pdir / "media" / "take.wav").write_bytes(src.read_bytes())
    projmod.save(pdir, proj)
    monkeypatch.setattr(transcribe, "require_model", lambda name: tmp_path)
    monkeypatch.setattr(transcribe, "load_model", lambda name, prefer=None: (Model(), "cpu", "int8"))
    monkeypatch.setattr(transcribe, "_transcribe_one", fake_one)
    monkeypatch.setenv("REELENGINE_HINTS", "1")
    monkeypatch.setattr(transcribe, "extract_audio", lambda sp, wav: (wav.parent.mkdir(parents=True, exist_ok=True), wav.write_bytes(src.read_bytes())))
    monkeypatch.setattr(audio_env, "refine_words", lambda words, *a, **k: words)
    r = transcribe.run(pdir)
    prompt, hot = seen[-1]
    assert "Neve" in hot and "Flowly" in hot and prompt.startswith("Why Flowly will win.")
    assert r["hintWords"] >= 2
    monkeypatch.delenv("REELENGINE_HINTS")
    transcribe.run(pdir)
    assert seen[-1] == (None, None)
