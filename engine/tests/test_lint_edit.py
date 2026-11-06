"""Lint regressions at the edit/timeline boundary."""
from copy import deepcopy

import pytest

from reelengine.lint_edit import LintTimeline, lint_edit
from reelengine.render_ctx import Segment, ZoomSpan


def edit(style=None):
    p = {'format': {'fps': 30, 'width': 1080, 'height': 1920}, 'sfx': []}
    if style:
        p['cutStyle'] = {'preset': style, 'seed': 17}
    return p


def plan(duration=12):
    return LintTimeline([Segment('s1', 0, duration, 0)], duration)


def rules(result):
    return {r['rule'] for r in result['issues']}


def z(a, b, **kwargs):
    return ZoomSpan(a, b, 1.3, 540, 960, **kwargs)


@pytest.mark.parametrize('transition', ['j', 'l'])
def test_join_frames_are_clamped_only_when_room_is_exceeded(transition):
    p, tl = edit(), plan()
    tl.segments.append(Segment('s2', 1, 5, 8, join_transition=transition,
                               join_requested_frames=99, join_frames=8))
    result = lint_edit(p, tl)
    assert result['fixed'] == [{'rule': 'join-room', 'at_seconds': 8, 'target': 1, 'frames': 8}]
    tl.segments[1].join_requested_frames = 8
    assert lint_edit(p, tl)['fixed'] == []


def test_ramps_are_shortened_to_the_visible_frame_span():
    p, tl = edit(), plan()
    tl.zooms = [z(2, 2.2, ramp_in=12, ramp_out=9)]
    assert lint_edit(p, tl)['fixed'] == [{'rule': 'zoom-ramp', 'at_seconds': 2, 'target': 0, 'ramp_in': 5, 'ramp_out': 0}]
    tl.zooms = [z(2, 4, ramp_in=6, ramp_out=9)]
    assert lint_edit(p, tl)['fixed'] == []


@pytest.mark.parametrize('boundary', ['cut', 'visual', 'zoom', 'event'])
def test_beat_snap_cannot_cross_another_event(boundary):
    p, tl = edit(), plan()
    tl.snaps = [{'original': 3.94, 'snapped': 4.04}]
    if boundary == 'cut':
        tl.segments.append(Segment('s2', 0, 8, 4))
    elif boundary == 'visual':
        tl.visuals = [{'t0': 4, 't1': 8}]
    elif boundary == 'zoom':
        tl.zooms = [z(4, 8)]
    else:
        tl.snaps.append({'original': 4, 'snapped': 4})
    assert any(f['rule'] == 'beat-snap' and f['seconds'] == 3.94 for f in lint_edit(p, tl)['fixed'])
    tl.snaps[0]['snapped'] = 3.97
    assert not any(f['rule'] == 'beat-snap' for f in lint_edit(p, tl)['fixed'])


@pytest.mark.parametrize('kind', ['visual', 'cut', 'zoom'])
def test_short_visuals_are_reported_without_repair(kind):
    p, tl = edit(), plan()
    if kind == 'visual':
        tl.visuals = [{'t0': 3, 't1': 4}]
    elif kind == 'cut':
        tl.segments.append(Segment('s2', 0, 11, 1))
    else:
        tl.zooms = [z(3, 4)]
    result = lint_edit(p, tl)
    assert 'visual-dwell' in rules(result)
    assert result['fixed'] == []
    assert 'visual-dwell' not in rules(lint_edit(p, plan()))


def test_framing_dwell_reports_short_holds():
    p, tl = edit(), plan()
    tl.zooms = [z(3, 4.5)]
    assert 'framing-dwell' in rules(lint_edit(p, tl))
    tl.zooms = [z(3, 5)]
    assert 'framing-dwell' not in rules(lint_edit(p, tl))


@pytest.mark.parametrize('rule,transition,count,style', [
    ('jl-budget', 'j', 4, 'standard'), ('smash-budget', 'smash', 2, 'standard'),
    ('sfx-budget', 'hard', 3, 'standard'),
])
def test_per_reel_budgets_report_excesses_only(rule, transition, count, style):
    p, tl = edit(style), plan(30)
    for i in range(count):
        tl.segments.append(Segment('s2', 0, 3, (i + 1) * 4, first_word=f'w{i}', join_transition=transition))
        if rule == 'sfx-budget':
            p['sfx'].append({'at': {'cut': f'w{i}'}, 'sound': 'impact-thud'})
    assert rule in rules(lint_edit(p, tl))
    if rule == 'sfx-budget':
        p['sfx'].pop()
    else:
        tl.segments.pop()
    assert rule not in rules(lint_edit(p, tl))


