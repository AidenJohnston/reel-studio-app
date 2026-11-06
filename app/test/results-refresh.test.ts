import { afterEach, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backoffMs, nextReadAt, ResultsRefresh, type ResultsSource } from '../src/main/results-refresh'
import type { InsightPlatform } from '../src/shared/insights'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const T0 = Date.parse('2026-11-01T00:00:00.000Z')
const dirs: string[] = []
afterEach(async () => { for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true }) })

async function world(posts: { slug: string; platform?: InsightPlatform; postId: string; accountId?: string; publishedAt: number; observedAt?: number | null }[]) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'results-refresh-'))
  dirs.push(dir)
  const projects = join(dir, 'Projects')
  for (const slug of new Set(posts.map((p) => p.slug))) {
    await fs.mkdir(join(projects, slug), { recursive: true })
    const versions = { v1: Object.fromEntries(posts.filter((p) => p.slug === slug).map((p) => {
      const platform = p.platform ?? 'instagram'
      return [`${platform === 'instagram' ? '' : `${platform}:`}${p.postId}`, { version: 1, platform, postId: p.postId, accountId: p.accountId ?? '1',
        apiVersion: 'v26.0', publishedAt: new Date(p.publishedAt).toISOString(), observedAt: p.observedAt ? new Date(p.observedAt).toISOString() : null, metrics: null }]
    })) }
    await fs.writeFile(join(projects, slug, 'outcomes.json'), JSON.stringify({ schemaVersion: 1, versions }))
  }
  return { dir, projects }
}
/** A platform that answers from a script: the error to throw for a post id, or a read. */
function source(platform: InsightPlatform, opts: { account?: string | null; fail?: Record<string, { code: string; userMessage: string }>; audience?: boolean } = {}) {
  const reads: string[] = []
  let audienceReads = 0
  const s: ResultsSource = {
    platform,
    account: async () => opts.account === undefined ? '1' : opts.account,
    read: async (_slug, _version, postId) => {
      reads.push(postId)
      const e = opts.fail?.[postId]
      if (e) throw Object.assign(new Error(e.userMessage), e)
    },
    ...(opts.audience ? { audience: async () => { audienceReads++; return { accountId: '1', followers: { age: [{ key: '25-34', value: 3 }], gender: [], country: [], city: [] } } } } : {})
  }
  return { s, reads, audienceReads: () => audienceReads }
}

// fails if new posts are read too rarely, old ones too often, or a settled post keeps costing calls
it('spaces reads by a post’s age and stops after 90 days', () => {
  expect(nextReadAt(T0, null)).toBe(T0 + HOUR)
  expect(nextReadAt(T0, T0 + HOUR)).toBe(T0 + 2 * HOUR)
  expect(nextReadAt(T0, T0 + 10 * HOUR)).toBe(T0 + 15 * HOUR)
  expect(nextReadAt(T0, T0 + 30 * DAY)).toBe(T0 + 33 * DAY)
  expect(nextReadAt(T0, T0 + 90 * DAY)).toBeNull()
  expect([1, 2, 3, 7, 20].map(backoffMs)).toEqual([15 * 60_000, 30 * 60_000, HOUR, 16 * HOUR, DAY])
})

// fails if the schedule reads posts that aren't due, another account's posts, or stops at one broken post
it('reads due posts of the connected account and carries on past a post that fails', async () => {
  const w = await world([
    { slug: 'a', postId: 'due', publishedAt: T0 - 2 * DAY, observedAt: T0 - 2 * DAY + HOUR },
    { slug: 'a', postId: 'fresh', publishedAt: T0 - 10 * HOUR, observedAt: T0 - HOUR }, // next read at T0 + 3.5 h
    { slug: 'b', postId: 'gone', publishedAt: T0 - 3 * DAY },
    { slug: 'b', postId: 'other', accountId: '2', publishedAt: T0 - 3 * DAY },
    { slug: 'c', platform: 'tiktok', postId: 'tt', publishedAt: T0 - 3 * DAY }
  ])
  const ig = source('instagram', { fail: { gone: { code: 'IG_POST', userMessage: 'Not linked.' } } })
  const tt = source('tiktok', { account: null })
  let changed = 0
  const r = new ResultsRefresh({ projectsRoot: () => w.projects, stateDir: w.dir, sources: [ig.s, tt.s], now: () => T0, changed: () => changed++ })
  const status = await r.refresh()
  expect(ig.reads.sort()).toEqual(['due', 'gone'])
  expect(tt.reads).toEqual([])
  expect(status.platforms).toMatchObject({ instagram: { state: 'ok' }, tiktok: { state: 'not-connected' }, facebook: { state: 'not-connected' } })
  expect(changed).toBe(1)
  // Refresh (all) also reads the post that isn't due yet
  await r.refresh({ all: true })
  expect(ig.reads.filter((id) => id === 'fresh')).toHaveLength(1)
})

