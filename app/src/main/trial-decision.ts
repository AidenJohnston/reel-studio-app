import type { InsightPost, TrialVerdict } from '../shared/insights'

// The rule that picks a trial's winner. Views decide it, because every platform reports them and a trial shows both
// tries to the same kind of audience (Instagram: people who don't follow you). Under "no difference", each of the
// combined views is equally likely to have landed on either try, so the count for one try is Binomial(n, 1/2).
// A winner needs all of:
//   - both results read at least SETTLE_HOURS after posting (Meta says insights can lag up to 48 hours);
//   - at least MIN_VIEWS views between them;
//   - a two-sided exact binomial p-value under MAX_P;
//   - the leader at least MIN_LIFT_PERCENT ahead.
// Views of one video are not independent coin flips (one share brings a burst), so the p-value is optimistic; the
// lift floor is there so a big but trivial gap never wins. None of these numbers comes from a study: they are the
// insights screen's own thresholds (main/insights.ts) and the usual 1-in-20 convention.
export const SETTLE_HOURS = 48
export const MIN_VIEWS = 100
export const MAX_P = 0.05
export const MIN_LIFT_PERCENT = 20

const HOUR = 3_600_000
const count = (n: number) => n.toLocaleString('en-US')

/** P(X <= k) for X ~ Binomial(n, 1/2), exactly for n <= 5000 (log-space sum), else the normal approximation. */
export function binomialLowerTail(k: number, n: number): number {
  if (!Number.isSafeInteger(k) || !Number.isSafeInteger(n) || k < 0 || n < 0 || k > n) throw new RangeError('binomialLowerTail needs 0 <= k <= n')
  if (k === n) return 1
  if (n <= 5000) {
    let logC = 0
    let sum = 0
    const half = n * Math.log(0.5)
    for (let i = 0; i <= k; i++) {
      sum += Math.exp(logC + half)
      logC += Math.log(n - i) - Math.log(i + 1)
    }
    return Math.min(1, sum)
  }
  // continuity-corrected normal tail; error is far below the 0.05 threshold at this size
  const z = (k + 0.5 - n / 2) / Math.sqrt(n / 4)
  return 0.5 * erfc(-z / Math.SQRT2)
}

/** Two-sided p-value that two view counts came from the same rate. */
export function twoSidedP(a: number, b: number): number {
  return Math.min(1, 2 * binomialLowerTail(Math.min(a, b), a + b))
}

// Abramowitz and Stegun 7.1.26, absolute error under 1.5e-7.
function erfc(x: number): number {
  const z = Math.abs(x)
  const t = 1 / (1 + 0.3275911 * z)
  const y = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * Math.exp(-z * z)
  return x >= 0 ? y : 2 - y
}

const settled = (p: InsightPost) => p.observedAt !== null && Date.parse(p.observedAt) - Date.parse(p.publishedAt) >= SETTLE_HOURS * HOUR

/** Decides a trial from both tries' saved results. Pure: the same results always give the same verdict. */
export function decideTrial(one: InsightPost, two: InsightPost): TrialVerdict {
  const a = one.metrics.plays, b = two.metrics.plays
  if (a === null || b === null || !settled(one) || !settled(two))
    return { kind: 'waiting', reason: `Waiting for both results. A winner is picked once both tries have been up for ${SETTLE_HOURS} hours.` }
  if (a + b < MIN_VIEWS)
    return { kind: 'too-few', reason: `${count(a + b)} ${a + b === 1 ? 'view' : 'views'} between them so far. It takes at least ${MIN_VIEWS} to tell them apart.` }
  const winner: 1 | 2 = a >= b ? 1 : 2
  const lead = Math.max(a, b), trail = Math.min(a, b)
  const lift = trail > 0 ? (lead - trail) / trail * 100 : Infinity
  const p = twoSidedP(a, b)
  const views = `Try 1 got ${count(a)} ${a === 1 ? 'view' : 'views'} and Try 2 got ${count(b)}.`
  if (a === b || p >= MAX_P || lift < MIN_LIFT_PERCENT)
    return { kind: 'too-close', reason: `${views} A gap that small could be luck, so neither one wins.` }
  const liftText = Number.isFinite(lift) ? `${Math.round(lift)}% more` : 'all of them'
  return {
    kind: 'winner', winner, liftPercent: Number.isFinite(lift) ? lift : null, pValue: p,
    reason: `${views} Try ${winner} got ${liftText}. With ${count(a + b)} views between them, a gap this big happens by chance less than 1 time in 20.`
  }
}
