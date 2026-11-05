import { useMemo } from 'react'
import { CUT_PRESETS, kindOf, nextSeed, paceLine, PACE_LABELS, withKind, ZOOM_KIND_LABELS, ZOOM_KINDS, zoomKey, type CutPreset, type Zoom } from '../../../../shared/cut-style'
import { clock } from '../../../../shared/progress'
import { Icon } from '../../components/icons'
import { Segmented } from '../../components/ui'
import { setP, type TabProps } from './controls'

const KINDS = ZOOM_KINDS.map((key) => ({ key, label: ZOOM_KIND_LABELS[key] }))
const NONE = 'none'
/** Long enough to tell zoom-ins apart, short enough for one line of the column. */
const QUOTE_WORDS = 6

/**
 * Cut > Pace: the reel's pace (project.json cutStyle) and how each zoom-in moves, the choices the AI makes with
 * set_cut_style and set_zoom. Neither shows on the player until it is rendered, so the panel says when it will.
 */
export function PaceControls({ d, base, now, change, placed, next }: TabProps) {
  const style = now.p.cutStyle
  const zooms = useMemo(() => now.p.zooms ?? [], [now.p.zooms])
  const wordAt = useMemo(() => new Map(d.words.map((w, i) => [w.id, i])), [d.words])

  const quote = (z: Zoom): string => {
    const [a, b] = [wordAt.get(z.anchor.from), wordAt.get(z.anchor.to)]
    if (a === undefined || b === undefined) return 'some words'
    const said = d.words.slice(Math.min(a, b), Math.max(a, b) + 1).map((w) => w.w)
    return `“${said.slice(0, QUOTE_WORDS).join(' ')}${said.length > QUOTE_WORDS ? '…' : ''}”`
  }
  // in the order they play; zoom-ins on cut words last, since they don't play
  const rows = useMemo(
    () =>
      zooms
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

  const value = style?.preset ?? NONE
  const reseeded = !!style && style.preset === base.p.cutStyle?.preset && style.seed !== base.p.cutStyle?.seed
  const changed = JSON.stringify(style) !== JSON.stringify(base.p.cutStyle) || JSON.stringify(zooms) !== JSON.stringify(base.p.zooms ?? [])

  return (
    <div className="edit-stack" data-testid="pace">
      <div className="edit-field">
        <h3 className="edit-label" id="pace-h">
          Pace
        </h3>
        <div className="edit-list" role="radiogroup" aria-labelledby="pace-h" data-testid="pace-list">
          {([NONE, ...CUT_PRESETS] as const).map((key) => (
            <label key={key} className={`edit-row radio${value === key ? ' on' : ''}`} data-testid={`pace-${key}`}>
              <input type="radio" name="pace" checked={value === key} onChange={() => pick(key)} />
              <span className="edit-row-main">
                <span className="edit-row-title">{key === NONE ? 'No set pace' : PACE_LABELS[key]}</span>
                <span className="edit-row-sub">{key === NONE ? 'The picture changes only at cuts, pictures and zoom-ins.' : paceLine(key)}</span>
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

      {changed && (
        <p className="edit-hint" data-testid="pace-later">
          The player shows the pace and zoom-ins as they are now. Make Version {next} to see your changes.
        </p>
      )}
    </div>
  )
}
