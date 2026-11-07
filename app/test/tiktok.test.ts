// TikTok API v2: https://developers.tiktok.com/doc/login-kit-desktop/
// Posting v2: https://developers.tiktok.com/doc/content-posting-api-reference-direct-post/
// Transfer/status v2: https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide/
// Stats v2: https://developers.tiktok.com/doc/tiktok-api-v2-video-query/
// All remote HTTP responses and credentials are fabricated. Only the loopback callback uses a socket.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TikTokService } from '../src/main/tiktok'
import { TikTokTokenStore, saveOutcome } from '../src/main/tiktok-store'
import { saveOutcome as saveInstagramOutcome } from '../src/main/instagram-store'
import { request } from '../src/main/tiktok-http'
import { registerTikTokIpc } from '../src/main/tiktok-ipc'
import { configFromEnv } from '../src/server/signin/config'
import { createSigninHandler } from '../src/server/signin/handler'
import type { TikTokPublishInput, TikTokSettings } from '../src/shared/tiktok'

const NOW = Date.UTC(2026, 9, 23), API = 'https://open.tiktokapis.com/v2', BROKER = 'https://broker.example'
const TOKEN = 'fabricated-access', REFRESH = 'fabricated-refresh'
const SCOPES = ['user.info.basic', 'video.list', 'video.upload', 'video.publish']
const UPLOAD = 'https://open-upload.tiktokapis.com/video/?upload_id=fixture&upload_token=fabricated'
const INPUT: TikTokPublishInput = { slug: 'fixture', version: 1, caption: 'Fixture #video', mode: 'direct-or-inbox', consent: true,
  privacy: 'PUBLIC_TO_EVERYONE', durationSec: 12, disableComment: false, disableDuet: false, disableStitch: false,
  brandContent: false, brandOrganic: false, isAigc: false }
const CREATOR = { creator_nickname: 'Fixture creator', privacy_level_options: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'],
  comment_disabled: true, duet_disabled: false, stitch_disabled: true, max_video_post_duration_sec: 60 }
const token = (extra = {}) => ({ access_token: TOKEN, refresh_token: REFRESH, token_type: 'Bearer', expires_in: 86400,
  refresh_expires_in: 31536000, open_id: 'fixture-open-id', scope: SCOPES.join(','), ...extra })
