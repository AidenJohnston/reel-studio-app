// The creator's niche (My style › Your niche): who their reels are for, what viewers get, a few kinds of reel to make,
// and words to keep out. Saved to <Reel Studio root>/My niche.json; the editor reads it on every reel
// (ai/src/niche.ts readNiche). No Node or DOM imports: main, the page and the tests share it.

export const NICHE_FILE = 'My niche.json'
/** The app's own first question in the niche chat; the editor asks at most two more (ai niche.ts NICHE_QUESTIONS). */
export const NICHE_OPENER = 'What do you make reels about?'
export const NICHE_LIMITS = { line: 160, angle: 120, angles: 5, word: 40, avoid: 12 } as const

export interface Niche {
  who: string
  promise: string
  angles: string[]
  avoid: string[]
}

export interface SavedNiche extends Niche {
  savedAt: string
  /** drafted in the chat with the editor, or written by the person */
  from: 'chat' | 'typed'
}

export interface NicheTurn {
  from: 'you' | 'editor'
  text: string
  kind?: 'question' | 'niche'
}
export type NicheTurnResult = { kind: 'question'; text: string } | ({ kind: 'niche'; say: string } & Niche)

/** One line as it is saved: spaces collapsed, no em dashes (CONTRIBUTING.md), cut to `max`. */
export function cleanLine(text: unknown, max: number): string {
  return String(text ?? '').replace(/\s*—\s*/g, ', ').replace(/\s+/g, ' ').trim().slice(0, max)
}

/** "hack, game-changer; insane" or one per line → ['hack', 'game-changer', 'insane']: trimmed, no repeats. */
export function splitWords(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of text.split(/[,;\n]/)) {
    const w = cleanLine(part.trim().replace(/^["“”']+|["“”']+$/g, ''), NICHE_LIMITS.word)
    if (w && !seen.has(w.toLowerCase())) {
      seen.add(w.toLowerCase())
      out.push(w)
    }
  }
  return out
}

const bad = (userMessage: string) => ({ code: 'BAD_NICHE', userMessage })

/** The niche the person saves, checked and cleaned; throws a user error naming the field to fix. */
export function checkNiche(v: unknown): Niche {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad('That niche could not be read. Try again.')
  const o = v as Record<string, unknown>
  const who = cleanLine(o.who, NICHE_LIMITS.line)
  const promise = cleanLine(o.promise, NICHE_LIMITS.line)
  if (!who) throw bad('Say who your reels are for.')
  if (!promise) throw bad('Say what viewers get from your reels.')
  if (!Array.isArray(o.angles) || !Array.isArray(o.avoid)) throw bad('That niche could not be read. Try again.')
  const angles = o.angles.map((a) => cleanLine(a, NICHE_LIMITS.angle)).filter(Boolean)
  if (!angles.length) throw bad('Add at least one kind of reel you make.')
  if (angles.length > NICHE_LIMITS.angles) throw bad(`Keep it to ${NICHE_LIMITS.angles} kinds of reel or fewer.`)
  const avoid = splitWords(o.avoid.filter((w) => typeof w === 'string').join('\n'))
  if (avoid.length > NICHE_LIMITS.avoid) throw bad(`Keep it to ${NICHE_LIMITS.avoid} words to avoid or fewer.`)
  return { who, promise, angles, avoid }
}

/** My niche.json as the app writes it. */
export function nicheFileData(n: SavedNiche): { version: 1; niche: SavedNiche } {
  return { version: 1, niche: n }
}

/** The saved niche from My niche.json's text: null for no file's worth of niche, 'damaged' when it can't be read. */
export function readNicheFile(text: string): SavedNiche | 'damaged' {
  let data: unknown
  try {
    data = JSON.parse(text.replace(/^﻿/, ''))
  } catch {
    return 'damaged'
  }
  const n = (data as { niche?: Record<string, unknown> } | null)?.niche
  try {
    const checked = checkNiche(n)
    return { ...checked, savedAt: typeof n?.savedAt === 'string' ? n.savedAt : '', from: n?.from === 'chat' ? 'chat' : 'typed' }
  } catch {
    return 'damaged'
  }
}
