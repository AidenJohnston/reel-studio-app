import { promises as fs } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import type {
  InsightChange, InsightMetric, InsightPlatform, InsightPost, InsightPostRef, InsightReel, InsightSentence, InsightTotals,
  InsightTrial, InsightTrialResult, InsightValues, InsightsOptions, InsightsSummary, PlatformAudience, PostTrial
} from '../shared/insights'
import { decideTrial } from './trial-decision'

const DAY = 86_400_000
const PLATFORMS: InsightPlatform[] = ['instagram', 'tiktok', 'facebook']
const METRICS: InsightMetric[] = ['plays', 'reach', 'averageWatchTimeMs', 'completionEstimate', 'skipRatePercent', 'shares', 'saves', 'comments', 'likes']
/** Rates and averages, weighted by plays when posts are combined; every other metric is a count and is summed. */
const PER_PLAY = new Set<InsightMetric>(['averageWatchTimeMs', 'completionEstimate', 'skipRatePercent'])
const LABELS: Record<InsightMetric, string> = {
  plays: 'Plays', reach: 'Reach', averageWatchTimeMs: 'Average watch time', completionEstimate: 'Estimated watch fraction',
  skipRatePercent: 'Skip rate', shares: 'Shares', saves: 'Saves', comments: 'Comments', likes: 'Likes'
}
const PLATFORM_LABELS: Record<InsightPlatform, string> = { instagram: 'Instagram', tiktok: 'TikTok', facebook: 'Facebook' }
const KEY_PREFIX: Record<InsightPlatform, string> = { instagram: '', tiktok: 'tiktok:', facebook: 'facebook:' }
const API_VERSION: Record<InsightPlatform, RegExp> = { instagram: /^v26\.0$/, tiktok: /^v2$/, facebook: /^v\d{2}\.0$/ }
const TRIAL_CHANGES = new Set(['video', 'hook', 'caption', 'cover', 'brightness'])
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
// These thresholds are unvalidated heuristics, with no significance or calibration study.
// Repeated posts and a 20% margin suppress small comparisons; 100 plays limits tiny samples.
const MIN_POSTS = 2
const MIN_PLAYS = 100
const MIN_CHANGE_PERCENT = 20
const COUNTING_HOURS = 48

export class InsightsError extends Error {
  constructor(readonly code: 'INSIGHTS_INPUT' | 'INSIGHTS_DATA', readonly userMessage: string) { super(userMessage) }
}
function badData(file: string): never {
  throw new InsightsError('INSIGHTS_DATA', `Saved insights could not be read in ${file}. Restore the file and try again.`)
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function isoDate(value: unknown): value is string {
  return typeof value === 'string' && /^(?:\d{4}-\d{2}-\d{2}|\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2}))$/.test(value)
    && Number.isFinite(Date.parse(value))
}
export function insightsOptions(value: unknown): InsightsOptions {
  if (value === undefined) return {}
  if (!object(value) || Object.keys(value).some((key) => key !== 'since' && key !== 'asOf')
    || (value.since !== undefined && !isoDate(value.since)) || (value.asOf !== undefined && !isoDate(value.asOf)))
    throw new InsightsError('INSIGHTS_INPUT', 'Choose valid ISO dates for insights.')
  return { ...(isoDate(value.since) ? { since: value.since } : {}), ...(isoDate(value.asOf) ? { asOf: value.asOf } : {}) }
}
function positiveVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}
function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0 }
function metric(value: unknown, file: string): number | null {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return badData(file)
  return value
}
function emptyValues(): InsightValues {
  return { plays: null, reach: null, averageWatchTimeMs: null, completionEstimate: null, skipRatePercent: null, shares: null, saves: null, comments: null, likes: null }
}
interface SavedPost extends InsightPostRef {
  publishedAt: string
  observedAt: string | null
  durationMs: number | null
  metrics: InsightValues
  trial: PostTrial | null
}
interface Snapshot { posts: SavedPost[]; trials: InsightTrial[] }