const signinWith = (fetcher: (url: string, init: RequestInit) => Promise<Response>) => createSigninHandler(configFromEnv({
  SIGNIN_PUBLIC_URL: BROKER, SIGNIN_SECRET: randomBytes(32).toString('base64url'),
  TIKTOK_CLIENT_KEY: 'fixture-key', TIKTOK_CLIENT_SECRET: 'fabricated-server-secret'
}, fetcher))
interface Step {
  path: string
  method?: string
  status?: number
  body?: unknown
  raw?: boolean
  inspect?: (init: RequestInit) => void | Promise<void>
  respond?: (init: RequestInit) => Promise<Response>
}
const cleanup: { service: TikTokService; dir: string }[] = []
const fixtureErrors: unknown[] = []
afterEach(async () => {
  for (const w of cleanup.splice(0)) { w.service.stop(); await fs.rm(w.dir, { recursive: true, force: true }) }
  expect(fixtureErrors.splice(0)).toEqual([])
})
async function world(opts: { enabled?: boolean; audited?: boolean; direct?: boolean; backend?: string } = {}) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'tt-fixture-')), project = join(dir, 'projects', 'fixture')
  const version = join(project, 'versions', 'v1')
  await fs.mkdir(version, { recursive: true }); await fs.writeFile(join(project, 'project.json'), '{}')
  await fs.writeFile(join(version, 'export.mp4'), 'fabricated-video')
  const steps: Step[] = [], calls: string[] = [], key = randomBytes(32)
  let now = NOW, encryptAction = () => {}
  const secrets = {
    isEncryptionAvailable: () => true, getSelectedStorageBackend: () => opts.backend ?? 'keychain',
    encryptString(value: string) {
      encryptAction()
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv)
      const body = Buffer.concat([cipher.update(value), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), body])
    },
    decryptString(value: Buffer) {
      const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); decipher.setAuthTag(value.subarray(12, 28))
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8')
    }
  }
  const settings: TikTokSettings = { tiktokEnabled: opts.enabled ?? true, tiktokClientKey: 'fixture-key', tiktokBrokerUrl: BROKER,
    tiktokAudited: opts.audited ?? true, tiktokDirectPost: opts.direct ?? true }
  const fetchFixture = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push(url)
    const step = steps.shift()
    try {
      expect(step, `Unexpected HTTP ${url}`).toBeDefined()
      if (!step) throw new Error('Unexpected HTTP')
      expect(url).toBe(step.path.startsWith('https://') ? step.path : `${API}/${step.path}`)
      expect(init.method ?? 'GET').toBe(step.method ?? 'POST')
      expect(init.redirect).toBe('error')
      await step.inspect?.(init)
    } catch (e) { fixtureErrors.push(e); throw e }
    if (!step) throw new Error('Unexpected HTTP')
    if (step.respond) return step.respond(init)
    if (url === UPLOAD) return new Response(null, { status: step.status ?? 201 })
    return Response.json(step.raw ? step.body : { data: step.body ?? {}, error: { code: 'ok', message: '' } }, { status: step.status ?? 200 })
  }
  let browser = async (_url: string): Promise<void> => { throw new Error('Unexpected browser') }
  // the real sign-in service in front of the TikTok fixture (src/server/signin)
  const broker = signinWith(fetchFixture)
  const service = new TikTokService({ settings: async () => settings, settingsDir: join(dir, 'settings'),
    projectsDir: () => join(dir, 'projects'), secrets, now: () => now,
    fetch: (url, init) => url.startsWith(`${BROKER}/v1/`) ? broker(new Request(url, init)) : fetchFixture(url, init),
    openExternal: (url) => browser(url) })
  cleanup.push({ service, dir })
  const store = new TikTokTokenStore(join(dir, 'settings'), secrets)
  const seed = (extra = {}) => store.save({ accessToken: TOKEN, refreshToken: REFRESH, expiresAt: NOW + 86400000,
    refreshExpiresAt: NOW + 31536000000, accountId: 'fixture-open-id', displayName: 'Fixture creator', scopes: SCOPES,
    clientKey: 'fixture-key', brokerUrl: BROKER, ...extra })
  const creator = (body: unknown = CREATOR) => steps.push({ path: 'post/publish/creator_info/query/', body })
  const init = (inbox = false, inspect?: Step['inspect']) => steps.push({ path: inbox ? 'post/publish/inbox/video/init/' : 'post/publish/video/init/',
    body: { publish_id: 'fixture-publish', upload_url: UPLOAD }, inspect })
  const status = (state = 'PROCESSING_UPLOAD', bytes = 0, ids: string[] = []) => steps.push({ path: 'post/publish/status/fetch/',
    body: { status: state, uploaded_bytes: bytes, publicaly_available_post_id: ids } })
  const put = (inspect?: Step['inspect'], response = 201) => steps.push({ path: UPLOAD, method: 'PUT', status: response, inspect })
  const success = (inbox = false, ids = ['789']) => {
    if (!inbox) creator(); init(inbox); status(); put(); status(inbox ? 'SEND_TO_USER_INBOX' : 'PUBLISH_COMPLETE', 16, inbox ? [] : ids)
  }
  const stats = (body: unknown = { videos: [{ id: '789', view_count: 100, like_count: 9, comment_count: 3, share_count: 2 }] }) =>
    steps.push({ path: 'video/query/?fields=id,view_count,like_count,comment_count,share_count', body })
  const oauth = (scope = SCOPES.join(','), declined = false) => {
    let challenge = '', redirect = ''
    browser = async (raw) => {
      const url = new URL(raw); expect(url.origin + url.pathname).toBe('https://www.tiktok.com/v2/auth/authorize/')
      expect(url.searchParams.get('scope')?.split(',')).toEqual(opts.direct === false ? SCOPES.slice(0, 3) : SCOPES)
      challenge = url.searchParams.get('code_challenge') ?? ''; expect(url.searchParams.get('code_challenge_method')).toBe('S256')
      redirect = url.searchParams.get('redirect_uri') ?? ''
      const callback = new URL(redirect)
      expect(callback.hostname).toBe('127.0.0.1')
      callback.search = new URLSearchParams({ code: 'fabricated/code+with=percent%', state: 'wrong' }).toString()
      expect((await fetch(callback)).status).toBe(400)
      callback.searchParams.set('state', url.searchParams.get('state') ?? '')
      if (declined) callback.searchParams.set('error', 'access_denied')
      expect((await fetch(callback)).status).toBe(200)
    }
    if (declined) return
    steps.push({ path: 'oauth/token/', raw: true, body: token({ scope }), inspect: (init) => {
      const form = new URLSearchParams(String(init.body))
      expect(form.get('client_secret')).toBe('fabricated-server-secret'); expect(form.get('redirect_uri')).toBe(redirect)
      expect(form.get('grant_type')).toBe('authorization_code')
      expect(form.get('code')).toBe('fabricated/code+with=percent%')
      expect(createHash('sha256').update(form.get('code_verifier') ?? '').digest('hex')).toBe(challenge)
      expect(challenge).toMatch(/^[a-f0-9]{64}$/)
    } })
    if (['user.info.basic', 'video.list', 'video.upload'].every((s) => scope.split(',').includes(s)))
      steps.push({ path: 'user/info/?fields=open_id,display_name', method: 'GET', body: { user: { open_id: 'fixture-open-id', display_name: 'Fixture creator' } } })
  }
  const published = async (input = INPUT) => { success(); return service.publish(input) }
  return { service, store, settings, steps, calls, dir, project, version, seed, creator, init, status, put, success, stats, oauth, published,
    encryptAction: (fn: () => void) => { encryptAction = fn }, tick: (ms: number) => { now += ms }, done: () => expect(steps).toEqual([]) }
}

