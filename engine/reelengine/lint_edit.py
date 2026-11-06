"""Pure lint rules over an edit and its resolved output timeline."""
from __future__ import annotations

from dataclasses import dataclass, field
import math

from .cut_style import CUT_STYLES, OPENING, OPENING_MAX_UNSTYLED
from .cut import MATCH_HOLD
from .placement import SAFE_BOTTOM, SAFE_TOP


@dataclass
class LintTimeline:
    segments: list
    duration: float
    visuals: list = field(default_factory=list)
    zooms: list = field(default_factory=list)
    snaps: list = field(default_factory=list)
    captions: list = field(default_factory=list)
    event_times: list | None = None
    match_joins: list = field(default_factory=list)   # cut.Timeline.match_joins


def snap_crosses(start, end, events):
    """Keep an event on its side of neighbouring event times."""
    return start != end and any(min(start, end) <= t <= max(start, end) and t != start for t in events)


def lint_edit(edit: dict, timeline: LintTimeline) -> dict:
    """Return repairs and advice; neither input is changed and no I/O is performed."""
    fixed, issues = [], []
    fps = float(edit['format']['fps'])

    def issue(rule, at, message, suggestion):
        issues.append(dict(rule=rule, at_seconds=round(at, 3), message=message, suggestion=suggestion))

    for i, seg in enumerate(timeline.segments):
        if seg.join_transition in ('j', 'l'):
            # The cut planner already knows the safe source handles at every occurrence.
            requested = seg.join_requested_frames
            if requested > seg.join_frames:
                fixed.append(dict(rule='join-room', at_seconds=round(seg.out_start, 3), target=i, frames=seg.join_frames))

    for i, z in enumerate(timeline.zooms):
        available = max(0, math.floor((z.t1 - z.t0) * fps + 1e-6) - 1)
        if z.ramp_in + z.ramp_out > available:
            entrance = min(z.ramp_in, available)
            fixed.append(dict(rule='zoom-ramp', at_seconds=round(z.t0, 3), target=i,
                              ramp_in=entrance, ramp_out=min(z.ramp_out, available - entrance)))

    cuts = [s.out_start for s in timeline.segments[1:]]
    events = timeline.event_times if timeline.event_times is not None else sorted(set(
        cuts + [v['t0'] for v in timeline.visuals] + [z.t0 for z in timeline.zooms]
        + [s['original'] for s in timeline.snaps]))
    accepted = []
    for i, snap in enumerate(timeline.snaps):
        a, b = snap['original'], snap['snapped']
        gap = snap.get('min_gap', 0)
        previous, following = snap.get('previous'), snap.get('following')
        crosses_cut = any(a < c <= b or b < c <= a for c in cuts)
        crowds_event = ((previous is not None and b - previous <= gap)
                        or (following is not None and following - b <= gap))
        if crosses_cut or crowds_event or snap_crosses(a, b, events):
            fixed.append(dict(rule='beat-snap', at_seconds=round(snap['original'], 3), target=i,
                              seconds=snap['original']))
        else:
            accepted.append(snap)

    # Cuts and framing changes split the visible picture; overlays have their own dwell too.
    starts = sorted({0.0, timeline.duration, *cuts, *(z.t0 for z in timeline.zooms),
                     *(z.t1 for z in timeline.zooms)})
    for a, b in zip(starts, starts[1:]):
        if 0 < b - a < 1.2 - 1e-6:
            issue('visual-dwell', a, 'This picture lasts under 1.2 seconds.', 'Hold the picture longer or remove a change.')
    for v in timeline.visuals:
        if 0 < v['t1'] - v['t0'] < 1.2 - 1e-6:
            issue('visual-dwell', v['t0'], 'This visual lasts under 1.2 seconds.', 'Extend its anchor or keep the stronger visual.')
    for a, b in zip(starts, starts[1:]):
        if 0 < b - a < 2 - 1e-6:
            issue('framing-dwell', a, 'This framing lasts under about 2 seconds.', 'Hold the framing for at least 2 seconds.')

    changes = sorted({*cuts, *(v['t0'] for v in timeline.visuals), *(z.t0 for z in timeline.zooms),
                      *(z.t1 for z in timeline.zooms)})
    for a, b in zip(timeline.zooms, timeline.zooms[1:]):
        if not any(a.t0 < t <= b.t0 for t in cuts + [v['t0'] for v in timeline.visuals]):
            issue('successive-zooms', b.t0, 'Two zooms start with no other change between them.', 'Keep one zoom or use another kind of visual change.')

    height = edit['format']['height']
    for cue in timeline.captions:
        _, y, _, h = cue['box']
        if y < SAFE_TOP * height or y + h > SAFE_BOTTOM * height:
            issue('caption-band', cue['s'], 'These captions overlap the Instagram interface band.', 'Move the captions inside the safe area.')

    for seg in timeline.segments:
        if seg.join_transition in ('j', 'l') and any(abs(s['snapped'] - seg.out_start) <= 1 / fps for s in accepted):
            issue('join-beat', seg.out_start, 'A J or L bridge shares this join with a beat accent.', 'Remove the bridge or move the beat accent.')

    for m in timeline.match_joins:
        if m.get('played') != 'match':
            at = timeline.segments[m['in']].out_start if 'in' in m else 0
            issue('match-unmet', at, f"cut.keep[{m['keep']}] asks for a match cut, but {m.get('why') or 'its frames were not compared'}; it plays as a plain cut.",
                  'Choose another join here, or move the cut to where the two sides line up.')
    for seg in timeline.segments:
        # a framing change on a match cut undoes it: the two sides no longer sit the same way
        if seg.join_transition == 'match' and any(abs(t - seg.out_start) < MATCH_HOLD for z in timeline.zooms for t in (z.t0, z.t1)):
            issue('match-framing', seg.out_start, 'A zoom changes the framing right at this match cut, so the two sides no longer line up.',
                  'Move the zoom off this join, or use a plain cut here.')

    style = edit.get('cutStyle')
    preset = CUT_STYLES.get(style['preset']) if style else None
    # The opening decides whether someone stays: past a few changes it reads as noise before the hook lands.
    # Changes inside one frame of each other are one, as in the cadence below.
    opening = []
    for t in sorted(t for t in changes if 0 < t < min(OPENING, timeline.duration)):
        if not opening or t - opening[-1] > 1 / fps:
            opening.append(t)
    cap = preset['openingMax'] if preset else OPENING_MAX_UNSTYLED
    if len(opening) > cap:
        issue('opening-busy', opening[cap], f'The first {OPENING:g} seconds change {len(opening)} times; {"this pace" if preset else "an opening"} holds at most {cap}.',
              'Let the opening breathe: move a zoom, picture or cut in the first 5 seconds later, or drop it.')
    if preset:
        counts = [('jl-budget', sum(s.join_transition in ('j', 'l') for s in timeline.segments), preset['jlBridges'], 'J/L bridges'),
                  ('smash-budget', sum(s.join_transition == 'smash' for s in timeline.segments), preset['smashes'], 'smash cuts'),
                  ('sfx-budget', sum('cut' in s['at'] for s in edit.get('sfx', []))
                   + sum(s.join_transition == 'smash' and not any(x['at'].get('cut') == s.first_word for x in edit.get('sfx', [])) for s in timeline.segments), preset['sfxOnCuts'], 'cut sound effects')]
        for rule, count, budget, label in counts:
            if count > budget:
                issue(rule, 0, f'You used {count} {label}; this preset allows {budget}.', 'Remove accents until you meet the preset budget.')
        band = preset['secondsPerVisualChange']
        if band and timeline.duration:
            # Include the opening and final hold; co-timed changes count as one visible event.
            boundaries = sorted({0.0, timeline.duration, *(t for t in changes if 0 < t < timeline.duration)})
            mean = timeline.duration / max(1, len(boundaries) - 1)
            if not band[0] <= mean <= band[1]:
                issue('cadence', 0, f'Your mean visual hold is {mean:.2f} seconds; this preset asks for {band[0]} to {band[1]}.', 'Adjust visual changes to fit the preset cadence.')
    return {'fixed': fixed, 'issues': issues}


