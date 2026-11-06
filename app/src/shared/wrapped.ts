// "Your recent reels": one thing that's working, one moment in your own video, and one edit to try, from the
// results saved for your posted reels (main/insights.ts) and the timing of each posted version's own render.
// Deterministic rules, no model: the same reels always give the same report. Ported from the Creator Wrapped web
// prototype's analysis.js, with the app's own data in place of numbers typed into a form.
//
// It compares the creator's reels with each other only, never with other creators, and gives no score: three reels
// can point at something to try, not prove a cause.
import type { RenderSegment } from './moments'

/**
 * The prototype's pilot thresholds, unchanged. They are product guesses for a three-reel comparison; no creator data
 * has checked them.
 */
export const WRAPPED_RULES = {
  /** A reel stands out at 1.5 times the median of the others. */
  standsOutRatio: 1.5,
  /** Below this many plays, per-1,000 rates swing on a handful of taps. */
  minPlays: 100,
  /** "People pass it on" needs more than a couple of shares (the same bar for saves). */
  minShares: 5,
  /** Seconds before the first word. */
  lateStart: 1.0,
  /** Seconds on one framing before the first cut. */
  longFirstShot: 3.5,
  /** Seconds the reel runs after the last word. */
  longEnding: 1.5,
  /** Reels compared. */
  reels: 3
}

export interface WrappedTiming {
  /** The render's length, seconds. */
  duration: number
  /** When the first word starts and the last one ends, on the render's clock. null when nothing is said. */
  firstWord: number | null
  lastWord: number | null
  /** Where the picture first cuts to another span, or null with a single span. */
  firstCut: number | null
}

export interface WrappedReel {
  project: string
  version: number
  title: string
  publishedAt: string
  plays: number | null
  averageWatchTimeMs: number | null
  shares: number | null
  saves: number | null
  /** null when that version's render is gone. */
  timing: WrappedTiming | null
  /** The reel's newest version when it is newer than the posted one: a note changes that one, not the posted. */
  latest?: { version: number; timing: WrappedTiming | null }
}

export interface WrappedStrength {
  kind: 'shares' | 'saves' | 'watch' | 'held-longest' | 'none'
  project: string
  version: number
  headline: string
  detail: string
}

export interface WrappedEdit {
  kind: 'late-start' | 'long-first-shot' | 'long-ending'
  project: string
  /** The posted version the observation is about. */
  version: number
  /** The version a note would change (the reel's newest), when it isn't the posted one. */
  changes: number | null
  /** That newer version no longer has this problem: there's nothing to try, and the report says which fixed it. */
  fixedIn: number | null
  headline: string
  detail: string
  /** Where on that version the moment is, for the player. */
  at: number
  /** The button's words. */
  editName: string
  /** The note "Try this edit" puts in that reel's note box. It isn't sent until the creator sends it. */
  note: string
  /** How to tell whether it helped, after posting the new version. */
  measure: string
}

export type WrappedReport =
  | { state: 'too-few'; posted: number }
  | { state: 'ready'; reels: WrappedReel[]; strength: WrappedStrength; edit: WrappedEdit | null; notes: string[] }

/** The render's own timing: first and last word, and the first cut (two spans in a row are a cut). */
export function timingOf(t: { duration: number; words: { s: number; e: number }[]; segments: RenderSegment[] }): WrappedTiming {
  const words = [...t.words].sort((a, b) => a.s - b.s)
  const cut = t.segments.length > 1 ? [...t.segments].sort((a, b) => a.out_start - b.out_start)[1].out_start : null
  return {
    duration: t.duration,
    firstWord: words.length ? words[0].s : null,
    lastWord: words.length ? Math.max(...words.map((w) => w.e)) : null,
    firstCut: cut
  }
}

const sec = (s: number): string => `${(Math.round(s * 10) / 10).toFixed(1).replace(/\.0$/, '')} s`
const pct = (x: number): string => `${Math.round(x * 100)}%`
const int = (n: number): string => Math.round(n).toLocaleString('en-US')
const rate = (n: number): string => (n >= 10 ? int(n) : (Math.round(n * 10) / 10).toString())
const times = (r: number): string => (r >= 2 ? `about ${Math.round(r)} times` : `about ${(Math.round(r * 10) / 10).toFixed(1)} times`)
const quote = (t: string): string => `“${t}”`
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** The share of the reel watched on average: watch time over this version's length, or null without both. */
const watchShare = (r: WrappedReel): number | null =>
  r.averageWatchTimeMs !== null && r.timing && r.timing.duration > 0 ? r.averageWatchTimeMs / 1000 / r.timing.duration : null
