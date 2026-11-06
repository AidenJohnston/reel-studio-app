import { afterEach, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { insightsSummary } from '../src/main/insights'
import { registerInsightsIpc } from '../src/main/insights-ipc'
import type { InstagramMetrics } from '../src/shared/instagram'
import type { InsightPlatform, InsightsSummary, PostTrial } from '../src/shared/insights'
import { ResultsRefresh } from '../src/main/results-refresh'

const NOW = '2026-10-23T12:00:00.000Z'
const TUESDAY = '2026-10-20T08:00:00.000Z'
const WEDNESDAY = '2026-10-21T08:00:00.000Z'
const LAST_WEEK = '2026-10-13T08:00:00.000Z'
const roots: string[] = []
afterEach(async () => {
  for (const dir of roots.splice(0)) await fs.rm(dir, { recursive: true, force: true })
})
async function world() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'insights-fixture-'))
  roots.push(dir)
  return dir
}
function post(options: { version?: number; postId?: string; platform?: InsightPlatform; publishedAt?: string;
  observedAt?: string | null; metrics?: Partial<InstagramMetrics> | null; accountId?: string; trial?: PostTrial } = {}) {
  const platform = options.platform ?? 'instagram'
  return {
    version: options.version ?? 1, postId: options.postId ?? '100', platform, accountId: options.accountId ?? '123',
    ...(options.trial ? { trial: options.trial } : {}),
    apiVersion: platform === 'tiktok' ? 'v2' : 'v26.0', publishedAt: options.publishedAt ?? TUESDAY,
    observedAt: options.observedAt === undefined ? NOW : options.observedAt,
    metrics: options.metrics === null ? null : {
      plays: 100, reach: 100, averageWatchTimeMs: 10_000, totalWatchTimeMs: null, skipRatePercent: null,
      likes: 0, shares: 1, saves: 1, comments: 1, ...options.metrics
    }
  }
}
async function seed(root: string, project: string, posts: ReturnType<typeof post>[], duration = 20) {
  const dir = join(root, project)
  await fs.mkdir(dir, { recursive: true })
  const versions: Record<string, Record<string, ReturnType<typeof post>>> = {}
  for (const p of posts) {
    const key = `v${p.version}`
    versions[key] ??= {}
    versions[key][p.platform === 'instagram' ? p.postId : `${p.platform}:${p.postId}`] = p
    const vdir = join(dir, 'versions', key)
    await fs.mkdir(vdir, { recursive: true })
    await fs.writeFile(join(vdir, 'render.json'), JSON.stringify({ duration, preview: false, draft: false, window: null }))
  }
  await fs.writeFile(join(dir, 'outcomes.json'), JSON.stringify({ schemaVersion: 1, versions }))
}
const summary = (root: string) => insightsSummary(root, { asOf: NOW })
const sentence = (s: InsightsSummary, id: string) => s.sentences.find((line) => line.template === id)

it('no-data template appears only without posts, including a missing Projects folder', async () => {
  const root = await world()
  const empty = await summary(join(root, 'missing'))
  expect(sentence(empty, 'no-data')).toMatchObject({ text: 'No post results yet', evidence: { posts: [], current: 0 } })
  expect(empty.totals).toMatchObject({ posts: 0, metrics: { plays: null } })
  expect(empty.trends.bestReel).toBeNull()
  await seed(root, 'one', [post()])
  expect(sentence(await summary(root), 'no-data')).toBeUndefined()
})

it('no-stats template appears only when saved posts have no reported metrics', async () => {
  const root = await world()
  await seed(root, 'one', [post({ metrics: null, observedAt: null })])
  expect(sentence(await summary(root), 'no-stats')).toMatchObject({ text: 'Post results are not available yet', evidence: { current: 1 } })
  await seed(root, 'one', [post({ metrics: { plays: 0 } })])
  expect(sentence(await summary(root), 'no-stats')).toBeUndefined()
})

