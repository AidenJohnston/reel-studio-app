// Instagram API v26.0: https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/business-login
// Publishing: https://developers.facebook.com/documentation/instagram-platform/content-publishing
// Insights: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-media/insights/
export interface InstagramSettings {
  instagramEnabled: boolean
  instagramAppId: string | null
  instagramBrokerUrl: string | null
  instagramUploadOrigins: string[]
}

export type InstagramSession =
  | { connected: false }
  /** `picture`: the account's profile picture as a data URL, saved when it connected (absent if that failed). */
  | { connected: true; accountId: string; username: string; expiresAt: number; picture?: string }

/**
 * A trial reel goes to people who don't follow the account first. MANUAL: the person shares it to followers from
 * Instagram; SS_PERFORMANCE: Instagram does when it does well. (Content publishing, "Trial reels".)
 */
export interface InstagramTrial {
  graduation: 'MANUAL' | 'SS_PERFORMANCE'
  /** Posted as Try 1 or Try 2 of Share › Other platforms; both carry the same `group`, so results can compare them. */
  try?: 1 | 2
  group?: string
}

export interface InstagramPublishInput {
  slug: string
  version: number
  caption: string
  cover: { kind: 'frame'; offsetMs: number } | { kind: 'image' }
  trial?: InstagramTrial
  /**
   * Instead of the version's own export: a Try 1 or Try 2 file Share › Other platforms saved in Library › Finished
   * videos (its video and JPEG cover). Needs trial.try. `cover` is then always that file's cover.
   */
  file?: { video: string; cover: string }
}

export interface InstagramPost {
  version: number
  accountId: string
  postId: string
  publishedAt: string
  /** Posted as a trial reel (outcomes.json keeps it, so results can tell a trial's reach from a normal post's). */
  trial?: InstagramTrial
}

export interface InstagramMetrics {
  /** v26.0 calls this views. Kept as plays for the learning loop. */
  plays: number | null
  reach: number | null
  likes: number | null
  comments: number | null
  shares: number | null
  saves: number | null
  /** Values are retained in Meta's native units, milliseconds for watch time. */
  averageWatchTimeMs: number | null
  totalWatchTimeMs: number | null
  /** Meta's estimated percentage of initial views skipped in the first three seconds. */
  skipRatePercent: number | null
}

export interface InstagramOutcome extends InstagramPost {
  platform: 'instagram'
  apiVersion: 'v26.0'
  observedAt: string | null
  metrics: InstagramMetrics | null
}

export interface InstagramApi {
  configure(settings: InstagramSettings): Promise<void>
  session(): Promise<InstagramSession>
  connect(): Promise<InstagramSession>
  cancelConnect(): Promise<void>
  disconnect(): Promise<void>
  publish(input: InstagramPublishInput): Promise<InstagramPost>
  insights(slug: string, version: number, postId: string): Promise<InstagramOutcome>
}
