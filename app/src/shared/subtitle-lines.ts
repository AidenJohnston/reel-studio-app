// The Subtitles list in "Edit it myself": the caption lines of the last render, with the edits not yet made
// into a version. Every edit is anchored on transcript word ids (engine/reelengine/captions.py edit_lines
// and apply_corrections "at"), so a recut keeps it. No Node or DOM imports.
import type { ProjectJson, Word } from './api'

type Captions = NonNullable<ProjectJson['captions']>
type Correction = NonNullable<Captions['corrections']>[number]

const flip = (ids: string[], id: string): string[] => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id])

/** Start a new line at `id` (Enter), or put the line starting at `id` onto the one before (Backspace, Join). */
export function setBreak(c: Captions, id: string, newLine: boolean): Captions {
  const [undo, add] = newLine ? (['join', 'split'] as const) : (['split', 'join'] as const)
  const cur = c[undo] ?? []
  return cur.includes(id) ? { ...c, [undo]: cur.filter((x) => x !== id) } : { ...c, [add]: [...(c[add] ?? []), id] }
}

/**
 * The lines to show: the render's lines (word ids, in the order they play) over the kept words, with each
 * line break added or taken away since the saved project flipped. A word cut since is left out.
 */
export function subtitleLines(rendered: string[][], words: Word[], kept: Set<string>, saved: Captions | undefined, now: Captions | undefined): Word[][] {
  const byId = new Map(words.map((w) => [w.id, w]))
  let flips: string[] = []
  for (const k of ['split', 'join'] as const) for (const id of now?.[k] ?? []) if (!(saved?.[k] ?? []).includes(id)) flips = flip(flips, id)
  for (const k of ['split', 'join'] as const) for (const id of saved?.[k] ?? []) if (!(now?.[k] ?? []).includes(id)) flips = flip(flips, id)
  const lines: Word[][] = []
  for (const ids of rendered) {
    let line: Word[] = []
    for (const id of ids) {
      const w = byId.get(id)
      if (!w || !kept.has(id) || line.includes(w)) continue
      if (flips.includes(id)) {
        if (line.length) {
          lines.push(line)
          line = []
        } else if (lines.length) {
          line = lines.pop()!
        }
      }
      line.push(w)
    }
    if (line.length) lines.push(line)
  }
  return lines
}

/** What a word says on screen before any fix made to it alone: the transcript, with one-word corrections (captions.py single). */
function heard(w: Word, corrections: Correction[]): string {
  const m = /^([^\w]*)(\w+(?:['’]\w+)?)(.*)$/u.exec(w.w)
  if (!m) return w.w
  const fix = corrections.find((c) => !c.at && !/\s/.test(c.from.trim()) && c.from.trim().replace(/^[^\w]+|[^\w]+$/gu, '').toLowerCase() === m[2].toLowerCase())
  return fix ? m[1] + fix.to.trim() + m[3] : w.w
}

export function wordText(w: Word, corrections: Correction[] = []): string {
  return corrections.find((c) => c.at === w.id)?.to ?? heard(w, corrections)
}

/**
 * The line's words after the person typed `typed` over them. Unchanged words at the start and end keep
 * their place; the words in between share what was typed in between, in order, the last of them taking
 * what is left over and any extra word getting nothing (it leaves the captions, still heard).
 */
export function retype(line: Word[], corrections: Correction[], typed: string): Correction[] {
  const before = line.map((w) => wordText(w, corrections))
  const after = typed.trim().split(/\s+/).filter(Boolean)
  let a = 0
  while (a < before.length && a < after.length && before[a] === after[a]) a++
  let z = 0
  while (z < before.length - a && z < after.length - a && before[before.length - 1 - z] === after[after.length - 1 - z]) z++
  const changed = line.slice(a, line.length - z)
  const given = after.slice(a, after.length - z)
  let out = corrections
  changed.forEach((w, i) => {
    const to = i === changed.length - 1 ? given.slice(i).join(' ') : (given[i] ?? '')
    out = out.filter((c) => c.at !== w.id)
    if (to !== heard(w, corrections)) out = [...out, { from: w.w, to, at: w.id }]
  })
  return out
}