it('still-counting template labels young posts and stops at exactly 48 hours', async () => {
  const root = await world()
  await seed(root, 'young', [post({ publishedAt: '2026-10-23T11:00:00.000Z' })])
  const young = await summary(root)
  expect(young.reels[0].posts[0].status).toBe('still counting')
  expect(sentence(young, 'still-counting')).toMatchObject({ text: 'New posts are still counting', evidence: { current: 1, baseline: null, minimumAgeHours: 48 } })
  await seed(root, 'young', [post({ publishedAt: '2026-10-21T12:00:00.000Z' })])
  const mature = await summary(root)
  expect(mature.reels[0].posts[0].status).toBe('available')
  expect(sentence(mature, 'still-counting')).toBeUndefined()
})

it('best-reel template names the highest mature reel only with a comparison', async () => {
  const root = await world()
  await seed(root, 'one', [post()])
  expect(sentence(await summary(root), 'best-reel')).toBeUndefined()
  await seed(root, 'two', [post({ postId: '200', metrics: { plays: 500 } })])
  await seed(root, 'young', [post({ postId: '300', publishedAt: '2026-10-23T11:00:00.000Z', metrics: { plays: 10_000 } })])
  const result = await summary(root)
  expect(result.trends.bestReel).toMatchObject({ project: 'two', version: 1 })
  expect(sentence(result, 'best-reel')).toMatchObject({ text: 'Your best reel has 500 plays', evidence: { metric: 'plays', current: 500, posts: [{ project: 'two', postId: '200' }] } })
})

it('most-improved template requires a 20 percent increase and two mature posts per week', async () => {
  const root = await world()
  for (const [name, date, shares] of [['a', TUESDAY, 3], ['b', TUESDAY, 3], ['c', LAST_WEEK, 1], ['d', LAST_WEEK, 1]] as const) {
    await seed(root, name, [post({ postId: name, publishedAt: date, metrics: { shares, reach: date === TUESDAY ? 120 : 100 } })])
  }
  const result = await summary(root)
  expect(result.trends.mostImproved).toMatchObject({ metric: 'shares', current: 6, previous: 2, changePercent: 200 })
  expect(sentence(result, 'most-improved')).toMatchObject({ text: "Shares improved most across weeks, up 200%", evidence: { current: 6, baseline: 2, changePercent: 200 } })
  await seed(root, 'a', [post({ postId: 'a', metrics: { shares: 1, reach: 100 } })])
  await seed(root, 'b', [post({ postId: 'b', metrics: { shares: 1, reach: 100 } })])
  expect(sentence(await summary(root), 'most-improved')).toBeUndefined()
})

it('shorter-held template compares play-weighted watch time within one platform', async () => {
  const root = await world()
  for (const [name, duration, watch] of [['short-a', 20, 12_000], ['short-b', 25, 12_000], ['long-a', 30, 10_000], ['long-b', 40, 10_000]] as const) {
    await seed(root, name, [post({ postId: name, metrics: { averageWatchTimeMs: watch } })], duration)
  }
  const result = await summary(root)
  expect(sentence(result, 'shorter-held')).toMatchObject({ text: 'On Instagram, reels under 30 seconds held viewers 20% longer', evidence: { metric: 'averageWatchTimeMs', current: 12_000, baseline: 10_000, changePercent: 20 } })
  await seed(root, 'short-a', [post({ postId: 'short-a', metrics: { averageWatchTimeMs: 11_000 } })], 20)
  expect(sentence(await summary(root), 'shorter-held')).toBeUndefined()
  await seed(root, 'short-a', [post({ postId: 'short-a', metrics: { plays: 99, averageWatchTimeMs: 12_000 } })], 20)
  expect(sentence(await summary(root), 'shorter-held')).toBeUndefined()
  await seed(root, 'short-a', [post({ postId: 'short-a', metrics: { averageWatchTimeMs: 12_000 } })], 20)
  for (const name of ['long-a', 'long-b'])
    await seed(root, name, [post({ postId: name, platform: 'tiktok', metrics: { averageWatchTimeMs: 10_000 } })], 40)
  expect(sentence(await summary(root), 'shorter-held')).toBeUndefined()
})

