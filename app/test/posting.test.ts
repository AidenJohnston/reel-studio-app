// Posting to YouTube from the main process (main/posting.ts) against an in-memory posting server
// (test/fake-posting.ts): the key is traded once and only on a click, a dropped connection carries on from what the
// server really has, a stopped post can be finished later, and every server error becomes the plain words in
// shared/posting.ts. Nothing secret ever reaches the log.
import { describe, expect, it, vi } from 'vitest'
import { createPostingService, isVideoLink, postingConfig, troubleOf, userErrorFor, GIVE_UP_MS, type PendingEntry, type PostingDeps, type StoredSession } from '../src/main/posting'
import { POSTING_ERRORS, FIELD_ERRORS, PRICING_URL } from '../src/shared/posting'
import type { PostingStatus, PostProgress, PostRequest } from '../src/shared/api'
import { createFakePosting, type FakePosting } from './fake-posting'

const UNIT = 256 * 1024
const b64url = (s: string) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const KEY = `v1.${b64url(JSON.stringify({ s: 'cs_test_1', p: 'monthly', e: 1830000000 }))}.${'k'.repeat(43)}`
const VIDEO = '/exports/My video - Version 2.mp4'

function world(o: { size?: number; chunkSize?: number; enabled?: boolean; key?: string | null } = {}) {
  const fake: FakePosting = createFakePosting({ chunkSize: o.chunkSize ?? UNIT })
  fake.state.keys.set(KEY, { sid: 'cs_test_1', plan: 'monthly' })
  let clock = 1_762_140_000_000
  fake.state.now = () => clock
  const size = o.size ?? 600_000
  const bytes = new Uint8Array(size).map((_, i) => (i * 7 + 3) % 251)
  const files = new Map([[VIDEO, { bytes, mtimeMs: 1000 }]])
  const w = {
    fake,
    files,
    bytes,
    key: (o.key === undefined ? KEY : o.key) as string | null,
    session: null as StoredSession | null,
    pending: [] as PendingEntry[],
    sleeps: [] as number[],
    opened: [] as string[],
    logs: [] as string[],
    changes: [] as PostingStatus[],
    progress: [] as PostProgress[],
    /** Runs on every wait (the app's sleep): a test's "meanwhile". */
    onSleep: null as null | ((n: number) => void | Promise<void>),
    /** Runs when the app opens the browser: the person clicking Allow, or not. */
    onOpen: null as null | ((url: URL) => void),
    onChunk: null as null | ((start: number) => void),
    advance: (ms: number) => (clock += ms),
    now: () => clock
  }
  const deps: PostingDeps = {
    enabled: o.enabled ?? true,
    baseUrl: fake.origin,
    appVersion: '0.1.5',
    platform: 'win32',
    fetch: fake.fetch,
    now: () => clock,
    sleep: async (ms, signal) => {
      if (signal?.aborted) throw new Error('aborted')
      w.sleeps.push(ms)
      clock += ms
      await w.onSleep?.(w.sleeps.length)
      if (signal?.aborted) throw new Error('aborted')
    },
    getKey: async () => w.key,
    loadSession: async () => w.session,
    saveSession: async (s) => void (w.session = s),
    clearSession: async () => void (w.session = null),
    loadPending: async () => w.pending,
    savePending: async (l) => void (w.pending = l),
    readChunk: async (f, start, length) => {
      w.onChunk?.(start)
      return files.get(f)!.bytes.slice(start, start + length)
    },
    statFile: async (f) => {
      const x = files.get(f)
      return x ? { size: x.bytes.length, mtimeMs: x.mtimeMs } : null
    },
    isFinishedVideo: async (f) => (f.startsWith('/exports/') && f.endsWith('.mp4') && files.has(f) ? f : null),
    openExternal: async (u) => {
      w.opened.push(u)
      w.onOpen?.(new URL(u))
    },
    log: (l) => w.logs.push(l),
    send: (c, v) => (c === 'posting:change' ? w.changes.push(v as PostingStatus) : w.progress.push(v as PostProgress))
  }
  const svc = createPostingService(deps)
  return Object.assign(w, { svc, deps })
}

/** Signed in, YouTube connected: ready to post. */
async function ready(o: Parameters<typeof world>[0] = {}) {
  const t = world(o)
  await t.svc.signIn()
  t.fake.state.connections.set('cs_test_1', { status: 'connected', channelName: 'My channel', channelUrl: 'https://www.youtube.com/@me' })
  return t
}

/** Puts `fn` between the app and the fake server: it sees every call and can answer instead, or change the answer. */
function intercept(t: ReturnType<typeof world>, fn: (call: { method: string; path: string; length: number }, real: () => Promise<Response>) => Promise<Response>) {
  const real = t.fake.fetch
  t.deps.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const length = init?.body instanceof Uint8Array ? init.body.length : 0
    return fn({ method: init?.method ?? 'GET', path: new URL(String(input)).pathname, length }, () => real(input, init))
  }) as typeof fetch
}

const req = (extra: Partial<PostRequest> = {}): PostRequest => ({ video: VIDEO, slug: 'my-video', version: 2, title: 'How I got my first job', description: 'A short one.', privacy: 'private', madeForKids: false, ...extra })
const uploaded = (t: ReturnType<typeof world>) => [...t.fake.state.uploads.values()][0]
const secretsIn = (t: ReturnType<typeof world>, text: string) => {
  const found: string[] = []
  if (text.includes(KEY)) found.push('key')
  for (const s of t.fake.state.sessions.keys()) if (text.includes(s)) found.push('session')
  for (const a of t.fake.state.attempts.values()) if (text.includes(a.begin)) found.push('begin token')
  return found
}

