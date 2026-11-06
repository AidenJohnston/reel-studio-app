import { expect, it } from 'vitest'
import { ago, audienceLines, bestReel, compact, reelLine } from '../src/shared/insight-words'
import type { InsightMetric, InsightReel } from '../src/shared/insights'

function reel(name: string, metrics: Partial<Record<InsightMetric, number>>, status: 'available' | 'still counting' = 'available'): InsightReel {
  const m = { plays: null, reach: null, averageWatchTimeMs: null, completionEstimate: null, skipRatePercent: null, shares: null, saves: null, comments: null, likes: null, ...metrics }
  const post = { project: name, version: 1, platform: 'instagram' as const, accountId: '1', postId: name, publishedAt: '2026-11-01T00:00:00.000Z',
    observedAt: '2026-11-04T00:00:00.000Z', status, durationMs: 20_000, metrics: m, trial: null }
  return { project: name, version: 1, title: name, cover: null, posts: [post], totals: { posts: 1, stillCounting: 0, metrics: m, coverage: { plays: 1, reach: 1, averageWatchTimeMs: 1, completionEstimate: 1, skipRatePercent: 1, shares: 1, saves: 1, comments: 1, likes: 1 } } }
}

// fails if a reel is compared with "your usual" on too little history, or the order of what's named changes
it('compares a reel with the median of the others, watching first', () => {
  const others = [reel('a', { plays: 1000, completionEstimate: 0.4, skipRatePercent: 30 }), reel('b', { plays: 1200, completionEstimate: 0.5, skipRatePercent: 30 })]
  const held = reel('c', { plays: 1100, completionEstimate: 0.71, skipRatePercent: 10 })
  expect(reelLine(held, [...others, held])).toBe('Held people longer than your usual reel (71%, usually 45%)')
  // watching about as usual: the skip rate is next, and lower is better
  const skippy = reel('d', { plays: 1100, completionEstimate: 0.46, skipRatePercent: 45 })
  expect(reelLine(skippy, [...others, skippy])).toBe('More people swiped away in the first 3 seconds (45%, usually 30%)')
  const same = reel('e', { plays: 1100, completionEstimate: 0.45, skipRatePercent: 30 })
  expect(reelLine(same, [...others, same])).toBe('About as usual for you')
  // two reels are not enough history: say what it did on its own
  expect(reelLine(held, [others[0], held])).toBe('People watched about 71% of it on average')
  expect(reelLine(reel('t', { plays: 12_400 }), [reel('t', { plays: 12_400 })])).toBe('12.4K views so far')
})

// fails if a reel still collecting views is judged, or counted as "usual"
it('leaves counting reels out of judgements', () => {
  const counting = reel('n', { plays: 5 }, 'still counting')
  expect(reelLine(counting, [counting])).toBe('Still counting · results settle about two days after posting')
  expect(bestReel([counting, reel('a', { plays: 10 })])).toBeNull()
  const top = reel('b', { plays: 900 })
  expect(bestReel([counting, reel('a', { plays: 10 }), top])).toBe(top)
})

// fails if the audience readout misreads Instagram's breakdowns
it('reads an audience in a few plain lines', () => {
  const lines = audienceLines({
    platform: 'instagram', accountId: '1', observedAt: '2026-11-04T00:00:00.000Z',
    followers: {
      age: [{ key: '25-34', value: 410 }, { key: '18-24', value: 300 }, { key: '35-44', value: 290 }],
      gender: [{ key: 'F', value: 620 }, { key: 'M', value: 330 }, { key: 'U', value: 50 }],
      country: [{ key: 'US', value: 500 }, { key: 'GB', value: 200 }, { key: 'CA', value: 100 }, { key: 'AU', value: 50 }],
      city: [{ key: 'London, England', value: 50 }, { key: 'Austin, Texas', value: 40 }]
    }
  })
  expect(lines).toEqual([
    'Most of your Instagram followers are 25-34 (41%).',
    '62% are women.',
    'Top places: United States, United Kingdom and Canada.',
    'A big group is in one city: London, England (56%).'
  ])
  expect(audienceLines({ platform: 'instagram', accountId: '1', observedAt: '', followers: { age: [], gender: [], country: [], city: [] } })).toEqual([])
})

it('formats counts and ages', () => {
  expect(compact(9_999)).toBe('9,999')
  expect(compact(12_400)).toBe('12.4K')
  expect(compact(1_250_000)).toBe('1.3M')
  const now = Date.parse('2026-11-06T12:00:00.000Z')
  expect(ago('2026-11-06T11:59:30.000Z', now)).toBe('just now')
  expect(ago('2026-11-06T10:00:00.000Z', now)).toBe('2 hours ago')
  expect(ago('2026-11-05T12:00:00.000Z', now)).toBe('1 day ago')
})