it('weekday-reach template requires repeated days and compares mean reach', async () => {
  const root = await world()
  for (const [name, date, reach] of [['a', TUESDAY, 120], ['b', TUESDAY, 120], ['c', WEDNESDAY, 100], ['d', WEDNESDAY, 100]] as const) {
    await seed(root, name, [post({ postId: name, publishedAt: date, metrics: { reach } })])
  }
  const result = await summary(root)
  expect(sentence(result, 'weekday-reach')).toMatchObject({ text: 'On Instagram, Tuesday posts reached the most people on average', evidence: { current: 120, baseline: 100, changePercent: 20 } })
  expect(sentence(result, 'weekday-reach')?.evidence.groups).toHaveLength(2)
  await seed(root, 'a', [post({ postId: 'a', metrics: { reach: 100 } })])
  await seed(root, 'b', [post({ postId: 'b', metrics: { reach: 100 } })])
  expect(sentence(await summary(root), 'weekday-reach')).toBeUndefined()
})

it('keeps platform-local post IDs separate and reports unavailable TikTok values as null', async () => {
  const root = await world()
  await seed(root, 'both', [post(), post({ platform: 'tiktok', metrics: { plays: 50, reach: null, saves: null, averageWatchTimeMs: null } })])
  const result = await summary(root)
  expect(result.reels[0].posts).toHaveLength(2)
  expect(result.platforms).toMatchObject([
    { platform: 'instagram', totals: { metrics: { plays: 100, reach: 100 } } },
    { platform: 'tiktok', totals: { metrics: { plays: 50, reach: null, saves: null, averageWatchTimeMs: null, completionEstimate: null } } }
  ])
  expect(result.totals).toMatchObject({ metrics: { plays: 150, reach: 100, averageWatchTimeMs: null }, coverage: { reach: 1 } })
})

it('weights watch time and completion estimates by plays, using rendered duration', async () => {
  const root = await world()
  await seed(root, 'a', [post({ postId: 'a', metrics: { plays: 100, averageWatchTimeMs: 10_000 } })], 20)
  await seed(root, 'b', [post({ postId: 'b', metrics: { plays: 300, averageWatchTimeMs: 30_000 } })], 40)
  const result = await summary(root)
  expect(result.platforms).toHaveLength(1)
  expect(result.totals.metrics).toMatchObject({ averageWatchTimeMs: 25_000, completionEstimate: 0.6875 })
  expect(result.completionEstimateMethod).toBe('average watched fraction')
  await fs.rm(join(root, 'a', 'versions', 'v1', 'render.json'))
  expect((await summary(root)).reels[0].posts[0].metrics.completionEstimate).toBeNull()
})

it('uses UTC publication weeks and since boundaries, with no ratio for a zero baseline', async () => {
  const root = await world()
  await seed(root, 'last', [post({ postId: 'last', publishedAt: '2026-10-18T23:59:59.999Z', metrics: { shares: 0 } })])
  await seed(root, 'this', [post({ postId: 'this', publishedAt: '2026-10-19T00:00:00.000Z', metrics: { shares: 2 } })])
  const result = await summary(root)
  expect(result.trends.thisWeek).toMatchObject({ since: '2026-10-19T00:00:00.000Z', totals: { posts: 1, metrics: { shares: 2 } } })
  expect(result.trends.lastWeek.totals.posts).toBe(1)
  expect(result.trends.changes.find((x) => x.metric === 'shares')).toMatchObject({ changePercent: null })
  const filtered = await insightsSummary(root, { since: '2026-10-19T00:00:00.000Z', asOf: NOW })
  expect(filtered.reels.map((x) => x.project)).toEqual(['this'])
  expect(filtered.trends.lastWeek.totals.posts).toBe(0)
})

