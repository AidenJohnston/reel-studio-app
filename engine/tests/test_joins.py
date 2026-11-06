"""Join regressions measured at the project, PCM and caption boundaries."""
import copy
import json
import wave
from pathlib import Path

import numpy as np
import pytest

from conftest import mkwords
from reelengine import captions, music, project, render, sfx
from reelengine.proto import EngineError

SR = 48000


def fixture_project(tmp_path, transition=None, frames=6, fps=30):
    words = (mkwords([(0.1, 0.4, "Removed."), (1.0, 2.0, "One."), (2.6, 2.8, "Removed.")])
             + mkwords([(0.1, 0.4, "Removed."), (1.0, 2.0, "Two."), (2.6, 2.8, "Removed.")],
                       source="s2", start_id=3))
    p = project.new_project("Joins")
    p["format"] = {"width": 160, "height": 284, "fps": fps}
    p["sources"] = [{"id": sid, "path": f"media/{sid}.wav", "duration": 3, "fps": 30}
                    for sid in ("s1", "s2")]
    p["cut"]["keep"] = [{"from": "w1", "to": "w1"}, {"from": "w4", "to": "w4"}]
    if transition:
        p["cut"]["keep"][1]["join"] = {"transition": transition, "frames": frames}
    tl = project.timeline(tmp_path, p, words)
    ctx = render.make_ctx(tmp_path, p, tl, False, tmp_path, tmp_path)
    return p, words, tl, ctx


def read_pcm(path):
    with wave.open(str(path), "rb") as wav:
        assert wav.getframerate() == SR
        return np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2").reshape(-1, wav.getnchannels()) / 32768


def tones(tmp_path):
    """Two tones with nonperiodic amplitude changes expose wrong source offsets too."""
    paths, signals = {}, {}
    t = np.arange(3 * SR) / SR
    for sid, hz in (("s1", 440), ("s2", 880)):
        # Quiet handles and a louder word make the audible word onset measurable.
        amp = np.where((t >= 1) & (t < 2), 0.12, 0.025) * (0.6 + t / 10)
        signal = np.round(32767 * amp * np.sin(2 * np.pi * hz * t)).astype("<i2")
        path = tmp_path / "media" / f"{sid}.wav"
        path.parent.mkdir(exist_ok=True)
        with wave.open(str(path), "wb") as wav:
            wav.setnchannels(2)
            wav.setsampwidth(2)
            wav.setframerate(SR)
            wav.writeframes(np.column_stack([signal, signal]).tobytes())
        paths[sid], signals[sid] = path, signal / 32768
    return paths, signals


def samples_at(signal, source_start, duration=0.04):
    a = round(source_start * SR)
    return signal[a:a + round(duration * SR)]


@pytest.mark.parametrize("kind", ["j", "l"])
def test_rendered_join_source_offset_duration_and_captions(tmp_path, kind):
    """Fails if a handle uses the wrong source/offset, lengthens the cut or moves a caption."""
    p, words, tl, ctx = fixture_project(tmp_path, kind)
    _, _, hard, hard_ctx = fixture_project(tmp_path)
    paths, signals = tones(tmp_path)
    voice = render.render_voice(ctx, tl.segments, paths, tmp_path / "voice.wav", render.probe_source_audio(ctx, tl.segments, paths))
    pcm = read_pcm(voice)[:, 0]
    old_pcm = read_pcm(render.render_voice(hard_ctx, hard.segments, paths, tmp_path / "hard.wav", render.probe_source_audio(hard_ctx, hard.segments, paths)))[:, 0]
    join = hard.segments[1].out_start
    t = join - 0.12 if kind == "j" else join + 0.08
    a = round(t * SR)
    # Both original mappings contribute within the bridge, with no global time shift.
    expected = sum(samples_at(signals[s.source], s.src_start + t - s.out_start) for s in hard.segments)
    np.testing.assert_allclose(pcm[a:a + len(expected)], expected, atol=5e-5)
    assert np.max(abs(pcm[a:a + len(expected)] - old_pcm[a:a + len(expected)])) > 0.01
    edge = round((join - 0.2 if kind == "j" else join + 0.2) * SR)
    edge_sample = edge if kind == "j" else edge - 1
    # The added handle reaches zero at its outer edge instead of starting/stopping abruptly.
    assert abs(pcm[edge_sample] - old_pcm[edge_sample]) < 0.001
    assert len(pcm) == len(old_pcm) == round(tl.duration * SR)
    assert tl.duration == hard.duration
    assert [(s.source, s.src_start, s.src_end, s.out_start) for s in tl.segments] == [
        (s.source, s.src_start, s.src_end, s.out_start) for s in hard.segments]
    # The bridge is local: the following word has exactly the hard-cut PCM and ASS cue.
    after = round((join + 0.4) * SR)
    np.testing.assert_allclose(pcm[after:], old_pcm[after:], atol=5e-5)
    ass, cues, *_ = captions.build_for_timeline(tl, p, 1080, 1920)
    hard_ass, *_ = captions.build_for_timeline(hard, p, 1080, 1920)
    assert ass == hard_ass
    for wid, source in (("w1", "s1"), ("w4", "s2")):
        cue = next(c for c in cues if wid in c["ids"])
        word_t = tl.word_out_time(wid)
        assert abs(cue["s"] - word_t) < 0.001
        start = round((word_t + 0.04) * SR)
        # Caption timestamps round to milliseconds; allow that rounding, not a frame.
        target = samples_at(signals[source], 1.04, 0.02)
        assert np.corrcoef(pcm[start:start + len(target)], target)[0, 1] > 0.97
        assert word_t == hard.word_out_time(wid)
        assert tl.word_out_end(wid) == hard.word_out_end(wid)
    # Changing to hard at the same cache destination must not reuse the overlap audio.
    render.render_voice(hard_ctx, hard.segments, paths, voice, render.probe_source_audio(hard_ctx, hard.segments, paths))
    np.testing.assert_array_equal(read_pcm(voice)[:, 0], old_pcm)


