import { expect, it } from 'vitest'
import { parseFacebookReel, readFacebookReel } from '../src/main/facebook-insights'
import { parseAudience } from '../src/main/instagram-audience'
import { errorKind } from '../src/main/results-refresh'

// The shape Graph API v26.0 returns for /{video-id}/video_insights (InsightsResult nodes, lifetime, one value each).
const REEL = {
  data: [
    { name: 'fb_reels_total_plays', period: 'lifetime', values: [{ value: 5210 }], id: '1/video_insights/fb_reels_total_plays/lifetime' },
    { name: 'post_impressions_unique', period: 'lifetime', values: [{ value: 4020 }] },
    { name: 'post_video_avg_time_watched', period: 'lifetime', values: [{ value: 9100 }] },
    { name: 'post_video_view_time', period: 'lifetime', values: [{ value: 47_411_000 }] },
    { name: 'post_video_social_actions', period: 'lifetime', values: [{ value: { COMMENT: 31, SHARE: 12 } }] },
    { name: 'post_video_likes_by_reaction_type', period: 'lifetime', values: [{ value: { REACTION_LIKE: 200, REACTION_LOVE: 40 } }] }
  ],
  paging: {}
}

// fails if a Facebook metric lands in the wrong field, or reactions and social actions aren't added up as the person counts them
it('reads a reel’s numbers into the app’s fields', () => {
  expect(parseFacebookReel(REEL)).toEqual({
    plays: 5210, reach: 4020, likes: 240, comments: 31, shares: 12, saves: null,
    averageWatchTimeMs: 9100, totalWatchTimeMs: 47_411_000, skipRatePercent: null
  })
})

// fails if a metric Facebook leaves out reads as zero, or a breakdown with one type missing reads as unknown
it('keeps missing numbers unknown', () => {
  const sparse = { data: [
    { name: 'fb_reels_total_plays', values: [] },
    { name: 'post_video_social_actions', values: [{ value: { SHARE: 3 } }] },
    { name: 'post_video_likes_by_reaction_type', values: [{ value: 7 }] }
  ] }
  expect(parseFacebookReel(sparse)).toMatchObject({ plays: null, reach: null, comments: 0, shares: 3, likes: 7 })
  expect(parseFacebookReel({ data: [{ name: 'post_video_social_actions', values: [{ value: 43 }] }] })).toMatchObject({ comments: null, shares: null })
})

it('refuses answers it cannot read', () => {
  for (const bad of [null, {}, { data: [{ name: 'fb_reels_total_plays', values: [{ value: -1 }] }] },
    { data: [{ name: 'fb_reels_total_plays', values: [{ value: 1 }, { value: 2 }] }] },
    { data: [{ name: 'x', values: [] }, { name: 'x', values: [] }] }])
    expect(() => parseFacebookReel(bad)).toThrow(expect.objectContaining({ code: 'FB_RESPONSE' }))
})

// fails if the request goes elsewhere, leaks the token into the URL, or a rate limit isn't recognised as one
it('asks the Graph API with the Page token and maps its errors', async () => {
  const calls: { url: string; auth: string | null }[] = []
  const answer = (status: number, body: unknown) => async (url: string, init: RequestInit) => {
    calls.push({ url, auth: new Headers(init.headers).get('authorization') })
    return new Response(JSON.stringify(body), { status })
  }
  const signal = new AbortController().signal
  expect((await readFacebookReel(answer(200, REEL), 'page-token', '1789', signal)).plays).toBe(5210)
  const url = new URL(calls[0].url)
  expect(url.origin + url.pathname).toBe('https://graph.facebook.com/v26.0/1789/video_insights')
  expect(url.searchParams.get('period')).toBe('lifetime')
  expect(url.searchParams.get('metric')?.split(',')).toContain('fb_reels_total_plays')
  expect(calls[0].url).not.toContain('page-token')
  expect(calls[0].auth).toBe('Bearer page-token')
  await expect(readFacebookReel(answer(400, { error: { code: 4 } }), 't', '1', signal)).rejects.toMatchObject({ code: 'FB_RATE_LIMIT' })
  await expect(readFacebookReel(answer(400, { error: { code: 190 } }), 't', '1', signal)).rejects.toMatchObject({ code: 'FB_TOKEN' })
  await expect(readFacebookReel(answer(403, { error: { code: 10 } }), 't', '1', signal)).rejects.toMatchObject({ code: 'FB_PERMISSION' })
  await expect(readFacebookReel(async () => { throw new TypeError('offline') }, 't', '1', signal)).rejects.toMatchObject({ code: 'FB_NETWORK' })
  await expect(readFacebookReel(answer(200, REEL), 't', '../me', signal)).rejects.toMatchObject({ code: 'FB_RESPONSE' })
})

// fails if one deleted or hidden reel stops the results refresh from reading the Page's other reels
it('treats a reel Facebook no longer has as that post’s problem only', async () => {
  const signal = new AbortController().signal
  const answer = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status })
  for (const gone of [answer(400, { error: { code: 100, error_subcode: 33 } }), answer(404, { error: { code: 803 } })]) {
    const e = await readFacebookReel(gone, 't', '1', signal).catch((x: unknown) => x)
    expect(e).toMatchObject({ code: 'FB_POST' })
    expect(errorKind(e)).toBe('post')
  }
  // a malformed request is wrong for every reel, so it still stops the run
  expect(errorKind(await readFacebookReel(answer(400, { error: { code: 100 } }), 't', '1', signal).catch((x: unknown) => x))).toBe('stop')
})

// The shape follower_demographics returns with metric_type=total_value and one breakdown.
// fails if a breakdown is read from the wrong dimension, or an account under 100 followers breaks the readout
it('reads Instagram follower breakdowns, biggest first', () => {
  const country = { data: [{ name: 'follower_demographics', period: 'lifetime', total_value: { breakdowns: [{
    dimension_keys: ['country'], results: [{ dimension_values: ['GB'], value: 20 }, { dimension_values: ['US'], value: 75 }] }] } }] }
  expect(parseAudience(country)).toEqual([{ key: 'US', value: 75 }, { key: 'GB', value: 20 }])
  const timed = { data: [{ total_value: { breakdowns: [{ dimension_keys: ['timeframe', 'age'], results: [{ dimension_values: ['THIS_MONTH', '25-34'], value: 9 }] }] } }] }
  expect(parseAudience(timed)).toEqual([{ key: '25-34', value: 9 }])
  expect(parseAudience({ data: [] })).toEqual([])
  expect(() => parseAudience({ data: [{ total_value: { breakdowns: [{ results: [{ dimension_values: [], value: 1 }] }] } }] })).toThrow()
})
