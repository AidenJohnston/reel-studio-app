export type InsightPlatform = 'instagram' | 'tiktok' | 'facebook'
export type InsightMetric = 'plays' | 'reach' | 'averageWatchTimeMs' | 'completionEstimate' | 'skipRatePercent' | 'shares' | 'saves' | 'comments' | 'likes'
export type InsightValues = Record<InsightMetric, number | null>

export interface InsightsOptions {
  /** Include posts published at or after this ISO date. */
  since?: string
  /** Without this, use the latest saved observation/publication for repeatable reads. */
  asOf?: string
}

/** What a trial's second try changed (shared/platforms.ts TryVariable), or 'video' for another version. */
export type TrialChange = 'video' | 'hook' | 'caption' | 'cover' | 'brightness'

/** Set by publish on both tries of a trial post (outcomes.json `trial`); the same id ties them together. */
export interface PostTrial {
  id: string
  try: 1 | 2
  change: TrialChange
}

export interface InsightPostRef {
  project: string
  version: number
  platform: InsightPlatform
  accountId: string
  postId: string
}

export interface InsightPost extends InsightPostRef {
  publishedAt: string
  observedAt: string | null
  status: 'still counting' | 'available' | 'unavailable'
  durationMs: number | null
  metrics: InsightValues
  trial: PostTrial | null
}

export interface InsightTotals {
  posts: number
  stillCounting: number
  metrics: InsightValues
  /** Number of posts with a known value, including zero. */
  coverage: Record<InsightMetric, number>
}

export interface InsightReel {
  project: string
  version: number
  /** The reel's name and that version's cover, filled in by the main process for the screen; null in plain reads. */
  title: string | null
  cover: string | null
  posts: InsightPost[]
  totals: InsightTotals
}

export interface InsightChange {
  metric: InsightMetric
  current: number | null
  previous: number | null
  changePercent: number | null
}

export interface InsightSentence {
  template: 'no-data' | 'no-stats' | 'still-counting' | 'best-reel' | 'most-improved' | 'shorter-held' | 'weekday-reach'
  text: string
  evidence: {
    posts: InsightPostRef[]
    metric: InsightMetric | null
    current: number | null
    baseline: number | null
    changePercent: number | null
    minimumAgeHours?: number
    groups: { label: string; posts: InsightPostRef[]; value: number }[]
  }
}

/** One row of the engine's trial log (engine/reelengine/variation.py, project trials.json). */
export interface InsightTrial {
  project: string
  index: number
  parentVersion: number
  variable: 'seed' | 'hook' | 'cover' | 'caption' | 'brightness'
  from: unknown
  to: unknown
}

/** A trial's verdict (main/trial-decision.ts). */
export type TrialVerdict =
  | { kind: 'waiting'; reason: string }
  | { kind: 'too-few'; reason: string }
  | { kind: 'too-close'; reason: string }
  /** liftPercent: how far ahead the winner is; null when the other try had no views. */
  | { kind: 'winner'; winner: 1 | 2; reason: string; liftPercent: number | null; pValue: number }

export interface InsightTrialResult {
  id: string
  project: string
  platform: InsightPlatform
  change: TrialChange
  /** Try 1, then Try 2. */
  tries: [InsightPost, InsightPost]
  verdict: TrialVerdict
  /** The engine's log row for this trial when Try 2 is a version the engine varied from Try 1's. */
  engine: InsightTrial | null
}

/** One audience breakdown, biggest share first. `key` is the platform's own value: an age band, a gender letter, a country code or a city. */
export interface AudienceSlice { key: string; value: number }
export interface PlatformAudience {
  platform: InsightPlatform
  accountId: string
  observedAt: string
  /** Who follows the account, as the platform reports it (Instagram: only with 100 or more followers). */
  followers: { age: AudienceSlice[]; gender: AudienceSlice[]; country: AudienceSlice[]; city: AudienceSlice[] }
}

export interface InsightsSummary {
  since: string
  asOf: string
  /** Reach is summed across posts; audiences may overlap. Weeks use publication time in UTC. */
  basis: 'saved lifetime metrics by publication date'
  /** Watch time divided by rendered duration, capped at one; not a measured completion rate. */
  completionEstimateMethod: 'average watched fraction'
  reels: InsightReel[]
  platforms: { platform: InsightPlatform; totals: InsightTotals }[]
  totals: InsightTotals
  trends: {
    thisWeek: { since: string; until: string; totals: InsightTotals }
    lastWeek: { since: string; until: string; totals: InsightTotals }
    changes: InsightChange[]
    bestReel: InsightReel | null
    mostImproved: InsightChange | null
  }
  trials: InsightTrial[]
  trialResults: InsightTrialResult[]
  audience: PlatformAudience[]
  sentences: InsightSentence[]
}

/** Why a platform's results aren't fresh, in the refresh's words (main/results-refresh.ts). */
export type ResultsPlatformState =
  | { state: 'not-connected' }
  /** connected, and nothing read since */
  | { state: 'ready' }
  | { state: 'ok'; checkedAt: string }
  | { state: 'reconnect'; message: string }
  | { state: 'waiting'; until: string; message: string }
  | { state: 'failed'; message: string }

export interface ResultsStatus {
  /** The last time a refresh finished, or null before the first. */
  checkedAt: string | null
  running: boolean
  platforms: Record<InsightPlatform, ResultsPlatformState>
}
