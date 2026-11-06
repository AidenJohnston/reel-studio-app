// Instagram account insights, demographics: https://developers.facebook.com/docs/instagram-platform/api-reference/instagram-user/insights
// follower_demographics needs metric_type=total_value, a timeframe (since v20 only this_month or this_week) and one
// breakdown per request. Instagram returns nothing for an account under 100 followers, and only its top 45 values.
import type { AudienceSlice } from '../shared/insights'
import { invalidResponse, object } from './instagram-http'

export const AUDIENCE_BREAKDOWNS = ['age', 'gender', 'country', 'city'] as const
export type AudienceBreakdown = (typeof AUDIENCE_BREAKDOWNS)[number]

export function audienceQuery(accountId: string, breakdown: AudienceBreakdown): string {
  return `${accountId}/insights?${new URLSearchParams({ metric: 'follower_demographics', period: 'lifetime', metric_type: 'total_value', timeframe: 'this_month', breakdown })}`
}

/** One breakdown's counts, biggest first. An empty answer (too few followers, or no data yet) is an empty list. */
export function parseAudience(data: unknown): AudienceSlice[] {
  const rows = object(data).data
  if (!Array.isArray(rows)) return invalidResponse()
  if (!rows.length) return []
  const total = object(object(rows[0]).total_value)
  const breakdowns = total.breakdowns
  if (breakdowns === undefined) return []
  if (!Array.isArray(breakdowns) || breakdowns.length > 1) return invalidResponse()
  if (!breakdowns.length) return []
  const results = object(breakdowns[0]).results
  if (!Array.isArray(results)) return invalidResponse()
  const slices = results.map((r: unknown) => {
    const row = object(r)
    const dims = row.dimension_values
    const value = row.value
    // the breakdown's own value is the last dimension (a timeframe can come first)
    if (!Array.isArray(dims) || !dims.length || typeof dims[dims.length - 1] !== 'string' || typeof value !== 'number' || !Number.isFinite(value) || value < 0)
      return invalidResponse()
    return { key: dims[dims.length - 1] as string, value }
  })
  return slices.sort((a, b) => b.value - a.value || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}
