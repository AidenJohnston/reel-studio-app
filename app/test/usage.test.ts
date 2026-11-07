// Anonymous usage data (src/main/usage.ts): opt in, a fixed shape per event, deleted on opt-out, sent only to an endpoint.
import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DataSharing, UsageEvent } from '../src/shared/api'
import { createUsage, editScore, invalidEvent, postViews, usageCode } from '../src/main/usage'

const ON: DataSharing = { asked: true, on: true, usage: true, quality: true, posts: true }
const JOB: UsageEvent = { part: 'usage', name: 'job', job: 'note', outcome: 'done', seconds: 42 }
const EDIT: UsageEvent = { part: 'quality', name: 'edit', outcome: 'kept' }

function setup(sharing: DataSharing, endpoint: string | null = null, fetch?: typeof globalThis.fetch, maxLines?: number) {
  const dir = join(mkdtempSync(join(tmpdir(), 'usage-')), 'usage')
  const state = { sharing }
  const usage = createUsage({ dir: () => dir, sharing: async () => state.sharing, version: '1.2.3', platform: 'win32', log: () => {}, endpoint, fetch, maxLines })
  return { dir, state, usage }
}

describe('usage data', () => {
  it('fails if anything is kept before the person turns sharing on, or for a part they left off', async () => {
    const off = setup({ asked: false, on: false, usage: true, quality: true, posts: true })
    expect(await off.usage.record(JOB)).toBe(false)
    expect(existsSync(off.dir)).toBe(false) // not even an install id
    const noQuality = setup({ ...ON, quality: false })
    expect(await noQuality.usage.record(EDIT)).toBe(false)
    expect(await noQuality.usage.record(JOB)).toBe(true)
    expect((await noQuality.usage.read()).map((l) => l.name)).toEqual(['job'])
  })

  it('fails if an event could carry a field or value outside its fixed shape', () => {
    expect(invalidEvent(JOB)).toBeNull()
    expect(invalidEvent({ ...JOB, code: 'ENGINE_STUCK' })).toBeNull()
    expect(invalidEvent({ ...JOB, title: 'My trip to Lisbon' })).toMatch(/no field title/)
    expect(invalidEvent({ ...JOB, code: 'C:\\Users\\me\\take.mov not found' })).toMatch(/code/)
    expect(invalidEvent({ ...JOB, job: 'my note' })).toMatch(/job/)
    expect(invalidEvent({ ...JOB, seconds: 4.5 })).toMatch(/seconds/)
    expect(invalidEvent({ ...JOB, part: 'posts' })).toMatch(/belongs to usage/)
    expect(invalidEvent({ part: 'posts', name: 'views', platform: 'instagram', views: 10 })).toMatch(/needs hours/)
    expect(invalidEvent({ part: 'usage', name: 'note-text' })).toMatch(/unknown event/)
  })

  it('fails if a refused event is written instead of thrown', async () => {
    const { usage } = setup(ON)
    await expect(usage.record({ ...JOB, note: 'cut the intro' } as unknown as UsageEvent)).rejects.toThrow(/no field note/)
    expect(await usage.read()).toEqual([])
  })

  it('fails if a line lacks its day, version, system and install id, or a new opt-in reuses the old id', async () => {
    const { usage, state, dir } = setup(ON)
    await usage.record(JOB)
    const [line] = await usage.read()
    expect(line).toMatchObject({ ...JOB, app: '1.2.3', os: 'win32' })
    expect(line.day).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    const first = line.install
    state.sharing = { ...ON, on: false }
    await usage.applySharing(state.sharing)
    expect(existsSync(join(dir, 'queue.jsonl'))).toBe(false)
    expect(existsSync(join(dir, 'install-id'))).toBe(false)
    state.sharing = ON
    await usage.record(JOB)
    const [again] = await usage.read()
    expect(again.install).not.toBe(first)
  })

  it('fails if an event that ends as sharing is switched off is written after it', async () => {
    const { usage, state, dir } = setup(ON)
    const late = usage.record(JOB)
    state.sharing = { ...ON, on: false }
    await usage.applySharing(state.sharing)
    expect(await late).toBe(false)
    expect(existsSync(join(dir, 'queue.jsonl'))).toBe(false)
  })

  it('fails if a part switched off keeps its lines', async () => {
    const { usage, state } = setup(ON)
    await usage.record(JOB)
    await usage.record(EDIT)
    state.sharing = { ...ON, usage: false }
    await usage.applySharing(state.sharing)
    expect((await usage.read()).map((l) => l.part)).toEqual(['quality'])
  })

  it('fails if the queue grows past its cap or drops the newest lines', async () => {
    const { usage } = setup(ON, null, undefined, 5)
    await Promise.all(Array.from({ length: 8 }, (_, i) => usage.record({ ...JOB, seconds: i })))
    expect((await usage.read()).map((l) => (l.name === 'job' ? l.seconds : null))).toEqual([3, 4, 5, 6, 7])
  })

  it('fails if anything is sent with no endpoint, or with sharing off', async () => {
    let calls = 0
    const fetch = (async () => ((calls += 1), new Response('{}'))) as typeof globalThis.fetch
    const none = setup(ON, null, fetch)
    await none.usage.record(JOB)
    expect(await none.usage.send()).toBe(0)
    const off = setup(ON, 'https://usage.example.com/v1', fetch)
    await off.usage.record(JOB)
    off.state.sharing = { ...ON, on: false }
    expect(await off.usage.send()).toBe(0)
    expect(calls).toBe(0)
  })

  it('fails if a send loses lines the endpoint did not accept, or keeps the ones it did', async () => {
    const bodies: string[] = []
    let status = 500
    const fetch = (async (_url: string, init: RequestInit) => (bodies.push(String(init.body)), new Response('', { status }))) as typeof globalThis.fetch
    const { usage, dir } = setup(ON, 'https://usage.example.com/v1', fetch)
    await usage.record(JOB)
    await usage.record(EDIT)
    await expect(usage.send()).rejects.toThrow(/500/)
    expect(await usage.read()).toHaveLength(2)
    status = 200
    expect(await usage.send()).toBe(2)
    expect(JSON.parse(bodies[1]).lines.map((l: { name: string }) => l.name)).toEqual(['job', 'edit'])
    expect(await usage.read()).toEqual([])
    expect(existsSync(join(dir, 'queue.jsonl'))).toBe(false)
    expect(readFileSync(join(dir, 'install-id'), 'utf8')).toMatch(/^[0-9a-f-]{36}$/)
  })

  // fails if a part switched off between the last write and a send still goes out
  it('sends only the parts switched on at the moment of sending', async () => {
    const bodies: string[] = []
    const fetch = (async (_url: string, init: RequestInit) => (bodies.push(String(init.body)), new Response(''))) as typeof globalThis.fetch
    const { usage, state } = setup(ON, 'https://usage.example.com/v1', fetch)
    await usage.record(JOB)
    await usage.record(EDIT)
    state.sharing = { ...ON, quality: false }
    expect(await usage.send()).toBe(1)
    expect(JSON.parse(bodies[0]).lines.map((l: { part: string }) => l.part)).toEqual(['usage'])
  })

  // fails if a temp copy a failed write left behind outlives opting out
  it('opting out removes the whole folder, temp files included', async () => {
    const { usage, state, dir } = setup(ON)
    await usage.record(JOB)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'queue.jsonl.0d1f.tmp'), 'left behind')
    state.sharing = { ...ON, on: false }
    await usage.applySharing(state.sharing)
    expect(existsSync(dir)).toBe(false)
  })

  // An opt-out saves the settings, then deletes the folder; the app can quit in between (audit 05-results).
  it('fails if what a cut-short opt-out left is readable after a restart', async () => {
    const first = setup(ON)
    await first.usage.record(JOB)
    first.state.sharing = { ...ON, on: false } // saved, and the app quit before the delete
    const restarted = createUsage({ dir: () => first.dir, sharing: async () => first.state.sharing, version: '1.2.3', platform: 'win32', log: () => {}, endpoint: null })
    void restarted.reconcile()
    expect(await restarted.read()).toEqual([])
    expect(existsSync(first.dir)).toBe(false)
  })
  it('fails if turning sharing back on reuses a queue or install id an opt-out left behind', async () => {
    const { dir, state, usage } = setup(ON)
    await usage.record(JOB)
    const oldId = readFileSync(join(dir, 'install-id'), 'utf8')
    const off = { ...ON, on: false }
    state.sharing = off // the delete never happened
    await usage.changeSharing(off, ON, async () => { state.sharing = ON })
    expect(await usage.read()).toEqual([])
    await usage.record(JOB)
    expect((await usage.read()).map((l) => l.install)).not.toContain(oldId)
  })
  it('fails if an edit is scored from the wrong next step', () => {
    expect(editScore({ type: 'export' }, 3)).toBe('kept')
    expect(editScore({ type: 'note', on: 3 }, 3)).toBe('changed')
    expect(editScore({ type: 'note', on: 2 }, 3)).toBe('undone')
  })

  it('fails if an error code that is not a constant reaches a line', () => {
    expect(usageCode('ENGINE_STUCK')).toBe('ENGINE_STUCK')
    // shaped like a code but not one of the app's: a title or id can't ride in on it
    expect(usageCode('MY_TRIP_TO_LISBON')).toBe('OTHER')
    expect(invalidEvent({ ...JOB, code: 'MY_TRIP_TO_LISBON' })).toMatch(/code/)
    expect(usageCode('ENOENT: no such file, open C:\\Users\\me\\take.mov')).toBe('OTHER')
  })

  // One correct answer per combination: a line is kept only with the main switch and its own part on. Post results
  // in particular go out only when sharing and Post results are both on.
  it('fails if any switch combination keeps a part it should not, or drops one it should keep', async () => {
    const VIEWS: UsageEvent = { part: 'posts', name: 'views', platform: 'tiktok', views: 900, hours: 72 }
    for (const on of [false, true]) for (const usage of [false, true]) for (const quality of [false, true]) for (const posts of [false, true]) {
      const sharing: DataSharing = { asked: true, on, usage, quality, posts }
      const t = setup(sharing)
      for (const e of [JOB, EDIT, VIEWS]) await t.usage.record(e)
      const expected = on ? (['usage', 'quality', 'posts'] as const).filter((k) => sharing[k]) : []
      expect((await t.usage.read()).map((l) => l.part), JSON.stringify(sharing)).toEqual(expected)
    }
  })
})

