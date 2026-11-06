// Instagram API v26.0: https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/business-login
// Fixtures are fabricated protocol responses. No Meta host is contacted.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InstagramService } from '../src/main/instagram'
import { InstagramTokenStore } from '../src/main/instagram-store'
import { registerInstagramIpc } from '../src/main/instagram-ipc'
import type { InstagramSettings } from '../src/shared/instagram'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 9, 23)
const GRAPH = 'https://graph.instagram.com/v26.0'
const BROKER = 'https://broker.example'
const TOKEN = 'fabricated-instagram-token'
const SCOPES = ['instagram_business_basic', 'instagram_business_content_publish', 'instagram_business_manage_insights']
const PROFILE = { user_id: '123', username: 'fixture_creator', account_type: 'MEDIA_CREATOR' }
const INPUT = { slug: 'fixture', version: 1, caption: 'A caption & #reel', cover: { kind: 'frame', offsetMs: 800 } }
const POST = { version: 1, accountId: '123', postId: '789', publishedAt: new Date(NOW).toISOString() }

interface Step {
  url: string
  method?: string
  status?: number
  body?: unknown
  inspect?: (init: RequestInit, url: URL) => void | Promise<void>
  respond?: (init: RequestInit) => Promise<Response>
}
const cleanup: { dir: string; service: InstagramService }[] = []
const fixtureErrors: unknown[] = []
afterEach(async () => {
  for (const item of cleanup.splice(0)) {
    item.service.stop()
    await fs.rm(item.dir, { recursive: true, force: true })
  }
  expect(fixtureErrors.splice(0)).toEqual([])
})