it('excludes young and early snapshots from conclusions while retaining their metrics', async () => {
  const root = await world()
  await seed(root, 'early', [post({ observedAt: '2026-10-20T09:00:00.000Z', metrics: { plays: 100_000 } })])
  await seed(root, 'young', [post({ postId: '200', publishedAt: '2026-10-23T11:00:00.000Z' })])
  const result = await summary(root)
  expect(result.totals.metrics.plays).toBe(100_100)
  expect(result.totals.stillCounting).toBe(2)
  expect(result.trends.bestReel).toBeNull()
  expect(result.sentences.map((x) => x.template)).toEqual(['still-counting'])
})

it('retains trial evidence without guessing which child post it describes', async () => {
  const root = await world()
  await seed(root, 'trial', [post(), post({ version: 2, postId: '200' })])
  await fs.writeFile(join(root, 'trial', 'trials.json'), JSON.stringify([{ parent_version: 1, variable: 'brightness', from: 1, to: 1.08 }]))
  expect((await summary(root)).trials).toEqual([{ project: 'trial', index: 0, parentVersion: 1, variable: 'brightness', from: 1, to: 1.08 }])
})

it('returns identical bytes for fixed data without a clock, including tied winners', async () => {
  const root = await world()
  await seed(root, 'z-last', [post({ postId: 'z' })])
  await seed(root, 'a-first', [post({ postId: 'a' })])
  const first = await insightsSummary(root, { since: '2026-10-01' })
  expect(first.asOf).toBe(NOW)
  expect(first.trends.bestReel?.project).toBe('a-first')
  expect(JSON.stringify(await insightsSummary(root, { since: '2026-10-01' }))).toBe(JSON.stringify(first))
})

it('keeps every emitted template under 13 words and exposes its numeric evidence', async () => {
  const root = await world()
  for (const [name, date, duration, watch, reach] of [
    ['a', TUESDAY, 20, 12_000, 120], ['b', TUESDAY, 20, 12_000, 120],
    ['c', WEDNESDAY, 40, 10_000, 100], ['d', WEDNESDAY, 40, 10_000, 100],
    ['e', '2026-10-14T08:00:00.000Z', 40, 10_000, 100], ['f', '2026-10-14T08:00:00.000Z', 40, 10_000, 100]
  ] as const) await seed(root, name, [post({ postId: name, publishedAt: date, metrics: { averageWatchTimeMs: watch, reach } })], duration)
  await seed(root, 'young', [post({ postId: 'young', publishedAt: '2026-10-23T11:00:00.000Z' })])
  const populated = await summary(root)
  const empty = await summary(join(root, 'missing'))
  const statsRoot = await world()
  await seed(statsRoot, 'none', [post({ metrics: null, observedAt: null })])
  const unavailable = await summary(statsRoot)
  const results = [populated, empty, unavailable]
  const lines = results.flatMap((result) => result.sentences)
  expect(populated.sentences.map((x) => x.template)).toEqual(['still-counting', 'best-reel', 'most-improved', 'shorter-held', 'weekday-reach'])
  for (const line of lines) {
    expect(line.text.trim().split(/\s+/).length).toBeLessThanOrEqual(12)
    expect(line.text).not.toMatch(/\bI\b|made people|caused/)
    expect(line.evidence.current).not.toBeNull()
    for (const ref of line.evidence.posts) expect(results.flatMap((result) => result.reels.flatMap((x) => x.posts))).toContainEqual(expect.objectContaining(ref))
  }
})

it('rejects corrupt outcomes and trials instead of silently reporting no data', async () => {
  const root = await world()
  await seed(root, 'broken', [post()])
  await fs.writeFile(join(root, 'broken', 'outcomes.json'), '{')
  await expect(summary(root)).rejects.toMatchObject({ code: 'INSIGHTS_DATA' })
  await seed(root, 'broken', [post()])
  await fs.writeFile(join(root, 'broken', 'trials.json'), '{}')
  await expect(summary(root)).rejects.toMatchObject({ code: 'INSIGHTS_DATA' })
})