def test_bridge_and_beat_on_one_join_are_reported_even_without_a_style():
    p, tl = edit(), plan()
    tl.segments.append(Segment('s2', 0, 6, 6, join_transition='j'))
    tl.snaps = [{'original': 6, 'snapped': 6}]
    assert 'join-beat' in rules(lint_edit(p, tl))
    tl.snaps[0]['snapped'] = 6.1
    assert 'join-beat' not in rules(lint_edit(p, tl))


def test_zoom_starts_need_another_kind_of_change_between_them():
    p, tl = edit(), plan()
    tl.zooms = [z(2, 4), z(6, 8)]
    assert 'successive-zooms' in rules(lint_edit(p, tl))
    tl.visuals = [{'t0': 5, 't1': 8}]
    assert 'successive-zooms' not in rules(lint_edit(p, tl))


def test_caption_band_uses_rendered_boxes_without_a_style():
    p, tl = edit(), plan()
    tl.captions = [{'s': 2, 'box': [100, 1600, 800, 100]}]
    assert 'caption-band' in rules(lint_edit(p, tl))
    tl.captions[0]['box'][1] = 1400
    assert 'caption-band' not in rules(lint_edit(p, tl))
    tl.captions = []
    assert 'caption-band' not in rules(lint_edit(p, tl))


@pytest.mark.parametrize('duration', [2, 8])
def test_cadence_reports_too_fast_and_too_slow_except_punchline(duration):
    tl = plan(duration)
    assert 'cadence' in rules(lint_edit(edit('standard'), tl))
    assert 'cadence' not in rules(lint_edit(edit('punchline'), tl))
    assert 'cadence' not in rules(lint_edit(edit('standard'), plan(4)))


def test_legacy_edit_runs_only_generic_rules():
    p, tl = edit(), plan(20)
    tl.zooms = [z(2, 3), z(6, 8)]
    tl.segments.append(Segment('s2', 0, 10, 10, join_transition='smash'))
    result = lint_edit(p, tl)
    assert {'visual-dwell', 'framing-dwell', 'successive-zooms'} <= rules(result)
    assert not {'cadence', 'jl-budget', 'smash-budget', 'sfx-budget'} & rules(result)


def test_lint_is_repeatable_and_does_not_mutate_its_inputs():
    p, tl = edit('hyper'), plan()
    tl.zooms = [z(2, 2.2, ramp_in=20)]
    p_before, tl_before = deepcopy(p), deepcopy(tl)
    outputs = [lint_edit(p, tl) for _ in range(10)]
    assert outputs[0]['fixed'] and outputs[0]['issues']
    assert all(x == outputs[0] for x in outputs)
    assert p == p_before and tl == tl_before


def test_prepare_applies_repairs_before_rendering(tmp_path):
    from reelengine import project, render
    from reelengine.lint_edit import prepare
    from conftest import mkwords
    p = project.new_project('Short ramp')
    p['sources'] = [{'id': 's1', 'path': 'media/take.mp4', 'duration': 4, 'fps': 30}]
    p['cut']['keep'] = [{'from': 'w0', 'to': 'w2'}]
    p['captions']['enabled'] = False
    p['zooms'] = [{'kind': 'snap', 'scale': 1.3, 'anchor': {'from': 'w1', 'to': 'w1'}, 'focus': [.5, .5]}]
    words = mkwords([(0, 1, 'One'), (1.1, 1.2, 'two'), (1.3, 3, 'three.')])
    tl = project.timeline(tmp_path, p, words)
    ctx = render.make_ctx(tmp_path, p, tl, True, tmp_path, tmp_path)
    result = prepare(ctx, tl)
    assert any(f['rule'] == 'zoom-ramp' for f in result['fixed'])
    [span] = ctx.lint_zooms
    assert span.ramp_in + span.ramp_out <= round((span.t1 - span.t0) * 30) - 1


