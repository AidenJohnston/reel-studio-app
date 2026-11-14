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


def test_a_short_skipped_sentence_is_not_shown():
    for skipped in ("Skip.", "Skip this.", "Skip this line."):
        script = f"First step done. {skipped} Then Neve works well."
        assert text(shown(script, "First step done. Then Nave works well.")) == "First step done Then Neve works well"


def test_a_word_left_out_shows_inside_its_own_sentence():
    # "so" was left out at the start of the sentence the speaker said: it opens that sentence's line
    words = heard("This is great. We went home.")
    assert {"ids": ["w3"], "words": ["So", "we"]} in scriptalign.build("This is great. So we went home.", words)["groups"]
    # left out at the end of one: it closes that one
    words = heard("We went home. Then we slept.")
    assert {"ids": ["w2"], "words": ["home", "now."]} in scriptalign.build("We went home now. Then we slept.", words)["groups"]


def test_a_mishearing_never_brings_in_a_sentence_nobody_said():
    out = text(shown("First step done. Skip this. Then Neve works.", "First step done. um Then Nave works."))
    assert "Skip" not in out and "um" in out and out.endswith("Then Neve works")


def test_the_off_script_limit_counts_words_not_number_keys():
    # "four point oh five" is one key but four heard words: past GAP_MAX, so it is off-script, not "Neve"
    out = text(shown("We use the Neve preamp daily.", "We use the four point oh five preamp daily.", {"digits": False}))
    assert "Neve" not in out and "four point oh five" in out


def test_markdown_marks_go_but_names_keep_their_characters():
    assert text(shown("I write C# and F# code every day.", "I write C# and F# code every day.")) == "I write C# and F# code every day"
    assert text(shown("I write C# code.", "I write C sharp code.")) == "I write C# code"
    assert text(shown("I installed whisper_cpp today.", "I installed whisper cpp today.")) == "I installed whisper_cpp today"
    units = [u for u, _ in scriptalign.script_units("# Hook\n- **Neve** is _great_, *really* [b-roll: mic] `__init__` C++")]
    assert units == ["Hook", "Neve", "is", "great,", "really", "__init__", "C++"]


def test_the_scripts_spelling_of_a_number_stays():
    # the default digits pass would draw "25": the script spells it out, so it stays spelled out
    assert text(shown("I waited twenty five days.", "I waited 25 days.")) == "I waited twenty five days"
    assert text(shown("I waited twenty five days.", "I waited twenty five days.")) == "I waited twenty five days"
    # words that follow no script still become digits
    assert text(shown("We record every day.", "We record every day. I waited twenty five days.")) == "We record every day I waited 25 days"


def test_a_script_without_spaces_aligns_to_whispers_words():
    out = shown("今天我们使用Neve录音。声音非常清晰。", "今天 我们 使用 Nave 录音。 声音 非常 清晰。")
    assert text(out) == text(shown("", "今天 我们 使用 Neve 录音。 声音 非常 清晰。"))   # as if heard right
    words = heard("今日は Nave で 録音 します。")
    groups = scriptalign.build("今日はNeveで録音します。", words)["groups"]
    assert {"ids": ["w1"], "words": ["Neve"]} in groups
    assert {"ids": ["w0"], "words": ["今日は"]} in groups           # drawn back as the script's own run


def test_a_skipped_sentence_inside_one_heard_word_stays_out():
    # whisper heard the whole unspaced line as one word: the sentence between still wasn't said
    groups = scriptalign.build("今天开始。谢谢。工作结束。", [{"id": "w0", "w": "今天开始工作结束。"}])["groups"]
    assert groups == [{"ids": ["w0"], "words": ["今天开始。", "工作结束。"]}]