it('rejects malformed metric values and duplicate post identities', async () => {
  const root = await world()
  await seed(root, 'broken', [post({ metrics: { plays: -1 } })])
  await expect(summary(root)).rejects.toMatchObject({ code: 'INSIGHTS_DATA' })
  await seed(root, 'broken', [post()])
  await seed(root, 'duplicate', [post()])
  await expect(summary(root)).rejects.toMatchObject({ code: 'INSIGHTS_DATA' })
})

it('does not follow linked project folders or outcome files outside Projects', async () => {
  const root = await world()
  const outside = await world()
  await seed(outside, 'external', [post()])
  await fs.symlink(join(outside, 'external'), join(root, 'linked'), 'dir')
  const empty = await summary(root)
  expect(sentence(empty, 'no-data')).toBeDefined()
  await fs.mkdir(join(root, 'local'))
  await fs.symlink(join(outside, 'external', 'outcomes.json'), join(root, 'local', 'outcomes.json'))
  await expect(summary(root)).rejects.toMatchObject({ code: 'INSIGHTS_DATA' })
})

it('IPC serves the configured root and validates dates without accepting caller paths', async () => {
  const root = await world()
  await seed(root, 'one', [post()])
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const refresh = new ResultsRefresh({ projectsRoot: () => root, stateDir: join(root, '.state'), sources: [] })
  registerInsightsIpc({ projectsRoot: () => root, now: () => Date.parse(NOW), refresh, handle: (channel, fn) => handlers.set(channel, (...args) => fn(undefined, ...args)),
    describe: async (slug, version) => slug === 'one' ? { title: 'My reel', cover: `cover-v${version}` } : null })
  const get = handlers.get('insights:get')
  expect(get).toBeTypeOf('function')
  expect(await get?.({ since: '2026-10-01' })).toMatchObject({ asOf: NOW, totals: { posts: 1, metrics: { plays: 100 } }, reels: [{ title: 'My reel', cover: 'cover-v1' }] })
  await expect(Promise.resolve().then(() => get?.({ since: 'yesterday' }))).rejects.toMatchObject({ code: 'INSIGHTS_INPUT' })
  await expect(Promise.resolve().then(() => get?.({ projectsRoot: '/untrusted' }))).rejects.toMatchObject({ code: 'INSIGHTS_INPUT' })
})

it('does not call a partly counted or missing-stat reel the best reel', async () => {
  const root = await world()
  await seed(root, 'partial', [post({ postId: 'p', metrics: { plays: 1000 } }), post({ platform: 'tiktok', postId: 't', publishedAt: '2026-10-23T11:00:00.000Z' })])
  await seed(root, 'complete', [post({ postId: 'c' })])
  expect((await summary(root)).trends.bestReel).toBeNull()
  await seed(root, 'partial', [post({ postId: 'p', metrics: { plays: 1000 } }), post({ platform: 'tiktok', postId: 't', metrics: null, observedAt: null })])
  expect((await summary(root)).trends.bestReel).toBeNull()
})

it('withholds weekly improvement when a mature post has unavailable metrics', async () => {
  const root = await world()
  for (const [name, date, shares] of [['a', TUESDAY, 3], ['b', TUESDAY, 3], ['c', LAST_WEEK, 1], ['d', LAST_WEEK, 1]] as const)
    await seed(root, name, [post({ postId: name, publishedAt: date, metrics: { shares } })])
  await seed(root, 'missing', [post({ postId: 'm', metrics: null, observedAt: null })])
  const result = await summary(root)
  expect(result.trends.mostImproved).toBeNull()
  expect(result.trends.thisWeek.totals).toMatchObject({ posts: 3, coverage: { shares: 2 } })
})

