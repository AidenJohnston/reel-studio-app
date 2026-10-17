"""Vocabulary correction after transcription (vocab.py): "Nave" -> "Neve", "flatly" -> "Flowly".

Measured on 3 real takes (status/vocab.md). These pin the guardrails that the measurement needed: an
everyday word whisper was sure of is never touched, library terms never respell dictionary words,
numbers are never respelled, and no heard word is ever dropped.
"""
from __future__ import annotations

import json
import wave

import numpy as np

from reelengine import audio_env, transcribe, vocab

COMMON = set("""flatly meal cloud code said times that's that sat oh boy so he his the and a in to of
is it was friends even got orla mae lin faith full have i why will succeed billion went back""".split())


def is_common(w):
    return vocab.make_is_common(lambda t: [1] if t.strip().lower().split("'")[0] in COMMON
                                or t.strip().lower() in COMMON else [1, 2])(w)


def W(text, p=0.5, gap=0.05, start=0.0, seg=None):
    out, t = [], start
    for x in text.split():
        w = {"s": round(t, 3), "e": round(t + 0.3, 3), "w": x, "p": p}
        if seg is not None:
            w["_seg"] = seg
        out.append(w)
        t += 0.3 + gap
    return out


def texts(words):
    return " ".join(w["w"] for w in words)


def run(words, **material):
    return vocab.correct(words, vocab.build(material, is_common), is_common)


def test_sound_keys():
    k = vocab.sound_key
    assert k("Nave") == k("Neve") == "NF"
    assert k("flowlee") == k("Flowly")
    assert k("Clodcode") == k("Claude Code")
    assert k("Orlakwint") == k("Orla Quint")
    assert k("maylin") == k("Mae Lin")
    assert k("codecs") == k("codex")
    assert k("meal") != k("Neve")


def test_names_from_the_script_and_title_keep_timing_and_say_what_was_heard():
    words = W("his cofounder Nave is like a genius")
    out, reps = run(words, script="My friend Neve went to TAMS.")
    assert texts(out) == "his cofounder Neve is like a genius"
    neve = out[2]
    assert (neve["s"], neve["e"]) == (words[2]["s"], words[2]["e"])
    assert neve["heard"] == "Nave" and neve["vocab"] == "script"
    assert reps == [{"heard": "Nave", "written": "Neve", "source": "script", "s": neve["s"], "e": neve["e"], "words": 1}]


def test_punctuation_and_possessive_are_kept():
    out, _ = run(W("back to Nave. and Nave's car"), title="Why Neve wins")
    assert texts(out) == "back to Neve. and Neve's car"


def test_everyday_word_only_when_whisper_was_unsure_and_the_term_is_this_projects():
    title = "Why I have full faith Flowly will succeed"
    assert texts(run(W("faith and flatly success", p=0.64), title=title)[0]) == "faith and Flowly success"
    # whisper was sure: "flatly" is flatly
    assert texts(run(W("faith and flatly success", p=0.95), title=title)[0]) == "faith and flatly success"
    # the same name corrected in ANOTHER project never eats the everyday word
    lib = [{"from": "flatly", "to": "Flowly"}]
    assert texts(run(W("faith and flatly success", p=0.3), library=lib)[0]) == "faith and flatly success"
    # ...but it does fix a non-word hearing of it
    assert texts(run(W("the flowlee app", p=0.9), library=lib)[0]) == "the Flowly app"


def test_short_acronyms_plurals_and_numbers_are_never_forced():
    script = "Kids come in with 1600 SATs. He had a 1550 SAT and went to TAMS. He made 6 billion AI dollars."
    out, reps = run(W("I said that's the SAT he got SATs and 8 billion", p=0.3), script=script,
                    library=[{"from": "8 billion", "to": "6 billion AI"}, {"from": "6th", "to": "4th"}])
    assert reps == [] and texts(out) == "I said that's the SAT he got SATs and 8 billion"
    assert texts(run(W("the 6th post", p=0.3), library=[{"from": "6th", "to": "4th"}])[0]) == "the 6th post"


def test_a_split_name_becomes_one_word_over_the_same_time():
    words = W("everyone knows maylin the guy")
    out, _ = run(words, script="Everyone knows Mae Lin.")
    assert texts(out) == "everyone knows Mae Lin the guy"
    words = W("so Flo Lee raised money")
    out, reps = run(words, title="Why Flowly will win")
    assert texts(out) == "so Flowly raised money"
    assert out[1]["s"] == words[1]["s"] and out[1]["e"] == words[2]["e"] and out[1]["heard"] == "Flo Lee"
    assert reps[0]["words"] == 2


def test_a_join_never_swallows_a_real_word():
    out, _ = run(W("Orlakwint Riz, oh boy"), script="Today: Orla Quint Rizz.")
    assert texts(out) == "Orla Quint Rizz, oh boy"
    # not across a long pause, nor across whisper's segments
    words = W("Flo", start=0.0) + W("Lee", start=2.0)
    assert texts(run(words, title="Why Flowly will win")[0]) == "Flo Lee"
    words = W("Flo", seg=0) + W("Lee", start=0.35, seg=1)
    assert texts(run(words, title="Why Flowly will win")[0]) == "Flo Lee"


