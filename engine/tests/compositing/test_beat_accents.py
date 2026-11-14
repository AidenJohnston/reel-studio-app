"""Optional music accents move overlays and effects without changing spoken cuts."""
from copy import deepcopy
import shutil
import subprocess

import numpy as np
import pytest

from reelengine import broll, music, project, render, sfx

BPM = 120
PERIOD = 60 / BPM
TARGETS = (4 * PERIOD, 12 * PERIOD)


@pytest.fixture(scope="module")
def click_track(tmp_path_factory):
    path = tmp_path_factory.mktemp("beat-track") / "click.flac"
    subprocess.run([shutil.which("ffmpeg"), "-v", "error", "-f", "lavfi", "-i",
                    f"aevalsrc=if(lt(mod(t\\,{PERIOD})\\,0.015)\\,0.8*sin(2*PI*1000*t)\\,0):s=48000:d=12",
                    "-ac", "2", str(path)], check=True)
    info = music.analyze_track_cached(path)
    assert info["bpm"] == pytest.approx(BPM, abs=1)
    assert all(min(abs(b - t) for b in info["beats"]) < 1 / 30 for t in TARGETS)
    return path


def context(tmp_path, click_track, **fields):
    proj = project.new_project("Beat accents")
    proj["sources"] = [{"id": "s1", "path": "media/take.mp4", "duration": 10, "fps": 30}]
    proj["cut"] = {"keep": [{"from": "w0", "to": "w4"}], "gapCap": 5}
    proj["music"] = {"track": str(click_track), "startAt": 0, "enabled": True}
    proj["broll"] = [{"id": "b1", "anchor": {"from": "w1", "to": "w1"}, "treatment": "text-pop"},
                     {"id": "b2", "anchor": {"from": "w3", "to": "w3"}, "treatment": "text-pop"}]
    proj["sfx"] = [{"at": {"word": "w1"}, "sound": "whoosh-quick"},
                   {"at": {"broll": "b2"}, "sound": "whoosh-quick"}]
    proj.update(fields)
    words = [{"id": f"w{i}", "source": "s1", "s": t, "e": t + 0.3, "w": "word"}
             for i, t in enumerate((0.1, TARGETS[0] + 0.06, 4.05, TARGETS[1] + 0.06, 8.05))]
    tl = project.timeline(tmp_path, proj, words)
    return render.make_ctx(tmp_path, proj, tl, True, tmp_path, tmp_path / "work"), tl


def times(ctx):
    placed, left = sfx.plan(ctx)
    assert left == []
    return [p["t"] for p in placed] + [p["t0"] for p in broll.plan_windows(ctx)]


def test_a_stored_beat_grid_puts_accents_on_the_same_frames_whatever_the_detector_says(tmp_path, click_track,
                                                                                       monkeypatch):
    # Fails if accents re-detect the song's beats while project.music.beats stores them for this file: another
    # machine, or a changed beat tracker, would move the cards and sound effects (architecture review 4).
    from reelengine import beats
    info = music.analyze_track_cached(click_track)
    grid = beats.quantise(info["beats"], 30, info["duration"], beats.file_sha256(click_track))
    stored = {"track": str(click_track), "startAt": 0, "enabled": True, "beats": grid}
    first = times(context(tmp_path, click_track, beatAccents=True, music=stored)[0])
    real = music.analyze_track_cached
    # the other machine's tracker: every beat 90 ms later, inside the 120 ms an accent may move
    monkeypatch.setattr(music, "analyze_track_cached",
                        lambda path, ctx=None: dict(real(path, ctx), beats=[b + 0.09 for b in real(path, ctx)["beats"]]))
    assert times(context(tmp_path, click_track, beatAccents=True, music=stored)[0]) == first


def test_hits_and_broll_land_on_detected_beats(tmp_path, click_track):
    ctx, _ = context(tmp_path, click_track, beatAccents=True)
    got = times(ctx)
    assert got == pytest.approx([*TARGETS, *TARGETS], abs=1 / 30)
    placed, _ = sfx.plan(ctx)
    voice = 0.1 * np.sin(2 * np.pi * 220 * np.arange(10 * music.SR) / music.SR)
    out, _ = sfx.track(ctx, placed, np.repeat(voice[:, None], 2, axis=1).astype(np.float32))
    for t in TARGETS:
        a, b = int((t - 0.2) * music.SR), int((t + 0.2) * music.SR)
        assert t - 0.2 + sfx.hit_offset(out[a:b]) == pytest.approx(t, abs=1 / 30)