@pytest.mark.parametrize("kind", ["j", "l"])
def test_handles_clamp_to_removed_words_and_zero_room(tmp_path, kind):
    """Fails if a bridge brings a removed word back or runs outside a source."""
    p, words, tl, ctx = fixture_project(tmp_path, kind, frames=999, fps=24)
    if kind == "j":
        seg = tl.segments[1]
        assert seg.audio_lead == pytest.approx(10 / 24)
        assert seg.src_start - seg.audio_lead >= words[3]["e"]
        words[3]["e"] = seg.src_start
    else:
        seg = tl.segments[0]
        assert seg.audio_tail == pytest.approx(12 / 24)
        assert seg.src_end + seg.audio_tail <= words[2]["s"]
        words[2]["s"] = seg.src_end
    no_room = project.timeline(tmp_path, p, words)
    assert all(s.audio_lead == s.audio_tail == 0 for s in no_room.segments)
    paths, _ = tones(tmp_path)
    no_room_ctx = render.make_ctx(tmp_path, p, no_room, False, tmp_path, tmp_path)
    p["cut"]["keep"][1].pop("join")
    hard = project.timeline(tmp_path, p, words)
    hard_ctx = render.make_ctx(tmp_path, p, hard, False, tmp_path, tmp_path)
    a = render.render_voice(no_room_ctx, no_room.segments, paths, tmp_path / "clamped.wav", render.probe_source_audio(no_room_ctx, no_room.segments, paths))
    b = render.render_voice(hard_ctx, hard.segments, paths, tmp_path / "hard.wav", render.probe_source_audio(hard_ctx, hard.segments, paths))
    np.testing.assert_array_equal(read_pcm(a), read_pcm(b))


def test_join_markers_survive_source_splits_repeats_and_merged_ranges(tmp_path):
    """Fails if a declared join is attached by run number or first occurrence of a word."""
    p, words, _, _ = fixture_project(tmp_path)
    p["cut"]["keep"] = [
        {"from": "w0", "to": "w4"},  # two source runs before the declared join
        {"from": "w1", "to": "w1", "join": {"transition": "j", "frames": 6}},
        {"from": "w4", "to": "w4", "join": {"transition": "l", "frames": 6}},
    ]
    tl = project.timeline(tmp_path, p, words)
    marked = [s for s in tl.segments if s.join_transition]
    assert [(s.source, s.first_word, s.join_transition) for s in marked] == [("s1", "w1", "j"), ("s2", "w4", "l")]
    assert marked[0].audio_lead == pytest.approx(0.2)
    assert marked[0].audio_tail == pytest.approx(0.2)
    # A continuous source boundary does not play the same samples twice or add frames.
    p["cut"]["keep"] = [{"from": "w0", "to": "w0"}, {"from": "w1", "to": "w1", "join": {"transition": "j", "frames": 6}}]
    p["cut"]["gapCap"] = 2
    joined = project.timeline(tmp_path, p, words)
    p["cut"]["keep"][1].pop("join")
    hard = project.timeline(tmp_path, p, words)
    assert joined.duration == hard.duration
    assert all(s.audio_lead == s.audio_tail == 0 for s in joined.segments)
    assert joined.words_out == hard.words_out


