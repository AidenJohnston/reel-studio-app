// How each cut of the reel plays (project.json cut.keep[i].join), as "Edit it myself" shows and changes it. The
// transitions mirror ai/src/project.ts and the engine schema; app/test/joins.test.ts fails when they drift, and checks
// joinProblem against the AI's own validateProject. No Node or DOM imports.
import type { Word } from './api'

export const TRANSITIONS = ['hard', 'j', 'l', 'smash', 'match', 'flash'] as const
export type Transition = (typeof TRANSITIONS)[number]
export interface Join { transition: Transition; frames: number }
export type KeepRange = { from: string; to: string; join?: Join }

// J and L are the names editors already use; the hint under the list says what each does.
export const TRANSITION_LABELS: Record<Transition, string> = { hard: 'Plain', j: 'J', l: 'L', smash: 'Smash', match: 'Match', flash: 'Flash' }
export const TRANSITION_HINTS: Record<Transition, string> = {
  hard: 'Picture and sound cut together.',
  j: 'You hear the next part a moment before you see it.',
  l: 'The sound runs on a moment over the next picture.',
  smash: 'A hard hit: a sound on the cut and the music dips.',
  match: 'The cut lands where both sides line up, so it hides.',
  flash: 'The picture dips to white for a moment on the cut.'
}
/** Frames a hand-picked J or L asks for; the engine clamps them to the room it has (ai/prompts/system.md: 6 to 12). */
export const BRIDGE_FRAMES = 8

/** Why `join` can't sit on cut.keep[index], in ai/src/project.ts joinProblem's words; null when it can. */
export function joinProblem(join: unknown, index: number): string | null {
  if (index === 0) return 'not allowed on the first range'
  if (!join || typeof join !== 'object') return 'needs transition and frames'
  const j = join as Record<string, unknown>
  if (!(TRANSITIONS as readonly unknown[]).includes(j.transition)) return 'transition must be hard, j, l, smash, match or flash'
  if (!Number.isSafeInteger(j.frames) || (j.frames as number) < 0) return 'frames must be a non-negative integer'
  return null
}

/** The join the drawer writes for a transition: J and L ask for frames, the rest need none. A plain cut is no join. */
export function joinFor(transition: Transition): Join | null {
  if (transition === 'hard') return null
  return { transition, frames: transition === 'j' || transition === 'l' ? BRIDGE_FRAMES : 0 }
}

export interface CutRow {
  /** the first word of the range the cut leads into: a join is told apart by it (hand-edit.ts) */
  at: string
  index: number
  transition: Transition
  /** the last words before the cut and the first after it */
  before: string
  after: string
}

/** Every cut between two ranges of a word cut, in play order. A range that starts right where the one before it ends
 * (the take runs on) has no cut. */
export function cutRows(words: Word[], keep: KeepRange[] | undefined, quote = 4): CutRow[] {
  const at = new Map(words.map((w, i) => [w.id, i]))
  const span = (r: KeepRange): [number, number] | null => {
    const a = at.get(r.from)
    const b = at.get(r.to)
    return a === undefined || b === undefined ? null : [Math.min(a, b), Math.max(a, b)]
  }
  const said = (a: number, b: number) => words.slice(a, b + 1).map((w) => w.w.trim()).join(' ')
  const rows: CutRow[] = []
  ;(keep ?? []).forEach((r, i) => {
    if (i === 0) return
    const prev = span(keep![i - 1])
    const cur = span(r)
    if (!prev || !cur) return
    if (cur[0] === prev[1] + 1 && words[cur[0]].source === words[prev[1]].source) return
    rows.push({
      at: r.from,
      index: i,
      transition: r.join?.transition ?? 'hard',
      before: said(Math.max(prev[0], prev[1] - quote + 1), prev[1]),
      after: said(cur[0], Math.min(cur[1], cur[0] + quote - 1))
    })
  })
  return rows
}

/** `keep` with the cut into the range starting at word `at` playing as `join` (null: a plain cut). Unchanged when no
 * range after the first starts there. */
export function withJoin(keep: KeepRange[], at: string, join: Join | null): KeepRange[] {
  return keep.map((r, i) => {
    if (i === 0 || r.from !== at) return r
    const { join: _old, ...rest } = r
    return join ? { ...rest, join: { ...join } } : rest
  })
}
