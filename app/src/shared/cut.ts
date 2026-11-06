// Pure helpers for cut.keep (word-id ranges, inclusive, output order). Used by main and renderer.
import type { Word } from './api'
import type { Join } from './joins'

type WordRange = { from: string; to: string; join?: Join }
type CutItem = WordRange | { clip: string; source: string; in: number; out: number }

/** A word-only rewrite would remove silent clips, so refuse it until manual cuts preserve both shapes. */
export function assertWordCutEditable(keep: CutItem[] | undefined): asserts keep is WordRange[] | undefined {
  if (keep?.some((item) => 'clip' in item)) {
    throw { code: 'CLIP_CUT', userMessage: 'Use an editor note to change the clips in this reel. Manual word cuts are not available for clip timelines yet.' }
  }
}

/** Expands keep ranges into kept word ids, in output order. */
export function keptIds(words: Word[], keep: { from: string; to: string }[] | undefined): string[] {
  if (!keep) return []
  const index = new Map(words.map((w, i) => [w.id, i]))
  const out: string[] = []
  for (const r of keep) {
    const a = index.get(r.from)
    const b = index.get(r.to)
    if (a === undefined || b === undefined) continue
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) out.push(words[i].id)
  }
  return out
}

/**
 * Builds keep ranges from kept ids. Ranges come out in transcript order: a cut the user tweaks by
 * hand plays in the order it was said.
 */
export function rangesFromKept(words: Word[], kept: Set<string>): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = []
  let start: string | null = null
  let prev: string | null = null
  for (const w of words) {
    if (kept.has(w.id)) {
      if (start === null) start = w.id
      prev = w.id
    } else if (start !== null) {
      out.push({ from: start, to: prev! })
      start = null
    }
  }
  if (start !== null) out.push({ from: start, to: prev! })
  return out
}

/**
 * Like rangesFromKept, but keeps the OUTPUT ORDER of the existing cut (review 28): the AI may have
 * moved a later take to the front, and un-striking one word must not put the whole reel back in
 * spoken order. Old ranges keep their place (split where words were struck); a word brought back
 * joins the range it touches, or becomes its own range right after the nearest earlier kept word.
 * A range keeps its join (J, L, smash, match) while it still starts with a cut, so striking a word
 * elsewhere doesn't turn the editor's joins back into plain cuts.
 */
export function rangesKeepingOrder(
  words: Word[],
  oldKeep: CutItem[] | undefined,
  kept: Set<string>
): WordRange[] {
  assertWordCutEditable(oldKeep)
  const index = new Map(words.map((w, i) => [w.id, i]))
  const runs: [number, number][] = [] // [start, end] word indexes, in output order
  const joins = new Map<number, NonNullable<WordRange['join']>>() // a run's first word index -> the join into it
  const placed = new Set<number>()
  for (const r of oldKeep ?? []) {
    const a = index.get(r.from)
    const b = index.get(r.to)
    if (a === undefined || b === undefined) continue
    let start = -1
    // the join leads into the range's first kept word; a range split by a struck word keeps it on its first piece only
    if (r.join) {
      let first = Math.min(a, b)
      while (first <= Math.max(a, b) && (!kept.has(words[first].id) || placed.has(first))) first++
      if (first <= Math.max(a, b)) joins.set(first, r.join)
    }
    for (let i = Math.min(a, b); i <= Math.max(a, b) + 1; i++) {
      const on = i <= Math.max(a, b) && kept.has(words[i].id) && !placed.has(i)
      if (on && start < 0) start = i
      if (!on && start >= 0) {
        runs.push([start, i - 1])
        start = -1
      }
      if (on) placed.add(i)
    }
  }
  words.forEach((w, i) => {
    if (!kept.has(w.id) || placed.has(i)) return
    placed.add(i)
    const k = runs.findIndex((r) => r[1] === i - 1)
    if (k >= 0) {
      runs[k][1] = i
      // the gap between two neighbouring ranges is closed: make them one range again
      if (runs[k + 1]?.[0] === i + 1) runs.splice(k, 2, [runs[k][0], runs[k + 1][1]])
      return
    }
    const after = runs.find((r) => r[0] === i + 1)
    if (after) {
      // a word brought back at a range's start: the cut into it moves one word earlier and keeps its join
      if (joins.has(i + 1)) joins.set(i, joins.get(i + 1)!)
      after[0] = i
      return
    }
    let at = -1
    runs.forEach((r, k) => {
      if (r[1] < i && (at < 0 || r[1] > runs[at][1])) at = k
    })
    runs.splice(at + 1, 0, [i, i])
  })
  return runs.map(([a, b], k) => {
    const join = joins.get(a)
    // the first range, or one the range before it now runs straight into, has no cut to join
    const touching = k > 0 && runs[k - 1][1] === a - 1
    return join && k > 0 && !touching ? { from: words[a].id, to: words[b].id, join: { ...join } } : { from: words[a].id, to: words[b].id }
  })
}
