import { useEffect, useMemo, useState } from 'react'
import type { PacePreview } from '../../../../shared/api'
import { CUT_PRESETS, kindOf, nextSeed, PACE_BANDS, paceLine, PACE_LABELS, withKind, ZOOM_KIND_LABELS, ZOOM_KINDS, zoomKey, type CutPreset, type Zoom } from '../../../../shared/cut-style'
import { clock } from '../../../../shared/progress'
import { Icon } from '../../components/icons'
import { Segmented } from '../../components/ui'
import { reel, userMessage } from '../../api'
import { canVary, variations, type VariationKind } from '../../../../shared/variations'
import { setP, type TabProps } from './controls'

/** What each "Versions to compare" button makes; one this reel can't vary that way is left out (shared/variations.ts). */
const VARIATION_BUTTONS: { kind: VariationKind; label: string }[] = [
  { kind: 'paces', label: 'One at each pace' },
  { kind: 'moments', label: '3 sets of moments' },
  { kind: 'brightness', label: 'Brighter and darker' },
  { kind: 'hook', label: 'Open on the next line' },
  { kind: 'cover', label: 'Another cover' }
]

const KINDS = ZOOM_KINDS.map((key) => ({ key, label: ZOOM_KIND_LABELS[key] }))
const NONE = 'none'
/** Long enough to tell zoom-ins apart, short enough for one line of the column. */
const QUOTE_WORDS = 6

/** What a pace does to this reel, from the plan its render would make (engine pace-preview). */
function measured(p: PacePreview['paces'][string] | undefined): string | null {
  if (!p) return null
  const often = `About ${Math.round(p.perMinute)} changes a minute`
  return p.opening > p.openingMax ? `${often}, ${p.opening} in the first 5 seconds: a busy start.` : `${often}.`
}

/**
 * Cut > Pace: the reel's pace (project.json cutStyle) and how each zoom-in moves, the choices the AI makes with
 * set_cut_style and set_zoom. Neither shows on the player until it is rendered, so the panel says so first.
 */
