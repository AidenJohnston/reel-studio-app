import { describe, expect, it } from 'vitest'
import { binomialLowerTail, decideTrial, twoSidedP } from '../src/main/trial-decision'
import type { InsightPost } from '../src/shared/insights'

const POSTED = '2026-11-01T10:00:00.000Z'
const SETTLED = '2026-11-03T10:00:00.000Z' // exactly 48 hours later
const at = (hours: number) => new Date(Date.parse(POSTED) + hours * 3_600_000).toISOString()
function post(plays: number | null, observedAt: string | null = SETTLED, t: 1 | 2 = 1): InsightPost {
  return {
    project: 'p', version: 1, platform: 'instagram', accountId: '1', postId: String(t), publishedAt: POSTED, observedAt,
    status: 'available', durationMs: null, trial: { id: 'x', try: t, change: 'hook' },
    metrics: { plays, reach: null, averageWatchTimeMs: null, completionEstimate: null, skipRatePercent: null, shares: null, saves: null, comments: null, likes: null }
  }
}

describe('binomial tail', () => {
  // fails if the p-value arithmetic drifts: these have one correct answer
  it('matches exact values', () => {
    expect(binomialLowerTail(0, 10)).toBeCloseTo(1 / 1024, 12)
    expect(binomialLowerTail(5, 10)).toBeCloseTo(638 / 1024, 12)
    expect(binomialLowerTail(10, 10)).toBe(1)
    // 40 of 100: two-sided p = 0.05689 (any binomial table)
    expect(twoSidedP(40, 60)).toBeCloseTo(0.0569, 4)
    expect(twoSidedP(50, 50)).toBe(1)
  })
  // fails if the large-sample branch disagrees with the exact sum where they meet
  it('switches to the normal approximation without a jump', () => {
    const exact = binomialLowerTail(2450, 5000)
    const approx = binomialLowerTail(2450, 5002)
    expect(Math.abs(exact - approx)).toBeLessThan(0.01)
    expect(twoSidedP(2700, 2400)).toBeLessThan(1e-4)
  })
  it('refuses impossible counts', () => {
    expect(() => binomialLowerTail(11, 10)).toThrow(RangeError)
    expect(() => binomialLowerTail(-1, 10)).toThrow(RangeError)
  })
})

describe('decideTrial', () => {
  // fails if a trial is called before both results have had time to settle, or with one missing
  it('waits for both tries to be 48 hours old and read', () => {
    expect(decideTrial(post(900, '2026-11-03T09:59:00.000Z'), post(100, SETTLED, 2)).kind).toBe('waiting')
    expect(decideTrial(post(900), post(null, SETTLED, 2)).kind).toBe('waiting')
    expect(decideTrial(post(900), post(100, null, 2)).kind).toBe('waiting')
  })
  // fails if a try wins only because it has been up longer: equal tries at 100 views a day, read at 4 and 2 days
  it('waits until both tries have been up about as long', () => {
    const younger = { ...post(200, '2026-11-05T10:00:00.000Z', 2), publishedAt: '2026-11-03T10:00:00.000Z' }
    expect(decideTrial(post(400, '2026-11-05T10:00:00.000Z'), younger)).toMatchObject({ kind: 'waiting', reason: expect.stringContaining('Try 2 has been up for less time') })
    // a day later both have been up long enough for the gap in age to stop mattering (5 days and 4 days)
    const later = { ...post(200, '2026-11-07T10:00:00.000Z', 2), publishedAt: '2026-11-03T10:00:00.000Z' }
    expect(decideTrial(post(400, '2026-11-06T10:00:00.000Z'), later).kind).not.toBe('waiting')
  })
  // fails if a try wins on its extra time up: both at 1,000 views an hour, read at 48 and 60 hours (audit 05-results)
  it('takes the older try’s extra time out before comparing', () => {
    expect(decideTrial(post(48_000, at(48)), post(60_000, at(60), 2))).toMatchObject({ kind: 'too-close', reason: expect.stringContaining('Try 2 has been up longer') })
    // a real lead survives: 80,000 views in 60 hours is at least 64,000 at 48, a third ahead
    expect(decideTrial(post(48_000, at(48)), post(80_000, at(60), 2))).toMatchObject({ kind: 'winner', winner: 2, reason: expect.stringContaining('allowing for its extra time up') })
  })
  // fails if the younger try is credited with the older try's leveling off: it must beat the older try's whole count
  it('holds the younger try to the older try’s whole count', () => {
    expect(decideTrial(post(55_000, at(48)), post(50_000, at(60), 2)).kind).toBe('too-close')
    expect(decideTrial(post(61_000, at(48)), post(50_000, at(60), 2))).toMatchObject({ kind: 'winner', winner: 1 })
  })
  // fails if a tiny sample can produce a winner
  it('needs 100 views between them', () => {
    const v = decideTrial(post(80), post(19, SETTLED, 2))
    expect(v).toMatchObject({ kind: 'too-few', reason: expect.stringContaining('99 views between them') })
  })
  // fails if a gap that chance explains is called a win
  it('calls a small or chance gap too close', () => {
    expect(decideTrial(post(55), post(45, SETTLED, 2)).kind).toBe('too-close')
    expect(decideTrial(post(500), post(500, SETTLED, 2)).kind).toBe('too-close')
    // significant (p far below 0.05) but under the 20% lift floor
    expect(decideTrial(post(10_500), post(9_500, SETTLED, 2)).kind).toBe('too-close')
  })
  // fails if the winner, its lift or the reason the person reads is wrong
  it('names the winner with its numbers', () => {
    const v = decideTrial(post(410), post(640, SETTLED, 2))
    expect(v).toMatchObject({ kind: 'winner', winner: 2 })
    if (v.kind !== 'winner') throw new Error('not a winner')
    expect(v.liftPercent).toBeCloseTo(56.1, 1)
    expect(v.pValue).toBeLessThan(0.05)
    expect(v.reason).toBe('Try 1 got 410 views and Try 2 got 640. Try 2 got 56% more. With 1,050 views between them, a gap this big happens by chance less than 1 time in 20.')
  })
  it('gives no lift percentage when the other try had no views', () => {
    const v = decideTrial(post(150), post(0, SETTLED, 2))
    expect(v).toMatchObject({ kind: 'winner', winner: 1, liftPercent: null, reason: expect.stringContaining('Try 1 got all of them') })
  })
})