describe('postingConfig (REELSTUDIO_POSTING, REELSTUDIO_POSTING_URL)', () => {
  const D = 'https://post.getreelstudio.com'
  it('is on for everyone, and off only with REELSTUDIO_POSTING=0', () => {
    expect(postingConfig({}, D, () => {})).toEqual({ enabled: true, baseUrl: D })
    expect(postingConfig({ REELSTUDIO_POSTING: '1' }, D, () => {})).toEqual({ enabled: true, baseUrl: D })
    expect(postingConfig({ REELSTUDIO_POSTING: '0' }, D, () => {})).toEqual({ enabled: false, baseUrl: D })
  })
  it('takes https anywhere, and http only on this computer; strips the trailing slash', () => {
    const on = (u: string) => postingConfig({ REELSTUDIO_POSTING: '1', REELSTUDIO_POSTING_URL: u }, D, () => {})
    expect(on('https://post-staging.getreelstudio.com/')).toEqual({ enabled: true, baseUrl: 'https://post-staging.getreelstudio.com' })
    expect(on('http://127.0.0.1:8788')).toEqual({ enabled: true, baseUrl: 'http://127.0.0.1:8788' })
    expect(on('http://localhost:8788/').baseUrl).toBe('http://localhost:8788')
    expect(on('http://[::1]:8788').baseUrl).toBe('http://[::1]:8788')
  })
  it('anything else keeps posting off and says so in the log', () => {
    const withUser = new URL('https://post.test')
    withUser.username = 'someone' // a user name in the address
    for (const bad of ['http://post.example.com', 'ftp://x', 'not a url', withUser.href, 'https://post.test/?a=1']) {
      const logs: string[] = []
      expect(postingConfig({ REELSTUDIO_POSTING: '1', REELSTUDIO_POSTING_URL: bad }, D, (l) => logs.push(l)).enabled).toBe(false)
      expect(logs).toEqual(['[posting] REELSTUDIO_POSTING_URL is not a usable address; posting stays off'])
    }
  })
})

describe('turned off', () => {
  it('status says so without any call; everything else answers POSTING_OFF', async () => {
    const t = world({ enabled: false })
    expect(await t.svc.status()).toMatchObject({ enabled: false, signedIn: false, youtube: null })
    for (const run of [() => t.svc.signIn(), () => t.svc.connect('youtube'), () => t.svc.post(req()), () => t.svc.pending('my-video', 2), () => t.svc.disconnect('youtube')])
      await expect((async () => run())()).rejects.toMatchObject({ code: 'POSTING_OFF', userMessage: POSTING_ERRORS.POSTING_OFF })
    expect(await t.svc.current()).toBeNull()
    expect(t.fake.state.calls).toEqual([])
  })
})

describe('signing in (the key is traded once, only on a click)', () => {
  it('status without a sign-in makes no call', async () => {
    const t = world()
    expect(await t.svc.status()).toEqual({ enabled: true, hasKey: true, signedIn: false, signedOutByServer: false, otherComputers: 0, youtube: null, ended: false, connecting: false })
    t.key = null
    expect((await t.svc.status()).hasKey).toBe(false)
    expect(t.fake.state.calls).toEqual([])
  })

  it('trades the key for a session, then sends only the session', async () => {
    const t = world()
    const s = await t.svc.signIn()
    expect(s).toMatchObject({ signedIn: true, youtube: null, otherComputers: 0 })
    expect(t.session).toMatchObject({ v: 1, server: t.fake.origin, plan: 'monthly' })
    expect([...t.fake.state.sessions.values()][0].device).toBe('Windows')
    await t.svc.status()
    expect(t.fake.state.auth.filter((a) => a.value === KEY).map((a) => a.path)).toEqual(['/v1/sessions'])
    expect(t.fake.state.calls.slice(-1)[0]).toBe('GET /v1/me auth=session')
    expect(t.changes.at(-1)?.signedIn).toBe(true)
  })

  it('no key, a key the server never signed, and an ended subscription each say what to do', async () => {
    const t = world({ key: null })
    await expect(t.svc.signIn()).rejects.toMatchObject({ code: 'NO_KEY', userMessage: POSTING_ERRORS.NO_KEY })
    t.key = 'v1.bogus.key'
    await expect(t.svc.signIn()).rejects.toMatchObject({ code: 'BAD_KEY', userMessage: POSTING_ERRORS.BAD_KEY })
    t.key = KEY
    t.fake.state.keys.get(KEY)!.ended = 'subscription ended'
    await expect(t.svc.signIn()).rejects.toMatchObject({ code: 'ENDED', userMessage: POSTING_ERRORS.ENDED, link: PRICING_URL })
    expect((await t.svc.status()).ended).toBe(true)
    expect(t.session).toBeNull()
  })

  it('a dropped connection while signing in is OFFLINE', async () => {
    const t = world()
    t.fake.state.faults.push({ on: 'session', network: true })
    await expect(t.svc.signIn()).rejects.toMatchObject({ code: 'OFFLINE' })
  })

  it('asks /v1/me at most every 30 seconds', async () => {
    const t = world()
    await t.svc.signIn()
    const before = t.fake.state.calls.length
    await t.svc.status()
    await t.svc.status()
    expect(t.fake.state.calls.length).toBe(before)
    t.advance(30_001)
    await t.svc.status()
    expect(t.fake.state.calls.length).toBe(before + 1)
  })

  it('a session for another server counts as none', async () => {
    const t = world()
    await t.svc.signIn()
    t.session = { ...t.session!, server: 'https://post-staging.example' }
    const calls = t.fake.state.calls.length
    expect((await t.svc.status()).signedIn).toBe(false)
    expect(t.fake.state.calls.length).toBe(calls)
  })

  it('signed out by the server (Sign out everywhere elsewhere): the session goes, and the key is NOT traded again by itself', async () => {
    const t = world()
    await t.svc.signIn()
    t.fake.state.sessions.clear()
    t.advance(31_000)
    const s = await t.svc.status()
    expect(s).toMatchObject({ signedIn: false, signedOutByServer: true })
    expect(t.session).toBeNull()
    t.advance(31_000)
    await t.svc.status()
    expect(t.fake.state.calls.filter((c) => c.startsWith('POST /v1/sessions'))).toHaveLength(1)
    expect(t.logs.join('\n')).toContain("the server ended this computer's sign-in")
    await t.svc.signIn()
    expect((await t.svc.status()).signedOutByServer).toBe(false)
  })

  it('a subscription that ends later shows as ended', async () => {
    const t = world()
    await t.svc.signIn()
    t.fake.state.keys.get(KEY)!.ended = 'refunded'
    t.advance(31_000)
    expect((await t.svc.status()).ended).toBe(true)
  })

  it('Sign out forgets the session even when the server cannot be reached', async () => {
    const t = world()
    await t.svc.signIn()
    t.fake.state.faults.push({ on: 'signout', network: true })
    expect((await t.svc.signOut()).signedIn).toBe(false)
    expect(t.session).toBeNull()
  })

  it('Sign out everywhere signs out every computer; offline, it keeps this one so it can be tried again', async () => {
    const t = world()
    await t.svc.signIn()
    await t.svc.signIn() // a second computer, same key (here: a second session)
    expect(t.fake.state.sessions.size).toBe(2)
    t.fake.state.faults.push({ on: 'signout', network: true })
    await expect(t.svc.signOutEverywhere()).rejects.toMatchObject({ code: 'OFFLINE' })
    expect(t.session).not.toBeNull()
    expect((await t.svc.signOutEverywhere()).signedIn).toBe(false)
    expect(t.fake.state.sessions.size).toBe(0)
    expect(t.session).toBeNull()
  })

  it('reports other computers and the connected channel', async () => {
    const t = world()
    await t.svc.signIn()
    await t.svc.signIn()
    t.fake.state.connections.set('cs_test_1', { status: 'connected', channelName: 'My channel', channelUrl: 'https://www.youtube.com/@me' })
    t.advance(31_000)
    expect(await t.svc.status()).toMatchObject({ otherComputers: 1, youtube: { state: 'connected', channelName: 'My channel', channelUrl: 'https://www.youtube.com/@me' } })
  })
})

