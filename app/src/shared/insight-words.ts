// The Insights screen's words: what each number means for one person's own reels, in a sentence, before any number.
// Pure, so every sentence has a test (app/test/insight-words.test.ts).
import type { AudienceSlice, InsightPlatform, InsightReel, PlatformAudience } from './insights'

export const PLATFORM_NAMES: Record<InsightPlatform, string> = { instagram: 'Instagram', tiktok: 'TikTok', facebook: 'Facebook', threads: 'Threads', x: 'X', linkedin: 'LinkedIn' }

/** 12,400 → "12.4K". Counts under 10,000 keep every digit. */
export function compact(n: number): string {
  if (n < 10_000) return Math.round(n).toLocaleString('en-US')
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n)
}
export const percent = (fraction: number): string => `${Math.round(fraction * 100)}%`
export function seconds(ms: number): string {
  const s = ms / 1000
  return s < 10 ? `${s.toFixed(1)} s` : `${Math.round(s)} s`
}

/** A reel is compared with the others only when it and at least two others have settled numbers. */
export const MIN_TO_COMPARE = 3
// A difference has to be this big before the screen calls it out. Not from a study: smaller gaps between a handful of
// reels are mostly noise, and the same 20% floor is what insights.ts and trial-decision.ts use.
const NOTABLE = 0.2

const settled = (r: InsightReel) => r.posts.length > 0 && r.posts.every((p) => p.status === 'available')
function median(values: number[]): number | null {
  if (!values.length) return null
  const s = [...values].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const sharesPerView = (r: InsightReel) => {
  const { shares, plays } = r.totals.metrics
  return shares !== null && plays !== null && plays > 0 ? shares / plays : null
}

/**
 * One line under a reel saying how it did, with no closing period (the readout adds one). Against the person's own usual reel (the median of their other settled
 * reels) when there are enough of them; otherwise what it did on its own. Watching longer is named first, because it
 * is the number a creator can most act on in the edit.
 */
export function reelLine(reel: InsightReel, all: InsightReel[]): string {
  if (reel.posts.some((p) => p.status === 'still counting')) return 'Still counting · results settle about two days after posting'
  if (!settled(reel)) return 'No results from the platform yet'
  const t = reel.totals.metrics
  const others = all.filter((r) => r !== reel && settled(r))
  if (others.length + 1 >= MIN_TO_COMPARE) {
    const rows: { mine: number | null; usual: number | null; higherIsBetter: boolean; better: string; worse: string; show: (v: number) => string }[] = [
      { mine: t.completionEstimate, usual: median(others.flatMap((r) => r.totals.metrics.completionEstimate ?? [])), higherIsBetter: true,
        better: 'Held people longer than your usual reel', worse: 'People left sooner than on your usual reel', show: percent },
      { mine: t.skipRatePercent, usual: median(others.flatMap((r) => r.totals.metrics.skipRatePercent ?? [])), higherIsBetter: false,
        better: 'Fewer people swiped away in the first 3 seconds', worse: 'More people swiped away in the first 3 seconds', show: (v) => `${Math.round(v)}%` },
      { mine: sharesPerView(reel), usual: median(others.flatMap((r) => sharesPerView(r) ?? [])), higherIsBetter: true,
        better: 'Shared more than your usual reel', worse: 'Shared less than your usual reel', show: (v) => `${(v * 1000).toFixed(1)} per 1,000 views` },
      { mine: t.plays, usual: median(others.flatMap((r) => r.totals.metrics.plays ?? [])), higherIsBetter: true,
        better: 'More views than your usual reel', worse: 'Fewer views than your usual reel', show: compact }
    ]
    for (const row of rows) {
      if (row.mine === null || row.usual === null || row.usual === 0) continue
      const change = (row.mine - row.usual) / row.usual
      if (Math.abs(change) < NOTABLE) continue
      const good = change > 0 === row.higherIsBetter
      return `${good ? row.better : row.worse} (${row.show(row.mine)}, usually ${row.show(row.usual)})`
    }
    return 'About as usual for you'
  }
  if (t.completionEstimate !== null) return `People watched about ${percent(t.completionEstimate)} of it on average`
  if (t.plays !== null) return `${compact(t.plays)} ${t.plays === 1 ? 'view' : 'views'} so far`
  return 'No results from the platform yet'
}

/** The best settled reel, by views: the one the readout leads with. Needs two to be "best". */
export function bestReel(reels: InsightReel[]): InsightReel | null {
  const ranked = reels.filter((r) => settled(r) && (r.totals.metrics.plays ?? 0) > 0)
    .sort((a, b) => (b.totals.metrics.plays ?? 0) - (a.totals.metrics.plays ?? 0))
  return ranked.length >= 2 ? ranked[0] : null
}

const COUNTRY = (() => {
  try { return new Intl.DisplayNames(['en'], { type: 'region' }) } catch { return null }
})()
const countryName = (code: string) => (/^[A-Z]{2}$/.test(code) && COUNTRY?.of(code)) || code
const GENDER: Record<string, string> = { F: 'women', M: 'men', U: 'not given' }
const share = (s: AudienceSlice, all: AudienceSlice[]) => s.value / all.reduce((sum, x) => sum + x.value, 0)
const andList = (items: string[]) => items.length < 3 ? items.join(' and ') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`

/**
 * Who follows the account, in at most four lines: the biggest age band, the gender split, the top places. Shares are of
 * the followers the platform could describe, which is fewer than all of them.
 */
export function audienceLines(a: PlatformAudience): string[] {
  const f = a.followers
  const lines: string[] = []
  const name = PLATFORM_NAMES[a.platform]
  if (f.age.length) lines.push(`Most of your ${name} followers are ${f.age[0].key} (${percent(share(f.age[0], f.age))}).`)
  const known = f.gender.filter((g) => g.key === 'F' || g.key === 'M')
  if (known.length) {
    const top = known[0]
    lines.push(`${percent(share(top, f.gender))} are ${GENDER[top.key]}.`)
  }
  if (f.country.length) lines.push(`Top places: ${andList(f.country.slice(0, 3).map((c) => countryName(c.key)))}.`)
  if (f.city.length && share(f.city[0], f.city) >= 0.25) lines.push(`A big group is in one city: ${f.city[0].key} (${percent(share(f.city[0], f.city))}).`)
  return lines
}

/** "3 days ago", "2 hours ago", "just now": the age of the last read, so old numbers say they're old. */
export function ago(iso: string, now: number): string {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000)
  if (s < 60) return 'just now'
  const units: [number, string][] = [[86_400, 'day'], [3600, 'hour'], [60, 'minute']]
  for (const [size, unit] of units) {
    const n = Math.floor(s / size)
    if (n >= 1) return `${n} ${unit}${n === 1 ? '' : 's'} ago`
  }
  return 'just now'
}