def events(ctx, tl) -> list:
    """The edit's visible events (cuts, framing changes, b-roll and zoom starts, sound effects on words) that a
    beat-snapped accent must not cross (music.accent_time). moments.py reads them too, so its plan of each card
    snaps as the render's does."""
    from . import broll
    out = [s.out_start for s in tl.segments[1:]]
    # Seeded framing is visible even without an authored zoom.
    if ctx.variation:
        out.extend(row['t0'] for row in ctx.variation['framing'][1:])
    for group in ('broll', 'zooms'):
        for item in ctx.project.get(group, []):
            anchor = item.get('anchor') or {}
            if ctx.is_kept(anchor.get('from')):
                start = ctx.word_out_time(anchor['from'])
                if group == 'broll':
                    start = max(0.0, start - float(item.get('leadIn', broll.LEAD)))
                out.append(start)
    for item in ctx.project.get('sfx', []):
        at = item['at']
        if 'word' in at and ctx.is_kept(at['word']):
            out.append(round(ctx.word_out_time(at['word']) * ctx.fmt['fps']) / ctx.fmt['fps'])
    return out


def prepare(ctx, tl):
    """Resolve media outside the pure checker; return the same plans the render uses."""
    from . import broll, captions, music, sfx, zoom
    ctx._lint_snap_requests = []
    ctx._lint_events = events(ctx, tl)
    visuals = broll.plan_windows(ctx)
    zooms = zoom.build_zooms(ctx)
    sfx.plan(ctx)
    cues = []
    if (ctx.project.get('captions') or {}).get('enabled', True):
        _, cues, *_ = captions.build_for_timeline(tl, ctx.project, ctx.fmt['width'], ctx.fmt['height'])
    # Compare against unsnapped events so an event cannot collide with its own target.
    plan = LintTimeline(tl.segments, tl.duration, visuals, zooms, ctx._lint_snap_requests, cues, ctx._lint_events,
                        getattr(tl, 'match_joins', []))
    result = lint_edit(ctx.project, plan)
    for fix in result['fixed']:
        if fix['rule'] == 'zoom-ramp':
            z = zooms[fix['target']]
            z.ramp_in, z.ramp_out = fix['ramp_in'], fix['ramp_out']
    ctx.lint_zooms = zooms
    ctx.lint_visuals = visuals
    return result