async function read(projectDir: string, name: string, label: string): Promise<unknown> {
  try {
    const file = join(projectDir, name)
    const resolved = await fs.realpath(file)
    const rel = relative(await fs.realpath(projectDir), resolved)
    if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) return badData(label)
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (error) {
    if (object(error) && error.code === 'ENOENT') return undefined
    return badData(label)
  }
}
function parseTrials(value: unknown, project: string): InsightTrial[] {
  if (value === undefined) return []
  const file = `${project}/trials.json`
  if (!Array.isArray(value)) return badData(file)
  return value.map((row: unknown, index) => {
    if (!object(row) || !positiveVersion(row.parent_version) || !('from' in row) || !('to' in row)) return badData(file)
    const variable = row.variable
    if (variable !== 'seed' && variable !== 'hook' && variable !== 'cover' && variable !== 'caption' && variable !== 'brightness') return badData(file)
    // The producer records only the parent, so no child version or winning post is inferred.
    return { project, index, parentVersion: row.parent_version, variable, from: row.from, to: row.to }
  })
}
function isPlatform(value: unknown): value is InsightPlatform {
  return value === 'instagram' || value === 'tiktok' || value === 'facebook'
}
/** outcomes.json `trial`, written by publish on both tries of a trial post. Absent on an ordinary post. */
function parseTrial(value: unknown, file: string): PostTrial | null {
  if (value === undefined) return null
  if (!object(value) || typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value.id) || (value.try !== 1 && value.try !== 2)
    || typeof value.change !== 'string' || !TRIAL_CHANGES.has(value.change)) return badData(file)
  return { id: value.id, try: value.try, change: value.change as PostTrial['change'] }
}
function parsePost(value: unknown, project: string, version: number, key: string): SavedPost {
  const file = `${project}/outcomes.json`
  if (!object(value) || value.version !== version || !text(value.postId) || !text(value.accountId)
    || !isoDate(value.publishedAt) || (value.observedAt !== null && !isoDate(value.observedAt)) || !isPlatform(value.platform)) return badData(file)
  if (key !== `${KEY_PREFIX[value.platform]}${value.postId}` || typeof value.apiVersion !== 'string' || !API_VERSION[value.platform].test(value.apiVersion)) return badData(file)
  if (value.observedAt !== null && Date.parse(value.observedAt) < Date.parse(value.publishedAt)) return badData(file)
  const metrics = emptyValues()
  if (value.metrics !== null) {
    if (!object(value.metrics) || value.observedAt === null) return badData(file)
    // A metric the platform doesn't report is missing from the saved record (older records have no likes or skip rate).
    for (const name of METRICS) if (name !== 'completionEstimate') metrics[name] = value.metrics[name] === undefined ? null : metric(value.metrics[name], file)
    if (metrics.skipRatePercent !== null && metrics.skipRatePercent > 100) return badData(file)
  }
  return { project, version, postId: value.postId, accountId: value.accountId, platform: value.platform,
    publishedAt: new Date(value.publishedAt).toISOString(), observedAt: value.observedAt === null ? null : new Date(value.observedAt).toISOString(),
    durationMs: null, metrics, trial: parseTrial(value.trial, file) }
}
async function load(projectsRoot: string): Promise<Snapshot> {
  let entries
  try { entries = await fs.readdir(projectsRoot, { withFileTypes: true }) } catch (error) {
    if (object(error) && error.code === 'ENOENT') return { posts: [], trials: [] }
    return badData('Projects')
  }
  const posts: SavedPost[] = [], trials: InsightTrial[] = []
  const identities = new Set<string>()
  for (const entry of entries.filter((e) => e.isDirectory()).sort((a, b) => compare(a.name, b.name))) {
    const dir = join(projectsRoot, entry.name)
    trials.push(...parseTrials(await read(dir, 'trials.json', `${entry.name}/trials.json`), entry.name))
    const saved = await read(dir, 'outcomes.json', `${entry.name}/outcomes.json`)
    if (saved === undefined) continue
    if (!object(saved) || saved.schemaVersion !== 1 || !object(saved.versions)) return badData(`${entry.name}/outcomes.json`)
    for (const [key, values] of Object.entries(saved.versions).sort(([a], [b]) => compare(a, b))) {
      const version = /^v([1-9]\d*)$/.test(key) ? Number(key.slice(1)) : NaN
      if (!positiveVersion(version) || !object(values)) return badData(`${entry.name}/outcomes.json`)
      const renderFile = `versions/${key}/render.json`
      const render = await read(dir, renderFile, `${entry.name}/${renderFile}`)
      let durationMs: number | null = null
      if (render !== undefined) {
        if (!object(render) || typeof render.duration !== 'number' || !Number.isFinite(render.duration) || render.duration <= 0
          || render.preview === true || render.draft === true || (render.window !== undefined && render.window !== null)) return badData(`${entry.name}/${renderFile}`)
        durationMs = render.duration * 1000
      }
      for (const [postKey, value] of Object.entries(values).sort(([a], [b]) => compare(a, b))) {
        const post = parsePost(value, entry.name, version, postKey)
        const identity = JSON.stringify([post.platform, post.accountId, post.postId])
        if (identities.has(identity)) return badData(`${entry.name}/outcomes.json`)
        identities.add(identity)
        posts.push({ ...post, durationMs })
      }
    }
  }
  return { posts, trials }
}
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0 }
function refs(posts: InsightPost[]): InsightPostRef[] {
  return posts.map(({ project, version, platform, accountId, postId }) => ({ project, version, platform, accountId, postId }))
}
function weighted(posts: InsightPost[], name: InsightMetric): number | null {
  if (!posts.length || posts.some((p) => p.metrics.plays === null || p.metrics[name] === null)) return null
  const plays = posts.reduce((sum, p) => sum + (p.metrics.plays ?? 0), 0)
  return plays > 0 ? posts.reduce((sum, p) => sum + (p.metrics[name] ?? 0) * (p.metrics.plays ?? 0), 0) / plays : null
}
function totals(posts: InsightPost[]): InsightTotals {
  const metrics = emptyValues()
  const coverage = { plays: 0, reach: 0, averageWatchTimeMs: 0, completionEstimate: 0, skipRatePercent: 0, shares: 0, saves: 0, comments: 0, likes: 0 }
  for (const name of METRICS) {
    const known = posts.flatMap((p) => p.metrics[name] === null ? [] : [p.metrics[name]])
    coverage[name] = known.length
    metrics[name] = PER_PLAY.has(name) ? weighted(posts, name) : known.length ? known.reduce((sum, n) => sum + n, 0) : null
  }
  return { posts: posts.length, stillCounting: posts.filter((p) => p.status === 'still counting').length, metrics, coverage }
}
function reels(posts: InsightPost[]): InsightReel[] {
  const groups = new Map<string, InsightReel>()
  for (const p of posts) {
    const key = JSON.stringify([p.project, p.version])
    let group = groups.get(key)
    if (!group) { group = { project: p.project, version: p.version, title: null, cover: null, posts: [], totals: totals([]) }; groups.set(key, group) }
    group.posts.push(p)
  }
  return [...groups.values()].map((r) => ({ ...r, totals: totals(r.posts) }))
}
function change(current: number | null, previous: number | null): number | null {
  return current !== null && previous !== null && previous > 0 ? (current - previous) / previous * 100 : null
}
function complete(total: InsightTotals, name: InsightMetric): number | null {
  return total.posts > 0 && total.coverage[name] === total.posts ? total.metrics[name] : null
}
function evidence(posts: InsightPost[], metric: InsightMetric | null, current: number | null, baseline: number | null = null,
  groups: InsightSentence['evidence']['groups'] = []): InsightSentence['evidence'] {
  return { posts: refs(posts), metric, current, baseline, changePercent: metric === null ? null : change(current, baseline), groups }
}
function cohortSentences(posts: InsightPost[]): InsightSentence[] {
  const sentences: InsightSentence[] = []
  for (const platform of PLATFORMS) {
    const eligible = posts.filter((p) => p.platform === platform && p.status === 'available' && (p.metrics.plays ?? 0) >= MIN_PLAYS)
    const withWatch = eligible.filter((p) => p.durationMs !== null && p.metrics.averageWatchTimeMs !== null)
    const short = withWatch.filter((p) => (p.durationMs ?? 0) < 30_000)
    const long = withWatch.filter((p) => (p.durationMs ?? 0) >= 30_000)
    const shortWatch = weighted(short, 'averageWatchTimeMs'), longWatch = weighted(long, 'averageWatchTimeMs')
    const watchChange = change(shortWatch, longWatch)
    if (short.length >= MIN_POSTS && long.length >= MIN_POSTS && watchChange !== null && watchChange >= MIN_CHANGE_PERCENT) {
      sentences.push({ template: 'shorter-held', text: `On ${PLATFORM_LABELS[platform]}, reels under 30 seconds held viewers ${Math.round(watchChange)}% longer`,
        evidence: evidence([...short, ...long], 'averageWatchTimeMs', shortWatch, longWatch, [
          { label: `${platform}: under 30 seconds`, posts: refs(short), value: shortWatch ?? 0 },
          { label: `${platform}: 30 seconds or longer`, posts: refs(long), value: longWatch ?? 0 }
        ]) })
    }
    const undersampledDay = DAYS.some((_, day) => {
      const members = eligible.filter((p) => new Date(p.publishedAt).getUTCDay() === day)
      return members.length > 0 && (members.length < MIN_POSTS || members.some((p) => p.metrics.reach === null))
    })
    const days = undersampledDay ? [] : DAYS.flatMap((label, day) => {
      const members = eligible.filter((p) => new Date(p.publishedAt).getUTCDay() === day && p.metrics.reach !== null)
      if (members.length < MIN_POSTS) return []
      return [{ label, posts: refs(members), value: members.reduce((sum, p) => sum + (p.metrics.reach ?? 0), 0) / members.length }]
    }).sort((a, b) => b.value - a.value || compare(a.label, b.label))
    const [best, next] = days
    const reachChange = best && next ? change(best.value, next.value) : null
    if (best && next && reachChange !== null && reachChange >= MIN_CHANGE_PERCENT) {
      const compared = eligible.filter((p) => days.some((d) => d.posts.some((ref) => ref.postId === p.postId && ref.accountId === p.accountId)))
      sentences.push({ template: 'weekday-reach', text: `On ${PLATFORM_LABELS[platform]}, ${best.label} posts reached the most people on average`,
        evidence: evidence(compared, 'reach', best.value, next.value, days.map((d) => ({ ...d, label: `${platform}: ${d.label}` }))) })
    }
  }
  return sentences
}