def test_shifts_stay_within_120ms_including_frame_rounding(tmp_path, click_track):
    ctx, _ = context(tmp_path, click_track)
    before = times(ctx)
    ctx.project["beatAccents"] = True
    after = times(ctx)
    assert after != before
    assert all(abs(a - b) <= 0.12 for a, b in zip(after, before))
    # The nearest beat is outside the permitted shift for these moments.
    ctx.project["music"]["startAt"] = 0.25
    assert times(ctx) == before
    ctx.project["music"]["startAt"] = 0
    beat = min(music.analyze_track_cached(click_track)["beats"], key=lambda t: abs(t - TARGETS[0]))
    original = beat - 0.119
    assert round(beat * 30) / 30 - original > 0.12
    ctx.project["broll"][0]["leadIn"] = ctx.word_out_time("w1") - original
    assert broll.plan_windows(ctx)[0]["t0"] == pytest.approx(original)


def test_flag_off_restores_original_times(tmp_path, click_track):
    ctx, _ = context(tmp_path, click_track)
    before = times(ctx)
    ctx.project["beatAccents"] = True
    assert times(ctx) != before
    ctx.project["beatAccents"] = False
    assert times(ctx) == before
    ctx.project.pop("beatAccents")
    assert times(ctx) == before


def test_word_cuts_and_word_mapping_never_move(tmp_path, click_track):
    ctx, tl = context(tmp_path, click_track,
                      cut={"keep": [{"from": "w0", "to": "w1"}, {"from": "w3", "to": "w4"}], "gapCap": 5})
    assert len(tl.segments) == 2
    # The shortened cut puts the two effects inside the pack's two-second gap.
    ctx.project["sfx"] = ctx.project["sfx"][:1]
    before = times(ctx)
    segments, words, cut = deepcopy(tl.segments), deepcopy(tl.words_out), deepcopy(ctx.project["cut"])
    ctx.project["beatAccents"] = True
    assert times(ctx) != before
    again = project.timeline(tmp_path, ctx.project, ctx.words)
    assert again.segments == tl.segments == segments
    assert again.words_out == tl.words_out == words
    assert ctx.project["cut"] == cut


def test_broll_cannot_exceed_its_card_lead(tmp_path, click_track):
    ctx, _ = context(tmp_path, click_track, beatAccents=True)
    assert times(ctx)[0] == pytest.approx(TARGETS[0], abs=1 / 30)
    ctx.project["broll"][0]["leadIn"] = 0.04
    assert broll.plan_windows(ctx)[0]["t0"] >= ctx.word_out_time("w1") - 0.04


def test_hyper_opts_in_without_cut_style_dependency(tmp_path, click_track):
    ctx, _ = context(tmp_path, click_track)
    before = times(ctx)
    for style in (None, False, "hyper", [], {"preset": "standard"}):
        ctx.project["cutStyle"] = style
        assert times(ctx) == before
    ctx.project["cutStyle"] = {"preset": "hyper"}
    assert times(ctx) == pytest.approx([*TARGETS, *TARGETS], abs=1 / 30)
    # fails if the person can't turn the fast pace's beat landing off
    ctx.project["beatAccents"] = False
    assert times(ctx) == before


def test_music_start_disabled_and_beatless_music(tmp_path, click_track):
    ctx, _ = context(tmp_path, click_track)
    before = times(ctx)
    ctx.project["beatAccents"] = True
    start = PERIOD - 0.04
    ctx.project["music"]["startAt"] = start
    beats = music.analyze_track_cached(click_track)["beats"]
    expected = [min(beats, key=lambda b: abs(b - t - start)) - start for t in TARGETS]
    assert times(ctx) == pytest.approx([*expected, *expected], abs=1 / 30)
    ctx.project["music"]["enabled"] = False
    assert times(ctx) == before
    silent = tmp_path / "silence.flac"
    subprocess.run([shutil.which("ffmpeg"), "-v", "error", "-f", "lavfi", "-i",
                    "anullsrc=r=48000:cl=stereo", "-t", "6", str(silent)], check=True)
    ctx.project["music"].update(enabled=True, track=str(silent))
    assert times(ctx) == before


def test_schema_requires_boolean_beat_accents():
    proj = project.new_project("Beat accents")
    assert project.validate(proj) == []
    for value in (True, False):
        proj["beatAccents"] = value
        assert project.validate(proj) == []
    proj["beatAccents"] = "true"
    assert any("beatAccents" in error for error in project.validate(proj))


def boundary_context(tmp_path, word_times, keep):
    proj = project.new_project("Accent boundaries")
    proj.update(beatAccents=True, sources=[{"id": "s1", "path": "media/take.mp4", "duration": 6, "fps": 30}],
                cut={"keep": keep, "gapCap": 5})
    words = [{"id": f"w{i}", "source": "s1", "s": a, "e": b, "w": "word"}
             for i, (a, b) in enumerate(word_times)]
    tl = project.timeline(tmp_path, proj, words)
    return render.make_ctx(tmp_path, proj, tl, True, tmp_path, tmp_path / "work")


