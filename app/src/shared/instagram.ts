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

export interface InstagramPublishInput {
  slug: string
  version: number
  caption: string
  cover: { kind: 'frame'; offsetMs: number } | { kind: 'image' }
}

export interface InstagramPost {
  version: number
  accountId: string
  postId: string
  publishedAt: string
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
