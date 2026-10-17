// Pure helpers for cut.keep (word-id ranges, inclusive, output order). Used by main and renderer.
import type { Word } from './api'

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
 */
export function rangesKeepingOrder(
  words: Word[],
  oldKeep: { from: string; to: string }[] | undefined,
  kept: Set<string>
): { from: string; to: string }[] {
  const index = new Map(words.map((w, i) => [w.id, i]))
  const runs: [number, number][] = [] // [start, end] word indexes, in output order
  const placed = new Set<number>()
  for (const r of oldKeep ?? []) {
    const a = index.get(r.from)
    const b = index.get(r.to)
    if (a === undefined || b === undefined) continue
    let start = -1
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
      after[0] = i
      return
    }
    let at = -1
    runs.forEach((r, k) => {
      if (r[1] < i && (at < 0 || r[1] > runs[at][1])) at = k
    })
    runs.splice(at + 1, 0, [i, i])
  })
  return runs.map(([a, b]) => ({ from: words[a].id, to: words[b].id }))
}
