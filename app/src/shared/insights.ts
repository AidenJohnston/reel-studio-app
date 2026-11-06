export type InsightPlatform = 'instagram' | 'tiktok' | 'facebook' | 'threads'
export type InsightMetric = 'plays' | 'reach' | 'averageWatchTimeMs' | 'completionEstimate' | 'shares' | 'saves' | 'comments'
export type InsightValues = Record<InsightMetric, number | null>

export interface InsightsOptions {
  /** Include posts published at or after this ISO date. */
  since?: string
  /** Without this, use the latest saved observation/publication for repeatable reads. */
  asOf?: string
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

export interface InsightTrial {
  project: string
  index: number
  parentVersion: number
  variable: 'seed' | 'hook' | 'cover' | 'caption' | 'brightness'
  from: unknown
  to: unknown
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
  sentences: InsightSentence[]
}
