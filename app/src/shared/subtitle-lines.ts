// The Subtitles list in "Edit it myself": the caption lines of the last render, word by word as drawn, with
// the edits not yet made into a version. Every edit is anchored on transcript word ids (engine
// captions.py edit_lines and apply_corrections "at"), so a recut keeps it. No Node or DOM imports.
import type { CaptionToken, ProjectJson } from './api'

type Captions = NonNullable<ProjectJson['captions']>
type Correction = NonNullable<Captions['corrections']>[number]

/** A word of a line in the list: as the last render drew it (`w`) and as it reads now (`shown`). */
export interface LineToken extends CaptionToken {
  shown: string
}

/** work/captions.json's cues (engine captions.build_for_timeline): each word as drawn, the transcript words it came from, its speech run. */
export function readCaptionLines(json: unknown): CaptionToken[][] {
  const cues = (json as { cues?: unknown } | null)?.cues
  if (!Array.isArray(cues)) return []
  const lines: CaptionToken[][] = []
  for (const c of cues) {
    if (!Array.isArray(c?.tokens) || typeof c.run !== 'number') continue
    const line = c.tokens
      .filter((t: unknown): t is { w: string; ids: string[] } => {
        const x = t as { w?: unknown; ids?: unknown }
        return typeof x?.w === 'string' && Array.isArray(x.ids) && x.ids.length > 0 && x.ids.every((id) => typeof id === 'string')
      })
      .map((t: { w: string; ids: string[] }) => ({ w: t.w, ids: t.ids, run: c.run as number }))
    if (line.length) lines.push(line)
  }
  return lines
}

const fixOf = (corrections: Correction[] | undefined, id: string): Correction | undefined => corrections?.find((x) => x.at === id)

/** How a word reads with the fixes not yet made: the render drew the saved ones already. */
export function shownAs(t: CaptionToken, saved: Correction[] | undefined, now: Correction[] | undefined): string {
  const pending = fixOf(now, t.ids[0])
  return pending?.to !== fixOf(saved, t.ids[0])?.to ? (pending?.to ?? t.w) : t.w
}

/** Start a new line at `id` (Enter), or put the line starting at `id` onto the one before (Backspace, Join). */
export function setBreak(c: Captions, id: string, newLine: boolean): Captions {
  const [undo, add] = newLine ? (['join', 'split'] as const) : (['split', 'join'] as const)
  const cur = c[undo] ?? []
  return cur.includes(id) ? { ...c, [undo]: cur.filter((x) => x !== id) } : { ...c, [add]: [...(c[add] ?? []), id] }
}

/** The engine keeps a long silence between lines (captions.edit_lines), so those two never join. */
export const canJoin = (above: LineToken[], line: LineToken[]): boolean => above[above.length - 1].run === line[0].run

/**
 * The lines to show: the render's lines over the kept words, each word as it reads with the fixes not yet
 * made, and each line break flipped that was added or taken away since the saved project. A word cut since,
 * or fixed to nothing, is left out.
 */
export function subtitleLines(rendered: CaptionToken[][], kept: Set<string>, saved: Captions | undefined, now: Captions | undefined): LineToken[][] {
  const flips = new Set<string>()
  const flip = (id: string) => (flips.has(id) ? flips.delete(id) : flips.add(id))
  for (const k of ['split', 'join'] as const) {
    for (const id of now?.[k] ?? []) if (!(saved?.[k] ?? []).includes(id)) flip(id)
    for (const id of saved?.[k] ?? []) if (!(now?.[k] ?? []).includes(id)) flip(id)
  }
  const lines: LineToken[][] = []
  for (const cue of rendered) {
    let line: LineToken[] = []
    for (const t of cue) {
      const shown = shownAs(t, saved?.corrections, now?.corrections)
      if (!shown || !t.ids.some((id) => kept.has(id))) continue
      const token = { ...t, shown }
      if (flips.has(t.ids[0])) {
        if (line.length) {
          lines.push(line)
          line = []
        } else if (lines.length && canJoin(lines[lines.length - 1], [token])) {
          line = lines.pop()!
        }
      }
      line.push(token)
    }
    if (line.length) lines.push(line)
  }
  return lines
}

/**
 * The corrections after the person typed `typed` over a line. Unchanged words at the start and end keep their
 * place; the words in between share what was typed in between, in order, the last of them taking what is left
 * over and any extra word getting nothing (it leaves the captions, still heard). A word made of several
 * transcript words is fixed on the first and emptied on the rest. Typing a word back as the render drew it
 * puts back its saved fixes.
 */
export function retype(line: LineToken[], now: Correction[], saved: Correction[], typed: string): Correction[] {
  const before = line.map((t) => t.shown)
  const after = typed.trim().split(/\s+/).filter(Boolean)
  let a = 0
  while (a < before.length && a < after.length && before[a] === after[a]) a++
  let z = 0
  while (z < before.length - a && z < after.length - a && before[before.length - 1 - z] === after[after.length - 1 - z]) z++
  const changed = line.slice(a, line.length - z)
  const given = after.slice(a, after.length - z)
  let out = now
  changed.forEach((t, i) => {
    const to = i === changed.length - 1 ? given.slice(i).join(' ') : (given[i] ?? '')
    const mine = (c: Correction) => !!c.at && t.ids.includes(c.at)
    out = out.filter((c) => !mine(c))
    out = to === t.w ? [...out, ...saved.filter(mine)] : [...out, ...t.ids.map((at, k) => ({ from: t.w, to: k ? '' : to, at }))]
  })
  return out
}