describe('post views from a results read', () => {
  const H = 3_600_000
  const PUBLISHED = Date.parse('2026-11-01T00:00:00.000Z')
  const read = (hours: number, plays: unknown = 1204) => ({
    version: 1, platform: 'instagram', postId: '9001', accountId: '17', publishedAt: new Date(PUBLISHED).toISOString(),
    observedAt: new Date(PUBLISHED + hours * H).toISOString(), metrics: { plays, reach: 900, likes: 3 }
  })
  const post = (lastReadHours: number | null) => ({ platform: 'instagram', publishedAt: PUBLISHED, observedAt: lastReadHours === null ? null : PUBLISHED + lastReadHours * H })

  // fails if every hourly read becomes a line, or a snapshot age is skipped
  it('keeps one line at the first read past each age', () => {
    expect(postViews(post(null), read(5))).toBeNull()
    expect(postViews(post(20), read(25))).toEqual({ part: 'posts', name: 'views', platform: 'instagram', views: 1204, hours: 25 })
    expect(postViews(post(25), read(26))).toBeNull()
    expect(postViews(post(70), read(80))).toMatchObject({ hours: 80 })
    expect(postViews(post(null), read(200))).toMatchObject({ hours: 200 })
    expect(postViews(post(800), read(900))).toBeNull()
  })

  // fails if a post, account or reel id reaches the line, or a read without a whole view count makes one
  it('holds only the platform, the count and the age', () => {
    const line = postViews(post(null), read(30))
    expect(Object.keys(line ?? {}).sort()).toEqual(['hours', 'name', 'part', 'platform', 'views'])
    expect(JSON.stringify(line)).not.toMatch(/9001|17"/)
    expect(postViews(post(null), read(30, null))).toBeNull()
    expect(postViews(post(null), read(30, 12.5))).toBeNull()
    expect(postViews(post(null), { metrics: { plays: 5 } })).toBeNull()
    expect(postViews({ ...post(null), platform: 'myspace' }, read(30))).toBeNull()
  })
})