async function world(opts: { dev?: boolean; enabled?: boolean; backend?: string; secure?: boolean } = {}) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'ig-fixture-'))
  const project = join(dir, 'projects', 'fixture')
  const version = join(project, 'versions', 'v1')
  await fs.mkdir(version, { recursive: true })
  await fs.writeFile(join(project, 'project.json'), '{}')
  await fs.writeFile(join(version, 'export.mp4'), 'fixture video bytes')
  await fs.writeFile(join(version, 'cover.png'), 'fixture image bytes')
  let now = NOW
  let cancelDuringEncryption = false
  let activeService: InstagramService | undefined
  const settings: InstagramSettings = { instagramEnabled: opts.enabled ?? true, instagramAppId: '456', instagramBrokerUrl: BROKER, instagramUploadOrigins: ['https://storage.example'] }
  const key = randomBytes(32)
  const secrets = {
    isEncryptionAvailable: () => opts.secure ?? true,
    getSelectedStorageBackend: () => opts.backend ?? 'gnome_libsecret',
    encryptString(value: string) {
      if (cancelDuringEncryption) activeService?.cancelConnect()
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), body])
    },
    decryptString(value: Buffer) {
      const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12))
      decipher.setAuthTag(value.subarray(12, 28))
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8')
    }
  }
  const store = new InstagramTokenStore(join(dir, 'settings'), secrets)
  const steps: Step[] = []
  const calls: string[] = []
  let browser: (url: string) => Promise<void> = async () => { throw new Error('unexpected browser request') }
  const service = new InstagramService({
    dev: opts.dev ?? true, settings: async () => settings, settingsDir: join(dir, 'settings'), projectsDir: () => join(dir, 'projects'), secrets,
    fetch: async (url, init) => {
      calls.push(url)
      const step = steps.shift()
      try {
        expect(step, `unexpected HTTP ${url}`).toBeDefined()
        if (!step) throw new Error('unexpected HTTP')
        expect(url).toBe(step.url)
        expect(init.method ?? 'GET').toBe(step.method ?? 'GET')
        expect(init.redirect).toBe('error')
        await step.inspect?.(init, new URL(url))
      } catch (error) { fixtureErrors.push(error); throw error }
      if (!step) throw new Error('unexpected HTTP')
      if (step.respond) return step.respond(init)
      return new Response(JSON.stringify(step.body ?? {}), { status: step.status ?? 200, headers: { 'content-type': 'application/json' } })
    },
    openExternal: (url) => browser(url),
    coverJpeg: (bytes) => Buffer.from(`jpeg:${bytes.toString()}`),
    now: () => now
  })
  activeService = service
  cleanup.push({ dir, service })
  const seed = (extra = {}) => store.save({ accessToken: TOKEN, expiresAt: now + 30 * DAY, issuedAt: now - 2 * DAY, accountId: '123', username: 'fixture_creator', appId: '456', brokerUrl: BROKER, ...extra })
  const finished = () => steps.push({ url: `${GRAPH}/900?fields=status_code`, body: { status_code: 'FINISHED' } })
  const profile = (body: unknown = PROFILE) => steps.push({ url: `${GRAPH}/me?fields=user_id,username,account_type`, body })
  const stage = (image = false) => {
    steps.push({ url: `${BROKER}/api/instagram/uploads`, method: 'POST', body: {
      video: { upload_url: 'https://storage.example/video?signature=fake', public_url: 'https://storage.example/video.mp4' },
      ...(image ? { cover: { upload_url: 'https://storage.example/cover?signature=fake', public_url: 'https://storage.example/cover.jpg' } } : {})
    }, inspect: (init) => {
      expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${TOKEN}`)
      expect(JSON.parse(String(init.body))).toEqual({ video_size: 19, cover_size: image ? 24 : null })
    } })
    steps.push({ url: 'https://storage.example/video?signature=fake', method: 'PUT', inspect: async (init) => {
      expect(new Headers(init.headers).has('authorization')).toBe(false)
      expect(await new Response(init.body).text()).toBe('fixture video bytes')
    } })
    if (image) steps.push({ url: 'https://storage.example/cover?signature=fake', method: 'PUT', inspect: async (init) => {
      expect(new Headers(init.headers).has('authorization')).toBe(false)
      expect(await new Response(init.body).text()).toBe('jpeg:fixture image bytes')
    } })
    steps.push({ url: `${GRAPH}/123/media`, method: 'POST', body: { id: '900' }, inspect: (init) => {
      const form = new URLSearchParams(String(init.body))
      expect(Object.fromEntries(form)).toEqual({ media_type: 'REELS', video_url: 'https://storage.example/video.mp4', caption: INPUT.caption,
        ...(image ? { cover_url: 'https://storage.example/cover.jpg' } : { thumb_offset: '800' }) })
    } })
  }
  const publish = () => steps.push({ url: `${GRAPH}/123/media_publish`, method: 'POST', body: { id: '789' }, inspect: (init) => {
    expect(String(init.body)).toBe('creation_id=900')
  } })
  const published = async () => {
    await fs.writeFile(join(project, 'instagram-publish.json'), JSON.stringify({ schemaVersion: 1, versions: { v1: { state: 'published', accountId: '123', containerId: '900', inputHash: '0'.repeat(64), post: POST } } }))
  }
  const oauth = (permissions = SCOPES, account: unknown = PROFILE) => {
    let state = ''
    let loopback = ''
    let challenge = ''
    steps.push({ url: `${BROKER}/api/instagram/oauth/start`, method: 'POST', inspect: (init) => {
      const body = JSON.parse(String(init.body))
      expect(body.app_id).toBe('456')
      expect(body.code_challenge_method).toBe('S256')
      expect(body).not.toHaveProperty('client_secret')
      state = body.state; loopback = body.loopback_uri; challenge = body.code_challenge
      expect(new URL(loopback).hostname).toBe('127.0.0.1')
    } })
    browser = async (raw) => {
      const url = new URL(raw)
      expect(url.origin + url.pathname).toBe('https://www.instagram.com/oauth/authorize')
      expect(url.searchParams.get('scope')?.split(',')).toEqual(SCOPES)
      expect(url.searchParams.get('redirect_uri')).toBe(`${BROKER}/api/instagram/oauth/callback`)
      const callback = new URL(loopback)
      const malformedStatus = await new Promise<number | undefined>((resolve, reject) => {
        const req = httpRequest(callback, { path: 'http://[', signal: AbortSignal.timeout(10_000) }, (res) => {
          res.resume()
          resolve(res.statusCode)
        })
        req.once('error', reject)
        req.end()
      })
      expect(malformedStatus).toBe(400)
      callback.search = new URLSearchParams({ state: 'wrong-state', handoff: 'fabricated-handoff-123456' }).toString()
      expect((await fetch(callback)).status).toBe(400)
      callback.searchParams.set('state', state)
      expect((await fetch(callback)).status).toBe(200)
    }
    steps.push({ url: `${BROKER}/api/instagram/oauth/complete`, method: 'POST', body: { access_token: TOKEN, token_type: 'bearer', expires_in: 60 * DAY / 1000, permissions }, inspect: (init) => {
      const body = JSON.parse(String(init.body))
      expect(body.state).toBe(state)
      expect(createHash('sha256').update(body.code_verifier).digest('base64url')).toBe(challenge)
    } })
    if (SCOPES.every((s) => permissions.includes(s))) steps.push({ url: `${GRAPH}/me?fields=user_id,username,account_type,profile_picture_url`, body: account })
  }
  return { dir, project, version, store, service, steps, calls, seed, profile, stage, finished, publish, published, oauth,
    cancelAtEncryption: () => { cancelDuringEncryption = true },
    tick: (ms: number) => { now += ms }, done: () => expect(steps).toEqual([]) }
}

const insightsUrl = `${GRAPH}/789/insights?metric=views%2Creach%2Clikes%2Ccomments%2Cshares%2Csaved%2Cig_reels_avg_watch_time%2Cig_reels_video_view_total_time%2Creels_skip_rate&period=lifetime`

describe('Instagram fixture HTTP', () => {
  it('cancelling during the token write removes that connection and rejects sign-in', async () => {
    const w = await world(); w.oauth(); w.cancelAtEncryption()
    await expect(w.service.connect()).rejects.toMatchObject({ code: 'IG_CANCELLED' })
    expect(await w.store.load()).toBeNull(); w.done()
  })
  it('cancelling before publish dispatch leaves a resumable container', async () => {
    const w = await world(); await w.seed(); w.profile(); w.stage(); w.finished()
    const rename = fs.rename.bind(fs)
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      await rename(from, to)
      if (String(to).endsWith('instagram-publish.json')) {
        const data = JSON.parse(await fs.readFile(to, 'utf8'))
        if (data.versions.v1.state === 'publishing') w.service.stop()
      }
    })
    try { await expect(w.service.publish(INPUT)).rejects.toMatchObject({ code: 'IG_CANCELLED' }) }
    finally { spy.mockRestore() }
    expect(JSON.parse(await fs.readFile(join(w.project, 'instagram-publish.json'), 'utf8')).versions.v1.state).toBe('processing')
    expect(w.calls.some((url) => url.endsWith('/media_publish'))).toBe(false); w.done()
  })
  it('rejects changed captions when resuming an existing container', async () => {
    const w = await world(); await w.seed(); w.profile(); w.stage()
    w.steps.push({ url: `${GRAPH}/900?fields=status_code`, status: 429, body: { error: { code: 4 } } })
    await expect(w.service.publish(INPUT)).rejects.toMatchObject({ code: 'IG_RATE_LIMIT' })
    w.profile()
    await expect(w.service.publish({ ...INPUT, caption: 'Corrected caption' })).rejects.toMatchObject({ code: 'IG_PUBLISH_CHANGED' }); w.done()
  })
  it('connects through the state-bound handoff and persists only encrypted credentials', async () => {
    const w = await world(); w.oauth()
    expect(await w.service.connect()).toEqual({ connected: true, accountId: '123', username: 'fixture_creator', expiresAt: NOW + 60 * DAY })
    const files = await fs.readdir(join(w.dir, 'settings'))
    expect(files).toEqual(['instagram-credentials.bin'])
    expect((await fs.readFile(join(w.dir, 'settings', files[0]))).includes(Buffer.from(TOKEN))).toBe(false)
    expect(await w.service.session()).toMatchObject({ connected: true, accountId: '123' })
    w.done()
  })
  // fails if the picture link gets the account's token, or the picture is not kept for the preview
  it('keeps the profile picture as a data URL, fetched without the token', async () => {
    const w = await world(); w.oauth(SCOPES, { ...PROFILE, profile_picture_url: 'https://cdn.example/p/123.jpg' })
    w.steps.push({ url: 'https://cdn.example/p/123.jpg', inspect: (init) => expect(new Headers(init.headers).has('authorization')).toBe(false),
      respond: async () => new Response(Buffer.from('jpeg bytes'), { headers: { 'content-type': 'image/jpeg' } }) })
    const picture = `data:image/jpeg;base64,${Buffer.from('jpeg bytes').toString('base64')}`
    expect(await w.service.connect()).toMatchObject({ connected: true, username: 'fixture_creator', picture })
    expect(await w.service.session()).toMatchObject({ connected: true, picture })
    w.done()
  })
  // fails if a picture that can't be read stops the connection
  it('connects without a picture when the picture is not an image', async () => {
    const w = await world(); w.oauth(SCOPES, { ...PROFILE, profile_picture_url: 'https://cdn.example/p/123.jpg' })
    w.steps.push({ url: 'https://cdn.example/p/123.jpg', respond: async () => new Response('<html>', { headers: { 'content-type': 'text/html' } }) })
    const session = await w.service.connect()
    expect(session).toMatchObject({ connected: true, username: 'fixture_creator' })
    expect(session).not.toHaveProperty('picture')
    w.done()
  })
  // fails if a picture with no Content-Length is read to its end before its size is checked
  it('stops reading a picture once it is over the size limit', async () => {
    const w = await world(); w.oauth(SCOPES, { ...PROFILE, profile_picture_url: 'https://cdn.example/p/123.jpg' })
    let pulls = 0
    let cancelled = false
    // highWaterMark 0: a chunk is made only when the reader asks for one, so `pulls` counts what was read
    const body = new ReadableStream<Uint8Array>({
      pull: (c) => (++pulls === 1 ? c.enqueue(new Uint8Array(600 * 1024)) : c.close()),
      cancel: () => { cancelled = true }
    }, { highWaterMark: 0 })
    w.steps.push({ url: 'https://cdn.example/p/123.jpg', respond: async () => new Response(body, { headers: { 'content-type': 'image/jpeg' } }) })
    expect(await w.service.connect()).not.toHaveProperty('picture')
    expect({ pulls, cancelled }).toEqual({ pulls: 1, cancelled: true })
    w.done()
  })
  it('refuses a connection missing insights permission', async () => {
    const w = await world(); w.oauth(SCOPES.slice(0, 2))
    await expect(w.service.connect()).rejects.toMatchObject({ code: 'IG_PERMISSION' })
    expect(await w.store.load()).toBeNull(); w.done()
  })
  it('rejects a Personal account before storing a token', async () => {
    const w = await world(); w.oauth(SCOPES, { ...PROFILE, account_type: 'PERSONAL' })
    await expect(w.service.connect()).rejects.toMatchObject({ code: 'IG_PROFESSIONAL' })
    expect(await w.store.load()).toBeNull()
    await w.seed(); w.profile({ ...PROFILE, account_type: 'PERSONAL' })
    await expect(w.service.publish(INPUT)).rejects.toMatchObject({ code: 'IG_PROFESSIONAL' }); w.done()
  })
  it('blocks all network and browser work when the developer gate is off', async () => {
    const w = await world({ dev: false })
    await expect(w.service.connect()).rejects.toMatchObject({ code: 'IG_DISABLED' })
    await expect(w.service.publish(INPUT)).rejects.toMatchObject({ code: 'IG_DISABLED' })
    await expect(w.service.insights('fixture', 1, '789')).rejects.toMatchObject({ code: 'IG_DISABLED' })
    // the preview asks on every reel: off reads as not connected, not as an error
    expect(await w.service.session()).toEqual({ connected: false })
    expect(w.calls).toEqual([])
  })
  it('blocks a disabled setting and insecure keychain before OAuth', async () => {
    const w = await world({ enabled: false })
    await expect(w.service.connect()).rejects.toMatchObject({ code: 'IG_DISABLED' })
    const insecure = await world({ backend: 'basic_text' })
    await expect(insecure.service.connect()).rejects.toMatchObject({ code: 'IG_SECURE_STORAGE' })
    expect([...w.calls, ...insecure.calls]).toEqual([])
  })
  it('publishes a local video with its JPEG cover and makes retries return the same post', async () => {
    const w = await world(); await w.seed(); w.profile(); w.stage(true); w.finished(); w.publish()
    expect(await w.service.publish({ ...INPUT, cover: { kind: 'image' } })).toEqual(POST)
    w.profile()
    expect(await w.service.publish(INPUT)).toEqual(POST)
    const out = JSON.parse(await fs.readFile(join(w.project, 'outcomes.json'), 'utf8'))
    expect(out.versions.v1['789']).toEqual({ ...POST, platform: 'instagram', apiVersion: 'v26.0', observedAt: null, metrics: null })
    w.done()
  })
  it('sends a frame cover and publishes only after the container finishes', async () => {
    const w = await world(); await w.seed(); w.profile(); w.stage(); w.finished(); w.publish()
    expect(await w.service.publish(INPUT)).toEqual(POST); w.done()
  })
  it('refreshes a still-valid token after an OAuth expiry response and retries insights once', async () => {
    const w = await world(); await w.seed(); await w.published()
    w.steps.push({ url: insightsUrl, status: 400, body: { error: { code: 190, error_subcode: 463 } } })
    w.steps.push({ url: `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${TOKEN}`, body: { access_token: 'fabricated-renewed-token', token_type: 'bearer', expires_in: 60 * DAY / 1000 } })
    w.steps.push({ url: insightsUrl, body: { data: [] }, inspect: (init) => { expect(new Headers(init.headers).get('authorization')).toBe('Bearer fabricated-renewed-token') } })
    expect((await w.service.insights('fixture', 1, '789')).metrics?.plays).toBeNull()
    expect((await w.store.load())?.accessToken).toBe('fabricated-renewed-token'); w.done()
  })
  it('refreshes proactively near expiry and asks to reconnect once a token has expired', async () => {
    const w = await world(); await w.seed({ expiresAt: NOW + DAY }); await w.published()
    w.steps.push({ url: `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${TOKEN}`, body: { access_token: 'fabricated-fresh', token_type: 'bearer', expires_in: 60 * DAY / 1000 } })
    w.steps.push({ url: insightsUrl, body: { data: [] } })
    await w.service.insights('fixture', 1, '789'); w.done()
    w.tick(61 * DAY)
    await expect(w.service.insights('fixture', 1, '789')).rejects.toMatchObject({ code: 'IG_TOKEN' })
    expect(await w.service.session()).toEqual({ connected: false })
  })
  it('maps a rate limit to a user message without retrying or rewriting insights', async () => {
    const w = await world(); await w.seed(); await w.published()
    w.steps.push({ url: insightsUrl, status: 429, body: { error: { code: 4, message: TOKEN } } })
    await expect(w.service.insights('fixture', 1, '789')).rejects.toMatchObject({ code: 'IG_RATE_LIMIT', userMessage: expect.stringContaining('Wait') })
    await expect(fs.access(join(w.project, 'outcomes.json'))).rejects.toThrow(); w.done()
  })
  it('never publishes a container that Instagram could not process', async () => {
    const w = await world(); await w.seed(); w.profile(); w.stage()
    w.steps.push({ url: `${GRAPH}/900?fields=status_code`, body: { status_code: 'ERROR', status: TOKEN } })
    await expect(w.service.publish(INPUT)).rejects.toMatchObject({ code: 'IG_CONTAINER' })
    expect(w.calls.some((url) => url.endsWith('/media_publish'))).toBe(false); w.done()
  })
  it('blocks another publish after the publish response is lost', async () => {
    const w = await world(); await w.seed(); w.profile(); w.stage(); w.finished()
    w.steps.push({ url: `${GRAPH}/123/media_publish`, method: 'POST', respond: async () => { throw new Error('fixture socket closed') } })
    await expect(w.service.publish(INPUT)).rejects.toMatchObject({ code: 'IG_PUBLISH_UNKNOWN' })
    w.profile()
    await expect(w.service.publish(INPUT)).rejects.toMatchObject({ code: 'IG_PUBLISH_UNKNOWN' }); w.done()
  })
  it('persists all reel metrics by version and post while preserving other outcomes', async () => {
    const w = await world(); await w.seed(); await w.published()
    await fs.writeFile(join(w.project, 'outcomes.json'), JSON.stringify({ schemaVersion: 1, versions: { v2: { '555': { platform: 'fixture' } } } }))
    const metrics = ['views', 'reach', 'likes', 'comments', 'shares', 'saved', 'ig_reels_avg_watch_time', 'ig_reels_video_view_total_time', 'reels_skip_rate']
    w.steps.push({ url: insightsUrl, body: { data: metrics.map((name, index) => ({ name, values: [{ value: index === 8 ? 12.5 : index * 100 }] })) } })
    const result = await w.service.insights('fixture', 1, '789')
    expect(result.metrics).toEqual({ plays: 0, reach: 100, likes: 200, comments: 300, shares: 400, saves: 500, averageWatchTimeMs: 600, totalWatchTimeMs: 700, skipRatePercent: 12.5 })
    const out = JSON.parse(await fs.readFile(join(w.project, 'outcomes.json'), 'utf8'))
    expect(out.versions.v1['789']).toEqual(result)
    expect(out.versions.v2['555']).toEqual({ platform: 'fixture' }); w.done()
  })
  // fails if reading results drops the trial tag publish saved, which would lose the pairing of Try 1 and Try 2
  it('keeps a post’s trial tag when its results are read', async () => {
    const w = await world(); await w.seed(); await w.published()
    const trial = { id: 'trial-a', try: 2, change: 'caption' }
    await fs.writeFile(join(w.project, 'outcomes.json'), JSON.stringify({ schemaVersion: 1, versions: { v1: { '789': { ...POST, platform: 'instagram', apiVersion: 'v26.0', observedAt: null, metrics: null, trial } } } }))
    w.steps.push({ url: insightsUrl, body: { data: [{ name: 'views', values: [{ value: 42 }] }] } })
    await w.service.insights('fixture', 1, '789')
    const out = JSON.parse(await fs.readFile(join(w.project, 'outcomes.json'), 'utf8'))
    expect(out.versions.v1['789']).toMatchObject({ trial, metrics: { plays: 42 } }); w.done()
  })
  // fails if one breakdown Instagram won't give (error 100 under 100 followers) stops the whole audience
  it('reads who follows the account, one breakdown at a time', async () => {
    const w = await world(); await w.seed()
    const ask = (breakdown: string) => `${GRAPH}/123/insights?metric=follower_demographics&period=lifetime&metric_type=total_value&timeframe=this_month&breakdown=${breakdown}`
    const one = (key: string, value: number) => ({ data: [{ name: 'follower_demographics', total_value: { breakdowns: [{ dimension_keys: ['x'], results: [{ dimension_values: [key], value }] }] } }] })
    w.steps.push({ url: ask('age'), body: one('25-34', 9) }, { url: ask('gender'), body: one('F', 5) },
      { url: ask('country'), status: 400, body: { error: { code: 100 } } }, { url: ask('city'), body: { data: [] } })
    expect(await w.service.audience()).toEqual({ accountId: '123', followers: { age: [{ key: '25-34', value: 9 }], gender: [{ key: 'F', value: 5 }], country: [], city: [] } })
    // every breakdown refused: an error, so the refresh keeps the audience it had instead of saving an empty one
    for (const b of ['age', 'gender', 'country', 'city']) w.steps.push({ url: ask(b), status: 400, body: { error: { code: 100 } } })
    await expect(w.service.audience()).rejects.toMatchObject({ code: 'IG_INPUT' })
    w.done()
  })
  it('rejects another version or account post before requesting insights', async () => {
    const w = await world(); await w.seed(); await w.published()
    await expect(w.service.insights('fixture', 2, '789')).rejects.toMatchObject({ code: 'IG_POST' })
    await expect(w.service.insights('fixture', 1, '999')).rejects.toMatchObject({ code: 'IG_POST' })
    expect(w.calls).toEqual([])
  })
  it('refuses symlink exports outside the project before uploading', async () => {
    const w = await world(); await w.seed(); w.profile()
    const outside = join(w.dir, 'private.mp4'); await fs.writeFile(outside, 'private')
    await fs.unlink(join(w.version, 'export.mp4')); await fs.symlink(outside, join(w.version, 'export.mp4'))
    await expect(w.service.publish(INPUT)).rejects.toMatchObject({ code: 'IG_PATH' }); w.done()
  })
  it('rejects a file opened through a swapped ancestor even after that ancestor is restored', async () => {
    const w = await world(); await w.seed(); w.profile()
    const versions = join(w.project, 'versions')
    const parked = join(w.project, 'parked-versions')
    const outside = join(w.dir, 'outside')
    await fs.mkdir(join(outside, 'v1'), { recursive: true })
    await fs.writeFile(join(outside, 'v1', 'export.mp4'), 'private video bytes')
    const target = await fs.realpath(join(w.version, 'export.mp4'))
    const open = fs.open.bind(fs)
    let redirected: Awaited<ReturnType<typeof fs.open>> | undefined
    const spy = vi.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
      if (path !== target) return open(path, flags, mode)
      await fs.rename(versions, parked)
      await fs.symlink(outside, versions, 'junction')
      try {
        redirected = await open(path, flags, mode)
        return redirected
      } finally {
        await fs.unlink(versions)
        await fs.rename(parked, versions)
      }
    })
    try { await expect(w.service.publish(INPUT)).rejects.toMatchObject({ code: 'IG_PATH' }) }
    finally { spy.mockRestore() }
    expect(redirected).toBeDefined()
    expect(redirected?.fd).toBe(-1)
    expect(w.calls).toEqual([`${GRAPH}/me?fields=user_id,username,account_type`]); w.done()
  })
  it('refuses an unapproved signed upload host before sending video bytes', async () => {
    const w = await world(); await w.seed(); w.profile()
    w.steps.push({ url: `${BROKER}/api/instagram/uploads`, method: 'POST', body: { video: { upload_url: 'https://unapproved.example/upload', public_url: 'https://storage.example/video.mp4' } } })
    await expect(w.service.publish(INPUT)).rejects.toMatchObject({ code: 'IG_UPLOAD_HOST' }); w.done()
  })
  it('does not overwrite a corrupt outcomes file', async () => {
    const w = await world(); await w.seed(); await w.published()
    await fs.writeFile(join(w.project, 'outcomes.json'), '{broken')
    w.steps.push({ url: insightsUrl, body: { data: [] } })
    await expect(w.service.insights('fixture', 1, '789')).rejects.toMatchObject({ code: 'IG_LOCAL_DATA' })
    expect(await fs.readFile(join(w.project, 'outcomes.json'), 'utf8')).toBe('{broken'); w.done()
  })
  it('disconnect cancels a pending refresh and cannot resurrect credentials', async () => {
    const w = await world(); await w.seed({ expiresAt: NOW + DAY }); await w.published()
    let started!: () => void
    const began = new Promise<void>((resolve) => { started = resolve })
    w.steps.push({ url: `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${TOKEN}`, respond: (init) => new Promise((_resolve, reject) => {
      started()
      init.signal?.addEventListener('abort', () => reject(new Error('aborted fixture')), { once: true })
    }) })
    const insight = w.service.insights('fixture', 1, '789')
    const failure = expect(insight).rejects.toMatchObject({ code: 'IG_CANCELLED' })
    await began; await w.service.disconnect(); await failure
    expect(await w.store.load()).toBeNull(); w.done()
  })
  it('wires the IPC publish and insights calls and restricts configuration to dev mode', async () => {
    const w = await world(); await w.seed(); w.profile(); w.stage(); w.finished(); w.publish()
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    let saved: unknown
    registerInstagramIpc({ dev: true, service: w.service, handle: (channel, fn) => { handlers.set(channel, (...args) => fn(undefined, ...args)) }, saveSettings: async (settings) => { saved = settings } })
    expect(await handlers.get('instagram:publish')?.(INPUT)).toEqual(POST)
    w.steps.push({ url: insightsUrl, body: { data: [{ name: 'views', total_value: { value: 7 } }] } })
    expect(await handlers.get('instagram:insights')?.('fixture', 1, '789')).toMatchObject({ metrics: { plays: 7 } })
    await handlers.get('instagram:configure')?.({ instagramEnabled: false, instagramAppId: null, instagramBrokerUrl: null, instagramUploadOrigins: [] })
    expect(saved).toMatchObject({ instagramEnabled: false })
    registerInstagramIpc({ dev: false, service: w.service, handle: (channel, fn) => { handlers.set(channel, (...args) => fn(undefined, ...args)) }, saveSettings: async () => { throw new Error('must not save') } })
    await expect(handlers.get('instagram:configure')?.({})).rejects.toMatchObject({ code: 'IG_DISABLED' }); w.done()
  })
})
