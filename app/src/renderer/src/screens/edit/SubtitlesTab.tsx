import type { ReactNode } from 'react'
import type { ProjectJson } from '../../../../shared/api'
import { SIZE_PER_EM } from '../../../../shared/caption-fit'
import { CAPTION_COLORS, CAPTION_PRESETS, applyPreset, colorName, lookFromStyle, presetOf, rowPosition } from '../../../../shared/caption-presets'
import { SubtitleSample } from '../../components/Player'
import { arrowPick, Segmented, tabStop } from '../../components/ui'
import { setP, type TabProps } from './controls'

type Captions = NonNullable<ProjectJson['captions']>
type Style = Record<string, unknown>

const SIZES = [
  { key: 'small', label: 'Small', size: 84 },
  { key: 'medium', label: 'Medium', size: 105 },
  { key: 'big', label: 'Big', size: 126 }
] as const
// the position each writes: shared/caption-presets.ts rowPosition
const POSITIONS = [
  { key: 'higher', label: 'Higher' },
  { key: 'lower', label: 'Lower' }
] as const
const HIGHLIGHTS = [
  { key: 'yellow', label: 'Yellow', color: '#FFD60A' },
  { key: 'green', label: 'Green', color: '#30D158' }
] as const

const sizeKey = (st: Style): string => {
  const n = Number(st.size ?? 105)
  return n < 95 ? 'small' : n > 115 ? 'big' : 'medium'
}
const positionKey = (st: Style): string => (Number(st.position ?? 0.75) < 0.69 ? 'higher' : 'lower')
const colorOf = (st: Style): string => String(st.color ?? '#FFFFFF').toUpperCase()
// A colour the editor picked that has an offered colour's name counts as that one: "make them bright red" gave #FF0000,
// and the row showed Red and "Other red" side by side (the runner's Windows capture, 2026-11-14)
const colorKey = (st: Style): string =>
  CAPTION_COLORS.find((x) => x.color === colorOf(st))?.key ?? CAPTION_COLORS.find((x) => x.key === colorName(colorOf(st)))?.key ?? 'current'
/**
 * The Colour row: the offered colours, and when the AI editor picked another one, that colour too, checked, so the
 * row shows what the reel has (#53 left every option unchecked), named and with a dot of it. A colour with an offered
 * colour's name checks that one instead (colorKey).
 */
function colorOptions(st: Style): { key: string; label: ReactNode; title?: string }[] {
  if (colorKey(st) !== 'current') return [...CAPTION_COLORS]
  const named = colorName(colorOf(st))
  const word = !named ? 'Another colour' : named.charAt(0).toUpperCase() + named.slice(1)
  return [
    ...CAPTION_COLORS,
    {
      key: 'current',
      title: 'The colour your editor picked',
      label: (
        <>
          <span className="cap-swatch" style={{ background: colorOf(st) }} aria-hidden />
          {word}
        </>
      )
    }
  ]
}
const highlightKey = (st: Style): string => HIGHLIGHTS.find((x) => x.color === String(st.highlight).toUpperCase())?.key ?? ''

const LOOK_KEYS = CAPTION_PRESETS.map((p) => p.key)
/** One word, the same in every look, so the rows differ only by the look. */
const LOOK_WORD = 'Bread'
/**
 * All five looks drawn at one scale, the width of a reel at which Clean's subtitles are 18 px: Bold pop then reads
 * bigger and Minimal smaller, as they are on the phone. At 18 px each, Bold pop would look like Clean.
 */
const LOOK_SCALE_WIDTH = (18 * SIZE_PER_EM * 1080) / Number(CAPTION_PRESETS[0].style.size)

/** The looks to start from, one row each: a word drawn in the look on a dark strip, and the look's name. */
function Looks({ value, onPick }: { value: string | null; onPick: (k: string) => void }) {
  return (
    <div className="looks" role="radiogroup" aria-label="Look" data-testid="cap-look" onKeyDown={(e) => arrowPick(e, LOOK_KEYS, value, onPick)}>
      {CAPTION_PRESETS.map((o) => (
        <button
          key={o.key}
          type="button"
          role="radio"
          aria-checked={o.key === value}
          tabIndex={tabStop(o.key, value, LOOK_KEYS)}
          data-key={o.key}
          className={`look${o.key === value ? ' on' : ''}`}
          onClick={() => onPick(o.key)}
          data-testid={`cap-look-${o.key}`}
        >
          <span className="look-dot" aria-hidden />
          <span className="look-strip" aria-hidden>
            <SubtitleSample look={{ ...lookFromStyle(o.style), position: 0.5 }} text={LOOK_WORD} width={LOOK_SCALE_WIDTH} />
          </span>
          <span className="look-name">{o.label}</span>
        </button>
      ))}
    </div>
  )
}

export function SubtitlesTab({ now, change, next }: TabProps) {
  const captions: Captions = now.p.captions ?? { enabled: true }
  const style = (captions.style ?? {}) as Style
  const set = (fn: (c: Captions) => Captions) => change(setP((p) => ({ captions: fn(p.captions ?? { enabled: true }) })))
  const setStyle = (extra: Style) => set((c) => ({ ...c, style: { ...(c.style ?? {}), ...extra } }))
  const on = captions.enabled !== false

  return (
    <div className="edit-stack">
      <label className="toggle">
        <input type="checkbox" checked={on} onChange={(e) => set((c) => ({ ...c, enabled: e.target.checked }))} data-testid="subs-on" />
        Show subtitles
      </label>
      {on ? (
        <div className="edit-stack" data-testid="caption-controls">
          <div className="edit-field">
            <span className="edit-label">Look</span>
            <Looks value={presetOf(style)} onPick={(k) => set((c) => ({ ...c, style: applyPreset(k, (c.style ?? {}) as Style) }))} />
          </div>
          <div className="edit-field">
            <span className="edit-label">Size</span>
            <Segmented testid="cap-size" label="Size" value={sizeKey(style)} options={SIZES} onPick={(k) => setStyle({ size: SIZES.find((x) => x.key === k)!.size, sizePicked: true })} />
          </div>
          <div className="edit-field">
            <span className="edit-label">Position</span>
            <Segmented testid="cap-pos" label="Position" value={positionKey(style)} options={POSITIONS} onPick={(k) => setStyle({ position: rowPosition(k as 'higher' | 'lower', style) })} />
          </div>
          {/* a look that lights up the word being said still has a colour for the rest (#53) */}
          <div className="edit-field">
            <span className="edit-label">Colour</span>
            <Segmented testid="cap-color" label="Colour" value={colorKey(style)} options={colorOptions(style)} onPick={(k) => {
                // the checked one is a no-op: Red over the editor's #FF0000 would swap in #FF3B30 and count a change
                // nobody made (review of 4bcbe80c)
                if (k === colorKey(style)) return
                const c = CAPTION_COLORS.find((x) => x.key === k)
                if (c) setStyle({ color: c.color })
              }}
            />
          </div>
          {!!style.highlight && (
            <div className="edit-field">
              <span className="edit-label">Word being said</span>
              <Segmented testid="cap-highlight" label="Word being said" value={highlightKey(style)} options={HIGHLIGHTS} onPick={(k) => setStyle({ highlight: HIGHLIGHTS.find((x) => x.key === k)!.color })} />
            </div>
          )}
          <p className="edit-hint">The phone shows a line of your reel in this look. The dashed frame is where Instagram's buttons don't cover the subtitles.</p>
        </div>
      ) : (
        <p className="edit-hint">Version {next} will have no words on the video.</p>
      )}
    </div>
  )
}
