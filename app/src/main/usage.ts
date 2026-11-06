import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { DataSharing, EditOutcome, JobKind, UsageEvent, UsageLine } from '../shared/api'

/**
 * Anonymous usage data, opt in (Settings › Privacy). Off by default: until the person turns sharing on, and the part
 * an event belongs to, `record` writes nothing. What is recorded waits in `<userData>/usage/queue.jsonl`; the person can
 * read it in Settings, and `send` posts it only to an endpoint the app was built with. There is none yet
 * (shared/config.ts USAGE_ENDPOINT), so today nothing leaves the computer.
 *
 * Every event has a fixed shape: names from fixed lists, error codes, and whole numbers. `record` refuses any other
 * field or value, so no video, word, note, title or file name can get in by mistake. Lines carry a random install id,
 * made when sharing is turned on and deleted with the queue when it is turned off, so data from before and after a
 * pause can't be joined.
 */

const JOB_KINDS: readonly JobKind[] = ['first-edit', 'note', 'rerender', 'export', 'script', 'propose']
const PLATFORMS = ['instagram', 'tiktok', 'youtube', 'facebook'] as const
// error codes are constants such as ENGINE_STUCK, never text a person wrote
const CODE = /^[A-Z][A-Z0-9_]{1,40}$/
const count = (v: unknown): boolean => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1e12
const oneOf = (list: readonly string[]) => (v: unknown) => typeof v === 'string' && list.includes(v)

// For each event name, every field it may carry and the check its value must pass. Nothing else is allowed.
const SHAPES: Record<UsageEvent['name'], { part: UsageEvent['part']; fields: Record<string, (v: unknown) => boolean>; optional?: string[] }> = {
  job: {
    part: 'usage',
    fields: { job: oneOf(JOB_KINDS), outcome: oneOf(['done', 'failed', 'cancelled']), code: (v) => typeof v === 'string' && CODE.test(v), seconds: count },
    optional: ['code']
  },
  edit: { part: 'quality', fields: { outcome: oneOf(['kept', 'changed', 'undone']) } },
  views: { part: 'posts', fields: { platform: oneOf(PLATFORMS), views: count, hours: count } }
}

/** Why `e` may not be recorded, or null when it may. */
export function invalidEvent(e: unknown): string | null {
  if (!e || typeof e !== 'object') return 'not an object'
  const { part, name, ...rest } = e as Record<string, unknown>
  const shape = SHAPES[name as UsageEvent['name']]
  if (!shape) return `unknown event ${JSON.stringify(name)}`
  if (part !== shape.part) return `${String(name)} belongs to ${shape.part}, not ${JSON.stringify(part)}`
  for (const [k, v] of Object.entries(rest)) {
    const check = shape.fields[k]
    if (!check) return `${String(name)} has no field ${k}`
    if (!check(v)) return `${String(name)}.${k} may not be ${JSON.stringify(v)}`
  }
  for (const k of Object.keys(shape.fields)) if (!(k in rest) && !shape.optional?.includes(k)) return `${String(name)} needs ${k}`
  return null
}

/** An error code as it may be recorded: a constant such as ENGINE_STUCK, or OTHER for anything that isn't one. */
export const usageCode = (code: string): string => (CODE.test(code) ? code : 'OTHER')

/**
 * What became of the version an edit made, from the next thing done to that reel: exported or shared, it was kept;
 * a note on it, it was changed; a note on an older version instead, it was undone. Anything else (another reel, the
 * app closing) says nothing.
 */
export function editScore(next: { type: 'export' } | { type: 'note'; on: number }, made: number): EditOutcome {
  if (next.type === 'export') return 'kept'
  return next.on < made ? 'undone' : 'changed'
}

/**
 * Post results are kept as a few snapshots per post, not one line per read: at the first read after each of these ages
 * (a day, three days, a week, a month), which is when a reel's views are worth comparing. Hours since posting.
 */
export const VIEW_AGES_HOURS = [24, 72, 168, 720] as const

/**
 * The views line for a read of one post (main/results-refresh.ts), or null when this read crosses no snapshot age or
 * has no view count. It holds the platform, the count and the hours since posting; no post, account or reel id.
 */