@pytest.mark.parametrize("beat", [35 / 30, 34 / 30])
def test_snapping_cannot_remove_a_neighbouring_card(tmp_path, monkeypatch, beat):
    ctx = boundary_context(tmp_path, [(0.1, 0.4), (1.2, 1.25), (1.3, 1.4), (3, 3.3)],
                           [{"from": "w0", "to": "w3"}])
    ctx.project["broll"] = [
        {"id": f"b{i}", "anchor": {"from": f"w{i}", "to": f"w{i}"},
         "treatment": "text-pop", "leadIn": 4 / 30} for i in (1, 2)]
    monkeypatch.setattr(music, "accent_beats", lambda ctx: [beat])
    plans = broll.plan_windows(ctx)
    assert [p["id"] for p in plans] == ["b1", "b2"]
    assert plans[0]["t0"] == pytest.approx(32 / 30)
    assert plans[0]["t1"] - plans[0]["t0"] > 0.05


@pytest.mark.parametrize("kind,direction", [
    ("sfx", "backward"), ("sfx", "forward"), ("sfx", "from-cut"), ("broll", "forward"),
])
def test_snapping_cannot_cross_a_shot_boundary(tmp_path, monkeypatch, kind, direction):
    word_times = [(0.1, 0.4), (1, 1.02), (1.2, 3), (3.05, 3.35), (3.6, 4)]
    if direction == "from-cut":
        word_times[1], word_times[3] = (0.9, 0.98), (3, 3.35)
    ctx = boundary_context(tmp_path, word_times,
                           [{"from": "w0", "to": "w1"}, {"from": "w3", "to": "w4"}])
    assert len(ctx.out_timeline) == 2
    cut = ctx.out_timeline[1].out_start
    word = "w1" if direction == "forward" else "w3"
    original = round(ctx.word_out_time(word) * 30) / 30
    beat = cut if direction == "forward" else round(cut * 30) / 30 - 1 / 30
    monkeypatch.setattr(music, "accent_beats", lambda ctx: [beat])
    if kind == "sfx":
        ctx.project["sfx"] = [{"at": {"word": word}, "sound": "click-tick"}]
        placed, left = sfx.plan(ctx)
        assert left == []
        assert placed[0]["t"] == pytest.approx(original)
    else:
        ctx.project["broll"] = [{"id": "b1", "anchor": {"from": word, "to": word},
                                  "treatment": "text-pop", "leadIn": 0}]
        assert broll.plan_windows(ctx)[0]["t0"] == pytest.approx(ctx.word_out_time(word))


def test_snapping_cannot_drop_a_neighbouring_sfx_hit(tmp_path, monkeypatch):
    ctx = boundary_context(tmp_path, [(0.1, 0.4), (1.1, 1.4), (3.1, 3.4)],
                           [{"from": "w0", "to": "w2"}])
    ctx.project["sfx"] = [{"at": {"word": f"w{i}"}, "sound": "click-tick"} for i in (1, 2)]
    monkeypatch.setattr(music, "accent_beats", lambda ctx: [1.2, 3.1])
    placed, left = sfx.plan(ctx)
    assert left == []
    assert [p["t"] for p in placed] == pytest.approx([1.1, 3.1])


def test_accents_follow_the_frozen_song_the_mix_plays_not_the_library_file(tmp_path, click_track):
    """Fails if beat landing reads the Library song after the mix has frozen a copy of it: once that
    Library file is replaced (here by one whose beats fall half a beat later) or deleted, cards would
    land off the beat you hear, or stop landing at all."""
    lib = tmp_path / "Library" / "Music"
    lib.mkdir(parents=True)
    subprocess.run([shutil.which("ffmpeg"), "-v", "error", "-f", "lavfi", "-i",
                    f"aevalsrc=if(lt(mod(t+{PERIOD / 2}\\,{PERIOD})\\,0.015)\\,0.8*sin(2*PI*1000*t)\\,0):s=48000:d=12",
                    "-ac", "2", str(lib / "song.flac")], check=True)          # the replaced Library file
    frozen = tmp_path / "work" / "assets" / "frozen"
    frozen.mkdir(parents=True)
    shutil.copy2(click_track, frozen / "song.flac")                           # what the mix plays
    ctx, _ = context(tmp_path, click_track, beatAccents=True,
                     music={"track": "Library/Music/song.flac", "startAt": 0, "enabled": True,
                            "frozen": {"track": "Library/Music/song.flac", "path": "work/assets/frozen/song.flac"}})
    for _ in range(2):
        beats = music.accent_beats(ctx)
        assert len(beats) >= 8
        assert all(abs(b / PERIOD - round(b / PERIOD)) * PERIOD < 1 / 30 for b in beats), beats
        (lib / "song.flac").unlink(missing_ok=True)                           # and once it is gone
        ctx._accent_analysis = None
