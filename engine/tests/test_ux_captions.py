"""Caption defaults = the proven default look (grandma test: captions were small, grey and on the chest)."""
import re

from conftest import mkwords
from reelengine import captions, project, verify


def _style_line(ass: str) -> list:
    line = next(l for l in ass.splitlines() if l.startswith("Style: Cap,"))
    return line[len("Style: "):].split(",")


def _cue():
    return [{"s": 0.0, "e": 1.0, "t": "HELLO THERE", "ids": ["w0"]}]


def test_new_project_defaults_are_the_proven_look():
    st = project.new_project("t")["captions"]["style"]
    assert st["font"] == "Montserrat SemiBold"
    assert st["size"] == 105 and st["maxWords"] == 3
    assert st["color"] == "#FFFFFF" and st["outlineColor"] == "#000000"
    assert st["outline"] == 8 and st["shadow"] == 0
    assert st["position"] == 0.75   # line centre y 1440 -> bottom ~1495, the 425 px margin


def test_default_render_is_solid_outline_no_grey_shadow():
    ass, report, _, _ = captions.render_ass(_cue(), {}, 1080, 1920)
    f = _style_line(ass)
    assert f[2] == "105"
    assert f[6] == "&H00000000"            # BackColour opaque, not &H80 (grey see-through)
    assert f[15] == "1" and float(f[16]) == 8.0 and float(f[17]) == 0.0
    x, y, w, h = report[0]["box"]
    assert abs((y + h / 2) - 1440) <= 2   # centred at 0.75 of 1920
    assert y + h <= 1920 - 415            # bottom clears the 425 px margin (+ outline)


def test_the_widest_default_line_stays_clear_of_instagrams_right_buttons():
    # the widest three-word cue in the eval clips; at the old 6.5% margins it ended at x 1007
    words = mkwords([(0.0, 0.4, "someone's"), (0.4, 0.8, "personal"), (0.8, 1.3, "brand.")])
    _, report, _, _ = captions.render_ass(captions.build_cues(words, {}), {}, 1080, 1920)
    assert verify.caption_report(report, (1080, 1920))[0] == "PASS"


def test_box_style_draws_an_opaque_box():
    ass, _, _, _ = captions.render_ass(_cue(), {"style": {"box": True}}, 1080, 1920)
    f = _style_line(ass)
    assert f[15] == "3"                    # BorderStyle 3 = opaque box in the outline colour
    assert float(f[16]) >= captions.BOX_PAD and float(f[17]) == 0.0


def test_highlight_lights_each_spoken_word_in_turn_and_the_pop_runs_once_across_them():
    words = mkwords([(0.0, 0.07, "Make"), (0.08, 0.35, "it"), (0.4, 1.2, "pop.")])
    cap = {"style": {"highlight": "#FFD60A", "pop": True}}
    ass, _, _, _ = captions.render_ass(captions.build_cues(words, cap), cap, 1080, 1920)
    events = [l.split(",", 9) for l in ass.splitlines() if l.startswith("Dialogue:")]
    # one event per word, each ending where the next starts: the line never blinks between words
    assert [(e[1], e[2]) for e in events] == [("0:00:00.00", "0:00:00.08"), ("0:00:00.08", "0:00:00.40"),
                                              ("0:00:00.40", "0:00:01.20")]
    assert [re.findall(r"\{\\1c&H0AD6FF&\}(\w+)", e[9]) for e in events] == [["MAKE"], ["IT"], ["POP"]]
    assert {re.sub(r"\{[^}]*\}", "", e[9]) for e in events} == {"MAKE IT POP"}
    # the 120 ms grow carries on through the second word's event instead of restarting or stopping
    assert [re.findall(r"\\t\((-?\d+),(\d+)", e[9]) for e in events] == [[("0", "120")], [("-80", "40")], []]


def test_a_line_with_a_word_that_is_only_punctuation_is_drawn_without_the_highlight():
    words = mkwords([(0.0, 0.3, "so"), (0.35, 0.5, "—"), (0.55, 1.0, "yeah")])
    cap = {"style": {"highlight": "#FFD60A"}}
    ass, _, _, _ = captions.render_ass(captions.build_cues(words, cap), cap, 1080, 1920)
    events = [l.split(",", 9)[9] for l in ass.splitlines() if l.startswith("Dialogue:")]
    assert len(events) == 1 and "\\1c" not in events[0] and events[0].endswith("SO — YEAH")
