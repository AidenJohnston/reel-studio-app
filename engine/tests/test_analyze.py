from conftest import sentence_words
from reelengine import analyze, cut


def build(*parts):
    """parts = (text, pause_before). Returns words with ids in order."""
    words, t, nid = [], 0.3, 0
    for text, pause in parts:
        t += pause
        ws = sentence_words(text, t, start_id=nid)
        words += ws
        nid += len(ws)
        t = ws[-1]["e"]
    return words


def kept_text(words, p):
    pos = cut.positions_from_keep(words, p["keep"])
    return " ".join(words[i]["w"] for i in pos)


def test_last_complete_take_wins():
    w = build(("Cooking at home is completely broken right now.", 0.0),
              ("Cooking at home is totally broken right now.", 1.5),
              ("Here is why.", 0.4))
    p = analyze.plan(w)
    assert kept_text(w, p) == "Cooking at home is totally broken right now. Here is why."
    assert len(p["retakes"]) == 1
    takes = p["retakes"][0]["takes"]
    assert [t["chosen"] for t in takes] == [False, True]


def test_abandoned_later_restart_loses_to_the_complete_take():
    w = build(("Everyone knows the pilot who got kicked out of school for cheating on the exam.", 0.0),
              ("Everyone knows the", 1.8),
              ("So he went to a fancy school in the city.", 2.0))
    p = analyze.plan(w)
    out = kept_text(w, p)
    assert out.startswith("Everyone knows the pilot who got kicked out")
    assert "the So he went" not in out


def test_false_start_dropped():
    w = build(("So the reason", 0.0), ("So the reason I built this app is simple.", 1.2))
    p = analyze.plan(w)
    assert kept_text(w, p) == "So the reason I built this app is simple."


def test_shorter_later_retake_still_wins():
    w = build(("That is like the biggest compliment I have ever heard in my entire life", 0.0),
              ("That is the biggest compliment I have ever heard.", 1.5),
              ("Being here in the city is crazy because nobody expected it.", 0.4))
    p = analyze.plan(w)
    assert kept_text(w, p).startswith("That is the biggest compliment I have ever heard. Being")


def test_meta_talk_dropped():
    w = build(("Let me do that again.", 0.0), ("This is the real line.", 1.0),
              ("Okay we'll cut this out.", 1.5), ("And this is the ending.", 1.5))
    p = analyze.plan(w)
    assert kept_text(w, p) == "This is the real line. And this is the ending."
    reasons = {d["reason"] for d in p["dropped"]}
    assert "meta" in reasons


def test_fluent_anaphora_is_not_a_retake():
    w = build(("You don't need money.", 0.0), ("You don't need connections.", 0.2),
              ("You need to start.", 0.2))
    p = analyze.plan(w)
    assert kept_text(w, p) == "You don't need money. You don't need connections. You need to start."
    assert p["retakes"] == []


def test_stutter_and_filler():
    w = build(("And this dude this dude is the reason um I care.", 0.0))
    p = analyze.plan(w)
    assert kept_text(w, p) == "And this dude is the reason I care."


def test_emphasis_repeat_kept():
    w = build(("And I thought no, no, no, no, grocery stores.", 0.0))
    p = analyze.plan(w)
    assert kept_text(w, p) == "And I thought no, no, no, no, grocery stores."


def test_restart_marker_splits_logistics_from_the_take():
    w = build(("Wonder if I can back this up a bit all right so everyone knows the story.", 0.0))
    p = analyze.plan(w)
    assert kept_text(w, p) == "so everyone knows the story."


def test_clean_take_keeps_everything():
    w = build(("This is a clean take.", 0.0), ("Nothing is repeated here.", 0.6),
              ("Follow along for more.", 0.6))
    p = analyze.plan(w)
    assert p["keptWords"] == p["totalWords"]
    assert p["keep"] == [{"from": w[0]["id"], "to": w[-1]["id"]}]


def test_mishap_exclamations_are_meta():
    w = build(("This morning I woke up early.", 0.0), ("Oh shoot.", 1.0), ("Oh shoot, my mic fell.", 1.2),
              ("This morning I woke up at five.", 2.0))
    p = analyze.plan(w)
    assert kept_text(w, p) == "This morning I woke up at five."