describe('Connect YouTube', () => {
  const allow = (t: ReturnType<typeof world>, name: string | null = 'My channel') => (u: URL) => {
    const a = t.fake.state.attempts.get(u.searchParams.get('a')!)!
    t.onSleep = () => {
      a.status = 'connected'
      t.fake.state.connections.set(a.sid, { status: 'connected', channelName: name, channelUrl: name ? 'https://www.youtube.com/@me' : null })
    }
  }

  it('signs in first, opens only the server\'s own page, and waits for the browser', async () => {
    const t = world()
    t.onOpen = allow(t)
    const r = await t.svc.connect('youtube')
    expect(r.outcome).toBe('connected')
    expect(r.status).toMatchObject({ signedIn: true, connecting: false, youtube: { state: 'connected', channelName: 'My channel' } })
    expect(t.opened).toHaveLength(1)
    expect(new URL(t.opened[0]).origin + new URL(t.opened[0]).pathname).toBe(`${t.fake.origin}/oauth/youtube/begin`)
    expect(t.sleeps.every((ms) => ms === 2000)).toBe(true)
    expect(t.changes.some((s) => s.connecting)).toBe(true)
  })

  it('readonly unticked: connected, channel unknown', async () => {
    const t = world()
    t.onOpen = allow(t, null)
    const r = await t.svc.connect('youtube')
    expect(r.status.youtube).toEqual({ state: 'connected', channelName: null, channelUrl: null })
  })

  it('already connected (from another computer): nothing to open', async () => {
    const t = world()
    t.fake.state.connections.set('cs_test_1', { status: 'connected', channelName: 'My channel', channelUrl: null })
    expect((await t.svc.connect('youtube')).outcome).toBe('connected')
    expect(t.opened).toEqual([])
  })

  it('never opens a link that is not the posting server\'s own page', async () => {
    const t = world()
    t.fake.state.openUrlOrigin = 'https://evil.example'
    await expect(t.svc.connect('youtube')).rejects.toMatchObject({ code: 'SERVER' })
    expect(t.opened).toEqual([])
    expect((await t.svc.status()).connecting).toBe(false)
  })

  for (const outcome of ['denied', 'missing_permission', 'no_channel', 'failed'] as const)
    it(`passes on "${outcome}"`, async () => {
      const t = world()
      t.onOpen = (u) => {
        const a = t.fake.state.attempts.get(u.searchParams.get('a')!)!
        t.onSleep = () => void (a.status = outcome)
      }
      expect((await t.svc.connect('youtube')).outcome).toBe(outcome)
    })

  it('gives up when the link runs out (10 minutes), and rides out a dropped connection meanwhile', async () => {
    const t = world()
    t.fake.state.faults.push({ on: 'poll', network: true, times: 3 })
    const r = await t.svc.connect('youtube')
    expect(r.outcome).toBe('expired')
    expect(t.sleeps.length).toBeGreaterThan(290)
  })

  it('Cancel stops waiting and cancels the attempt on the server', async () => {
    const t = world()
    t.onSleep = (n) => {
      if (n === 3) void t.svc.cancelConnect()
    }
    const r = await t.svc.connect('youtube')
    expect(r.outcome).toBe('cancelled')
    expect([...t.fake.state.attempts.values()][0].status).toBe('cancelled')
    expect(t.fake.state.calls).toContain(`DELETE /v1/connections/youtube/attempts/${[...t.fake.state.attempts.keys()][0]} auth=session`)
  })

  it('Open the page again makes a fresh one-time link and keeps waiting on it', async () => {
    const t = world()
    t.onSleep = async (n) => {
      if (n === 2) await t.svc.reopenConnect()
      if (n === 4) {
        const [first, second] = [...t.fake.state.attempts.values()]
        expect(first.status).toBe('cancelled')
        second.status = 'connected'
        t.fake.state.connections.set('cs_test_1', { status: 'connected', channelName: 'My channel', channelUrl: null })
      }
    }
    expect((await t.svc.connect('youtube')).outcome).toBe('connected')
    expect(t.opened).toHaveLength(2)
    expect(t.opened[0]).not.toBe(t.opened[1])
  })

  it("waits by this computer's clock, so a clock that is off doesn't make every connect run out", async () => {
    const t = world()
    t.fake.state.now = () => t.now() - 3 * 3600_000 // the server's clock is 3 hours behind
    t.onOpen = allow(t)
    expect((await t.svc.connect('youtube')).outcome).toBe('connected')
  })

  it('a second Connect while one waits gets the same answer', async () => {
    const t = world()
    t.onOpen = allow(t)
    const [a, b] = [t.svc.connect('youtube'), t.svc.connect('youtube')]
    expect(a).toBe(b)
    expect((await a).outcome).toBe('connected')
  })

  it('reconnect needed shows as such; Connect runs the browser part again', async () => {
    const t = world()
    await t.svc.signIn()
    t.fake.state.connections.set('cs_test_1', { status: 'reconnect', channelName: null, channelUrl: null })
    t.advance(31_000)
    expect((await t.svc.status()).youtube?.state).toBe('reconnect')
    t.onOpen = allow(t)
    expect((await t.svc.connect('youtube')).outcome).toBe('connected')
    expect(t.opened).toHaveLength(1)
  })

  it('no key: NO_KEY, nothing opened', async () => {
    const t = world({ key: null })
    await expect(t.svc.connect('youtube')).rejects.toMatchObject({ code: 'NO_KEY' })
    expect(t.opened).toEqual([])
  })

  it('Disconnect removes the connection', async () => {
    const t = await ready()
    expect((await t.svc.disconnect('youtube')).youtube).toBeNull()
    expect(t.fake.state.connections.size).toBe(0)
  })
})

