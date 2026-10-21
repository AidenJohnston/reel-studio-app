// The cover picker's suggestions: which moments of the take to look at, and the plain-words reason the
// engine's cover scorer (engine/reelengine/cover.py score_frames) picked each frame.
import type { Word } from './api'

/** A signal the cover scorer found this frame standing out on, against the other faces near the same
 * moment (engine cover._mark_reasons). Listed in the scorer's weight order. */
export type CoverSignal = 'eyesOpen' | 'sharp' | 'betweenWords' | 'still'
export const COVER_SIGNALS: readonly CoverSignal[] = ['eyesOpen', 'sharp', 'betweenWords', 'still']

/** One frame from `cover-candidates --picker`. */
export interface CoverCandidate {
  atSourceTime: number
  source: string
  reasons: CoverSignal[]
  /** reel-media: URL of the still */
  image: string
}

export const COVER_SUGGESTIONS = 6 // the engine's cover-candidates looks at six moments at most

// The engine searches 0.6 s either side of each moment (cover.CANDIDATE_HALF). Moments closer than
// both windows together would return the same frame twice.
const MIN_GAP = 1.2

/** Up to `n` moments spread over the kept words of one source, as raw-take seconds: the start of the
 * middle word of each of n equal stretches. */
export function coverMoments(words: Word[], kept: Set<string>, source: string, n = COVER_SUGGESTIONS): number[] {
  const ws = words.filter((w) => kept.has(w.id) && (w.source ?? 's1') === source).sort((a, b) => a.s - b.s)
  const picks = ws.length <= n ? ws : Array.from({ length: n }, (_, i) => ws[Math.floor(((i + 0.5) * ws.length) / n)])
  const out: number[] = []
  for (const w of picks) if (!out.length || w.s - out[out.length - 1] >= MIN_GAP) out.push(w.s)
  return out
}

const SAY: Record<CoverSignal, string> = {
  eyesOpen: 'eyes open',
  sharp: 'face in focus',
  betweenWords: 'between words',
  still: 'holding still'
}

/** Why the scorer picked this frame, in words: the first two signals it stood out on. With none (flat
 * signals, too few faces nearby to compare) it still won on the combined score. */
export function coverReason(reasons: CoverSignal[]): string {
  const text = reasons.slice(0, 2).map((r) => SAY[r]).join(', ') || 'clearest face nearby'
  return text[0].toUpperCase() + text.slice(1)
}