const per1k = (n: number | null, plays: number | null): number | null => (n === null || !plays ? null : (n / plays) * 1000)

interface Metric {
  kind: 'shares' | 'saves' | 'watch'
  value: (r: WrappedReel) => number | null
  enough: (r: WrappedReel) => boolean
  headline: (r: WrappedReel) => string
  detail: (r: WrappedReel, others: WrappedReel[], ratio: number) => string
}

// In this order: a share is the strongest thing a viewer does, a save next, then watching.
const METRICS: Metric[] = [
  {
    kind: 'shares',
    value: (r) => per1k(r.shares, r.plays),
    enough: (r) => (r.plays ?? 0) >= WRAPPED_RULES.minPlays && (r.shares ?? 0) >= WRAPPED_RULES.minShares,
    headline: (r) => `People pass on ${quote(r.title)}.`,
    detail: (r, others, ratio) =>
      `${int(r.shares!)} shares from ${int(r.plays!)} plays: ${rate(per1k(r.shares, r.plays)!)} per 1,000, ` +
      (ratio === Infinity ? 'and the only one of these reels people shared.' : `${times(ratio)} your others (${others.map((o) => rate(per1k(o.shares, o.plays)!)).join(' and ')}).`)
  },
  {
    kind: 'saves',
    value: (r) => per1k(r.saves, r.plays),
    enough: (r) => (r.plays ?? 0) >= WRAPPED_RULES.minPlays && (r.saves ?? 0) >= WRAPPED_RULES.minShares,
    headline: (r) => `People save ${quote(r.title)} for later.`,
    detail: (r, others, ratio) =>
      `${int(r.saves!)} saves from ${int(r.plays!)} plays: ${rate(per1k(r.saves, r.plays)!)} per 1,000, ` +
      (ratio === Infinity ? 'and the only one of these reels people saved.' : `${times(ratio)} your others (${others.map((o) => rate(per1k(o.saves, o.plays)!)).join(' and ')}).`)
  },
  {
    kind: 'watch',
    value: watchShare,
    enough: (r) => (r.plays ?? 0) >= WRAPPED_RULES.minPlays,
    headline: (r) => `${quote(r.title)} holds attention best.`,
    detail: (r, others, ratio) => `On average people watched ${pct(watchShare(r)!)} of it, ${times(ratio)} your others (${others.map((o) => pct(watchShare(o)!)).join(' and ')}).`
  }
]

function strength(reels: WrappedReel[]): WrappedStrength {
  for (const m of METRICS) {
    const values = reels.map(m.value)
    if (values.some((v) => v === null)) continue
    const best = reels.reduce((a, b) => (m.value(b)! > m.value(a)! ? b : a))
    const others = reels.filter((r) => r !== best)
    const base = median(others.map((r) => m.value(r)!))
    const ratio = base === 0 ? Infinity : m.value(best)! / base
    if (ratio >= WRAPPED_RULES.standsOutRatio && m.enough(best)) {
      return { kind: m.kind, project: best.project, version: best.version, headline: m.headline(best), detail: m.detail(best, others, ratio) }
    }
  }
  // Nothing stands apart: say which held people longest, without claiming it's different. With no watch time saved
  // for any of them, there is nothing to say that about either.
  if (reels.every((r) => r.averageWatchTimeMs === null)) {
    return { kind: 'none', project: reels[0].project, version: reels[0].version, headline: 'None of these reels stands apart yet.', detail: "The saved results have no watch time to compare them by." }
  }
  const held = heldBy(reels)
  const best = reels.reduce((a, b) => (held(b) > held(a) ? b : a))
  const others = reels.filter((r) => r !== best)
  const share = watchShare(best)
  return {
    kind: 'held-longest',
    project: best.project,
    version: best.version,
    headline: `${quote(best.title)} held viewers longest.`,
    detail:
      share !== null && others.every((o) => watchShare(o) !== null)
        ? `On average people watched ${pct(share)} of it. Your others: ${others.map((o) => pct(watchShare(o)!)).join(' and ')}. None stands far apart yet.`
        : `None of these reels stands far apart yet.`
  }
}

interface Check {
  kind: WrappedEdit['kind']
  applies: (t: WrappedTiming) => boolean
  edit: (r: WrappedReel, t: WrappedTiming) => Omit<WrappedEdit, 'kind' | 'project' | 'version' | 'measure'> & { shorter: boolean }
}

