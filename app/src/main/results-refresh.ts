// Reads post results for connected accounts on a schedule and on demand. Each platform service does its own reading
// and saving (instagram.ts, tiktok.ts insights); this decides which posts are due, keeps within rate limits, and keeps
// a small status file the Insights screen shows ("Updated 2 hours ago", "Connect Instagram again").
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { AudienceSlice, InsightPlatform, PlatformAudience, ResultsPlatformState, ResultsStatus } from '../shared/insights'
import { atomicSocialFile } from './social-store'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
export const PLATFORMS: InsightPlatform[] = ['instagram', 'tiktok', 'facebook']
/** The first read waits an hour: Meta says insights can lag, and a minute-old post has nothing to show. */
export const FIRST_READ_AFTER = HOUR
/** Lifetime numbers settle within weeks; after this a post is read only when the person asks. */
export const STOP_AUTO_READS_AFTER = 90 * DAY
// Instagram allows 200 calls an hour per account and TikTok's video list is rate limited per token; 60 posts per
// platform per run keeps a manual refresh well under both even with a token refresh per call. Unmeasured.
export const MAX_READS_PER_RUN = 60
const AUDIENCE_EVERY = DAY
/** Backoff after a rate limit: 15 minutes, doubling per limit in a row, at most a day. */
export function backoffMs(streak: number): number {
  return Math.min(DAY, 15 * MINUTE * 2 ** Math.max(0, streak - 1))
}

/**
 * When a post is next due. Reads thin out as it ages: the gap is half its age at the last read, between an hour and
 * three days, so a new post is read every hour or two and a month-old one every few days. null = no automatic read.
 */
export function nextReadAt(publishedAt: number, observedAt: number | null): number | null {
  if (observedAt === null) return publishedAt + FIRST_READ_AFTER
  const age = observedAt - publishedAt
  if (age >= STOP_AUTO_READS_AFTER) return null
  return observedAt + Math.min(3 * DAY, Math.max(HOUR, age / 2))
}

export interface SavedPostRef { slug: string; version: number; platform: InsightPlatform; accountId: string; postId: string; publishedAt: number; observedAt: number | null }

