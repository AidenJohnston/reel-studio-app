import numpy as np

from conftest import mkwords
from reelengine import audio_env, captions, render
from reelengine.render_ctx import Segment


def test_chunking_rules():
    w = mkwords([(0.0, 0.2, "Today"), (0.2, 0.4, "is"), (0.4, 0.6, "day"), (0.6, 0.8, "1."),
                 (0.9, 1.1, "We"), (1.1, 1.3, "have"), (1.3, 1.5, "3,000"), (1.5, 1.7, "users"),
                 (1.7, 1.9, "now.")])
    cues = captions.chunk(captions.stitch_numbers(w), 3)
    texts = [" ".join(c["words"]) for c in cues]
    # a number never opens a line and never loses its unit; a sentence end always breaks
    assert texts[0] == "Today is day 1."
    assert "3,000 users" in " | ".join(texts)
    assert not any(t.split()[0][0].isdigit() for t in texts)


def test_split_thousands_restitched():
    w = mkwords([(0.0, 0.3, "won"), (0.3, 0.5, "$10"), (0.5, 0.7, ",000")])
    out = captions.stitch_numbers(w)
    assert [x["w"] for x in out] == ["won", "$10,000"]


def test_corrections_counted_and_spans():
    w = mkwords([(0, 0.3, "cloud"), (0.3, 0.6, "code's"), (0.6, 0.9, "many"), (0.9, 1.2, "chat.")])
    stats = {}
    corr = captions.normalize_corrections([{"from": "cloud", "to": "Claude"},
                                           {"from": "many chat", "to": "ManyChat"},
                                           {"from": "zzz", "to": "y"}])
    out = captions.apply_corrections(w, corr, stats)
    assert [x["w"] for x in out] == ["Claude", "code's", "ManyChat."]
    assert stats["cloud"] == 1 and stats["many chat"] == 1 and stats["zzz"] == 0


def test_runs_split_on_silence_and_hold():
    w = mkwords([(0, 0.3, "one"), (0.35, 0.6, "two"), (3.0, 3.3, "three")])
    runs = captions.split_runs(w)
    assert len(runs) == 2
    cues = captions.hold(captions.chunk(runs[0], 3))
    assert cues[0]["e"] >= cues[0]["s"] + captions.MIN_CUE - 1e-9


def test_fit_shrinks_long_lines_and_never_grows():
    fam, path, metrics, warn = captions.resolve_font("Montserrat SemiBold")
    assert warn is None and path.name.lower().startswith("montserrat")
    m = captions.Measurer(path, metrics)
    size, lines = captions.fit("HI", 76, 940, 6, m)
    assert size == 76 and lines == ["HI"]
    size, lines = captions.fit("INTERNATIONALIZATION EVERYWHERE", 76, 940, 6, m)
    assert size <= 76
    assert max(m.width(t, size, 6) for t in lines) <= 940
    # a real cue the old size-by-ratio estimate left 1 px too wide
    size, lines = captions.fit("AND IMPERSONATED BEING 7", 105, 939.6, 8, m)
    assert m.width(lines[0], size, 8) <= 939.6


def test_unknown_font_falls_back_with_a_warning():
    fam, path, _, warn = captions.resolve_font("No Such Font 123")
    assert fam == captions.DEFAULT_FONT and warn


def test_ass_timestamps():
    assert captions.ts(0) == "0:00:00.00"
    assert captions.ts(61.256) == "0:01:01.26"
    assert captions.ts(3600.5) == "1:00:00.50"


def test_release_rescued_and_late_start_fixed():
    per = audio_env.PER
    env = np.full(400, 0.001, dtype=np.float32)
    env[int(1.0 * per):int(1.62 * per)] = 0.05         # sound really runs to 1.62
    env[int(2.5 * per):int(3.0 * per)] = 0.05          # next word starts at 2.5
    words = [{"s": 1.0, "e": 1.45, "w": "things."}, {"s": 1.9, "e": 3.0, "w": "Every"}]
    out = audio_env.refine_words(words, env, audio_env.noise_threshold(env), 4.0)
    assert out[0]["e"] >= 1.60                              # the release belongs to the word
    assert 2.40 <= out[1]["s"] <= 2.50                      # start pulled to the real onset


def test_lanes_handle_reordered_cuts():
    segs = [Segment("s1", 50.0, 52.0, 0.0), Segment("s1", 1.0, 3.0, 2.0), Segment("s1", 4.0, 6.0, 4.0)]
    lanes = render.plan_lanes(segs)
    assert len(lanes) == 2
    assert lanes[0]["segs"] == [0] and lanes[1]["segs"] == [1, 2]
    assert lanes[0]["seek"] > 40          # the late segment is reached by an input seek


def test_reframe_landscape_centres_on_face():
    src = {"width": 1920, "height": 1080, "rotation": 0}
    pl = render.reframe_plan(src, 1080, 1920, face=(1500.0, 500.0))
    assert pl["rch"] == 1080 and abs(pl["rcw"] / pl["rch"] - 1080 / 1920) < 0.01
    assert pl["rx"] + pl["rcw"] / 2 > 1200                 # moved toward the face


def test_reframe_rotated_phone_video():
    src = {"width": 1920, "height": 1080, "rotation": 90}   # stored sideways, displayed portrait
    pl = render.reframe_plan(src, 1080, 1920, face=None)
    assert (pl["rcw"], pl["rch"]) == (1920, 1080)          # already 9:16 once turned: no crop
    assert (pl["sw"], pl["sh"]) == (1920, 1080)            # scaled in stored orientation
    chain = render.reframe_filter(src, 540, 960, None, True)
    assert chain.endswith("transpose=clock") and "crop" not in chain


def test_phrase_correction_wins_over_a_single_word_of_it():
    # an AI that adds "script" -> "TypeScript" AND "type script" -> "TypeScript" used to show
    # "type TypeScript": the single word ran first and the phrase no longer matched
    w = mkwords([(0, 0.3, "learn"), (0.3, 0.6, "type"), (0.6, 0.9, "script,"), (1.0, 1.3, "script")])
    stats = {}
    corr = captions.normalize_corrections([{"from": "script", "to": "TypeScript"},
                                           {"from": "type script", "to": "TypeScript"}])
    out = captions.apply_corrections(w, corr, stats)
    assert [x["w"] for x in out] == ["learn", "TypeScript,", "TypeScript"]
    assert stats["type script"] == 1 and stats["script"] == 1
    assert all("_fixed" not in x for x in out)