/**
 * Pairs each trial's two tries and decides it (trial-decision.ts). A trial is two posts on one platform account with
 * the same trial id, one Try 1 and one Try 2; anything else is a broken record. When Try 2 is another version, the
 * engine's log row for that version pair says what it varied.
 */
function trialResults(posts: InsightPost[], engine: InsightTrial[]): InsightTrialResult[] {
  const groups = new Map<string, InsightPost[]>()
  for (const p of posts) if (p.trial) groups.set(p.trial.id, [...(groups.get(p.trial.id) ?? []), p])
  const results: InsightTrialResult[] = []
  for (const [id, group] of groups) {
    const one = group.find((p) => p.trial?.try === 1), two = group.find((p) => p.trial?.try === 2)
    // a try still outside the date range leaves the trial out rather than half-shown
    if (!one || !two) continue
    if (group.length !== 2 || one.project !== two.project || one.platform !== two.platform || one.accountId !== two.accountId
      || one.trial?.change !== two.trial?.change) return badData(`${one.project}/outcomes.json`)
    const change = one.trial!.change
    const row = two.version !== one.version
      ? engine.filter((t) => t.project === one.project && t.parentVersion === one.version).at(-1) ?? null : null
    results.push({ id, project: one.project, platform: one.platform, change, tries: [one, two], verdict: decideTrial(one, two), engine: row })
  }
  return results.sort((a, b) => compare(b.tries[0].publishedAt, a.tries[0].publishedAt) || compare(a.id, b.id))
}

