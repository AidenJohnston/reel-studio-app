// The cover picker's suggestions: which moments of the take to look at, and the plain-words reason the
// engine's cover scorer (engine/reelengine/cover.py score_frames) picked each frame.
import type { Word } from './api'

/** One frame from `cover-candidates`. eyesOpen / sharp / still are 0-1 against the other frames near the
 * same moment (1 = in the top tenth of them); betweenWords = no word was being said at that instant. */
export interface CoverCandidate {
  atSourceTime: number
  source: string
  eyesOpen: number
  sharp: number
  still: number
  betweenWords: boolean
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

/** Why the scorer picked this frame, strongest signal first, in the order the scorer weighs them
 * (eyes 0.35, sharpness 0.35, between words 0.20, stillness 0.10). A signal counts only when the frame
 * is at the top of its neighbours for it, so the words never claim more than the numbers show. */
export function coverReason(c: Pick<CoverCandidate, 'eyesOpen' | 'sharp' | 'still' | 'betweenWords'>): string {
  const parts = [
    c.eyesOpen >= 1 && 'eyes open',
    c.sharp >= 1 && 'face in focus',
    c.betweenWords && 'between words',
    c.still >= 1 && 'holding still'
  ].filter((p): p is string => !!p)
  const text = parts.slice(0, 2).join(', ') || 'clearest face nearby'
  return text[0].toUpperCase() + text.slice(1)
}