def test_a_name_whisper_wrote_is_only_replaced_by_a_name():
    out, reps = run(W("a high school in Georgia and"), script="my friend george said hi")
    assert reps == [] and texts(out) == "a high school in Georgia and"


def test_already_right_words_and_no_vocabulary_change_nothing():
    words = W("Flowly and flowly and Neve")
    out, reps = run(words, title="Why Flowly's Neve wins")
    assert reps == [] and texts(out) == texts(words)
    out, reps = vocab.correct(words, [], is_common)
    assert out == words and reps == []


def test_case_only_only_from_the_users_own_words():
    words = W("on notion today")
    assert texts(run(words, vocabulary=["Notion"])[0]) == "on Notion today"
    assert texts(run(words, script="I was on Notion.")[0]) == "on notion today"


def test_word_count_never_shrinks_except_a_join():
    script = "Mae Lin and Neve built Flowly. Orla Quint Rizz. Claude Code and Codex."
    words = W("maylin and Nave built flowlee Orlakwint Riz Clodcode and codecs oh boy the end", p=0.4)
    out, reps = run(words, script=script)
    heard = sum(r["words"] for r in reps) + (len(out) - len(reps))
    assert heard == len(words)
    assert texts(out) == "Mae Lin and Neve built Flowly Orla Quint Rizz Claude Code and Codex oh boy the end"


def _wav(path):
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
        w.writeframes(np.zeros(16000, dtype=np.int16).tobytes())


def _run_project(tmp_path, monkeypatch, heard, **proj_extra):
    from reelengine import project as projmod

    class Tok:
        def encode(self, text, add_special_tokens=False):
            class R:
                ids = [1] if text.strip().lower() in COMMON else [1, 2]
            return R()

    class Model:
        hf_tokenizer = Tok()

    def fake_one(model, wav, lang, prompt, dur, p0, p1, hotwords=None):
        ws = [dict(w, _seg=0 if i < 2 else 1) for i, w in enumerate(W(heard, p=0.4, start=0.1))]
        segs = [{"s": 0.1, "e": 0.7, "text": "", "n": 2}, {"s": 0.8, "e": 2.0, "text": "", "n": len(ws) - 2}]
        return ws, segs, "en"
    pdir = tmp_path / "Projects" / "p"
    (pdir / "media").mkdir(parents=True)
    _wav(pdir / "media" / "take.wav")
    proj = projmod.new_project(proj_extra.pop("title", "Why Flowly will win"))
    proj["sources"] = [{"id": "s1", "path": "media/take.wav", "duration": 1.0}]
    proj["captions"].update(proj_extra)
    projmod.save(pdir, proj)
    monkeypatch.setattr(transcribe, "require_model", lambda name: tmp_path)
    monkeypatch.setattr(transcribe, "load_model", lambda name, prefer=None: (Model(), "cpu", "int8"))
    monkeypatch.setattr(transcribe, "_transcribe_one", fake_one)
    monkeypatch.setattr(transcribe, "extract_audio", lambda sp, wav: (wav.parent.mkdir(parents=True, exist_ok=True), _wav(wav)))
    monkeypatch.setattr(audio_env, "refine_words", lambda words, *a, **k: words)
    r = transcribe.run(pdir)
    return r, json.loads((pdir / "work" / "transcript.json").read_text(encoding="utf-8"))


def test_run_respells_logs_and_keeps_segments_consistent(tmp_path, monkeypatch):
    monkeypatch.delenv("REELENGINE_VOCAB", raising=False)
    r, t = _run_project(tmp_path, monkeypatch, "so Nave built Flo Lee today", vocabulary=["Neve"])
    assert [w["w"] for w in t["words"]] == ["so", "Neve", "built", "Flowly", "today"]
    assert r["respelled"] == 2
    reps = t["vocab"]["replacements"]
    assert [(x["heard"], x["written"], x["source"]) for x in reps] == [("Nave", "Neve", "vocabulary"),
                                                                       ("Flo Lee", "Flowly", "title")]
    assert {x["id"] for x in reps} <= {w["id"] for w in t["words"]}
    assert all("_seg" not in w for w in t["words"])
    ids = [w["id"] for w in t["words"]]
    assert [(s["from"], s["to"]) for s in t["segments"]] == [(ids[0], ids[1]), (ids[2], ids[4])]


def test_run_can_be_turned_off(tmp_path, monkeypatch):
    monkeypatch.setenv("REELENGINE_VOCAB", "0")
    r, t = _run_project(tmp_path, monkeypatch, "so Nave built Flo Lee today", vocabulary=["Neve"])
    assert [w["w"] for w in t["words"]] == ["so", "Nave", "built", "Flo", "Lee", "today"]
    assert r["respelled"] == 0 and t["vocab"]["replacements"] == []
