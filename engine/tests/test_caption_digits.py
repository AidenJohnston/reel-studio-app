"""Numbers on screen are digits (the rubric's caption rule), without turning pronoun "one" into 1."""
from reelengine.captions import build_cues, digits_for_numbers


def _words(text):
    return [{"s": i * 0.4, "e": i * 0.4 + 0.3, "w": w, "id": f"w{i}"} for i, w in enumerate(text.split())]


def _text(text):
    return " ".join(w["w"] for w in digits_for_numbers(_words(text)))


def test_number_words_become_digits():
    assert _text("with two or three words") == "with 2 or 3 words"
    assert _text("It costs zero money") == "It costs 0 money"
    assert _text("when I was three.") == "when I was 3."
    assert _text("twenty five people and fifty-five reasons") == "25 people and 55 reasons"


def test_percent_joins_its_number():
    assert _text("Meanwhile, 64 % of guys") == "Meanwhile, 64% of guys"
    assert _text("54 percent of girls") == "54% of girls"


def test_one_only_when_it_is_a_count():
    assert _text("Number one, the hook.") == "Number 1, the hook."
    assert _text("done. One, seeing who likes you is free.") == "done. 1, seeing who likes you is free."
    # the pronoun stays a word, both directions of the rule
    assert _text("the best one for my video") == "the best one for my video"
    assert _text("one of them") == "one of them"
    assert _text("no one cares") == "no one cares"
    assert _text("One thing I learned") == "One thing I learned"


def test_merged_words_keep_both_ids_and_span():
    out = digits_for_numbers(_words("64 % of"))
    assert out[0]["w"] == "64%" and out[0]["ids"] == ["w0", "w1"]
    assert out[0]["e"] == _words("64 % of")[1]["e"]


def test_build_cues_applies_digits_and_can_be_turned_off():
    words = _words("Number two, rough cut.")
    on = " ".join(c["t"] for c in build_cues(words, {"style": {"case": "as-is"}}))
    off = " ".join(c["t"] for c in build_cues(words, {"style": {"case": "as-is"}, "digits": False}))
    assert "2," in on and "two," in off