def test_a_mapping_saved_by_an_older_version_is_rebuilt(tmp_path, monkeypatch):
    words = heard("今天开始工作结束。")
    proj = project(tmp_path, "今天开始。谢谢。工作结束。")
    # what the previous version stored: the skipped sentence drawn back in
    monkeypatch.setattr(scriptalign, "VERSION", scriptalign.VERSION - 1)
    old = {"version": scriptalign.VERSION, "key": scriptalign._key(proj["script"], words), "script": proj["script"],
           "groups": [{"ids": ["w0"], "words": ["今天开始。谢谢。工作结束。"]}], "spans": [["w0", "w0"]]}
    monkeypatch.undo()
    (tmp_path / "work").mkdir()
    (tmp_path / "work" / scriptalign.FILE).write_text(json.dumps(old), encoding="utf-8")
    assert scriptalign.mapping(tmp_path, proj, words)["groups"] == [{"ids": ["w0"], "words": ["今天开始。", "工作结束。"]}]


def test_the_mapping_key_is_pinned():
    # the same inputs and value as ai/test/script-follow.test.ts: the AI checks the key the same way
    words = [{"id": "w0", "w": " Nave"}, {"id": "w1", "w": "今天。"}]
    assert scriptalign._key('Use Neve, 4.0 — 今天。\n"quoted"', words) == "1600ca474501091523e309c7b2bf0f1d69bc8bff38d7cf0709690a809cf2a28b"


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
    assert {"ids": ["w2"], "words": ["Claude", "Code"]} in groups
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
    # the script removed: the stored mapping goes with it
    del proj["script"]
    assert scriptalign.mapping(tmp_path, proj, words) is None
    assert not (tmp_path / "work" / scriptalign.FILE).exists()


def test_unrelated_speech_follows_nothing():
    m = scriptalign.build("Neve makes great microphones for studios.", heard("So today we talk about cooking pasta at home."))
    assert m["groups"] == [] and m["spans"] == []


def test_following_the_script_never_moves_a_caption_off_the_audio():
    """The script changes the words drawn, never when they show: each caption keeps the start, end and transcript
    words it has without the script, and each word starts when it is heard. Fails if a caption drifts from the
    timing the audio gives it."""
    said = "I use Nave and flatly every day. Talk to Nave about it. Then call Flowly back."
    script = "I use Neve and Flowly every day. Talk to Neve about it. Then call Flowly back."
    words = heard(said)
    groups = scriptalign.build(script, words)["groups"]
    cap = {"style": {"case": "as-is"}}
    plain = captions.build_cues(words, cap)
    follow = captions.build_cues(words, cap, script_groups=groups)
    assert text([c["t"] for c in follow]) == "I use Neve and Flowly every day Talk to Neve about it Then call Flowly back"
    assert [(c["s"], c["e"], c["ids"]) for c in follow] == [(c["s"], c["e"], c["ids"]) for c in plain]
    # and each word lights at the moment it is heard (a karaoke highlight reads these)
    by_id = {w["id"]: w for w in words}
    for c in follow:
        assert c["starts"] == [by_id[ids[0]]["s"] for ids in c["wids"]], c


def test_a_planned_reels_hook_and_lines_are_one_script(tmp_path):
    """The app writes a planned reel's script as {hook, script, shots} (app shared/plan.ts planAsScript), with the
    hook apart from its lines; the editor's own script already holds its hook. ai test/script-follow.test.ts pins
    the same text, which the mapping's key is made from."""
    planned = {"hook": "Nobody tells you this about Neve.", "script": "I use Neve every day.", "shots": ["desk"]}
    assert scriptalign.script_text(None, {"script": planned}) == "Nobody tells you this about Neve.\nI use Neve every day."
    written = {"hook": "Nobody tells you this.", "script": "Nobody tells you this.\nI use Neve every day."}
    assert scriptalign.script_text(None, {"script": written}) == written["script"]
    words = heard("Nobody tells you this about Nave. I use Nave every day.")
    assert text(lines_for(tmp_path, project(tmp_path, planned), words)) == "Nobody tells you this about Neve I use Neve every day"