it('withholds a weekday winner if the highest day has only one post', async () => {
  const root = await world()
  for (const [name, date, reach] of [['a', TUESDAY, 120], ['b', TUESDAY, 120], ['c', WEDNESDAY, 100], ['d', WEDNESDAY, 100]] as const)
    await seed(root, name, [post({ postId: name, publishedAt: date, metrics: { reach } })])
  await seed(root, 'outlier', [post({ postId: 'o', publishedAt: '2026-10-19T08:00:00.000Z', metrics: { reach: 1000 } })])
  expect(sentence(await summary(root), 'weekday-reach')).toBeUndefined()
})

const TRY = (n: 1 | 2, change: PostTrial['change'] = 'hook'): PostTrial => ({ id: 'trial-a', try: n, change })
const SETTLED_AT = '2026-10-23T08:00:00.000Z' // 72 hours after TUESDAY

// fails if the two tries of a trial aren't paired, or the verdict isn't the trial rule's
it('pairs a trial’s two tries and decides it', async () => {
  const root = await world()
  await seed(root, 'trial', [
    post({ postId: '1', trial: TRY(1), observedAt: SETTLED_AT, metrics: { plays: 410 } }),
    post({ postId: '2', trial: TRY(2), observedAt: SETTLED_AT, metrics: { plays: 640 } })
  ])
  const [result] = (await summary(root)).trialResults
  expect(result).toMatchObject({ id: 'trial-a', project: 'trial', platform: 'instagram', change: 'hook', engine: null, verdict: { kind: 'winner', winner: 2 } })
  expect(result.tries.map((p) => p.postId)).toEqual(['1', '2'])
})

// fails if Try 2 on another version loses the engine's record of what it varied
it('links the engine’s trial log when Try 2 is another version', async () => {
  const root = await world()
  await seed(root, 'trial', [post({ postId: '1', trial: TRY(1, 'video') }), post({ version: 2, postId: '2', trial: TRY(2, 'video') })])
  await fs.writeFile(join(root, 'trial', 'trials.json'), JSON.stringify([{ parent_version: 1, variable: 'seed', from: 4, to: 9 }]))
  expect((await summary(root)).trialResults[0].engine).toMatchObject({ parentVersion: 1, variable: 'seed', from: 4, to: 9 })
})

// fails if a broken trial record (two Try 1s, mixed platforms, an unknown change) is shown as a trial
it('refuses broken trial records', async () => {
  const root = await world()
  await seed(root, 'trial', [post({ postId: '1', trial: TRY(1) }), post({ platform: 'tiktok', postId: '2', trial: TRY(2) })])
  await expect(summary(root)).rejects.toMatchObject({ code: 'INSIGHTS_DATA' })
  await seed(root, 'trial', [post({ postId: '1', trial: { id: 'x', try: 1, change: 'music' as PostTrial['change'] } })])
  await expect(summary(root)).rejects.toMatchObject({ code: 'INSIGHTS_DATA' })
})

// fails if Facebook posts (saved under facebook:<id>) can't be read, or a key from another platform is accepted
it('reads Facebook posts by their own key', async () => {
  const root = await world()
  await seed(root, 'fb', [post({ platform: 'facebook', postId: '55', metrics: { plays: 300 } })])
  expect((await summary(root)).platforms).toMatchObject([{ platform: 'facebook', totals: { metrics: { plays: 300 } } }])
  await fs.writeFile(join(root, 'fb', 'outcomes.json'), JSON.stringify({ schemaVersion: 1, versions: { v1: { '55': post({ platform: 'facebook', postId: '55' }) } } }))
  await expect(summary(root)).rejects.toMatchObject({ code: 'INSIGHTS_DATA' })
})

// fails if a rate (skip rate) is added up across posts like a count
it('weights skip rate by plays and sums likes', async () => {
  const root = await world()
  await seed(root, 'a', [post({ postId: 'a', metrics: { plays: 100, skipRatePercent: 10, likes: 5 } })])
  await seed(root, 'b', [post({ postId: 'b', metrics: { plays: 300, skipRatePercent: 30, likes: 7 } })])
  expect((await summary(root)).totals.metrics).toMatchObject({ skipRatePercent: 25, likes: 12 })
})