export function PaceControls({ d, base, now, change, placed, next }: TabProps) {
  const style = now.p.cutStyle
  const [preview, setPreview] = useState<PacePreview | null>(null)
  // counted on the saved reel, once per version: the drawer's own word changes are not in it
  useEffect(() => {
    let live = true
    reel.projects.pacePreview(d.slug).then((p) => live && setPreview(p), () => live && setPreview(null))
    return () => {
      live = false
    }
  }, [d.slug, d.project.version])
  const zooms = useMemo(() => now.p.zooms ?? [], [now.p.zooms])
  const wordAt = useMemo(() => new Map(d.words.map((w, i) => [w.id, i])), [d.words])

  const quote = (z: Zoom): string => {
    const [a, b] = [wordAt.get(z.anchor.from), wordAt.get(z.anchor.to)]
    if (a === undefined || b === undefined) return 'some words'
    const said = d.words.slice(Math.min(a, b), Math.max(a, b) + 1).map((w) => w.w)
    return `“${said.slice(0, QUOTE_WORDS).join(' ')}${said.length > QUOTE_WORDS ? '…' : ''}”`
  }
  // in the order they play, zoom-ins on cut words last since they don't play; one row per stretch of words, since a
  // kind picked here goes to every zoom-in on them (shared/hand-edit.ts)
  const rows = useMemo(
    () =>
      [...new Map(zooms.map((z) => [zoomKey(z), z])).values()]
        .map((z) => ({ z, at: now.kept.has(z.anchor.from) ? placed.get(z.anchor.from)?.s : undefined }))
        .sort((x, y) => (x.at ?? Infinity) - (y.at ?? Infinity)),
    [zooms, now.kept, placed]
  )
  const groupSize = useMemo(() => {
    const n = new Map<string, number>()
    for (const z of zooms) if (z.accentGroup) n.set(z.accentGroup, (n.get(z.accentGroup) ?? 0) + 1)
    return n
  }, [zooms])

  const pick = (preset: CutPreset | typeof NONE) =>
    change(
      setP((p) => {
        if (preset === NONE) return { cutStyle: undefined }
        // back on this version's pace, its own moments come back with it, so picking it again is no change
        const own = base.p.cutStyle?.preset === preset ? base.p.cutStyle.seed : undefined
        return { cutStyle: { preset, seed: own ?? p.cutStyle?.seed ?? base.p.cutStyle?.seed ?? nextSeed(undefined) } }
      })
    )
  const reshuffle = () => change(setP((p) => (p.cutStyle ? { cutStyle: { ...p.cutStyle, seed: nextSeed(p.cutStyle.seed) } } : {})))
  const setKind = (key: string, kind: (typeof ZOOM_KINDS)[number]) =>
    change(setP((p) => ({ zooms: (p.zooms ?? []).map((z) => (zoomKey(z) === key ? withKind(z, kind) : z)) })))

  // beat landing: the person's own choice when set, else the pace's (Fast lands on the beat)
  const paceBeats = style ? PACE_BANDS[style.preset].beatAccents : false
  const beats = now.p.beatAccents ?? paceBeats
  const song = !!(now.p.music?.track && now.p.music.enabled !== false)
  // a choice that matches the pace is stored as no choice, so a later pace still decides
  const setBeats = (on: boolean) => change(setP(() => ({ beatAccents: on === paceBeats ? undefined : on })))

  // Versions to compare: queued as hand edits that each change one thing (shared/variations.ts)
  const [making, setMaking] = useState<{ said: string; busy?: boolean } | null>(null)
  const makeVersions = async (kind: VariationKind) => {
    const list = variations(base.p, kind, d.words)
    if (!list?.length) return
    setMaking({ said: 'Adding them to the queue…', busy: true })
    try {
      for (const v of list) await reel.projects.handEdit(d.slug, v.edit, v.summary, 1)
      const last = next + list.length - 1
      setMaking({
        said: list.length === 1
          ? `Version ${next} is on its way. When it's made, open it in the notes and Compare it with the one before.`
          : `Versions ${next} to ${last} are on their way, each changing one thing. When they're made, open one in the notes and Compare it with the one before.`
      })
    } catch (e) {
      setMaking({ said: userMessage(e) })
    }
  }

  const value = style?.preset ?? NONE
  const reseeded = !!style && style.preset === base.p.cutStyle?.preset && style.seed !== base.p.cutStyle?.seed

  return (
    <div className="edit-stack" data-testid="pace">
      {/* first, where it is seen: on the 1100 x 720 window a note at the end was below the fold; and it stays in view while
          the list under it scrolls, as picking a pace makes the panel taller than the window */}
      <p className="edit-hint edit-hint-stay" data-testid="pace-later">
        The player shows the pace and zoom-ins as made. What you pick here plays in Version {next}.
      </p>
      <div className="edit-field">
        <h3 className="edit-label" id="pace-h">
          Pace
        </h3>
        <div className="edit-list" role="radiogroup" aria-labelledby="pace-h" data-testid="pace-list">
          {([NONE, ...CUT_PRESETS] as const).map((key) => (
            <label key={key} className={`edit-row radio${value === key ? ' on' : ''}`} data-testid={`pace-${key}`}>
              {/* named by the pace alone; what it does is its description, so arrowing through reads "Fast" first */}
              <input type="radio" name="pace" checked={value === key} onChange={() => pick(key)} aria-labelledby={`pace-${key}-name`} aria-describedby={`pace-${key}-what`} />
              <span className="edit-row-main">
                <span className="edit-row-title" id={`pace-${key}-name`}>
                  {key === NONE ? 'No set pace' : PACE_LABELS[key]}
                </span>
                <span className="edit-row-sub" id={`pace-${key}-what`}>
                  {key === NONE ? 'The picture changes only at cuts, pictures and zoom-ins.' : paceLine(key)}
                  {measured(preview?.paces[key]) && (
                    <span className="pace-measured" data-testid={`pace-${key}-measured`}>
                      {' '}
                      {measured(preview?.paces[key])}
                    </span>
                  )}
                </span>
              </span>
            </label>
          ))}
        </div>
        {style && (
          <div className="edit-actions">
            <button className="btn small" onClick={reshuffle} data-testid="pace-reshuffle">
              <Icon name="retry" size={14} /> Try other moments
            </button>
          </div>
        )}
        {style && (
          <p className="edit-hint" role="status" data-testid="pace-moments">
            {reseeded
              ? `Version ${next} keeps the ${PACE_LABELS[style.preset].toLowerCase()} pace with other moments.`
              : 'Keeps the pace and changes its moments: where the framing switches, and which zoom-in of a set plays.'}
          </p>
        )}
      </div>

      <div className="edit-field">
        <label className="toggle quiet">
          <input type="checkbox" checked={beats} disabled={!song} onChange={(e) => setBeats(e.target.checked)} data-testid="pace-beats" aria-describedby="pace-beats-why" />
          Land sound effects and pictures on the beat
        </label>
        <p className="edit-hint" id="pace-beats-why" data-testid="pace-beats-why">
          {!song
            ? 'Needs a song. Add one in Sound first.'
            : now.p.beatAccents === undefined
              ? paceBeats
                ? 'The fast pace does this. Untick it to keep each one on its word.'
                : 'Each moves at most an eighth of a second; what you say never moves.'
              : now.p.beatAccents
                ? 'On for this reel, whatever the pace.'
                : 'Off for this reel, even at the fast pace.'}
        </p>
      </div>

      <div className="edit-field">
        <h3 className="edit-label" id="compare-h">
          Versions to compare
        </h3>
        <p className="edit-hint">
          Makes new versions from Version {base.p.version ?? next - 1}, each changing one thing, so you can play them against each other. To try
          another post caption, use Share › Try 2.
        </p>
        <div className="edit-actions" role="group" aria-labelledby="compare-h">
          {VARIATION_BUTTONS.filter((b) => canVary(base.p, b.kind, d.words)).map((b) => (
            <button key={b.kind} className="btn small" onClick={() => void makeVersions(b.kind)} disabled={!!making?.busy} data-testid={`variations-${b.kind}`}>
              {b.label}
            </button>
          ))}
        </div>
        <p className="edit-hint" role="status" data-testid="variations-said">
          {making?.said}
        </p>
      </div>

      <div className="edit-rule" />

      <div className="edit-field">
        <h3 className="edit-label" id="zooms-h">
          Zoom-ins
        </h3>
        {rows.length ? (
          <ul className="edit-list" aria-labelledby="zooms-h" data-testid="zooms">
            {rows.map(({ z, at }) => {
              const key = zoomKey(z)
              const words = quote(z)
              const when = at === undefined ? null : clock(at)
              const set = z.accentGroup ? (groupSize.get(z.accentGroup) ?? 1) : 1
              return (
                <li key={key} className="edit-row zoom-row" data-testid="zoom-row">
                  <span className="edit-row-main">
                    <span className="edit-row-title">
                      {words}
                      {when && <span className="muted tnum"> · {when}</span>}
                    </span>
                    {when === null ? (
                      <span className="edit-row-sub">Its words are cut, so it doesn't play.</span>
                    ) : style && set > 1 ? (
                      <span className="edit-row-sub">One of a set of {set}. The pace picks which one plays.</span>
                    ) : null}
                  </span>
                  <Segmented
                    label={`How the zoom-in on ${words}${when ? ` at ${when}` : ''} moves`}
                    value={kindOf(z)}
                    options={KINDS}
                    onPick={(k) => setKind(key, k)}
                    testid="zoom-kind"
                    className="zoom-kind"
                  />
                </li>
              )
            })}
          </ul>
        ) : (
          <p className="edit-hint">This version has no zoom-ins.</p>
        )}
        {rows.length > 0 && <p className="edit-hint">Instant cuts in, Quick pushes in fast, Slow drifts in over the whole line.</p>}
      </div>

    </div>
  )
}
