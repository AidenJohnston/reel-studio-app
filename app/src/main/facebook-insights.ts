// Facebook Reels insights: https://developers.facebook.com/docs/graph-api/reference/video/video_insights#reels-metrics
// Every Reels metric is lifetime only. It needs a Page access token from someone who can do ANALYZE on the Page,
// with read_insights and pages_manage_engagement. The Page connection belongs to publishing (posting lane); this file
// only reads one reel's numbers with the token it is handed.
import type { InstagramMetrics } from '../shared/instagram'

export const FACEBOOK_GRAPH_VERSION = 'v26.0'
const GRAPH = `https://graph.facebook.com/${FACEBOOK_GRAPH_VERSION}`

/** Plays count replays, as Instagram's views do; average watch time is per play and can pass the reel's length. */
export const FACEBOOK_REEL_METRICS = [
  'fb_reels_total_plays', 'post_impressions_unique', 'post_video_avg_time_watched', 'post_video_view_time',
  'post_video_social_actions', 'post_video_likes_by_reaction_type'
] as const

export class FacebookError extends Error {
  constructor(readonly code: 'FB_NETWORK' | 'FB_RATE_LIMIT' | 'FB_TOKEN' | 'FB_PERMISSION' | 'FB_POST' | 'FB_RESPONSE' | 'FB_API', readonly userMessage: string) {
    super(userMessage)
  }
}
const incomplete = (): never => { throw new FacebookError('FB_RESPONSE', 'Facebook returned incomplete data. Try again later.') }
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : incomplete()
const amount = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : incomplete()

export type FacebookFetch = (url: string, init: RequestInit) => Promise<Response>

/** Reads one reel's lifetime numbers. `videoId` is the id publishing got back for the reel. */
export async function readFacebookReel(fetcher: FacebookFetch, pageAccessToken: string, videoId: string, signal: AbortSignal): Promise<InstagramMetrics> {
  if (!/^\d+$/.test(videoId)) throw new FacebookError('FB_RESPONSE', 'This Facebook reel has no valid id.')
  const url = `${GRAPH}/${videoId}/video_insights?${new URLSearchParams({ metric: FACEBOOK_REEL_METRICS.join(','), period: 'lifetime' })}`
  signal.throwIfAborted()
  let response: Response
  try {
    response = await fetcher(url, { method: 'GET', headers: { authorization: `Bearer ${pageAccessToken}` }, redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]) })
  } catch {
    signal.throwIfAborted()
    throw new FacebookError('FB_NETWORK', 'Facebook could not be reached. Check your connection and try again.')
  }
  let data: unknown
  try { data = await response.json() } catch { data = null }
  if (!response.ok || (data && typeof data === 'object' && 'error' in data)) throw facebookError(response.status, data)
  return parseFacebookReel(data)
}

// Graph API error codes: https://developers.facebook.com/docs/graph-api/guides/error-handling
function facebookError(status: number, data: unknown): FacebookError {
  const error = data && typeof data === 'object' && 'error' in data && data.error && typeof data.error === 'object' ? (data.error as Record<string, unknown>) : {}
  const code = error.code
  if (status === 429 || code === 4 || code === 17 || code === 32 || code === 613 || code === 80001)
    return new FacebookError('FB_RATE_LIMIT', 'Facebook has reached a request limit. Wait a while before trying again.')
  if (status === 401 || code === 190) return new FacebookError('FB_TOKEN', 'Your Facebook connection has expired. Connect Facebook again in Settings.')
  // A deleted or hidden reel (404, or code 100 with subcode 33, "object does not exist"): this post only, so the
  // results refresh carries on with the others. Other code 100 answers mean the request itself is wrong and stay FB_API.
  if (status === 404 || (code === 100 && error.error_subcode === 33))
    return new FacebookError('FB_POST', 'This reel is no longer on Facebook, or this Page can’t see it.')
  if (status === 403 || code === 10 || code === 200 || code === 283)
    return new FacebookError('FB_PERMISSION', 'Facebook did not allow reading this reel’s results. Connect Facebook again and allow insights.')
  return new FacebookError('FB_API', 'Facebook could not finish this request. Try again later.')
}

/** The response's numbers as the app keeps them. A metric Facebook leaves out is unknown (null), not zero. */
export function parseFacebookReel(data: unknown): InstagramMetrics {
  const rows = record(data).data
  if (!Array.isArray(rows)) return incomplete()
  const values = new Map<string, unknown>()
  for (const row of rows) {
    const r = record(row)
    const name = r.name
    if (typeof name !== 'string' || values.has(name)) return incomplete()
    const list = r.values
    if (!Array.isArray(list) || list.length > 1) return incomplete()
    values.set(name, list.length ? record(list[0]).value : null)
  }
  const num = (name: string): number | null => {
    const v = values.get(name)
    return v === undefined || v === null ? null : amount(v)
  }
  // Reactions arrive as { REACTION_LIKE: n, REACTION_LOVE: n, ... }; all of them are likes to the person.
  const reactions = values.get('post_video_likes_by_reaction_type')
  const likes = reactions === undefined || reactions === null ? null
    : typeof reactions === 'number' ? amount(reactions) : Object.values(record(reactions)).reduce((sum: number, n) => sum + amount(n), 0)
  // Social actions arrive split by type ({ COMMENT, SHARE }) or, on some Pages, as one number that can't be split.
  const social = values.get('post_video_social_actions')
  const split = social && typeof social === 'object' ? record(social) : null
  // A breakdown leaves out a type nobody did, so a missing key is zero.
  const part = (key: string) => split ? (split[key] === undefined ? 0 : amount(split[key])) : null
  return {
    plays: num('fb_reels_total_plays'), reach: num('post_impressions_unique'), likes,
    comments: part('COMMENT'), shares: part('SHARE'), saves: null,
    averageWatchTimeMs: num('post_video_avg_time_watched'), totalWatchTimeMs: num('post_video_view_time'), skipRatePercent: null
  }
}