export function postViews(post: { platform: string; publishedAt: number; observedAt: number | null }, outcome: unknown): UsageEvent | null {
  if (!outcome || typeof outcome !== 'object') return null
  const o = outcome as { observedAt?: unknown; metrics?: { plays?: unknown } | null }
  const observed = typeof o.observedAt === 'string' ? Date.parse(o.observedAt) : NaN
  const views = o.metrics?.plays
  if (!Number.isFinite(observed) || typeof views !== 'number' || !Number.isInteger(views) || views < 0) return null
  const hours = Math.floor((observed - post.publishedAt) / 3_600_000)
  const before = post.observedAt === null ? -1 : (post.observedAt - post.publishedAt) / 3_600_000
  if (!VIEW_AGES_HOURS.some((age) => before < age && hours >= age)) return null
  const e = { part: 'posts', name: 'views', platform: post.platform, views, hours }
  return invalidEvent(e) === null ? (e as UsageEvent) : null
}

/** The most lines kept waiting; the oldest go first. About 200 bytes each. */
export const MAX_LINES = 2000

export interface UsageDeps {
  /** the folder for the queue and the install id (read when needed: the app's paths are set after start-up) */
  dir: () => string
  sharing: () => Promise<DataSharing>
  version: string
  platform: string
  log: (line: string) => void
  /** where `send` posts; null: nowhere, and nothing is sent */
  endpoint: string | null
  fetch?: typeof fetch
  now?: () => Date
  /** the most lines kept (default MAX_LINES) */
  maxLines?: number
}

export function createUsage(d: UsageDeps) {
  const queue = (): string => join(d.dir(), 'queue.jsonl')
  const idFile = (): string => join(d.dir(), 'install-id')
  const now = d.now ?? (() => new Date())
  // one write at a time, so lines are never lost between a read and a rewrite
  let chain: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn)
    chain = next.catch(() => undefined)
    return next
  }

  async function lines(): Promise<UsageLine[]> {
    const text = await fs.readFile(queue(), 'utf8').catch((e) => (e?.code === 'ENOENT' ? '' : Promise.reject(e)))
    return text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as UsageLine)
  }
  const write = async (all: UsageLine[]): Promise<void> => {
    if (!all.length) return fs.rm(queue(), { force: true })
    await fs.mkdir(d.dir(), { recursive: true })
    const tmp = `${queue()}.tmp`
    await fs.writeFile(tmp, all.map((l) => JSON.stringify(l)).join('\n') + '\n')
    await fs.rename(tmp, queue())
  }
  async function installId(): Promise<string> {
    const have = (await fs.readFile(idFile(), 'utf8').catch(() => '')).trim()
    if (have) return have
    const id = randomUUID()
    await fs.mkdir(d.dir(), { recursive: true })
    await fs.writeFile(idFile(), id)
    return id
  }

  /** Records `e` when sharing and its part are on; throws when `e` has a field or value no event may carry. */
  async function record(e: UsageEvent): Promise<boolean> {
    const bad = invalidEvent(e)
    if (bad) throw new Error(`usage: refused event: ${bad}`)
    return serial(async () => {
      // read in turn with applySharing, so an event that ends as sharing is switched off is never written after it
      const s = await d.sharing()
      if (!s.on || !s[e.part]) return false
      const line: UsageLine = { ...e, day: now().toISOString().slice(0, 10), app: d.version, os: d.platform, install: await installId() }
      await write([...(await lines()), line].slice(-(d.maxLines ?? MAX_LINES)))
      return true
    })
  }

  /** After a change in Settings: sharing off deletes everything and the install id; a part turned off loses its lines. */
  function applySharing(s: DataSharing): Promise<void> {
    return serial(async () => {
      if (!s.on) {
        await fs.rm(queue(), { force: true })
        await fs.rm(idFile(), { force: true })
        return
      }
      const all = await lines()
      const kept = all.filter((l) => s[l.part])
      if (kept.length !== all.length) await write(kept)
    })
  }

  /** Posts what is waiting to the endpoint and drops what it accepted. No endpoint, or sharing off: nothing. */
  function send(): Promise<number> {
    return serial(async () => {
      if (!d.endpoint || !(await d.sharing()).on) return 0
      const all = await lines()
      if (!all.length) return 0
      const r = await (d.fetch ?? fetch)(d.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lines: all }),
        signal: AbortSignal.timeout(20_000)
      })
      if (!r.ok) throw new Error(`usage: the endpoint answered ${r.status}`)
      // only what was sent: lines recorded while it was on its way wait for the next send
      await write((await lines()).slice(all.length))
      return all.length
    })
  }

  return { record, read: () => serial(lines), applySharing, send, clear: () => applySharing({ asked: true, on: false, usage: false, quality: false, posts: false }) }
}

export type Usage = ReturnType<typeof createUsage>