describe('posting', () => {
  it('sends the file in chunks and ends with the video\'s links', async () => {
    const t = await ready()
    const p = await t.svc.post(req())
    expect(p).toMatchObject({ step: 'done', sent: 600_000, total: 600_000, slug: 'my-video', version: 2 })
    expect(p.result).toEqual({
      videoId: 'dQw4w9WgXcQ',
      videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      studioUrl: 'https://studio.youtube.com/video/dQw4w9WgXcQ/edit',
      privacy: 'private',
      channelName: 'My channel'
    })
    const u = uploaded(t)
    expect(u.title).toBe('How I got my first job')
    expect(Buffer.from(u.bytes).equals(Buffer.from(t.bytes))).toBe(true)
    expect(t.fake.state.calls.filter((c) => c.startsWith('PUT')).map((c) => c.split(' ')[3])).toEqual(['0-262143/600000', '262144-524287/600000', '524288-599999/600000'])
    expect(t.pending).toEqual([])
    expect(t.progress[0].step).toBe('starting')
    expect(t.progress.at(-1)?.step).toBe('done')
    expect(await t.svc.current()).toBeNull()
  })

  it('reports what YouTube set when it differs from what was asked', async () => {
    const t = await ready()
    t.fake.state.forcePrivacy = 'private'
    expect((await t.svc.post(req({ privacy: 'public' }))).result?.privacy).toBe('private')
  })

  it('always carries on from what the server says it has, even when YouTube kept only part of a chunk', async () => {
    const t = await ready({ size: 3 * UNIT + 1000, chunkSize: 2 * UNIT })
    t.fake.state.shortChunks = UNIT
    const p = await t.svc.post(req())
    expect(p.step).toBe('done')
    expect(Buffer.from(uploaded(t).bytes).equals(Buffer.from(t.bytes))).toBe(true)
    const starts = t.fake.state.calls.filter((c) => c.startsWith('PUT')).map((c) => Number(c.split(' ')[3].split('-')[0]))
    expect(starts).toEqual([0, UNIT, 2 * UNIT]) // 2 chunks of which YouTube kept half, then the rest in one
  })

  it('jumps to the server\'s offset after offset_mismatch', async () => {
    const t = await ready()
    t.fake.state.mismatch = { at: UNIT, received: 0 }
    expect((await t.svc.post(req())).step).toBe('done')
    expect(t.fake.state.calls.filter((c) => c.startsWith('PUT')).map((c) => c.split(' ')[3].split('-')[0])).toEqual(['0', String(UNIT), '0', String(UNIT), String(2 * UNIT)])
  })

  it('a dropped connection: waits, asks how much YouTube really has, and resumes from there', async () => {
    const t = await ready()
    t.fake.state.faults.push({ on: 'chunk', network: true, keepBytes: UNIT, times: 1 })
    t.fake.state.faults.push({ on: 'status', network: true, times: 1 })
    const p = await t.svc.post(req())
    expect(p.step).toBe('done')
    expect(Buffer.from(uploaded(t).bytes).equals(Buffer.from(t.bytes))).toBe(true)
    expect(t.sleeps).toEqual([2000, 4000])
    const retrying = t.progress.filter((x) => x.step === 'retrying')
    expect(retrying.map((x) => x.retryInSec)).toEqual([2, 4])
    expect(retrying.map((x) => x.retryReason)).toEqual(['offline', 'offline'])
    // after the drop the next chunk starts at the server's count (UNIT), not at 0 or the app's own guess
    expect(t.fake.state.calls.filter((c) => c.startsWith('PUT')).map((c) => c.split(' ')[3].split('-')[0])).toEqual(['0', String(UNIT), String(2 * UNIT)])
  })

  it('YouTube having a moment (502 retry) is retried, the waits growing to 30 seconds', async () => {
    const t = await ready()
    t.fake.state.faults.push({ on: 'chunk', status: 502, body: { error: 'platform_error', retry: true } })
    t.fake.state.faults.push({ on: 'status', status: 502, body: { error: 'platform_error', retry: true }, times: 5 })
    expect((await t.svc.post(req())).step).toBe('done')
    expect(t.sleeps).toEqual([2000, 4000, 8000, 16000, 30000, 30000])
    // the sheet says YouTube is busy, not that this computer's connection dropped
    expect(new Set(t.progress.filter((x) => x.step === 'retrying').map((x) => x.retryReason))).toEqual(new Set(['youtube']))
  })

  it('after 5 minutes without progress it stops; Finish posting picks it up later', async () => {
    const t = await ready()
    t.fake.state.faults.push({ on: 'chunk', network: true, keepBytes: UNIT, times: 1 })
    t.fake.state.faults.push({ on: 'status', network: true, times: 100 })
    const p = await t.svc.post(req())
    expect(p).toMatchObject({ step: 'failed', canResume: true, error: { code: 'OFFLINE', userMessage: POSTING_ERRORS.OFFLINE } })
    expect(t.sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(GIVE_UP_MS)
    expect(t.pending).toHaveLength(1)
    expect(t.pending[0]).toMatchObject({ slug: 'my-video', version: 2, size: 600_000, server: t.fake.origin, sent: 0 })

    // later (even after a restart): the server is back
    t.fake.state.faults.length = 0
    const pend = await t.svc.pending('my-video', 2)
    expect(pend).toEqual({ uploadId: t.pending[0].uploadId, slug: 'my-video', version: 2, sent: UNIT, total: 600_000 })
    const done = await t.svc.resume(pend!.uploadId)
    expect(done.step).toBe('done')
    expect(Buffer.from(uploaded(t).bytes).equals(Buffer.from(t.bytes))).toBe(true)
    expect(t.pending).toEqual([])
  })

  it('gave up while YouTube kept failing: PLATFORM, and it can still be finished', async () => {
    const t = await ready()
    t.fake.state.faults.push({ on: 'chunk', status: 502, body: { error: 'platform_error', retry: true } })
    t.fake.state.faults.push({ on: 'status', status: 502, body: { error: 'platform_error', retry: true }, times: 100 })
    expect(await t.svc.post(req())).toMatchObject({ step: 'failed', canResume: true, error: { code: 'PLATFORM' } })
    expect(t.pending).toHaveLength(1)
  })

  it('pending(): a changed file or a finished upload is forgotten', async () => {
    const t = await ready()
    t.fake.state.faults.push({ on: 'chunk', network: true, times: 1 })
    t.fake.state.faults.push({ on: 'status', network: true, times: 100 })
    await t.svc.post(req())
    expect(t.pending).toHaveLength(1)
    t.fake.state.faults.length = 0
    expect(await t.svc.pending('my-video', 3)).toBeNull() // another version
    t.files.get(VIDEO)!.mtimeMs = 2000
    await expect(t.svc.resume(t.pending[0].uploadId)).rejects.toMatchObject({ code: 'FILE_CHANGED', userMessage: POSTING_ERRORS.FILE_CHANGED })
    expect(await t.svc.pending('my-video', 2)).toBeNull()
    expect(t.pending).toEqual([])
  })

  it('pending(): offline, it still offers Finish posting with what was confirmed', async () => {
    const t = await ready()
    t.fake.state.faults.push({ on: 'chunk', network: true, keepBytes: UNIT, times: 1 })
    t.fake.state.faults.push({ on: 'status', network: true, times: 1000 })
    await t.svc.post(req())
    expect(await t.svc.pending('my-video', 2)).toMatchObject({ sent: 0, total: 600_000 })
    expect(t.pending).toHaveLength(1)
  })

  it('a stopped post older than 3 days is not offered (the server has given up on it)', async () => {
    const t = await ready()
    t.fake.state.faults.push({ on: 'chunk', network: true, times: 1 })
    t.fake.state.faults.push({ on: 'status', network: true, times: 100 })
    await t.svc.post(req())
    t.fake.state.faults.length = 0
    t.advance(3 * 24 * 3600_000)
    expect(await t.svc.pending('my-video', 2)).toBeNull()
    await t.svc.post(req()) // the next post writes the list without it
    expect(t.pending).toEqual([])
  })

  it('Start over cancels the stopped post on the server and forgets it', async () => {
    const t = await ready()
    t.fake.state.faults.push({ on: 'chunk', network: true, times: 1 })
    t.fake.state.faults.push({ on: 'status', network: true, times: 100 })
    await t.svc.post(req())
    t.fake.state.faults.length = 0
    await t.svc.discard(t.pending[0].uploadId)
    expect(uploaded(t).status).toBe('cancelled')
    expect(t.pending).toEqual([])
  })

  it('Stop: the chunk is dropped, the upload is cancelled on the server and forgotten', async () => {
    const t = await ready()
    t.onChunk = (start) => {
      if (start === UNIT) void t.svc.cancel()
    }
    const p = await t.svc.post(req())
    expect(p.step).toBe('cancelled')
    expect(uploaded(t).status).toBe('cancelled')
    expect(t.pending).toEqual([])
    expect(t.progress.at(-1)?.step).toBe('cancelled')
  })

  it('Stop after YouTube already had the last chunk: the server says done, so the post is done', async () => {
    const t = await ready()
    intercept(t, async (call, real) => {
      const res = await real()
      if (call.method === 'PUT' && uploaded(t).status === 'done') void t.svc.cancel()
      return res
    })
    const p = await t.svc.post(req({ privacy: 'unlisted' }))
    expect(p.step).toBe('done')
    expect(p.result).toMatchObject({ videoId: 'dQw4w9WgXcQ', privacy: 'unlisted' })
    expect(t.fake.state.calls.some((c) => c.startsWith('DELETE /v1/uploads/'))).toBe(true)
    expect(uploaded(t).status).toBe('done')
    expect(t.pending).toEqual([])
    expect(t.progress.at(-1)?.step).toBe('done')
  })

  it('Stop while waiting to try again', async () => {
    const t = await ready()
    t.fake.state.faults.push({ on: 'chunk', network: true, times: 1 })
    t.onSleep = () => void t.svc.cancel()
    expect((await t.svc.post(req())).step).toBe('cancelled')
    expect(uploaded(t).status).toBe('cancelled')
  })

  it('one post at a time', async () => {
    const t = await ready()
    let second: Promise<unknown> | null = null
    t.onChunk = () => {
      second ??= t.svc.post(req())
    }
    expect((await t.svc.post(req())).step).toBe('done')
    await expect(second!).rejects.toMatchObject({ code: 'BUSY', userMessage: POSTING_ERRORS.BUSY })
  })

  it('current() hands the running post to a sheet opened again', async () => {
    const t = await ready()
    let seen: PostProgress | null = null
    t.onChunk = (start) => {
      if (start === UNIT) void t.svc.current().then((c) => (seen = c))
    }
    await t.svc.post(req())
    expect(seen).toMatchObject({ step: 'sending', sent: UNIT, slug: 'my-video', version: 2 })
  })

  it('only a finished video in Library › Finished videos, and only fields YouTube takes', async () => {
    const t = await ready()
    for (const video of ['/elsewhere/clip.mp4', '/exports/clip.mov', '/exports/missing.mp4'])
      await expect(t.svc.post(req({ video }))).rejects.toMatchObject({ code: 'NOT_A_FINISHED_VIDEO', userMessage: POSTING_ERRORS.NOT_A_FINISHED_VIDEO })
    await expect(t.svc.post(req({ title: '  ' }))).rejects.toMatchObject({ code: 'BAD_FIELD', userMessage: FIELD_ERRORS.title })
    await expect(t.svc.post(req({ title: 'a <b>' }))).rejects.toMatchObject({ code: 'BAD_FIELD', userMessage: FIELD_ERRORS.title })
    await expect(t.svc.post(req({ title: 'x'.repeat(101) }))).rejects.toMatchObject({ code: 'BAD_FIELD' })
    await expect(t.svc.post(req({ description: 'é'.repeat(2501) }))).rejects.toMatchObject({ code: 'BAD_FIELD', userMessage: FIELD_ERRORS.description })
    await expect(t.svc.post(req({ privacy: 'friends' as never }))).rejects.toMatchObject({ code: 'BAD_FIELD', userMessage: FIELD_ERRORS.privacy })
    expect(t.fake.state.uploads.size).toBe(0)
  })

  it('signed out: SIGNED_OUT before anything is sent', async () => {
    const t = world()
    await expect(t.svc.post(req())).rejects.toMatchObject({ code: 'SIGNED_OUT' })
  })

  it('signed out part way: the post is kept for after Sign in', async () => {
    const t = await ready()
    t.onChunk = (start) => {
      if (start === UNIT) t.fake.state.sessions.clear()
    }
    const p = await t.svc.post(req())
    expect(p).toMatchObject({ step: 'failed', canResume: false, error: { code: 'SIGNED_OUT', userMessage: POSTING_ERRORS.SIGNED_OUT } })
    expect(t.session).toBeNull()
    expect(t.pending).toHaveLength(1)
    expect((await t.svc.status()).signedOutByServer).toBe(true)
  })

  it('YouTube forgot the upload (410): EXPIRED, and it is not offered again', async () => {
    const t = await ready()
    t.fake.state.faults.push({ on: 'chunk', status: 410, body: { error: 'upload_expired' } })
    expect(await t.svc.post(req())).toMatchObject({ step: 'failed', canResume: false, error: { code: 'EXPIRED', userMessage: POSTING_ERRORS.EXPIRED } })
    expect(t.pending).toEqual([])
  })

  it('the channel\'s own daily limit mid-upload: UPLOAD_LIMIT', async () => {
    const t = await ready()
    t.fake.state.faults.push({ on: 'chunk', status: 429, body: { error: 'upload_limit' } })
    expect((await t.svc.post(req())).error).toMatchObject({ code: 'UPLOAD_LIMIT', userMessage: POSTING_ERRORS.UPLOAD_LIMIT })
  })

  const initErrors: [number, Record<string, unknown>, string, string][] = [
    [429, { error: 'quota' }, 'QUOTA', POSTING_ERRORS.QUOTA],
    [429, { error: 'upload_limit' }, 'UPLOAD_LIMIT', POSTING_ERRORS.UPLOAD_LIMIT],
    [429, { error: 'rate_limited' }, 'RATE_LIMITED', POSTING_ERRORS.RATE_LIMITED],
    [409, { error: 'not_connected' }, 'NOT_CONNECTED', POSTING_ERRORS.NOT_CONNECTED],
    [409, { error: 'reconnect_needed' }, 'RECONNECT', POSTING_ERRORS.RECONNECT],
    [409, { error: 'no_channel' }, 'NO_CHANNEL', POSTING_ERRORS.NO_CHANNEL],
    [503, { error: 'not_configured', what: 'google' }, 'NOT_CONFIGURED', POSTING_ERRORS.NOT_CONFIGURED],
    [400, { error: 'bad_request', field: 'description' }, 'BAD_FIELD', FIELD_ERRORS.description],
    [400, { error: 'bad_request', field: 'size' }, 'SERVER', POSTING_ERRORS.SERVER],
    [403, { error: 'not_entitled', reason: 'disputed' }, 'ENDED', POSTING_ERRORS.ENDED],
    [500, { error: 'server_error' }, 'SERVER', POSTING_ERRORS.SERVER],
    [502, { error: 'platform_error', retry: false }, 'PLATFORM', POSTING_ERRORS.PLATFORM]
  ]
  for (const [status, body, code, message] of initErrors)
    it(`starting a post: ${status} ${String(body.error)} → ${code}`, async () => {
      const t = await ready()
      t.fake.state.faults.push({ on: 'init', status, body })
      const p = await t.svc.post(req())
      expect(p).toMatchObject({ step: 'failed', canResume: false, error: { code, userMessage: message } })
      expect(t.pending).toEqual([])
    })

  it('starting a post offline: OFFLINE, nothing to finish', async () => {
    const t = await ready()
    t.fake.state.faults.push({ on: 'init', network: true })
    expect(await t.svc.post(req())).toMatchObject({ step: 'failed', canResume: false, error: { code: 'OFFLINE' } })
  })
})

describe('posting: the server failing for a moment', () => {
  it('a 500 on a chunk (a database blip) is tried again, not the end of the post', async () => {
    const t = await ready()
    t.fake.state.faults.push({ on: 'chunk', status: 500, body: { error: 'server_error' } })
    const p = await t.svc.post(req())
    expect(p.step).toBe('done')
    expect(Buffer.from(uploaded(t).bytes).equals(Buffer.from(t.bytes))).toBe(true)
    expect(t.progress.find((x) => x.step === 'retrying')?.retryReason).toBe('server')
  })

  it("an edge error page that isn't our JSON (522, then a cut-off GET) is tried again too", async () => {
    const t = await ready()
    let puts = 0
    let gets = 0
    intercept(t, async (c, real) => {
      if (c.method === 'PUT' && ++puts === 2) return new Response('<html>522 Connection timed out</html>', { status: 522 })
      if (c.method === 'GET' && c.path.startsWith('/v1/uploads/') && ++gets === 1) return new Response('{"status":', { status: 200 })
      return real()
    })
    expect((await t.svc.post(req())).step).toBe('done')
    expect(Buffer.from(uploaded(t).bytes).equals(Buffer.from(t.bytes))).toBe(true)
  })

  it('YouTube took the last chunk but the server answered 500: the GET finds the video, nothing is sent twice', async () => {
    const t = await ready()
    intercept(t, async (c, real) => {
      const res = await real()
      return c.method === 'PUT' && uploaded(t)?.status === 'done' ? new Response(JSON.stringify({ error: 'server_error' }), { status: 500 }) : res
    })
    const p = await t.svc.post(req())
    expect(p).toMatchObject({ step: 'done', result: { videoId: 'dQw4w9WgXcQ' } })
    expect(t.fake.state.calls.filter((c) => c.startsWith('POST /v1/uploads'))).toHaveLength(1)
    expect(t.fake.state.calls.filter((c) => c.startsWith('PUT'))).toHaveLength(3)
    expect(t.pending).toEqual([])
  })

  it('gave up while the server kept failing: SERVER, kept, and Finish posting can pick it up', async () => {
    const t = await ready()
    t.fake.state.faults.push({ on: 'chunk', status: 500, body: { error: 'server_error' } })
    t.fake.state.faults.push({ on: 'status', status: 500, body: { error: 'server_error' }, times: 100 })
    expect(await t.svc.post(req())).toMatchObject({ step: 'failed', canResume: true, error: { code: 'SERVER', userMessage: POSTING_ERRORS.SERVER } })
    expect(t.pending).toHaveLength(1)
    t.fake.state.faults.length = 0
    expect((await t.svc.resume(t.pending[0].uploadId)).step).toBe('done')
  })

  it('a final server error part way (not one to retry) still keeps the post for Finish posting', async () => {
    const t = await ready()
    t.fake.state.faults.push({ on: 'chunk', status: 400, body: { error: 'bad_request', field: 'content_range' } })
    expect(await t.svc.post(req())).toMatchObject({ step: 'failed', canResume: true, error: { code: 'SERVER' } })
    expect(t.pending).toHaveLength(1)
  })

  it('troubleOf: what is safe to try again', () => {
    expect(troubleOf(502, { error: 'platform_error', retry: true })).toBe('PLATFORM')
    expect(troubleOf(502, { error: 'platform_error', retry: false })).toBeNull()
    expect(troubleOf(500, { error: 'server_error' })).toBe('SERVER')
    expect(troubleOf(503, { error: 'not_configured', what: 'db' })).toBeNull()
    expect(troubleOf(522, null)).toBe('SERVER')
    expect(troubleOf(200, null)).toBe('SERVER')
    for (const [status, body] of [[409, { error: 'reconnect_needed' }], [410, { error: 'upload_expired' }], [429, { error: 'quota' }], [401, null], [403, null], [404, null]] as const)
      expect(troubleOf(status, body), String(status)).toBeNull()
  })
})

describe('posting on a slow connection', () => {
  it('a chunk that runs out of time is sent in smaller pieces, so the post still gets through', async () => {
    const MiB = 1024 * 1024
    const t = await ready({ size: 3 * MiB + 1000, chunkSize: 4 * MiB })
    // this uplink only gets 1 MiB through before the timeout
    const lengths: number[] = []
    intercept(t, async (c, real) => {
      if (c.method === 'PUT') lengths.push(c.length)
      if (c.method === 'PUT' && c.length > MiB) throw new DOMException('The operation timed out.', 'TimeoutError')
      return real()
    })
    const p = await t.svc.post(req())
    expect(p.step).toBe('done')
    expect(Buffer.from(uploaded(t).bytes).equals(Buffer.from(t.bytes))).toBe(true)
    expect(lengths.slice(0, 4)).toEqual([3 * MiB + 1000, 2 * MiB, MiB, MiB]) // halved twice, then each goes through
    expect(t.logs.some((l) => l.includes('ran out of time'))).toBe(true)
  })

  it('a chunk is never made smaller than 256 KiB', async () => {
    const t = await ready({ size: 600_000, chunkSize: UNIT })
    const lengths: number[] = []
    intercept(t, async (c, real) => {
      if (c.method === 'PUT' && lengths.push(c.length) <= 2) throw new DOMException('The operation timed out.', 'TimeoutError')
      return real()
    })
    expect((await t.svc.post(req())).step).toBe('done')
    expect(lengths.slice(0, 3)).toEqual([UNIT, UNIT, UNIT])
  })
})

describe('posting: the YouTube connection changed on the server', () => {
  it('connect again needed (the weekly Testing expiry): the post fails RECONNECT and the pages hear it at once', async () => {
    const t = await ready()
    t.advance(31_000)
    expect((await t.svc.status()).youtube?.state).toBe('connected') // cached for 30 seconds
    t.fake.state.connections.set('cs_test_1', { status: 'reconnect', channelName: 'My channel', channelUrl: null })
    const p = await t.svc.post(req())
    expect(p).toMatchObject({ step: 'failed', error: { code: 'RECONNECT' } })
    await vi.waitFor(() => expect(t.changes.at(-1)?.youtube?.state).toBe('reconnect'))
    expect((await t.svc.status()).youtube?.state).toBe('reconnect') // not the cached "connected"
  })

  it('disconnected on another computer: NOT_CONNECTED, and the pages show no channel', async () => {
    const t = await ready()
    t.advance(31_000)
    expect((await t.svc.status()).youtube?.state).toBe('connected')
    t.fake.state.connections.clear()
    expect(await t.svc.post(req())).toMatchObject({ step: 'failed', error: { code: 'NOT_CONNECTED' } })
    await vi.waitFor(() => expect(t.changes.at(-1)).toMatchObject({ signedIn: true, youtube: null }))
  })

  it('the upload was removed part way (its connection removed elsewhere): EXPIRED, not a server error, and the pages hear it', async () => {
    const t = await ready()
    t.advance(31_000)
    expect((await t.svc.status()).youtube?.state).toBe('connected')
    t.onChunk = (start) => {
      if (start !== UNIT) return
      t.fake.state.connections.clear()
      t.fake.state.uploads.clear()
    }
    expect(await t.svc.post(req())).toMatchObject({ step: 'failed', canResume: false, error: { code: 'EXPIRED', userMessage: POSTING_ERRORS.EXPIRED } })
    expect(t.pending).toEqual([])
    await vi.waitFor(() => expect(t.changes.at(-1)?.youtube).toBeNull())
  })
})

describe('posting: the links after a post', () => {
  it("are made from the video's id; the server's own url strings are never used", async () => {
    const t = await ready()
    intercept(t, async (_c, real) => {
      const res = await real()
      const b = (await res.json()) as any
      if (b?.status === 'done') {
        b.video.url = 'https://phish.example/watch'
        b.video.studioUrl = 'https://www.youtube.com/redirect?q=https://phish.example'
      }
      return new Response(JSON.stringify(b), { status: res.status })
    })
    const p = await t.svc.post(req())
    expect(p.result).toMatchObject({ videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', studioUrl: 'https://studio.youtube.com/video/dQw4w9WgXcQ/edit' })
  })

  it("a video id that isn't one: SERVER, and the post is not offered again", async () => {
    const t = await ready()
    intercept(t, async (_c, real) => {
      const res = await real()
      const b = (await res.json()) as any
      if (b?.status === 'done') b.video.id = '../../evil?x='
      return new Response(JSON.stringify(b), { status: res.status })
    })
    expect(await t.svc.post(req())).toMatchObject({ step: 'failed', canResume: false, error: { code: 'SERVER' } })
    expect(t.pending).toEqual([])
  })
})

describe('userErrorFor: every server error has plain words', () => {
  const table: [number, unknown, string][] = [
    [400, { error: 'bad_request', field: 'title' }, 'BAD_FIELD'],
    [400, { error: 'bad_request', field: 'privacy' }, 'BAD_FIELD'],
    [400, { error: 'bad_request', field: 'content_range' }, 'SERVER'],
    [401, { error: 'no_key' }, 'BAD_KEY'],
    [401, { error: 'bad_key' }, 'BAD_KEY'],
    [401, { error: 'no_session' }, 'SIGNED_OUT'],
    [401, { error: 'bad_session' }, 'SIGNED_OUT'],
    [403, { error: 'not_entitled', reason: 'unknown purchase' }, 'ENDED'],
    [404, { error: 'not_found' }, 'SERVER'],
    [409, { error: 'not_connected' }, 'NOT_CONNECTED'],
    [409, { error: 'reconnect_needed' }, 'RECONNECT'],
    [409, { error: 'no_channel' }, 'NO_CHANNEL'],
    [410, { error: 'upload_expired' }, 'EXPIRED'],
    [413, { error: 'chunk_too_large', max: 16777216 }, 'SERVER'],
    [429, { error: 'rate_limited' }, 'RATE_LIMITED'],
    [429, { error: 'quota' }, 'QUOTA'],
    [429, { error: 'upload_limit' }, 'UPLOAD_LIMIT'],
    [500, { error: 'server_error' }, 'SERVER'],
    [502, { error: 'platform_error', retry: false }, 'PLATFORM'],
    [503, { error: 'not_configured', what: 'enc_key' }, 'NOT_CONFIGURED'],
    [502, null, 'SERVER'], // a proxy's HTML page
    [401, null, 'SIGNED_OUT'],
    [403, null, 'ENDED']
  ]
  for (const [status, body, code] of table)
    it(`${status} ${JSON.stringify(body)} → ${code}`, () => {
      const e = userErrorFor(status, body)
      expect(e.code).toBe(code)
      expect(e.userMessage.length).toBeGreaterThan(10)
      expect(e.userMessage).not.toMatch(/[–—]/)
    })
})

describe('openLink', () => {
  const ID = 'dQw4w9WgXcQ'
  it("opens only a video's own YouTube pages over https", async () => {
    const t = world()
    const good = [`https://studio.youtube.com/video/${ID}/edit`, `https://www.youtube.com/watch?v=${ID}`, `https://youtu.be/${ID}`]
    for (const u of good) await t.svc.openLink(u)
    for (const u of [
      `http://www.youtube.com/watch?v=${ID}`,
      'https://evil.example/',
      'https://www.youtube.com.evil.example/',
      'https://www.youtube.com/redirect?q=https://phish.example',
      `https://www.youtube.com/watch?v=${ID}&redirect=https://phish.example`,
      `https://studio.youtube.com/video/${ID}/edit?next=x`,
      'https://studio.youtube.com/video/abc/edit',
      'file:///etc/passwd',
      'javascript:alert(1)'
    ])
      await t.svc.openLink(u)
    expect(t.opened).toEqual(good)
  })
  it('isVideoLink', () => {
    expect(isVideoLink(`https://youtu.be/${ID}`)).toBe(true)
    expect(isVideoLink(`https://youtu.be/${ID}/x`)).toBe(false)
    expect(isVideoLink(`https://www.youtube.com:8443/watch?v=${ID}`)).toBe(false)
    expect(isVideoLink(null)).toBe(false)
  })
})

describe('nothing secret in the log', () => {
  it('a whole run (sign in, connect, a dropped post, finish, sign out) logs no key, session or one-time link', async () => {
    const t = world()
    t.onOpen = (u) => {
      const a = t.fake.state.attempts.get(u.searchParams.get('a')!)!
      t.onSleep = () => {
        a.status = 'connected'
        t.fake.state.connections.set(a.sid, { status: 'connected', channelName: 'My channel', channelUrl: null })
        t.onSleep = null
      }
    }
    await t.svc.connect('youtube')
    t.fake.state.faults.push({ on: 'chunk', network: true, keepBytes: UNIT, times: 1 })
    await t.svc.post(req())
    const sessions = [...t.fake.state.sessions.keys()]
    await t.svc.signOut()
    for (const s of sessions) t.fake.state.sessions.set(s, { id: 'x', sid: 'x', device: 'x', createdAt: 0 }) // so secretsIn can still look for it
    const log = t.logs.join('\n')
    expect(secretsIn(t, log)).toEqual([])
    expect(secretsIn(t, JSON.stringify(t.progress))).toEqual([])
    expect(secretsIn(t, JSON.stringify(t.changes))).toEqual([])
    expect(log).toContain('[posting] posted u_')
  })
})
