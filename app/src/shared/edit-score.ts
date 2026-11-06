// The words for a version's edit checks (engine `score`, score.py). The engine says what it measured; this says it
// in a line a creator reads beside the version, short enough for the version's detail rows, with the full sentence
// as the row's tooltip. No Node or DOM imports.
import type { VersionRow } from './version-diff'

/** One check the engine ran on a saved version. Fields beyond id and ok depend on the check. */
export interface EditCheck {
  id: 'deadAir' | 'subtitleCoverage' | 'subtitleSafeZone' | 'loudness' | 'videoFile' | 'myStyle' | 'doubleCheck'
  ok: boolean
  count?: number
  longest?: number
  allowed?: number
  words?: number
  subtitles?: number
  lufs?: number | null
  target?: number
  failed?: string[]
  rules?: number
  repairs?: number
}
export interface EditScore {
  version: number
  checks: EditCheck[]
  passed: number
  measured: number
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const num = (n: number | null | undefined) => (typeof n === 'number' ? String(Math.round(n * 10) / 10).replace('-', '−') : '?')

/** What one check found: a label, a short value, and the sentence behind it. Unknown checks (a newer engine) are skipped. */
export function checkRow(c: EditCheck): VersionRow | null {
  const n = c.count ?? 0
  switch (c.id) {
    case 'deadAir':
      return c.ok
        ? { label: 'Pauses', before: '', after: 'None too long', title: `No pause between kept words is longer than ${num(c.allowed)} s.` }
        : { label: 'Pauses', before: '', after: `${plural(n, 'long pause')} left in`, title: `${plural(n, 'pause')} longer than ${num(c.allowed)} s; the longest is ${num(c.longest)} s.` }
    case 'subtitleCoverage':
      return c.ok
        ? { label: 'Subtitles', before: '', after: 'Every word shown', title: `All ${c.words ?? 0} kept words have a subtitle.` }
        : { label: 'Subtitles', before: '', after: `${plural(n, 'word')} not shown`, title: `${plural(n, 'kept word')} of ${c.words ?? 0} have no subtitle.` }
    case 'subtitleSafeZone':
      return c.ok
        ? { label: 'Subtitle position', before: '', after: 'Clear of buttons', title: "Every subtitle stays clear of Instagram's top bar, caption and buttons." }
        : { label: 'Subtitle position', before: '', after: `${plural(n, 'subtitle')} under buttons`, title: `${plural(n, 'subtitle')} of ${c.subtitles ?? 0} sit where Instagram's caption or buttons cover them.` }
    case 'loudness':
      return {
        label: 'Loudness', before: '', after: c.ok ? `${num(c.lufs)} LUFS` : `${num(c.lufs)} LUFS, off target`,
        title: `Instagram and TikTok play reels at about ${num(c.target ?? -14)} LUFS${c.ok ? ', and this one is there' : '; this one will sound quieter or louder than the reels around it'}.`
      }
    case 'videoFile':
      return c.ok
        ? { label: 'Video file', before: '', after: 'Plays as expected', title: 'Length, size, frame rate and sound all match the edit.' }
        : { label: 'Video file', before: '', after: `${plural(n, 'problem')}`, title: `The video file failed: ${(c.failed ?? []).join(', ')}.` }
    case 'myStyle':
      return c.ok
        ? { label: 'My style', before: '', after: `Meets ${plural(c.rules ?? 0, 'rule')}`, title: `Meets all ${plural(c.rules ?? 0, 'checked My style rule')}.` }
        : { label: 'My style', before: '', after: `Breaks ${n} of ${c.rules ?? 0}`, title: `Breaks ${n} of your ${plural(c.rules ?? 0, 'checked My style rule')}. The note's reply says which.` }
    case 'doubleCheck':
      return c.ok
        ? { label: 'Double-check', before: '', after: 'Nothing to fix', title: `The second look found nothing to fix${c.repairs ? ` after ${plural(c.repairs, 'repair')}` : ''}.` }
        : { label: 'Double-check', before: '', after: 'Still found something', title: 'The second look still found something to fix after its repairs.' }
    default:
      return null
  }
}

/** The line above the rows: how many of the checks shown pass (one this app can't name is left out of both). */
export function scoreLine(s: EditScore): string {
  const known = s.checks.filter((c) => checkRow(c) !== null)
  const passed = known.filter((c) => c.ok).length
  if (!known.length) return 'Nothing to check on this version.'
  if (passed === known.length) return known.length === 1 ? 'The one check passes' : `All ${known.length} checks pass`
  return `${passed} of ${known.length} checks pass`
}

/** Said once, so a pass is not read as "this reel is good". */
export const SCORE_SCOPE = 'These check the craft that has one right answer, not whether the reel works.'

/** Failing checks first: those are the ones to act on. */
export function scoreRows(s: EditScore): VersionRow[] {
  return [...s.checks].sort((a, b) => Number(a.ok) - Number(b.ok)).map(checkRow).filter((r): r is VersionRow => r !== null)
}

/** Only the checks that failed: what to fix in the edit (Insights shows these beside a reel's results). */
export function failingRows(s: EditScore): VersionRow[] {
  return s.checks.filter((c) => !c.ok).map(checkRow).filter((r): r is VersionRow => r !== null)
}