function summarize(snapshot: Snapshot, options: InsightsOptions, audience: PlatformAudience[]): InsightsSummary {
  const since = new Date(options.since ?? 0).toISOString()
  const latest = snapshot.posts.reduce((time, p) => Math.max(time, Date.parse(p.observedAt ?? p.publishedAt)), Date.parse(since))
  const asOf = new Date(options.asOf ?? latest).toISOString()
  if (Date.parse(since) > Date.parse(asOf)) throw new InsightsError('INSIGHTS_INPUT', 'The start date must come before the insights date.')
  const posts: InsightPost[] = snapshot.posts.filter((p) => p.publishedAt >= since && p.publishedAt <= asOf).map((p) => {
    const metrics = p.observedAt !== null && p.observedAt <= asOf ? { ...p.metrics } : emptyValues()
    if (metrics.averageWatchTimeMs !== null && p.durationMs !== null)
      metrics.completionEstimate = Math.min(1, metrics.averageWatchTimeMs / p.durationMs)
    const early = Date.parse(asOf) - Date.parse(p.publishedAt) < COUNTING_HOURS * 3_600_000
      || (p.observedAt !== null && Date.parse(p.observedAt) - Date.parse(p.publishedAt) < COUNTING_HOURS * 3_600_000)
    return { ...p, metrics, status: early ? 'still counting' : METRICS.some((m) => metrics[m] !== null) ? 'available' : 'unavailable' }
  })
  const settled = posts.filter((p) => p.status !== 'still counting')
  const week = new Date(asOf)
  week.setUTCHours(0, 0, 0, 0)
  week.setUTCDate(week.getUTCDate() - (week.getUTCDay() + 6) % 7)
  const weekStart = week.toISOString(), previousStart = new Date(week.getTime() - 7 * DAY).toISOString()
  const thisPosts = settled.filter((p) => p.publishedAt >= weekStart)
  const lastPosts = settled.filter((p) => p.publishedAt >= previousStart && p.publishedAt < weekStart)
  const current = totals(thisPosts), previous = totals(lastPosts)
  const changes: InsightChange[] = METRICS.map((metric) => {
    const a = complete(current, metric), b = complete(previous, metric)
    return { metric, current: a, previous: b, changePercent: change(a, b) }
  })
  const mostImproved = thisPosts.length >= MIN_POSTS && lastPosts.length >= MIN_POSTS
    ? changes.filter((c) => c.changePercent !== null && c.changePercent >= MIN_CHANGE_PERCENT)
      .sort((a, b) => (b.changePercent ?? 0) - (a.changePercent ?? 0) || compare(a.metric, b.metric))[0] ?? null : null
  const ranked = reels(posts).filter((r) => r.posts.every((p) => p.status === 'available') && complete(r.totals, 'plays') !== null && (r.totals.metrics.plays ?? 0) >= MIN_PLAYS)
    .sort((a, b) => (b.totals.metrics.plays ?? 0) - (a.totals.metrics.plays ?? 0) || compare(a.project, b.project) || a.version - b.version)
  const bestReel = ranked.length >= MIN_POSTS ? ranked[0] : null
  const sentences: InsightSentence[] = []
  if (!posts.length) sentences.push({ template: 'no-data', text: 'No post results yet', evidence: evidence([], null, 0) })
  else if (posts.every((p) => METRICS.every((m) => p.metrics[m] === null)))
    sentences.push({ template: 'no-stats', text: 'Post results are not available yet', evidence: evidence(posts, null, posts.length) })
  const counting = posts.filter((p) => p.status === 'still counting')
  if (counting.length) sentences.push({ template: 'still-counting', text: 'New posts are still counting', evidence: { ...evidence(counting, null, counting.length), minimumAgeHours: COUNTING_HOURS } })
  if (bestReel) sentences.push({ template: 'best-reel', text: `Your best reel has ${bestReel.totals.metrics.plays} plays`,
    evidence: evidence(bestReel.posts, 'plays', bestReel.totals.metrics.plays, null,
      ranked.map((r) => ({ label: `${r.project}/v${r.version}`, posts: refs(r.posts), value: r.totals.metrics.plays ?? 0 }))) })
  if (mostImproved) sentences.push({ template: 'most-improved', text: `${LABELS[mostImproved.metric]} improved most across weeks, up ${Math.round(mostImproved.changePercent ?? 0)}%`,
    evidence: evidence([...thisPosts, ...lastPosts], mostImproved.metric, mostImproved.current, mostImproved.previous, [
      { label: 'this UTC publication week', posts: refs(thisPosts), value: mostImproved.current ?? 0 },
      { label: 'last UTC publication week', posts: refs(lastPosts), value: mostImproved.previous ?? 0 }
    ]) })
  sentences.push(...cohortSentences(posts))
  return { since, asOf, basis: 'saved lifetime metrics by publication date', completionEstimateMethod: 'average watched fraction',
    reels: reels(posts), platforms: PLATFORMS.filter((platform) => posts.some((p) => p.platform === platform))
      .map((platform) => ({ platform, totals: totals(posts.filter((p) => p.platform === platform)) })),
    totals: totals(posts), trends: { thisWeek: { since: weekStart, until: asOf, totals: current },
      lastWeek: { since: previousStart, until: weekStart, totals: previous }, changes, bestReel, mostImproved },
    trials: snapshot.trials.filter((t) => posts.some((p) => p.project === t.project)), trialResults: trialResults(posts, snapshot.trials),
    audience, sentences }
}

/**
 * Read-only adapter. All scoring uses saved values and explicit dates, with no clock or network. `audience` is what the
 * results refresh last saved about who follows each account (results-refresh.ts); it is passed through as it is.
 */
export async function insightsSummary(projectsRoot: string, options: InsightsOptions = {}, audience: PlatformAudience[] = []): Promise<InsightsSummary> {
  const parsed = insightsOptions(options)
  return summarize(await load(projectsRoot), parsed, audience)
}
