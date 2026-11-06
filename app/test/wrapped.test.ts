// Insights > Your recent reels (shared/wrapped.ts): which reel it says is working, which edit it offers, and when it
// refuses to compare. Each case is a claim a creator would read and might act on.
import { describe, expect, it } from 'vitest'
import { timingOf, wrappedReport, type WrappedReel } from '../src/shared/wrapped'

const NOW = Date.parse('2026-11-06T12:00:00Z')
const tidy = { duration: 20, firstWord: 0.2, lastWord: 19.6, firstCut: 2 }

function reelOf(n: number, over: Partial<WrappedReel> = {}): WrappedReel {
  return {
    project: `reel-${n}`, version: 1, title: `Reel ${n}`, publishedAt: `2026-10-${String(10 + n).padStart(2, '0')}T10:00:00Z`,
    plays: 1000, averageWatchTimeMs: 10_000, shares: 3, saves: 3, timing: tidy, ...over
  }
}

describe('wrappedReport', () => {
  it('fails if it compares fewer than 3 posted reels with results', () => {
    expect(wrappedReport([reelOf(1), reelOf(2), reelOf(3, { plays: null })], NOW)).toEqual({ state: 'too-few', posted: 2 })
  })

  it('fails if it compares older reels instead of the newest 3 posted', () => {
    const r = wrappedReport([reelOf(1, { shares: 60 }), reelOf(2), reelOf(3), reelOf(4)], NOW)
    expect(r.state === 'ready' && r.reels.map((x) => x.project)).toEqual(['reel-4', 'reel-3', 'reel-2'])
  })

  it('fails if a reel shared far more than the others is not the one called working', () => {
    const r = wrappedReport([reelOf(1), reelOf(2, { shares: 40 }), reelOf(3, { shares: 4 })], NOW)
    expect(r.state === 'ready' && r.strength).toMatchObject({ kind: 'shares', project: 'reel-2', headline: 'People pass on “Reel 2”.' })
  })

  it('fails if a standout on a handful of plays is claimed instead of saying none stands apart', () => {
    const small = [reelOf(1, { plays: 50, shares: 10 }), reelOf(2, { plays: 50, shares: 1, saves: 1 }), reelOf(3, { plays: 50, shares: 1, saves: 1 })]
    const r = wrappedReport(small, NOW)
    expect(r.state === 'ready' && r.strength.kind).toBe('held-longest')
    expect(r.state === 'ready' && r.strength.detail).toContain('None stands far apart yet.')
  })

  it('fails if the edit offered is not for the reel people watched least of, at its silent opening', () => {
    const r = wrappedReport(
      [reelOf(1), reelOf(2, { averageWatchTimeMs: 4000, timing: { ...tidy, firstWord: 1.8 } }), reelOf(3, { timing: { ...tidy, firstWord: 2.5 } })],
      NOW
    )
    expect(r.state === 'ready' && r.edit).toMatchObject({ kind: 'late-start', project: 'reel-2', editName: 'Trim the first 1.8 s' })
    expect(r.state === 'ready' && r.edit!.note).toContain('first word comes right at the start')
  })

  it('fails if a reel that runs on after its last word is not offered "End on your last word"', () => {
    const r = wrappedReport([reelOf(1), reelOf(2), reelOf(3, { averageWatchTimeMs: 3000, timing: { ...tidy, lastWord: 16 } })], NOW)
    expect(r.state === 'ready' && r.edit).toMatchObject({ kind: 'long-ending', project: 'reel-3', at: 16, note: 'End the reel on my last word: cut the 4 s after it.' })
  })

  it('fails if it offers an edit for a version whose render is gone', () => {
    const r = wrappedReport([reelOf(1), reelOf(2), reelOf(3, { averageWatchTimeMs: 1000, timing: null })], NOW)
    expect(r.state === 'ready' && r.edit).toBeNull()
  })
})

describe('timingOf', () => {
  it("fails if the first cut, first word or last word aren't read from the render's own clock", () => {
    const seg = (out_start: number) => ({ source: 's1', src_start: 0, src_end: 3, out_start })
    expect(
      timingOf({ duration: 9, words: [{ s: 4.1, e: 4.5 }, { s: 0.9, e: 1.2 }, { s: 7, e: 8.4 }], segments: [seg(4.2), seg(0)] })
    ).toEqual({ duration: 9, firstWord: 0.9, lastWord: 8.4, firstCut: 4.2 })
    expect(timingOf({ duration: 9, words: [], segments: [seg(0)] })).toEqual({ duration: 9, firstWord: null, lastWord: null, firstCut: null })
  })
})
