"""Captions follow the locked script (scriptalign + captions.follow_script): the script's words, at the
audio's times, where the speech follows the script; the transcript where the speaker left it."""
import json

from reelengine import captions, scriptalign


def heard(text: str, t0: float = 0.0) -> list:
    """Transcript words w0, w1, ... 0.4 s apart."""
    return [{"id": f"w{k}", "w": w, "s": round(t0 + 0.4 * k, 3), "e": round(t0 + 0.4 * k + 0.35, 3)}
            for k, w in enumerate(text.split())]


def shown(script: str, said: str, cap=None, words_out=None) -> list:
    """The caption lines (as written, not upper-cased) for `said` under `script`."""
    words = heard(said)
    groups = scriptalign.build(script, words)["groups"]
    cap = {"style": {"case": "as-is"}, **(cap or {})}
    return [c["t"] for c in captions.build_cues(words_out or words, cap, script_groups=groups)]


def text(lines: list) -> str:
    return " ".join(lines)


def test_misheard_names_are_spelled_as_the_script_writes_them():
    out = shown("I use Neve and Flowly every day.", "I use Nave and flatly every day.")
    assert text(out) == "I use Neve and Flowly every day"


def test_a_misheard_name_opening_or_closing_a_sentence_is_fixed_too():
    out = shown("Neve makes great mics. Talk to Neve.", "Nave makes great mics. Talk to Nave.")
    assert text(out) == "Neve makes great mics Talk to Neve"


def test_numbers_said_in_words_show_as_the_script_writes_them():
    assert text(shown("Version 4.0 ships today.", "Version four point oh ships today.")) == "Version 4.0 ships today"
    out = shown("It costs $3,000, and 25% of people pay.",
                "It costs three thousand dollars, and twenty five percent of people pay.")
    assert text(out) == "It costs $3,000 and 25% of people pay"


def test_number_keys():
    k = lambda s: [x[0] for x in scriptalign.keys(s.split())]
    assert k("four point oh") == k("4.0") == ["4.0"]
    assert k("three thousand dollars") == k("$3,000") == ["3000", "dollar"]
    assert k("3 ,000") == ["3000"]                              # whisper's split thousands
    assert k("a hundred and five") == ["105"]
    assert k("1.5 million") == k("1.5M") == k("one point five million") == ["1500000"]
    assert k("twenty five percent") == k("25%") == ["25", "percent"]
    assert k("twenty twenty five") == ["20", "25"]              # never added up into 45
    assert k("a dog") == ["a", "dog"]                           # "a" is a number only before a hundred


def test_a_skipped_line_is_not_shown_and_the_rest_still_follows():
    script = "First line here. This second line gets skipped entirely by me. Then Neve closes it out."
    out = shown(script, "First line here. Then Nave closes it out.")
    assert text(out) == "First line here Then Neve closes it out"


def test_an_ad_lib_stays_as_heard():
    script = "We built this in a week. Then we shipped Flowly."
    said = "We built this in a week. Honestly I did not sleep at all that week. Then we shipped flatly."
    out = text(shown(script, said))
    assert "Honestly I did not sleep at all that week" in out
    assert out.endswith("Then we shipped Flowly")
    m = scriptalign.build(script, heard(said))
    # "Honestly ... that" (w6-w13) is off-script; its last word "week." reads as the script's own "week."
    assert m["spans"] == [["w0", "w5"], ["w14", "w18"]]


def test_a_word_said_inside_a_line_but_not_in_the_script_is_kept():
    assert text(shown("This is really great.", "This is really really great.")) == "This is really really great"


def test_a_line_said_twice_follows_the_script_both_times():
    script = "Here is the Neve hook. And here comes the payoff."
    said = "Here is the Nave hook. Here is the Nave hook. And here comes the payoff."
    out = text(shown(script, said))
    assert out.count("Neve") == 2 and "Nave" not in out
    # whichever take the cut keeps
    words = heard(said)
    groups = scriptalign.build(script, words)["groups"]
    kept = [c["t"] for c in captions.build_cues(words[5:], {"style": {"case": "as-is"}}, script_groups=groups)]
    assert text(kept) == "Here is the Neve hook And here comes the payoff"


def test_the_scripts_punctuation_breaks_the_lines():
    # the script ends sentences after "really?" and "Yes."; the transcript heard one run-on sentence
    out = shown("Wait, really? Yes. It works.", "Wait really yes it works.")
    assert out == ["Wait, really", "Yes", "It works"]
    # and a comma the transcript put in the middle of a sentence ending is gone
    assert shown("Stop. Breathe now.", "Stop breathe. Now.") == ["Stop", "Breathe now"]