// Checked in this order on each reel, starting with the one people watched least of.
const CHECKS: Check[] = [
  {
    kind: 'late-start',
    applies: (t) => t.firstWord !== null && t.firstWord >= WRAPPED_RULES.lateStart,
    edit: (r, t) => ({
      headline: `You start talking ${sec(t.firstWord!)} in.`,
      detail: `For the first ${sec(t.firstWord!)} of ${quote(r.title)} nothing is said.`,
      at: 0,
      editName: `Trim the first ${sec(t.firstWord!)}`,
      note: `Cut the opening so my first word comes right at the start. Right now the first ${sec(t.firstWord!)} has nothing said.`,
      shorter: true
    })
  },
  {
    kind: 'long-first-shot',
    applies: (t) => t.firstCut !== null && t.firstCut >= WRAPPED_RULES.longFirstShot,
    edit: (r, t) => {
      const at = Math.round((t.firstCut! / 2) * 10) / 10
      return {
        headline: `Your first shot runs ${sec(t.firstCut!)}.`,
        detail: `${quote(r.title)} stays on one shot for its first ${sec(t.firstCut!)}.`,
        at,
        editName: `Punch in closer at ${sec(at)}`,
        note: `Punch in closer at ${sec(at)} so the picture changes inside the first 3 seconds. Keep everything else as it is.`,
        shorter: false
      }
    }
  },
  {
    kind: 'long-ending',
    applies: (t) => t.lastWord !== null && t.duration - t.lastWord >= WRAPPED_RULES.longEnding,
    edit: (r, t) => {
      const tail = t.duration - t.lastWord!
      return {
        headline: `It keeps going ${sec(tail)} after your last word.`,
        detail: `Your last word in ${quote(r.title)} ends at ${sec(t.lastWord!)}, and the reel runs to ${sec(t.duration)}.`,
        at: t.lastWord!,
        editName: 'End on your last word',
        note: `End the reel on my last word: cut the ${sec(tail)} after it.`,
        shorter: true
      }
    }
  }
]

/**
 * How well a reel held people, comparable across these reels: the share watched when every reel has one, otherwise
 * seconds watched (a share and a number of seconds can't be compared). No watch time sorts last.
 */
function heldBy(reels: WrappedReel[]): (r: WrappedReel) => number {
  const shares = reels.every((r) => watchShare(r) !== null)
  return (r) => (shares ? watchShare(r)! : r.averageWatchTimeMs === null ? -1 : r.averageWatchTimeMs / 1000)
}

function edit(reels: WrappedReel[]): WrappedEdit | null {
  const held = heldBy(reels)
  const watched = (r: WrappedReel): number => (held(r) < 0 ? Infinity : held(r))
  for (const r of [...reels].sort((a, b) => watched(a) - watched(b))) {
    if (!r.timing) continue
    const t = r.timing
    const check = CHECKS.find((c) => c.applies(t))
    if (!check) continue
    const { shorter, ...e } = check.edit(r, t)
    const share = watchShare(r)
    // A note changes the reel's newest version. When that's newer than the posted one, the edit is checked again on
    // it, and its words come from its own timing.
    const later = r.latest && r.latest.version !== r.version ? r.latest : null
    const now = later?.timing && check.applies(later.timing) ? check.edit(r, later.timing) : null
    return {
      kind: check.kind,
      project: r.project,
      version: r.version,
      changes: later ? later.version : null,
      fixedIn: later && !now ? later.version : null,
      ...e,
      // the whole edit from the version it would change, so its words and the note agree
      ...(now ? { headline: now.headline, detail: now.detail, at: now.at, editName: now.editName, note: now.note } : {}),
      measure:
        share !== null
          ? `After 2 days, compare the share of the new version people watch with this one's ${pct(share)}.${shorter ? ' Compare the share, not the seconds: the new version is shorter.' : ''}`
          : 'After 2 days, compare how long people watch the new version with this one.'
    }
  }
  return null
}

/**
 * The report from posted reels, newest first by publication. Fewer than WRAPPED_RULES.reels with plays is too few to
 * compare, and the report says so instead of guessing.
 */
export function wrappedReport(all: WrappedReel[], now: number): WrappedReport {
  const usable = all.filter((r) => r.plays !== null).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
  if (usable.length < WRAPPED_RULES.reels) return { state: 'too-few', posted: usable.length }
  const reels = usable.slice(0, WRAPPED_RULES.reels)
  const notes: string[] = []
  for (const r of reels) {
    if (r.timing && r.averageWatchTimeMs !== null && r.averageWatchTimeMs / 1000 > r.timing.duration)
      notes.push(`Average watch time for ${quote(r.title)} is longer than the reel, so it counts replays.`)
    if (now - Date.parse(r.publishedAt) < 2 * 86_400_000) notes.push(`${quote(r.title)} was posted less than 2 days ago; its numbers may still be counting.`)
  }
  return { state: 'ready', reels, strength: strength(reels), edit: edit(reels), notes }
}