@pytest.mark.parametrize("join,first", [
    ({"transition": "j", "frames": 6}, True),
    ({"transition": "match", "frames": 6}, True),
    ({"transition": "dissolve", "frames": 6}, False),
    ({"transition": "j", "frames": -1}, False),
    ({"transition": "l", "frames": 1.5}, False),
])
def test_invalid_joins_fail_schema_and_planner(tmp_path, join, first):
    """Fails if malformed persisted joins silently render as hard cuts."""
    p, words, _, _ = fixture_project(tmp_path)
    p["cut"]["keep"][0 if first else 1]["join"] = join
    assert project.validate(p)
    with pytest.raises(EngineError, match="cut.keep"):
        project.timeline(tmp_path, p, words)


def test_smash_renders_hit_and_short_music_dip_without_mutating_project(tmp_path):
    """Fails if a smash only changes metadata, or its music dip follows the whole word."""
    p, words, tl, ctx = fixture_project(tmp_path, "smash")
    saved = copy.deepcopy(p)
    paths, _ = tones(tmp_path)
    voice = render.render_voice(ctx, tl.segments, paths, tmp_path / "voice.wav", render.probe_source_audio(ctx, tl.segments, paths))
    placed, skipped = sfx.plan(ctx)
    assert not skipped and len(placed) == 1
    assert placed[0]["at"] == {"cut": "w4"}
    hit = round(tl.segments[1].out_start * 30) / 30
    assert placed[0]["t"] == hit
    _, _, hard, hard_ctx = fixture_project(tmp_path)
    signal = read_pcm(voice).astype(np.float32)
    fx, rows = sfx.track(ctx, placed, signal)
    assert np.max(abs(fx)) > 0
    peak = sfx.hit_offset(fx)
    assert abs(peak - hit) < 0.04
    curve, rep = music.music_gain_curve(ctx, signal, signal, p["music"])
    plain, _ = music.music_gain_curve(hard_ctx, signal, signal, p["music"])
    assert rep["automation"] == [{"from": round(hit, 3), "to": round(hit + 0.2, 3), "gainDb": -6.0}]
    assert np.min(curve - plain) < -1
    np.testing.assert_allclose(curve[-3:], plain[-3:], atol=0.2)
    # Exercise actual mix creation, including cache invalidation with identical voice PCM.
    hard_mix = music.build_audio(hard_ctx, voice)
    smash_mix = music.build_audio(ctx, voice)
    assert smash_mix != hard_mix
    report = json.loads(Path(smash_mix).with_suffix(".json").read_text())  # each mix's report sits beside it (#87)
    assert report["sfx"][0]["at"] == {"cut": "w4"}
    mixed = music.decode(smash_mix, ctx)
    plain_mix = music.decode(hard_mix, ctx)
    assert mixed.shape == plain_mix.shape == signal.shape
    assert np.max(abs(mixed - plain_mix)) > 0.001
    assert p == saved
    # An explicit effect on that cut replaces the default rather than competing with it.
    p["sfx"] = [{"at": {"cut": "w4"}, "sound": "pop-soft"}]
    placed, skipped = sfx.plan(ctx)
    assert not skipped and [x["sound"]["id"] for x in placed] == ["pop-soft"]

def test_legacy_and_explicit_hard_pcm_match_pre_join_engine(tmp_path):
    """Fails if adding join support changes an existing project's decoded voice samples."""
    _, _, tl, ctx = fixture_project(tmp_path)
    paths, signals = tones(tmp_path)
    pcm = read_pcm(render.render_voice(ctx, tl.segments, paths, tmp_path / "legacy.wav", render.probe_source_audio(ctx, tl.segments, paths)))
    # What multi-source eccb384, which has no join support, played for this fixture: s1's samples 43200-99199, then
    # s2's 40000-111999, each with a 6 ms (288-sample) linear fade in and out. Outside the fades that is the source
    # exactly. Inside them FFmpeg rounds each faded sample to 16 bits, and builds round differently (the exact digest
    # this replaced, 0bbccbec..., held only where FFmpeg rounds down; 4fe77be's, 89de48d4..., where it truncates), so
    # there each sample must be within 1 LSB of the ramp.
    fade = 288
    expected, in_fade = [], []
    for sid, start, n in (("s1", 43200, 56000), ("s2", 40000, 72000)):
        i = np.arange(n)
        gain = np.ones(n)
        gain[:fade] = np.arange(fade) / fade
        gain[n - fade:] = 1 - np.arange(fade) / fade
        expected.append(signals[sid][start:start + n] * gain)
        in_fade.append((i < fade) | (i >= n - fade))
    expected, in_fade = np.concatenate(expected), np.concatenate(in_fade)
    assert pcm.shape == (len(expected), 2)
    for ch in (0, 1):
        np.testing.assert_array_equal(pcm[~in_fade, ch], expected[~in_fade])
        assert np.max(np.abs(pcm[in_fade, ch] - expected[in_fade])) * 32768 <= 1
    assert tl.duration == 2.666667
    _, _, hard, hard_ctx = fixture_project(tmp_path, "hard", frames=12)
    explicit = render.render_voice(hard_ctx, hard.segments, paths, tmp_path / "hard.wav", render.probe_source_audio(hard_ctx, hard.segments, paths))
    np.testing.assert_array_equal(read_pcm(explicit), pcm)