// fails if a rate limit doesn't stop that platform, isn't backed off, or is forgotten across a restart
it('backs off a rate-limited platform and remembers it across restarts', async () => {
  const w = await world([{ slug: 'a', postId: 'p1', publishedAt: T0 - 2 * DAY }, { slug: 'a', postId: 'p2', publishedAt: T0 - 2 * DAY }])
  let now = T0
  const limited = source('instagram', { fail: { p1: { code: 'IG_RATE_LIMIT', userMessage: 'Wait a few minutes.' }, p2: { code: 'IG_RATE_LIMIT', userMessage: 'Wait a few minutes.' } } })
  const r = new ResultsRefresh({ projectsRoot: () => w.projects, stateDir: w.dir, sources: [limited.s], now: () => now })
  expect((await r.refresh()).platforms.instagram).toEqual({ state: 'waiting', until: new Date(T0 + 15 * 60_000).toISOString(), message: 'Wait a few minutes.' })
  expect(limited.reads).toHaveLength(1)
  // a restart reads the saved state: still waiting, nothing is asked
  const again = new ResultsRefresh({ projectsRoot: () => w.projects, stateDir: w.dir, sources: [limited.s], now: () => now })
  await again.refresh({ all: true })
  expect(limited.reads).toHaveLength(1)
  // after the wait it tries again, and a second limit in a row waits twice as long
  now = T0 + 16 * 60_000
  expect((await again.refresh()).platforms.instagram).toMatchObject({ state: 'waiting', until: new Date(now + 30 * 60_000).toISOString() })
})

// fails if an expired connection reads as "not connected" (the screen would hide the way to fix it)
it('asks to reconnect when the token is refused', async () => {
  const w = await world([{ slug: 'a', postId: 'p', publishedAt: T0 - 2 * DAY }])
  const ig = source('instagram', { fail: { p: { code: 'IG_TOKEN', userMessage: 'Connect Instagram again in Settings.' } } })
  const r = new ResultsRefresh({ projectsRoot: () => w.projects, stateDir: w.dir, sources: [ig.s], now: () => T0 })
  expect((await r.refresh()).platforms.instagram).toEqual({ state: 'reconnect', message: 'Connect Instagram again in Settings.' })
})

// fails if the audience is asked for on every hourly tick, or is lost between runs
it('reads the audience at most once a day and keeps it', async () => {
  const w = await world([])
  let now = T0
  const ig = source('instagram', { audience: true })
  const r = new ResultsRefresh({ projectsRoot: () => w.projects, stateDir: w.dir, sources: [ig.s], now: () => now })
  await r.refresh()
  now += 2 * HOUR
  await r.refresh()
  expect(ig.audienceReads()).toBe(1)
  now += DAY
  await r.refresh()
  expect(ig.audienceReads()).toBe(2)
  const reopened = new ResultsRefresh({ projectsRoot: () => w.projects, stateDir: w.dir, sources: [] })
  expect(await reopened.audience()).toMatchObject([{ platform: 'instagram', accountId: '1', followers: { age: [{ key: '25-34', value: 3 }] } }])
})

// fails if two refreshes at once (the hourly tick and a click) read every post twice
it('joins a refresh already running', async () => {
  const w = await world([{ slug: 'a', postId: 'p', publishedAt: T0 - 2 * DAY }])
  const ig = source('instagram')
  const r = new ResultsRefresh({ projectsRoot: () => w.projects, stateDir: w.dir, sources: [ig.s], now: () => T0 })
  await Promise.all([r.refresh(), r.refresh({ all: true })])
  expect(ig.reads).toEqual(['p'])
})
