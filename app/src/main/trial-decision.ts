import type { InsightPost, TrialVerdict } from '../shared/insights'

// The rule that picks a trial's winner. Views decide it, because every platform reports them and a trial shows both
// tries to the same kind of audience (Instagram: people who don't follow you). Under "no difference", each of the
// combined views is equally likely to have landed on either try, so the count for one try is Binomial(n, 1/2).
// A winner needs all of:
//   - both results read at least SETTLE_HOURS after posting (Meta says insights can lag up to 48 hours);
//   - both tries about the same age when read (MIN_AGE_RATIO): views are lifetime counts, so a try that has been up
//     twice as long would win on time alone. Lifetime views level off, so ages drawing closer as both tries get
//     older lets a trial whose tries went up days apart still be decided;
//   - the older try leading even after its extra time is taken out (comparedViews): within that age gap, a try up
//     25% longer at the same rate has 25% more views, past the lift floor (audit 05-results);
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
/** The younger try's age at its read over the older's must be at least this. */
export const MIN_AGE_RATIO = 0.8

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

/**
 * The two counts the rule compares: the younger try's views, and the older try's views at the younger try's age.
 * That second number isn't read. Assuming lifetime views grow at most in proportion to time (a reel gets most of
 * its views early, then levels off; one that takes off late breaks this), the older try had at least
 * `older × youngerAge / olderAge` and at most `older` by then. Each try is held to the
 * count least in its favour: the older try leads only if it leads on the smallest count it could have had, and the
 * younger try only if it leads the older try's whole count. When neither does, the counts are returned equal.
 */
export function comparedViews(a: number, ageOne: number, b: number, ageTwo: number): [number, number] {
  if (ageOne === ageTwo) return [a, b]
  const oneOlder = ageOne > ageTwo
  const older = oneOlder ? a : b, younger = oneOlder ? b : a
  const olderAtYoungerAge = Math.floor(older * Math.min(ageOne, ageTwo) / Math.max(ageOne, ageTwo))
  const pair: [number, number] = olderAtYoungerAge > younger ? [olderAtYoungerAge, younger] : younger > older ? [older, younger] : [younger, younger]
  return oneOlder ? pair : [pair[1], pair[0]]
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
  const ageOne = Date.parse(one.observedAt!) - Date.parse(one.publishedAt), ageTwo = Date.parse(two.observedAt!) - Date.parse(two.publishedAt)
  if (Math.min(ageOne, ageTwo) / Math.max(ageOne, ageTwo) < MIN_AGE_RATIO) {
    const later = ageOne < ageTwo ? 1 : 2
    return { kind: 'waiting', reason: `Try ${later} has been up for less time, so its views aren't comparable yet. A winner is picked once both have been up about as long.` }
  }
  if (a + b < MIN_VIEWS)
    return { kind: 'too-few', reason: `${count(a + b)} ${a + b === 1 ? 'view' : 'views'} between them so far. It takes at least ${MIN_VIEWS} to tell them apart.` }
  const [ca, cb] = comparedViews(a, ageOne, b, ageTwo)
  const adjusted = ca !== a || cb !== b
  const winner: 1 | 2 = ca >= cb ? 1 : 2
  const lead = Math.max(ca, cb), trail = Math.min(ca, cb)
  const lift = trail > 0 ? (lead - trail) / trail * 100 : Infinity
  const p = twoSidedP(ca, cb)
  const views = `Try 1 got ${count(a)} ${a === 1 ? 'view' : 'views'} and Try 2 got ${count(b)}.`
  const older = ageOne > ageTwo ? 1 : 2
  // the comparison took the leader's extra time out, and the reason says so
  const fair = adjusted && winner === older ? ', allowing for its extra time up' : ''
  if (ca === cb) {
    // equal after the adjustment: the older try's whole lead is what its extra time could have given it
    return { kind: 'too-close', reason: adjusted && (older === 1 ? a > b : b > a)
      ? `${views} Try ${older} has been up longer, which is enough to explain its lead, so neither one wins.`
      : `${views} A gap that small could be luck, so neither one wins.` }
  }
  if (p >= MAX_P)
    return { kind: 'too-close', reason: `${views} Try ${winner} is ahead${fair}, but with ${count(a + b)} views between them a gap that size could be luck, so neither one wins.` }
  if (lift < MIN_LIFT_PERCENT)
    // rounded down, so a lead just under the floor never reads as the floor itself
    return { kind: 'too-close', reason: `${views} Try ${winner} got ${Math.floor(lift)}% more${fair}, short of the ${MIN_LIFT_PERCENT}% lead a winner needs.` }
  const liftText = Number.isFinite(lift) ? `${Math.round(lift)}% more` : 'all of them'
  return {
    kind: 'winner', winner, liftPercent: Number.isFinite(lift) ? lift : null, pValue: p,
    reason: `${views} Try ${winner} got ${liftText}${fair}. With ${count(a + b)} views between them, a gap this big happens by chance less than 1 time in 20.`
  }
}