describe('TikTok fixture HTTP', () => {
  it('connects with state-bound hex PKCE through the broker and encrypts both tokens', async () => {
    const w = await world({ direct: false }); w.oauth(SCOPES.slice(0, 3).join(','))
    const result = await w.service.connect()
    expect(result).toMatchObject({ connected: true, accountId: 'fixture-open-id', scopes: SCOPES.slice(0, 3) })
    const bytes = await fs.readFile(join(w.dir, 'settings', 'tiktok-credentials.bin'))
    expect(bytes.includes(Buffer.from(TOKEN))).toBe(false); expect(bytes.includes(Buffer.from(REFRESH))).toBe(false)
    expect(await w.store.load()).toMatchObject({ accessToken: TOKEN, refreshToken: REFRESH })
    expect(result).not.toHaveProperty('accessToken'); expect(await w.service.session()).toEqual(result); w.done()
  })
  it('maps declined consent and refuses a connection missing stats permission', async () => {
    const w = await world(); w.oauth('', true)
    await expect(w.service.connect()).rejects.toMatchObject({ code: 'TT_DECLINED' })
    expect(await w.store.load()).toBeNull()
    w.oauth('user.info.basic,video.upload')
    await expect(w.service.connect()).rejects.toMatchObject({ code: 'TT_PERMISSION' }); expect(await w.store.load()).toBeNull(); w.done()
  })
  it('rolls back a connection cancelled during encryption', async () => {
    const w = await world(); w.oauth(); w.encryptAction(() => w.service.cancelConnect())
    await expect(w.service.connect()).rejects.toMatchObject({ code: 'TT_CANCELLED' })
    expect(await w.store.load()).toBeNull(); w.done()
  })
  it('blocks network actions while TikTok isn’t open', async () => {
    const w = await world({ enabled: false })
    await expect(w.service.connect()).rejects.toMatchObject({ code: 'TT_DISABLED' })
    await expect(w.service.publish(INPUT)).rejects.toMatchObject({ code: 'TT_DISABLED' })
    await expect(w.service.insights('fixture', 1, '789')).rejects.toMatchObject({ code: 'TT_DISABLED' })
    // Settings and Share ask on every visit: not open reads as not connected
    expect(await w.service.session()).toEqual({ connected: false })
    expect(w.calls).toEqual([])
  })
  it('refuses insecure keychain storage before opening authorization', async () => {
    const w = await world({ backend: 'basic_text' })
    await expect(w.service.connect()).rejects.toMatchObject({ code: 'TT_SECURE_STORAGE' }); expect(w.calls).toEqual([])
  })
  it('publishes FILE_UPLOAD with creator restrictions and stores stats beside Instagram outcomes', async () => {
    const w = await world(); await w.seed(); w.creator(); w.init(false, (init) => {
      expect(JSON.parse(String(init.body))).toMatchObject({ source_info: { source: 'FILE_UPLOAD', video_size: 16, chunk_size: 16, total_chunk_count: 1 },
        post_info: { title: INPUT.caption, privacy_level: INPUT.privacy, disable_comment: true, disable_stitch: true, disable_duet: false } })
    }); w.status(); w.put(async (init) => {
      expect(new Headers(init.headers).get('content-range')).toBe('bytes 0-15/16')
      expect(new Headers(init.headers).has('authorization')).toBe(false)
      expect(await new Response(init.body).text()).toBe('fabricated-video')
    }); w.status('PUBLISH_COMPLETE', 16, ['789'])
    expect(await w.service.publish(INPUT)).toMatchObject({ state: 'published', mode: 'direct', postIds: ['789'] })
    await saveInstagramOutcome(w.project, { version: 1, accountId: '123', postId: '789', publishedAt: new Date(NOW).toISOString(),
      platform: 'instagram', apiVersion: 'v26.0', observedAt: null, metrics: null })
    w.stats(); const result = await w.service.insights('fixture', 1, '789')
    expect(result.metrics).toEqual({ plays: 100, likes: 9, comments: 3, shares: 2, reach: null, saves: null,
      averageWatchTimeMs: null, totalWatchTimeMs: null, skipRatePercent: null })
    await w.service.publish(INPUT)
    const out = JSON.parse(await fs.readFile(join(w.project, 'outcomes.json'), 'utf8'))
    expect(out.versions.v1['tiktok:789']).toEqual(result); expect(out.versions.v1['789'].platform).toBe('instagram'); w.done()
  })
  it('sends a draft to inbox when direct scope is unavailable', async () => {
    const w = await world(); await w.seed({ scopes: SCOPES.slice(0, 3) }); w.success(true)
    expect(await w.service.publish(INPUT)).toMatchObject({ state: 'inbox', mode: 'inbox', postIds: [], message: expect.stringContaining('draft') })
    await expect(w.service.insights('fixture', 1, '789')).rejects.toMatchObject({ code: 'TT_POST' })
    await expect(fs.access(join(w.project, 'outcomes.json'))).rejects.toThrow(); w.done()
  })
  it('reconciles an inbox draft later published by its creator and attributes its stats', async () => {
    const w = await world({ direct: false }); await w.seed(); w.success(true)
    expect((await w.service.publish(INPUT)).state).toBe('inbox')
    w.status('PUBLISH_COMPLETE', 16, ['789'])
    expect((await w.service.publish(INPUT)).state).toBe('published')
    w.stats(); expect((await w.service.insights('fixture', 1, '789')).metrics?.plays).toBe(100); w.done()
  })
  it('links a public post whose id TikTok gives only after its review, keeping when it was published', async () => {
    const w = await world(); await w.seed(); w.success(false, [])
    expect(await w.service.publish(INPUT)).toMatchObject({ state: 'published', postIds: [] })
    await expect(fs.access(join(w.project, 'outcomes.json'))).rejects.toThrow()
    // asking again while TikTok can't answer keeps what was saved
    w.steps.push({ path: 'post/publish/status/fetch/', status: 500, raw: true, body: { error: { code: 'internal_error' } } })
    expect(await w.service.publish(INPUT)).toMatchObject({ state: 'published', postIds: [] })
    w.tick(3_600_000)
    w.status('PUBLISH_COMPLETE', 16, ['789'])
    expect(await w.service.publish(INPUT)).toMatchObject({ state: 'published', postIds: ['789'] })
    const out = JSON.parse(await fs.readFile(join(w.project, 'outcomes.json'), 'utf8'))
    expect(out.versions.v1['tiktok:789']).toMatchObject({ platform: 'tiktok', publishedAt: new Date(NOW).toISOString() })
    w.stats(); expect((await w.service.insights('fixture', 1, '789')).metrics?.plays).toBe(100)
    // once linked, asking again asks TikTok nothing
    expect(await w.service.publish(INPUT)).toMatchObject({ postIds: ['789'] }); w.done()
  })
  it('falls back to inbox only on a definite creator permission rejection', async () => {
    const w = await world(); await w.seed()
    w.steps.push({ path: 'post/publish/creator_info/query/', status: 401, raw: true, body: { error: { code: 'scope_not_authorized' } } })
    w.success(true)
    expect((await w.service.publish(INPUT)).state).toBe('inbox'); w.done()
  })
  it('surfaces private-only restrictions and publishes only the explicit Only me choice', async () => {
    const w = await world({ audited: false }); await w.seed(); w.creator()
    expect(await w.service.creator()).toMatchObject({ privateOnly: true, privacyOptions: ['SELF_ONLY'] })
    w.creator(); await expect(w.service.publish(INPUT)).rejects.toMatchObject({ code: 'TT_PRIVATE_ONLY', userMessage: expect.stringContaining('audit') })
    w.success(false, [])
    const result = await w.service.publish({ ...INPUT, privacy: 'SELF_ONLY' })
    expect(result).toMatchObject({ state: 'published', privateOnly: true, postIds: [], message: expect.stringContaining('privately') })
    await expect(fs.access(join(w.project, 'outcomes.json'))).rejects.toThrow(); w.done()
  })
  it('refreshes an expired access token through the broker and persists the rotated refresh token', async () => {
    const w = await world(); await w.seed({ expiresAt: NOW - 1 })
    w.steps.push({ path: 'oauth/token/', raw: true, body: token({ access_token: 'fabricated-next', refresh_token: 'fabricated-rotated' }), inspect: (init) => {
      const form = new URLSearchParams(String(init.body)); expect(form.get('refresh_token')).toBe(REFRESH)
      expect(form.get('client_secret')).toBe('fabricated-server-secret'); expect(form.get('grant_type')).toBe('refresh_token')
    } })
    w.steps.push({ path: 'post/publish/creator_info/query/', body: CREATOR, inspect: (init) => {
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer fabricated-next')
    } })
    await w.service.creator(); expect(await w.store.load()).toMatchObject({ accessToken: 'fabricated-next', refreshToken: 'fabricated-rotated' }); w.done()
  })
  it('refreshes once after a definite invalid-token rejection', async () => {
    const w = await world(); await w.seed()
    w.steps.push({ path: 'post/publish/creator_info/query/', status: 401, raw: true, body: { error: { code: 'access_token_invalid' } } })
    w.steps.push({ path: 'oauth/token/', raw: true, body: token({ access_token: 'fabricated-renewed' }) }); w.creator()
    expect((await w.service.creator()).displayName).toBe('Fixture creator'); w.done()
  })
  it('asks to reconnect after refresh expiry without sending an expired token', async () => {
    const w = await world(); await w.seed({ expiresAt: NOW - 1, refreshExpiresAt: NOW - 1 })
    await expect(w.service.creator()).rejects.toMatchObject({ code: 'TT_TOKEN' })
    expect(await w.service.session()).toEqual({ connected: false }); expect(w.calls).toEqual([])
  })
  it('resumes sequential chunks from TikTok progress with trailing bytes in the last chunk', async () => {
    const w = await world(); await w.seed()
    await fs.writeFile(join(w.version, 'export.mp4'), Buffer.alloc(25_000_003, 42))
    w.creator(); w.init(false, (init) => expect(JSON.parse(String(init.body)).source_info).toEqual({ source: 'FILE_UPLOAD',
      video_size: 25_000_003, chunk_size: 10_000_000, total_chunk_count: 2 }))
    w.status(); w.put(undefined, 206)
    w.steps.push({ path: UPLOAD, method: 'PUT', respond: async () => { throw new Error('fabricated socket loss') } })
    await expect(w.service.publish(INPUT)).rejects.toMatchObject({ code: 'TT_NETWORK' })
    w.status('PROCESSING_UPLOAD', 10_000_000)
    w.put(async (init) => {
      expect(new Headers(init.headers).get('content-range')).toBe('bytes 10000000-25000002/25000003')
      expect((await new Response(init.body).arrayBuffer()).byteLength).toBe(15_000_003)
    })
    w.status('PUBLISH_COMPLETE', 25_000_003, ['789'])
    expect((await w.service.publish(INPUT)).postIds).toEqual(['789']); w.done()
  })
  it('does not resend the final chunk after TikTok received it but its response was lost', async () => {
    const w = await world(); await w.seed(); w.creator(); w.init(); w.status()
    w.steps.push({ path: UPLOAD, method: 'PUT', respond: async () => { throw new Error('fabricated lost response') } })
    await expect(w.service.publish(INPUT)).rejects.toMatchObject({ code: 'TT_NETWORK' })
    w.status('PUBLISH_COMPLETE', 16, ['789'])
    expect((await w.service.publish(INPUT)).state).toBe('published'); w.done()
  })
  it('polls an uploaded video until TikTok confirms publication', async () => {
    const w = await world(); await w.seed(); w.creator(); w.init(); w.status(); w.put()
    w.status('PROCESSING_UPLOAD', 16); w.status('PUBLISH_COMPLETE', 16, ['789'])
    expect((await w.service.publish(INPUT)).state).toBe('published'); w.done()
  })
  it('keeps the receipt and maps a rate limit without retrying or overwriting stats', async () => {
    const w = await world(); await w.seed(); await w.published(); w.stats(); await w.service.insights('fixture', 1, '789')
    const before = await fs.readFile(join(w.project, 'outcomes.json'), 'utf8')
    w.steps.push({ path: 'video/query/?fields=id,view_count,like_count,comment_count,share_count', status: 429, raw: true,
      body: { error: { code: 'rate_limit_exceeded', message: TOKEN } } })
    await expect(w.service.insights('fixture', 1, '789')).rejects.toMatchObject({ code: 'TT_RATE_LIMIT', userMessage: expect.stringContaining('Wait') })
    expect(await fs.readFile(join(w.project, 'outcomes.json'), 'utf8')).toBe(before); w.done()
  })
  it('blocks duplicate init after an uncertain response', async () => {
    const w = await world(); await w.seed(); w.creator()
    w.steps.push({ path: 'post/publish/video/init/', respond: async () => { throw new Error('fabricated lost init') } })
    await expect(w.service.publish(INPUT)).rejects.toMatchObject({ code: 'TT_NETWORK' })
    await expect(w.service.publish(INPUT)).rejects.toMatchObject({ code: 'TT_PUBLISH_UNKNOWN' }); w.done()
  })
  it('preserves the receipt when a status reports a failed video', async () => {
    const w = await world(); await w.seed(); w.creator(); w.init()
    w.steps.push({ path: 'post/publish/status/fetch/', body: { status: 'FAILED', fail_reason: 'file_format_check_failed' } })
    await expect(w.service.publish(INPUT)).rejects.toMatchObject({ code: 'TT_FORMAT', userMessage: expect.stringContaining('MP4') })
    expect(JSON.parse(await fs.readFile(join(w.project, 'tiktok-publish.json'), 'utf8')).versions.v1.state).toBe('upload'); w.done()
  })
  it('refuses changed exports on resume and files outside the project', async () => {
    const w = await world(); await w.seed(); w.creator(); w.init()
    w.steps.push({ path: 'post/publish/status/fetch/', status: 429, raw: true, body: { error: { code: 'rate_limit_exceeded' } } })
    await expect(w.service.publish(INPUT)).rejects.toMatchObject({ code: 'TT_RATE_LIMIT' })
    await fs.writeFile(join(w.version, 'export.mp4'), 'different-video')
    await expect(w.service.publish(INPUT)).rejects.toMatchObject({ code: 'TT_PUBLISH_CHANGED' })
    const other = await world(); await other.seed()
    const outside = join(other.dir, 'private.mp4'); await fs.writeFile(outside, 'private')
    await fs.unlink(join(other.version, 'export.mp4')); await fs.symlink(outside, join(other.version, 'export.mp4'))
    await expect(other.service.publish(INPUT)).rejects.toMatchObject({ code: 'TT_PATH' }); w.done(); other.done()
  })
  it('rejects an outside descriptor opened during an ancestor swap and closes it', async () => {
    const w = await world(); await w.seed()
    const versions = join(w.project, 'versions'), parked = join(w.project, 'parked-versions'), outside = join(w.dir, 'outside')
    await fs.mkdir(join(outside, 'v1'), { recursive: true })
    await fs.writeFile(join(outside, 'v1', 'export.mp4'), 'fabricated-private-video')
    const target = await fs.realpath(join(w.version, 'export.mp4')), open = fs.open.bind(fs)
    let redirected: Awaited<ReturnType<typeof fs.open>> | undefined
    const spy = vi.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
      if (path !== target) return open(path, flags, mode)
      await fs.rename(versions, parked); await fs.symlink(outside, versions, 'junction')
      try { redirected = await open(path, flags, mode); return redirected }
      finally { await fs.unlink(versions); await fs.rename(parked, versions) }
    })
    try { await expect(w.service.publish(INPUT)).rejects.toMatchObject({ code: 'TT_PATH' }) }
    finally { spy.mockRestore() }
    expect(redirected).toBeDefined(); expect(redirected?.fd).toBe(-1)
    expect(w.calls).toEqual([]); w.done()
  })
  it('refuses unapproved upload addresses before sending video bytes', async () => {
    const w = await world(); await w.seed(); w.creator()
    w.steps.push({ path: 'post/publish/video/init/', body: { publish_id: 'fixture-publish', upload_url: 'https://unapproved.example/upload' } })
    await expect(w.service.publish(INPUT)).rejects.toMatchObject({ code: 'TT_UPLOAD_HOST' }); w.done()
  })
  it('requires explicit consent and validates duration and privacy before initializing', async () => {
    const w = await world(); await w.seed()
    await expect(w.service.publish({ ...INPUT, consent: false })).rejects.toMatchObject({ code: 'TT_CONSENT' })
    w.creator(); await expect(w.service.publish({ ...INPUT, durationSec: 61 })).rejects.toMatchObject({ code: 'TT_DURATION' })
    w.creator(); await expect(w.service.publish({ ...INPUT, privacy: 'FOLLOWER_OF_CREATOR' })).rejects.toMatchObject({ code: 'TT_PRIVACY' }); w.done()
  })
  it('disconnect cancels refresh and prevents credentials returning later', async () => {
    const w = await world(); await w.seed({ expiresAt: NOW - 1 })
    let started!: () => void; const began = new Promise<void>((resolve) => { started = resolve })
    w.steps.push({ path: 'oauth/token/', respond: (init) => new Promise((_resolve, reject) => {
      started(); init.signal?.addEventListener('abort', () => reject(new Error('fixture aborted')), { once: true })
    }) })
    const pending = expect(w.service.creator()).rejects.toMatchObject({ code: 'TT_CANCELLED' })
    // and asks TikTok, through the sign-in service, to end the grant
    w.steps.push({ path: 'oauth/revoke/', raw: true, body: {}, inspect: (init) => {
      expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({ client_key: 'fixture-key', client_secret: 'fabricated-server-secret', token: TOKEN })
    } })
    await began; await w.service.disconnect(); await pending
    expect(await w.store.load()).toBeNull(); w.done()
  })
  it('preserves corrupt outcomes and refuses stats from a different project version', async () => {
    const w = await world(); await w.seed(); await w.published()
    await expect(w.service.insights('fixture', 2, '789')).rejects.toMatchObject({ code: 'TT_POST' })
    await fs.writeFile(join(w.project, 'outcomes.json'), '{broken'); w.stats()
    await expect(w.service.insights('fixture', 1, '789')).rejects.toMatchObject({ code: 'TT_LOCAL_DATA' })
    expect(await fs.readFile(join(w.project, 'outcomes.json'), 'utf8')).toBe('{broken'); w.done()
  })
  it('serializes simultaneous Instagram and TikTok outcome writes', async () => {
    const w = await world()
    const post = { version: 1, accountId: '123', postId: '789', publishedAt: new Date(NOW).toISOString(), observedAt: null, metrics: null }
    await Promise.all([saveInstagramOutcome(w.project, { ...post, platform: 'instagram', apiVersion: 'v26.0' }),
      saveOutcome(w.project, { ...post, platform: 'tiktok', apiVersion: 'v2' })])
    const out = JSON.parse(await fs.readFile(join(w.project, 'outcomes.json'), 'utf8'))
    expect(Object.keys(out.versions.v1).sort()).toEqual(['789', 'tiktok:789'])
  })
  it('routes publish and insights through IPC and restricts configuration', async () => {
    const w = await world(); await w.seed(); w.success()
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const handle = (channel: string, fn: (_event: unknown, ...args: unknown[]) => unknown) => { handlers.set(channel, (...args) => fn(undefined, ...args)) }
    let configured: unknown
    registerTikTokIpc({ handle, dev: true, service: w.service, saveSettings: async (s) => { configured = s } })
    expect(await handlers.get('tiktok:publish')?.(INPUT)).toMatchObject({ state: 'published' })
    w.stats(); expect(await handlers.get('tiktok:insights')?.('fixture', 1, '789')).toMatchObject({ metrics: { plays: 100 } })
    // configuring forgets the connection, which also asks TikTok to end the grant
    w.steps.push({ path: 'oauth/revoke/', raw: true, body: {} })
    await handlers.get('tiktok:configure')?.({ ...w.settings, tiktokEnabled: false }); expect(configured).toMatchObject({ tiktokEnabled: false })
    registerTikTokIpc({ handle, dev: false, service: w.service, saveSettings: async () => { throw new Error('must not save') } })
    await expect(handlers.get('tiktok:configure')?.({})).rejects.toMatchObject({ code: 'TT_DISABLED' }); w.done()
  })
})