/** Every post in every project's outcomes.json. A project whose file can't be read is skipped here; Insights says so. */
export async function savedPosts(projectsRoot: string): Promise<SavedPostRef[]> {
  let names: string[]
  try { names = (await fs.readdir(projectsRoot, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort() } catch { return [] }
  const posts: SavedPostRef[] = []
  for (const slug of names) {
    let saved: unknown
    try { saved = JSON.parse(await fs.readFile(join(projectsRoot, slug, 'outcomes.json'), 'utf8')) } catch { continue }
    if (!saved || typeof saved !== 'object' || !('versions' in saved) || !saved.versions || typeof saved.versions !== 'object') continue
    for (const [key, entries] of Object.entries(saved.versions as Record<string, unknown>)) {
      const version = /^v[1-9]\d*$/.test(key) ? Number(key.slice(1)) : NaN
      if (!Number.isSafeInteger(version) || !entries || typeof entries !== 'object') continue
      for (const value of Object.values(entries as Record<string, unknown>)) {
        if (!value || typeof value !== 'object') continue
        const p = value as Record<string, unknown>
        const publishedAt = typeof p.publishedAt === 'string' ? Date.parse(p.publishedAt) : NaN
        const observedAt = typeof p.observedAt === 'string' ? Date.parse(p.observedAt) : null
        if (!PLATFORMS.includes(p.platform as InsightPlatform) || typeof p.postId !== 'string' || typeof p.accountId !== 'string'
          || !Number.isFinite(publishedAt) || (observedAt !== null && !Number.isFinite(observedAt))) continue
        posts.push({ slug, version, platform: p.platform as InsightPlatform, accountId: p.accountId, postId: p.postId, publishedAt, observedAt })
      }
    }
  }
  return posts
}

/** One platform's reader: the service that owns its connection. */
export interface ResultsSource {
  platform: InsightPlatform
  /** The connected account id, or null when nothing is connected (or the platform isn't set up). */
  account(): Promise<string | null>
  /** Reads one post's numbers and saves them to its outcomes.json. */
  read(slug: string, version: number, postId: string): Promise<unknown>
  /** Who follows the account. Absent where the platform gives no audience facts. */
  audience?(): Promise<{ accountId: string; followers: PlatformAudience['followers'] }>
}

/** What an error from a source means for the run. Codes are the services' own (IG_*, TT_*, FB_*). */
export function errorKind(e: unknown): 'rate-limit' | 'reconnect' | 'not-connected' | 'post' | 'stop' {
  const code = e && typeof e === 'object' && 'code' in e && typeof e.code === 'string' ? e.code : ''
  if (/_RATE_LIMIT$/.test(code)) return 'rate-limit'
  if (/_(TOKEN|PERMISSION|ACCOUNT)$/.test(code)) return 'reconnect'
  if (/_(DISABLED|SETUP|SECURE_STORAGE)$/.test(code)) return 'not-connected'
  // this post only: not linked to the account, private, deleted, or an answer that didn't parse
  if (/_(POST|STATS_UNAVAILABLE|RESPONSE|INPUT|PATH|LOCAL_DATA)$/.test(code)) return 'post'
  return 'stop'
}
const message = (e: unknown, fallback: string) => e && typeof e === 'object' && 'userMessage' in e && typeof e.userMessage === 'string' ? e.userMessage : fallback

interface PlatformMemory { state: ResultsPlatformState; streak: number; audienceAt: number | null }
/**
 * `tried`: when a read last failed for one post (key: postKey), so a post the platform keeps refusing waits its turn
 * like a read one instead of taking the front of every run.
 */
const ALL_PLATFORMS: InsightPlatform[] = ['instagram', 'tiktok', 'facebook', 'threads', 'x', 'linkedin']
interface Saved { checkedAt: string | null; platforms: Record<InsightPlatform, PlatformMemory>; audience: PlatformAudience[]; tried: Record<string, number> }
const postKey = (p: SavedPostRef) => JSON.stringify([p.platform, p.accountId, p.slug, p.version, p.postId])
const fresh = (): Saved => ({
  checkedAt: null, audience: [], tried: {},
  // every platform Insights knows, including the ones nothing reads results from yet (Threads, X, LinkedIn)
  platforms: Object.fromEntries(ALL_PLATFORMS.map((p) => [p, { state: { state: 'not-connected' }, streak: 0, audienceAt: null }])) as Record<InsightPlatform, PlatformMemory>
})

function slices(value: unknown): AudienceSlice[] {
  return Array.isArray(value) ? value.filter((s): s is AudienceSlice => !!s && typeof s === 'object' && typeof s.key === 'string' && typeof s.value === 'number') : []
}
/** The status file is a cache: anything unreadable starts over rather than blocking Insights. */
function parseSaved(value: unknown): Saved {
  const base = fresh()
  if (!value || typeof value !== 'object') return base
  const v = value as Record<string, unknown>
  if (typeof v.checkedAt === 'string' && Number.isFinite(Date.parse(v.checkedAt))) base.checkedAt = v.checkedAt
  const platforms = v.platforms && typeof v.platforms === 'object' ? v.platforms as Record<string, unknown> : {}
  for (const p of PLATFORMS) {
    const m = platforms[p] as Record<string, unknown> | undefined
    const s = m?.state as Record<string, unknown> | undefined
    if (!m || !s || typeof s.state !== 'string') continue
    const ok = s.state === 'not-connected' || s.state === 'ready' || (s.state === 'ok' && typeof s.checkedAt === 'string')
      || ((s.state === 'reconnect' || s.state === 'failed') && typeof s.message === 'string')
      || (s.state === 'waiting' && typeof s.until === 'string' && typeof s.message === 'string')
    if (!ok) continue
    base.platforms[p] = { state: s as unknown as ResultsPlatformState, streak: typeof m.streak === 'number' ? m.streak : 0,
      audienceAt: typeof m.audienceAt === 'number' ? m.audienceAt : null }
  }
  if (v.tried && typeof v.tried === 'object')
    for (const [k, t] of Object.entries(v.tried as Record<string, unknown>)) if (typeof t === 'number' && Number.isFinite(t)) base.tried[k] = t
  if (Array.isArray(v.audience)) {
    base.audience = v.audience.flatMap((a: unknown) => {
      if (!a || typeof a !== 'object') return []
      const r = a as Record<string, unknown>, f = r.followers as Record<string, unknown> | undefined
      if (!PLATFORMS.includes(r.platform as InsightPlatform) || typeof r.accountId !== 'string' || typeof r.observedAt !== 'string' || !f) return []
      return [{ platform: r.platform as InsightPlatform, accountId: r.accountId, observedAt: r.observedAt,
        followers: { age: slices(f.age), gender: slices(f.gender), country: slices(f.country), city: slices(f.city) } }]
    })
  }
  return base
}

export class ResultsRefresh {
  private saved: Saved | null = null
  private running: Promise<ResultsStatus> | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly o: {
    projectsRoot: () => string
    /** where results-refresh.json lives (the app's settings folder) */
    stateDir: string
    sources: ResultsSource[]
    now?: () => number
    /** after every run, once it is no longer running: Insights reloads */
    changed?: () => void
    /** after each post read, with what the source returned (Settings › Privacy › Post results, main/usage.ts postViews) */
    onRead?: (post: SavedPostRef, outcome: unknown) => void
  }) {}

  private now(): number { return this.o.now?.() ?? Date.now() }
  private file(): string { return join(this.o.stateDir, 'results-refresh.json') }
  private async load(): Promise<Saved> {
    if (this.saved) return this.saved
    try { this.saved = parseSaved(JSON.parse(await fs.readFile(this.file(), 'utf8'))) } catch { this.saved = fresh() }
    return this.saved
  }
  private async store(s: Saved): Promise<void> {
    this.saved = s
    await fs.mkdir(this.o.stateDir, { recursive: true })
    await atomicSocialFile(this.file(), JSON.stringify(s, null, 2) + '\n')
  }

  /**
   * The last run's word on each platform, with connections checked now: connecting or disconnecting between runs
   * shows at once (each source's account() reads only local state).
   */
  async status(): Promise<ResultsStatus> {
    const s = await this.load()
    const platforms = Object.fromEntries(ALL_PLATFORMS.map((p) => [p, s.platforms[p].state])) as Record<InsightPlatform, ResultsPlatformState>
    for (const source of this.o.sources) {
      const account = await source.account().catch(() => null)
      const saved = platforms[source.platform]
      platforms[source.platform] = account === null ? { state: 'not-connected' } : saved.state === 'not-connected' ? { state: 'ready' } : saved
    }
    return { checkedAt: s.checkedAt, running: this.running !== null, platforms }
  }
  /**
   * What the last refresh saved about each connected account's followers: only for the account connected now, so
   * a disconnect or a switch to another account never shows the old account's followers, even before the next run.
   */
  async audience(): Promise<PlatformAudience[]> {
    const saved = (await this.load()).audience
    const now = new Map(await Promise.all(this.o.sources.map(async (src) => [src.platform, await src.account().catch(() => null)] as const)))
    return saved.filter((a) => now.get(a.platform) === a.accountId)
  }

  /**
   * Reads due posts (or, with `all`, every post the person can see, newest first) for each connected platform. One run
   * at a time: asking during a run gets that run. A platform waiting out a rate limit is skipped until its time.
   */
  refresh({ all = false }: { all?: boolean } = {}): Promise<ResultsStatus> {
    if (this.running) return this.running
    // Every finished run is announced once `running` is clear: a status-only change (a rate limit) matters to an open
    // Insights screen as much as new numbers, and a screen that loaded mid-run must not keep showing it running.
    const run = this.run(all).finally(() => {
      this.running = null
      this.o.changed?.()
    })
    this.running = run
    return run
  }

  private async run(all: boolean): Promise<ResultsStatus> {
    const s = structuredClone(await this.load())
    const posts = await savedPosts(this.o.projectsRoot())
    // a failed read counts as a read for spacing; a post since read, or gone, drops its failure
    const last = (p: SavedPostRef) => Math.max(p.observedAt ?? -Infinity, s.tried[postKey(p)] ?? -Infinity)
    s.tried = Object.fromEntries(posts.flatMap((p) => {
      const t = s.tried[postKey(p)]
      return t !== undefined && (p.observedAt === null || t > p.observedAt) ? [[postKey(p), t]] : []
    }))
    for (const source of this.o.sources) {
      const memory = s.platforms[source.platform]
      const now = this.now()
      // account() reads only local state, so it is asked even while the platform waits out a rate limit
      let account: string | null = null
      let lookup: { failed: unknown } | null = null
      try { account = await source.account() } catch (e) { lookup = { failed: e } }
      // another account's followers, or those of an account no longer connected (or that can't be told), are not
      // kept; a new account's are read at its next run rather than a day later
      if (s.audience.some((x) => x.platform === source.platform && (lookup || x.accountId !== account))) {
        s.audience = s.audience.filter((x) => x.platform !== source.platform || (!lookup && x.accountId === account))
        memory.audienceAt = null
      }
      if (memory.state.state === 'waiting' && Date.parse(memory.state.until) > now) continue
      if (lookup) {
        memory.state = errorKind(lookup.failed) === 'reconnect' ? { state: 'reconnect', message: message(lookup.failed, 'Connect again in Settings.') } : { state: 'not-connected' }
        continue
      }
      if (account === null) { memory.state = { state: 'not-connected' }; continue }
      const mine = posts.filter((p) => p.platform === source.platform && p.accountId === account)
      const due = mine
        .filter((p) => {
          const at = last(p)
          return p.publishedAt <= now && (all || (nextReadAt(p.publishedAt, Number.isFinite(at) ? at : null) ?? Infinity) <= now)
        })
        // never tried first, then the longest since a read or a try; newest post first among equals
        .sort((a, b) => Math.max(last(a), 0) - Math.max(last(b), 0) || b.publishedAt - a.publishedAt)
        .slice(0, MAX_READS_PER_RUN)
      let stopped: ResultsPlatformState | null = null
      for (const p of due) {
        try {
          const outcome = await source.read(p.slug, p.version, p.postId)
          delete s.tried[postKey(p)]
          this.o.onRead?.(p, outcome)
        } catch (e) {
          const kind = errorKind(e)
          if (kind === 'post') {
            s.tried[postKey(p)] = now
            continue
          }
          stopped = this.halt(memory, kind, e, now)
          break
        }
      }
      if (!stopped && source.audience && (memory.audienceAt === null || now - memory.audienceAt >= (all ? HOUR : AUDIENCE_EVERY))) {
        try {
          const a = await source.audience()
          s.audience = [...s.audience.filter((x) => x.platform !== source.platform),
            { platform: source.platform, accountId: a.accountId, observedAt: new Date(now).toISOString(), followers: a.followers }]
          memory.audienceAt = now
        } catch (e) {
          // audience is extra: a post-shaped failure leaves the old facts; anything else stops the platform as reads do
          if (errorKind(e) !== 'post') stopped = this.halt(memory, errorKind(e), e, now)
        }
      }
      if (!stopped) {
        memory.state = { state: 'ok', checkedAt: new Date(now).toISOString() }
        memory.streak = 0
      }
    }
    s.checkedAt = new Date(this.now()).toISOString()
    await this.store(s)
    const status = await this.status()
    return { ...status, running: false }
  }

  private halt(memory: PlatformMemory, kind: ReturnType<typeof errorKind>, e: unknown, now: number): ResultsPlatformState {
    if (kind === 'rate-limit') {
      memory.streak += 1
      memory.state = { state: 'waiting', until: new Date(now + backoffMs(memory.streak)).toISOString(), message: message(e, 'The platform asked to slow down.') }
    } else if (kind === 'reconnect') memory.state = { state: 'reconnect', message: message(e, 'Connect again in Settings.') }
    else if (kind === 'not-connected') memory.state = { state: 'not-connected' }
    else memory.state = { state: 'failed', message: message(e, 'Results could not be read. Try again later.') }
    return memory.state
  }

  /** Background reads: shortly after launch, then every hour. */
  start({ firstAfter = 30_000, every = HOUR }: { firstAfter?: number; every?: number } = {}): void {
    this.stop()
    const tick = (wait: number) => {
      this.timer = setTimeout(() => {
        void this.refresh().catch(() => undefined).finally(() => { if (this.timer) tick(every) })
      }, wait)
      this.timer.unref?.()
    }
    tick(firstAfter)
  }
  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}