def test_more_or_fewer_script_words_share_the_heard_time():
    words = heard("This is Clodcode at work.")
    groups = scriptalign.build("This is Claude Code at work.", words)["groups"]
    assert groups == [{"ids": ["w2"], "words": ["Claude", "Code"]}]
    out = captions.follow_script([dict(w, ids=[w["id"]]) for w in words], groups)
    claude, code = out[2], out[3]
    assert (claude["w"], code["w"]) == ("Claude", "Code")
    assert claude["s"] == words[2]["s"] and code["e"] == words[2]["e"]
    assert claude["e"] == code["s"] and claude["s"] < claude["e"] < code["e"]
    assert claude["ids"] == code["ids"] == ["w2"]               # one line, one anchor


def test_anchors_stay_on_transcript_word_ids():
    words = heard("I use Nave and flatly every day.")
    groups = scriptalign.build("I use Neve and Flowly every day.", words)["groups"]
    _, report, _, _, _ = captions.build_for_timeline(None, {"captions": {}}, 1080, 1920, words_out=words)
    plain = [t["ids"] for r in report for t in r["tokens"]]
    cues = captions.build_cues(words, {}, script_groups=groups)
    assert [c["ids"] for c in cues] == [r["ids"] for r in report]
    assert [x for c in cues for x in c["wids"]] == plain


def test_a_group_the_cut_splits_stays_as_heard():
    words = heard("Version four point oh ships today.")
    groups = scriptalign.build("Version 4.0 ships today.", words)["groups"]
    cut = [w for w in words if w["id"] != "w3"]                 # "oh" removed
    out = [c["t"] for c in captions.build_cues(cut, {"style": {"case": "as-is"}, "digits": False}, script_groups=groups)]
    assert text(out) == "Version four point ships today"


def test_corrections_win_over_the_script():
    script, said = "I use Neve and Flowly every day.", "I use Nave and flatly every day."
    fix = {"corrections": [{"from": "Nave", "to": "Nev"}]}
    assert text(shown(script, said, fix)) == "I use Nev and Flowly every day"
    at = {"corrections": [{"from": "flatly", "to": "Flowlie", "at": "w4"}]}
    assert text(shown(script, said, at)) == "I use Neve and Flowlie every day"


def project(tmp_path, script=None, **cap):
    proj = {"captions": {"style": {"case": "as-is"}, **cap}}
    if script is not None:
        proj["script"] = script
    return proj


def lines_for(tmp_path, proj, words):
    _, report, _, _, _ = captions.build_for_timeline(None, proj, 1080, 1920, words_out=words, project_dir=tmp_path)
    return [r["text"] for r in report]


def test_on_by_default_with_a_script_and_off_per_project(tmp_path):
    words = heard("I use Nave every day.")
    assert text(lines_for(tmp_path, project(tmp_path, "I use Neve every day."), words)) == "I use Neve every day"
    off = project(tmp_path, "I use Neve every day.", followScript=False)
    assert text(lines_for(tmp_path, off, words)) == "I use Nave every day"
    assert text(lines_for(tmp_path, project(tmp_path), words)) == "I use Nave every day"     # no script


def test_a_script_file_in_the_project_folder_counts(tmp_path):
    (tmp_path / "script.txt").write_text("[HOOK] I use **Neve** every day.", encoding="utf-8")
    assert text(lines_for(tmp_path, project(tmp_path), heard("I use Nave every day."))) == "I use Neve every day"


def test_the_plans_script_counts_once_it_is_locked(tmp_path):
    words = heard("I use Nave every day.")
    plan = {"script": {"draft": "I use Neve every day.", "rewrite": None, "locked": False}}
    assert text(lines_for(tmp_path, {**project(tmp_path), "plan": plan}, words)) == "I use Nave every day"
    plan["script"]["locked"] = True
    assert text(lines_for(tmp_path, {**project(tmp_path), "plan": plan}, words)) == "I use Neve every day"
    plan["script"]["rewrite"] = "I use NEVE every day."       # the creator's own version wins over the draft
    assert text(lines_for(tmp_path, {**project(tmp_path), "plan": plan}, words)) == "I use NEVE every day"


def test_the_mapping_is_stored_and_the_same_inputs_give_the_same_mapping(tmp_path):
    words = heard("Here is the Nave hook. Here is the Nave hook. Version four point oh is out.")
    proj = project(tmp_path, "Here is the Neve hook. Version 4.0 is out.")
    first = scriptalign.mapping(tmp_path, proj, words)
    stored = json.loads((tmp_path / "work" / scriptalign.FILE).read_text(encoding="utf-8"))
    assert stored == first
    assert scriptalign.mapping(tmp_path, proj, words) == first
    assert scriptalign.mapping(None, proj, words) == first          # built again, not read: still the same
    # a changed script is a new mapping
    proj["script"] = "Here is the Neve hook. Version 4.1 is out."
    again = scriptalign.mapping(tmp_path, proj, words)
    assert again["key"] != first["key"] and again["groups"] != first["groups"]
    assert json.loads((tmp_path / "work" / scriptalign.FILE).read_text(encoding="utf-8"))["key"] == again["key"]


def test_unrelated_speech_follows_nothing():
    m = scriptalign.build("Neve makes great microphones for studios.", heard("So today we talk about cooking pasta at home."))
    assert m["groups"] == [] and m["spans"] == []