def test_lint_backstop_records_snaps_already_stopped_by_engine_bounds(tmp_path, monkeypatch):
    from reelengine import broll, music, project, render
    from reelengine.lint_edit import prepare
    from conftest import mkwords
    p = project.new_project('Bounded beats')
    p.update(beatAccents=True, sources=[{'id': 's1', 'path': 'media/take.mp4', 'duration': 6, 'fps': 30}])
    p['cut'] = {'keep': [{'from': 'w0', 'to': 'w3'}], 'gapCap': 5}
    p['captions']['enabled'] = False
    words = mkwords([(.1, .4, 'One'), (1.2, 1.25, 'two'), (1.3, 1.4, 'three'), (3, 3.3, 'four.')])
    p['broll'] = [{'id': f'b{i}', 'anchor': {'from': f'w{i}', 'to': f'w{i}'}, 'treatment': 'text-pop',
                   'leadIn': 4/30, 'params': {}} for i in (1, 2)]
    monkeypatch.setattr(music, 'accent_beats', lambda ctx: [35/30])
    tl = project.timeline(tmp_path, p, words)
    ctx = render.make_ctx(tmp_path, p, tl, True, tmp_path, tmp_path)
    lint = prepare(ctx, tl)
    windows = broll.plan_windows(ctx)
    assert [v['id'] for v in windows] == ['b1', 'b2']
    assert windows[0]['t0'] == pytest.approx(32/30)
    assert any(f['rule'] == 'beat-snap' for f in lint['fixed'])
    # A legal candidate remains snapped and does not produce a redundant repair.
    ctx.project['broll'] = ctx.project['broll'][:1]
    monkeypatch.setattr(music, 'accent_beats', lambda ctx: [33/30])
    safe = prepare(ctx, tl)
    assert broll.plan_windows(ctx)[0]['t0'] == pytest.approx(33/30)
    assert not any(f['rule'] == 'beat-snap' for f in safe['fixed'])


def test_seeded_framing_boundaries_also_bound_beat_snaps(tmp_path, monkeypatch):
    from reelengine import broll, music, project, render, variation
    from reelengine.lint_edit import prepare
    from conftest import mkwords
    p = project.new_project('Framing beat boundary')
    p.update(beatAccents=True, cutStyle={'preset': 'standard', 'seed': 0},
             sources=[{'id': 's1', 'path': 'media/take.mp4', 'duration': 32, 'fps': 30}])
    p['cut'] = {'keep': [{'from': 'w0', 'to': 'w60'}], 'gapCap': 5}
    p['captions']['enabled'] = False
    words = mkwords([(i * .5 + .1, i * .5 + .4, 'word') for i in range(61)])
    tl = project.timeline(tmp_path, p, words)
    _, decisions = variation.resolve(p, tl)
    boundary = decisions['framing'][1]['t0']
    word = min(tl.words_out, key=lambda w: abs(w['s'] - boundary))['id']
    p['broll'] = [{'id': 'b1', 'anchor': {'from': word, 'to': word}, 'treatment': 'text-pop', 'params': {}}]
    ctx = render.make_ctx(tmp_path, p, tl, True, tmp_path, tmp_path)
    original = ctx.word_out_time(word) - ctx.project['broll'][0]['leadIn']
    monkeypatch.setattr(music, 'accent_beats', lambda ctx: [boundary])
    result = prepare(ctx, tl)
    assert broll.plan_windows(ctx)[0]['t0'] == pytest.approx(original)
    assert any(f['rule'] == 'beat-snap' for f in result['fixed'])


def test_cadence_counts_releases_back_to_wide_framing():
    tl = plan(24)
    tl.zooms = [z(4, 8), z(12, 16), z(20, 24)]
    assert 'cadence' not in rules(lint_edit(edit('standard'), tl))


def test_cut_at_second_zoom_start_is_another_visual_change():
    tl = plan()
    tl.segments.append(Segment('s2', 0, 6, 6))
    tl.zooms = [z(2, 4), z(6, 8)]
    assert 'successive-zooms' not in rules(lint_edit(edit(), tl))


def test_a_match_that_did_not_line_up_is_reported_with_its_reason():
    p, tl = edit(), plan()
    tl.segments.append(Segment('s1', 6, 9, 12, join_transition='hard'))
    tl.match_joins = [{'keep': 1, 'out': 0, 'in': 1, 'played': 'hard', 'matched': False, 'why': 'the speaker moves too much across the cut'}]
    (issue,) = [r for r in lint_edit(p, tl)['issues'] if r['rule'] == 'match-unmet']
    assert issue['at_seconds'] == 12
    assert 'moves too much' in issue['message']
    tl.match_joins[0].update(played='match', matched=True)
    tl.segments[1].join_transition = 'match'
    assert 'match-unmet' not in rules(lint_edit(p, tl))


def test_a_zoom_on_a_match_cut_is_flagged_and_one_clear_of_it_is_not():
    p, tl = edit(), plan()
    tl.segments.append(Segment('s1', 6, 9, 12, join_transition='match'))
    tl.zooms = [z(12.1, 14)]
    assert 'match-framing' in rules(lint_edit(p, tl))
    tl.zooms = [z(12.4, 14)]
    assert 'match-framing' not in rules(lint_edit(p, tl))
