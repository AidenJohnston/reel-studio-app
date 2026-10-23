// The Subtitles list in "Edit it myself": the caption lines of the last render, word by word as drawn, with
// the edits not yet made into a version. Every edit is anchored on transcript word ids (engine
// captions.py edit_lines and apply_corrections "at"), so a recut keeps it. No Node or DOM imports.
import type { CaptionToken, ProjectJson } from './api'

type Captions = NonNullable<ProjectJson['captions']>
type Correction = NonNullable<Captions['corrections']>[number]
/** What the transcript heard at each word id. */
type Heard = Map<string, string>

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

const heardOf = (t: CaptionToken, heard: Heard): string => t.ids.map((id) => heard.get(id) ?? '').join(' ').trim()

/** How a word reads with the fixes not yet made: the render drew the saved ones; one taken back reads as heard. */
export function shownAs(t: CaptionToken, saved: Correction[] | undefined, now: Correction[] | undefined, heard: Heard): string {
  const pending = fixOf(now, t.ids[0])
  if (pending?.to === fixOf(saved, t.ids[0])?.to) return t.w
  return pending ? pending.to : heardOf(t, heard)
}

/**
 * Start a new line at `id` (Enter), or put the line starting at `id` onto the line above, which ends at
 * `above` (Backspace, Join). Taking back a split or a join that hasn't been made yet removes it.
 */
export function setBreak(c: Captions, id: string, newLine: boolean, above?: string): Captions {
  const split = c.split ?? []
  const join = c.join ?? []
  if (newLine) return join.some((j) => j.to === id) ? { ...c, join: join.filter((j) => j.to !== id) } : split.includes(id) ? c : { ...c, split: [...split, id] }
  if (split.includes(id)) return { ...c, split: split.filter((x) => x !== id) }
  if (!above) throw new Error(`joining the line at ${id} needs the line above it`)
  return { ...c, join: [...join, { from: above, to: id }] }
}

/** The engine keeps a long silence between lines (captions.edit_lines), so those two never join. */
export const canJoin = (above: LineToken[], line: LineToken[]): boolean => above[above.length - 1].run === line[0].run

/**
 * The lines to show: the render's lines over the kept words, each word as it reads with the fixes not yet
 * made, and each line break flipped that was added or taken away since the saved project. A word cut since,
 * or fixed to nothing, is left out.
 */
export function subtitleLines(rendered: CaptionToken[][], kept: Set<string>, saved: Captions | undefined, now: Captions | undefined, heard: Heard): LineToken[][] {
  const flips = new Set<string>()
  const flip = (id: string) => (flips.has(id) ? flips.delete(id) : flips.add(id))
  const breaks = (c: Captions | undefined) => [...(c?.split ?? []), ...(c?.join ?? []).map((j) => j.to)]
  for (const id of breaks(now)) if (!breaks(saved).includes(id)) flip(id)
  for (const id of breaks(saved)) if (!breaks(now).includes(id)) flip(id)
  const lines: LineToken[][] = []
  for (const cue of rendered) {
    let line: LineToken[] = []
    for (const t of cue) {
      const shown = shownAs(t, saved?.corrections, now?.corrections, heard)
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
 * The corrections after the person typed `typed` over a line. The line's words and the typed words are
 * compared word by word; the changed stretch widens to whole drawn words, and each of those gets back as
 * many typed words as it showed, the last one what is left over (fewer typed words leave the last ones
 * empty: off the captions, still heard). A drawn word made of several transcript words is fixed as one
 * (`at` through `through`). Typing a word back as the render drew it puts back its saved fixes.
 */
export function retype(line: LineToken[], now: Correction[], saved: Correction[], typed: string, heard: Heard): Correction[] {
  const subs = line.flatMap((t, i) => t.shown.split(' ').filter(Boolean).map((w) => ({ w, i })))
  const after = typed.trim().split(/\s+/).filter(Boolean)
  let a = 0
  while (a < subs.length && a < after.length && subs[a].w === after[a]) a++
  let z = 0
  while (z < subs.length - a && z < after.length - a && subs[subs.length - 1 - z].w === after[after.length - 1 - z]) z++
  if (a + z === subs.length && a + z === after.length) return now
  // a pure insertion belongs to the word before it (or, at the very start, the word after)
  const lo = a + z === subs.length ? Math.max(0, a - 1) : a
  const hi = Math.max(lo + 1, subs.length - z)
  const first = subs[lo].i
  const last = subs[hi - 1].i
  const from = subs.findIndex((x) => x.i === first)
  const to = subs.length - [...subs].reverse().findIndex((x) => x.i === last)
  const given = after.slice(from, after.length - (subs.length - to))
  let out = now
  let k = 0
  for (let i = first; i <= last; i++) {
    const t = line[i]
    const count = subs.filter((x) => x.i === i).length
    const text = (i === last ? given.slice(k) : given.slice(k, k + count)).join(' ')
    k += count
    if (text === t.shown) continue
    const mine = (c: Correction) => !!c.at && t.ids.includes(c.at)
    out = out.filter((c) => !mine(c))
    const fix: Correction = { from: heardOf(t, heard), to: text, at: t.ids[0] }
    if (t.ids.length > 1) fix.through = t.ids[t.ids.length - 1]
    out = text === t.w ? [...out, ...saved.filter(mine)] : [...out, fix]
  }
  return out
}

/** A line cleaned for the phone preview as the engine cleans a caption (captions.cue_text). */
export const previewText = (text: string): string => text.trim().replace(/^[(\[{"¿¡]+/, '').replace(/[.,!?;:)\]}"…]+$/, '')
