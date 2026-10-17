"""Caption defaults = the proven default look (grandma test: captions were small, grey and on the chest)."""
from reelengine import captions, project


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


def test_box_style_draws_an_opaque_box():
    ass, _, _, _ = captions.render_ass(_cue(), {"style": {"box": True}}, 1080, 1920)
    f = _style_line(ass)
    assert f[15] == "3"                    # BorderStyle 3 = opaque box in the outline colour
    assert float(f[16]) >= captions.BOX_PAD and float(f[17]) == 0.0