const errors = [
  ['access_token_invalid', 'TT_TOKEN', 'expired'], ['invalid_grant', 'TT_TOKEN', 'revoked'], ['auth_removed', 'TT_TOKEN', 'removed'],
  ['scope_not_authorized', 'TT_PERMISSION', 'permissions'], ['invalid_scope', 'TT_PERMISSION', 'approval'], ['access_denied', 'TT_DECLINED', 'not connected'],
  ['unaudited_client_can_only_post_to_private_accounts', 'TT_PRIVATE_ONLY', 'private-only'], ['privacy_level_option_mismatch', 'TT_PRIVACY', 'privacy'],
  ['spam_risk_too_many_pending_share', 'TT_DRAFT_LIMIT', 'pending drafts'], ['spam_risk_too_many_posts', 'TT_POST_LIMIT', 'daily posting'],
  ['reached_active_user_cap', 'TT_APP_LIMIT', 'creator limit'], ['spam_risk_user_banned_from_posting', 'TT_BANNED', 'blocked'],
  ['spam_risk_text', 'TT_CAPTION', 'caption'], ['spam_risk', 'TT_REJECTED', 'safety'], ['file_format_check_failed', 'TT_FORMAT', 'MP4'],
  ['duration_check_failed', 'TT_DURATION', 'length'], ['frame_rate_check_failed', 'TT_FRAME_RATE', 'frame rate'],
  ['picture_size_check_failed', 'TT_SIZE', 'dimensions'], ['video_pull_failed', 'TT_TRANSFER', 'download'], ['photo_pull_failed', 'TT_TRANSFER', 'download'],
  ['publish_cancelled', 'TT_CANCELLED', 'cancelled'], ['invalid_publish_id', 'TT_PUBLISH_ID', 'find'],
  ['token_not_authorized_for_specified_publish_id', 'TT_ACCOUNT', 'another'], ['url_ownership_unverified', 'TT_URL', 'local'],
  ['rate_limit_exceeded', 'TT_RATE_LIMIT', 'Wait'], ['invalid_client', 'TT_SETUP', 'configured'], ['unauthorized_client', 'TT_SETUP', 'configured'],
  ['unsupported_grant_type', 'TT_SETUP', 'configured'], ['unsupported_response_type', 'TT_SETUP', 'configured'],
  ['invalid_param', 'TT_INPUT', 'settings'], ['invalid_request', 'TT_INPUT', 'settings'], ['server_error', 'TT_API', 'later'],
  ['temporarily_unavailable', 'TT_API', 'later'], ['internal', 'TT_API', 'later'], ['internal_error', 'TT_API', 'later'], ['__proto__', 'TT_API', 'later']
]
describe('TikTok API and OAuth error messages', () => {
  it.each(errors)('maps %s without exposing provider text', async (code, expected, message) => {
    for (const error of [code, { code, message: TOKEN }]) {
      await expect(request(async () => Response.json({ error, error_description: TOKEN }, { status: 400 }), 'https://fixture.example',
        { method: 'POST' }, new AbortController().signal, false)).rejects.toMatchObject({ code: expected, userMessage: expect.stringContaining(message) })
    }
  })
  it.each([[400, 'TT_API'], [403, 'TT_PERMISSION'], [404, 'TT_API'], [413, 'TT_API'], [416, 'TT_API'], [429, 'TT_RATE_LIMIT'], [500, 'TT_API']])('maps non-JSON HTTP %s without exposing the response', async (status, code) => {
    await expect(request(async () => new Response(TOKEN, { status: Number(status) }), 'https://fixture.example', {}, new AbortController().signal))
      .rejects.toMatchObject({ code, userMessage: expect.not.stringContaining(TOKEN) })
  })
})
