import type { ProjectDetail, ProjectJson, VersionInfo, PlacedWord, Word } from '../../../../shared/api'
import type { PlayerHandle } from './preview'
import type { Draft } from './session'

/** What every tab of Edit it myself gets. */
export interface TabProps {
  d: ProjectDetail
  base: Draft
  now: Draft
  /** One step of Undo (`key`: typing in one box is one step). */
  change: (fn: (x: Draft) => Draft, key?: string) => void
  /** Ends a run of typing. */
  settle: () => void
  player: PlayerHandle
  /** Where each word plays in the version on screen (its own clock, the player's). */
  placed: Map<string, PlacedWord>
  version: VersionInfo | null
  /** The number the next version will get. */
  next: number
}

/** A change to the project itself (not the words kept). */
export const setP = (fn: (p: ProjectJson) => Partial<ProjectJson>) => (x: Draft): Draft => ({ ...x, p: { ...x.p, ...fn(x.p) } })

/**
 * Arrow keys between the words of a word list, so the list is one Tab stop and not one per word
 * (a 5-minute take was about 900 stops before the panel's buttons).
 */
export function wordKeys(e: React.KeyboardEvent<HTMLElement>): void {
  const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
  if (!step && e.key !== 'Home' && e.key !== 'End') return
  const all = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('.word'))
  const at = all.indexOf(document.activeElement as HTMLElement)
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : Math.min(all.length - 1, Math.max(0, at + step))
  e.preventDefault()
  all[next]?.focus()
}

/** The transcript in takes: a new paragraph where the speaker paused or the file changes. */
export function takes(words: Word[]): Word[][] {
  const out: Word[][] = []
  let cur: Word[] = []
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    const prev = words[i - 1]
    if (prev && (prev.source !== w.source || w.s - prev.e > 1.0)) {
      out.push(cur)
      cur = []
    }
    cur.push(w)
  }
  if (cur.length) out.push(cur)
  return out
}

/** Enter and Space press a word that is a span with role="button". */
export const pressKeys = (e: React.KeyboardEvent<HTMLElement>) => {
  if (e.key !== 'Enter' && e.key !== ' ') return
  e.preventDefault()
  e.currentTarget.click()
}

export const fileTitle = (name: string): string => name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim()

/** A labelled slider with its value beside it. `onDone` runs when a drag or a key press ends. */
export function Slider({
  label,
  aria,
  value,
  shown,
  spoken,
  min,
  max,
  step,
  onChange,
  onDone,
  testid
}: {
  label: string
  aria?: string
  value: number
  shown: string
  spoken: string
  min: number
  max: number
  step: number
  onChange: (v: number) => void
  onDone: (how: 'pointer' | 'key') => void
  testid: string
}) {
  return (
    <label className="edit-slider">
      <span className="edit-slider-label">{label}</span>
      <input
        type="range"
        className="slider"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={aria ?? label}
        aria-valuetext={spoken}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerUp={() => onDone('pointer')}
        onKeyUp={() => onDone('key')}
        data-testid={testid}
      />
      <output className="edit-slider-value tnum" aria-hidden>
        {shown}
      </output>
    </label>
  )
}
