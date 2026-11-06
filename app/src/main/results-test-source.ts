// Test builds only: REELSTUDIO_TEST_RESULTS=<file> stands in for the platforms' APIs, as REELSTUDIO_TEST_INSTAGRAM
// stands in for a connected account (instagram-ipc.ts). The refresh, the saved outcomes, the summary and the screen are
// the real ones; only the network answer is this file's. The file is read on every call, so a test can change it.
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { InsightPlatform, PlatformAudience } from '../shared/insights'
import type { InstagramMetrics } from '../shared/instagram'
import type { ResultsSource } from './results-refresh'
import { atomicSocialFile, withSocialFile } from './social-store'

interface Fixture {
  accountId: string
  /** postId -> its numbers now */
  posts: Record<string, Partial<InstagramMetrics>>
  followers?: PlatformAudience['followers']
  /** every read answers with a rate limit */
  rateLimited?: boolean
}
const KEY: Record<InsightPlatform, string> = { instagram: '', tiktok: 'tiktok:', facebook: 'facebook:' }
const EMPTY: InstagramMetrics = { plays: null, reach: null, likes: null, comments: null, shares: null, saves: null, averageWatchTimeMs: null, totalWatchTimeMs: null, skipRatePercent: null }
const failure = (code: string, userMessage: string) => Object.assign(new Error(userMessage), { code, userMessage })

export function testResultsSources(file: string, projectsRoot: () => string, now: () => number = Date.now): ResultsSource[] {
  const fixture = async (platform: InsightPlatform): Promise<Fixture | null> => {
    const all = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<Record<InsightPlatform, Fixture>>
    return all[platform] ?? null
  }
  return (['instagram', 'tiktok', 'facebook'] as const).map((platform): ResultsSource => ({
    platform,
    account: async () => (await fixture(platform))?.accountId ?? null,
    read: async (slug, version, postId) => {
      const f = await fixture(platform)
      if (!f) throw failure('TEST_DISABLED', 'Not connected.')
      if (f.rateLimited) throw failure('TEST_RATE_LIMIT', 'The platform has reached a request limit. Wait a few minutes before trying again.')
      const numbers = f.posts[postId]
      if (!numbers) throw failure('TEST_POST', 'No such post.')
      const out = join(projectsRoot(), slug, 'outcomes.json')
      // like the services' insights(): the saved post with its new numbers
      return withSocialFile(out, async () => {
        const saved = JSON.parse(await fs.readFile(out, 'utf8'))
        const record = saved.versions[`v${version}`][`${KEY[platform]}${postId}`]
        record.observedAt = new Date(now()).toISOString()
        record.metrics = { ...EMPTY, ...numbers }
        await atomicSocialFile(out, JSON.stringify(saved, null, 2) + '\n')
        return record
      })
    },
    ...(platform === 'instagram' ? {
      audience: async () => {
        const f = await fixture(platform)
        if (!f) throw failure('TEST_DISABLED', 'Not connected.')
        return { accountId: f.accountId, followers: f.followers ?? { age: [], gender: [], country: [], city: [] } }
      }
    } : {})
  }))
}