@pytest.mark.parametrize('kind', ['j', 'l'])
def test_two_seeds_change_rendered_bridge_timing_without_moving_words(tmp_path, kind):
    """Fails if seeded offsets are reported but absent from the rendered PCM."""
    p, words, _, _ = fixture_project(tmp_path, kind, frames=8)
    p['cutStyle'] = {'preset': 'standard', 'seed': 0}
    paths, _ = tones(tmp_path)
    hard = copy.deepcopy(p)
    hard['cut']['keep'][1].pop('join')
    hard_tl = project.timeline(tmp_path, hard, words)
    hard_ctx = render.make_ctx(tmp_path, hard, hard_tl, False, tmp_path, tmp_path)
    baseline = read_pcm(render.render_voice(hard_ctx, hard_tl.segments, paths, tmp_path / 'seed_hard.wav', render.probe_source_audio(hard_ctx, hard_tl.segments, paths)))[:, 0]
    join = hard_tl.segments[1].out_start
    regions = []
    outputs = []
    for seed in (0, 4):
        p['cutStyle']['seed'] = seed
        tl = project.timeline(tmp_path, p, words)
        ctx = render.make_ctx(tmp_path, p, tl, False, tmp_path, tmp_path)
        pcm = read_pcm(render.render_voice(ctx, tl.segments, paths, tmp_path / f'seed_{seed}.wav', render.probe_source_audio(ctx, tl.segments, paths)))[:, 0]
        changed = np.flatnonzero(abs(pcm - baseline) > .0002)
        assert changed.size
        regions.append((changed[0] / SR, changed[-1] / SR))
        reported = ctx.variation['jlOffsets'][0]['frames'] / 30
        measured = join - regions[-1][0] if kind == 'j' else regions[-1][1] - join
        assert measured == pytest.approx(reported, abs=.007)
        outputs.append(pcm)
        assert len(pcm) == len(baseline)
        assert tl.words_out == hard_tl.words_out
        # Outside the bridge both seeds keep the exact hard-cut speech samples.
        for wid in ('w1', 'w4'):
            a = round((tl.word_out_time(wid) + .25) * SR)
            np.testing.assert_array_equal(pcm[a:a + 960], baseline[a:a + 960])
    assert not np.array_equal(*outputs)
    edge = 0 if kind == 'j' else 1
    assert abs(regions[0][edge] - regions[1][edge]) >= 1 / 30 - .002
    if kind == 'j':
        assert all(b <= join + .007 for a, b in regions)
    else:
        assert all(a >= join - .007 for a, b in regions)


def test_a_clip_can_open_the_cut_and_a_join_after_a_clip_plays_hard(tmp_path):
    """Fails if multi-source clips and per-join transitions do not combine: the schema must take a clip as
    the first item and a join on a later range, and a join with no spoken range before it must not crash."""
    p, words, _, _ = fixture_project(tmp_path)
    p["cut"]["keep"] = [{"clip": "c1", "source": "s2", "in": 0.5, "out": 1.5},
                        {"from": "w1", "to": "w1", "join": {"transition": "l", "frames": 6}},
                        {"from": "w4", "to": "w4", "join": {"transition": "j", "frames": 6}}]
    assert project.validate(p) == []
    tl = project.timeline(tmp_path, p, words)
    assert [s.source for s in tl.segments] == ["s2", "s1", "s2"]
    # after the clip: no spoken range to bridge, so a hard cut; between the two word ranges: the J handle
    assert tl.segments[1].join_transition is None and tl.segments[1].audio_lead == 0
    assert tl.segments[2].join_transition == "j" and tl.segments[2].audio_lead > 0
    first_join = dict(p, cut=dict(p["cut"], keep=[{"from": "w1", "to": "w1", "join": {"transition": "j", "frames": 6}}]))
    assert project.validate(first_join)
