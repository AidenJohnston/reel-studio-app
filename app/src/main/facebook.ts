// Posting a reel to a Facebook Page, from the main process. Graph API v26.0.
// Facebook Login: https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow
// Pages: https://developers.facebook.com/docs/pages-api/getting-started
// Reels publishing: https://developers.facebook.com/docs/video-api/guides/reels-publishing
//
// Connect signs in through Reel Studio's sign-in service (docs/signin.md), which holds the app secret and returns a
// long-lived user token; the app reads the Pages that token can post to and keeps their tokens, encrypted. A post
// is three calls: start (Facebook makes the video), the bytes to rupload.facebook.com (resumed from the count
// Facebook reports), and finish with video_state=PUBLISHED. facebook-publish.json in the project keeps where each
// version got to, so a retry carries on and a post Facebook may already have made is never sent twice.
import { createHash, randomBytes } from 'node:crypto'
import { constants, promises as fs } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { Readable } from 'node:stream'
import type { FacebookOutcome, FacebookPage, FacebookPost, FacebookPublishInput, FacebookSession } from '../shared/facebook'
import type { InstagramSecretStore } from './instagram-store'
import { serviceOrigin } from './instagram-http'
import { signinCallback } from './signin-callback'
import { atomicSocialFile, withSocialFile } from './social-store'

export const FACEBOOK_VERSION = 'v26.0'
export const FACEBOOK_GRAPH = `https://graph.facebook.com/${FACEBOOK_VERSION}`
const RUPLOAD = `https://rupload.facebook.com/video-upload/${FACEBOOK_VERSION}`
export const FACEBOOK_SCOPES = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts']
const MAX_VIDEO = 1_000_000_000

export class FacebookError extends Error {
  constructor(readonly code: string, readonly userMessage: string) {
    super(userMessage)
  }
}
const fail = (code: string, message: string): never => { throw new FacebookError(code, message) }
const invalid = (): never => fail('FB_RESPONSE', 'Facebook returned incomplete data. Try again later.')
const localError = (): never => fail('FB_LOCAL_DATA', 'The saved Facebook data could not be read. Connect Facebook again in Settings.')

function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return invalid()
  return v as Record<string, unknown>
}
function text(v: unknown): string {
  if (typeof v !== 'string' || !v || v.length > 10_000) return invalid()
  return v
}
function id(v: unknown): string {
  const t = typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : text(v)
  if (!/^\d{1,32}$/.test(t)) return invalid()
  return t
}

export type FacebookFetch = (url: string, init: RequestInit) => Promise<Response>

/** One Graph call. Meta's error codes become plain words; anything else is "try again later". */
export async function request(fetcher: FacebookFetch, url: string, init: RequestInit, signal: AbortSignal, onDispatch?: () => void): Promise<Record<string, unknown>> {
  signal.throwIfAborted()
  let res: Response
  try {
    onDispatch?.()
    res = await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]) })
  } catch {
    signal.throwIfAborted()
    return fail('FB_NETWORK', 'Facebook could not be reached. Check your connection and try again.')
  }
  let data: unknown = null
  try { data = await res.json() } catch { /* handled below */ }
  const err = data && typeof data === 'object' && 'error' in data ? (data as { error: unknown }).error : undefined
  if (res.ok && data && typeof data === 'object' && !err) return data as Record<string, unknown>
  const code = err && typeof err === 'object' ? (err as Record<string, unknown>).code : undefined
  if (res.status === 429 || code === 4 || code === 17 || code === 32 || code === 613 || code === 80001)
    return fail('FB_RATE_LIMIT', 'Facebook has reached a request limit. Wait a few minutes before trying again.')
  if (res.status === 401 || code === 190) return fail('FB_TOKEN', 'Your Facebook connection has ended. Connect Facebook again in Settings.')
  if (code === 10 || code === 200 || res.status === 403)
    return fail('FB_PERMISSION', 'Facebook did not allow this. Check that you can post to the Page, then connect again in Settings.')
  if (code === 100 || code === 6000) return fail('FB_INPUT', 'Facebook could not use this video. Reels need to be 3 to 90 seconds and vertical.')
  return fail('FB_API', 'Facebook could not finish this request. Try again later.')
}

const form = (fields: Record<string, string>, token: string): RequestInit => ({
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Bearer ${token}` }, body: new URLSearchParams(fields)
})
const get = (token: string): RequestInit => ({ method: 'GET', headers: { authorization: `Bearer ${token}` } })
const jsonPost = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

/** What Facebook's service sees: Facebook as the sign-in service offers it, or off. */
export interface FacebookSettings {
  appId: string | null
  brokerUrl: string | null
}

interface Credentials {
  userToken: string
  userName: string
  expiresAt: number
  pages: (FacebookPage & { token: string })[]
  pageId: string
  appId: string
  brokerUrl: string
}

interface Options {
  settings(): Promise<FacebookSettings>
  settingsDir: string
  projectsDir(): string
  secrets: InstagramSecretStore
  fetch: FacebookFetch
  openExternal(url: string): Promise<void>
  now?(): number
}

type Receipt =
  | { state: 'uploading' | 'publishing'; pageId: string; videoId: string; inputHash: string }
  | { state: 'published'; pageId: string; videoId: string; inputHash: string; post: FacebookPost }

function inside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel !== '' && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel)
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  let raw: string
  try { raw = await fs.readFile(file, 'utf8') } catch (e) {
    if (e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT') return null
    return localError()
  }
  try { return object(JSON.parse(raw)) } catch { return localError() }
}

async function receipt(dir: string, version: number): Promise<Receipt | null> {
  const saved = await readJson(join(dir, 'facebook-publish.json'))
  const v = saved?.versions && typeof saved.versions === 'object' ? (saved.versions as Record<string, unknown>)[`v${version}`] : undefined
  if (v === undefined) return null
  try {
    const r = object(v)
    const base = { pageId: id(r.pageId), videoId: id(r.videoId), inputHash: text(r.inputHash) }
    if (r.state === 'uploading' || r.state === 'publishing') return { ...base, state: r.state }
    if (r.state === 'published') {
      const p = object(r.post)
      return { ...base, state: 'published', post: { version, accountId: id(p.accountId), postId: id(p.postId), publishedAt: text(p.publishedAt) } }
    }
  } catch { /* below */ }
  return localError()
}

async function saveReceipt(dir: string, version: number, r: Receipt): Promise<void> {
  const file = join(dir, 'facebook-publish.json')
  const saved = await readJson(file)
  const versions = saved?.versions && typeof saved.versions === 'object' ? (saved.versions as Record<string, unknown>) : {}
  await atomicSocialFile(file, JSON.stringify({ schemaVersion: 1, versions: { ...versions, [`v${version}`]: r } }, null, 2) + '\n')
}

/** outcomes.json, next to Instagram's and TikTok's posts. Facebook ids are kept as facebook:<id>, like TikTok's. */
async function saveOutcome(dir: string, value: FacebookOutcome): Promise<void> {
  const file = join(dir, 'outcomes.json')
  return withSocialFile(file, async () => {
    const saved = await readJson(file)
    if (saved && saved.schemaVersion !== 1) return localError()
    const versions = saved?.versions && typeof saved.versions === 'object' ? (saved.versions as Record<string, unknown>) : {}
    const key = `v${value.version}`
    const posts = versions[key] && typeof versions[key] === 'object' ? (versions[key] as Record<string, unknown>) : {}
    const postKey = `facebook:${value.postId}`
    if (posts[postKey] !== undefined) return
    await atomicSocialFile(file, JSON.stringify({ ...saved, schemaVersion: 1, versions: { ...versions, [key]: { ...posts, [postKey]: value } } }, null, 2) + '\n')
  })
}

export class FacebookService {
  private queue: Promise<unknown> = Promise.resolve()
  private connection = new AbortController()
  private connecting?: AbortController

  constructor(private readonly o: Options) {}
  private now(): number { return this.o.now?.() ?? Date.now() }
  private file(): string { return join(this.o.settingsDir, 'facebook-credentials.bin') }

  private secure(): void {
    if (!this.o.secrets.isEncryptionAvailable() || this.o.secrets.getSelectedStorageBackend?.() === 'basic_text')
      fail('FB_SECURE_STORAGE', 'This computer cannot store the Facebook connection securely. Turn on its system keychain and try again.')
  }
  private async load(): Promise<Credentials | null> {
    let bytes: Buffer
    try { bytes = await fs.readFile(this.file()) } catch (e) {
      if (e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT') return null
      return localError()
    }
    this.secure()
    try {
      const c = object(JSON.parse(this.o.secrets.decryptString(bytes)))
      const pages = (Array.isArray(c.pages) ? c.pages : []).map((p) => { const x = object(p); return { id: id(x.id), name: text(x.name), token: text(x.token) } })
      if (!pages.length || typeof c.expiresAt !== 'number') return localError()
      return { userToken: text(c.userToken), userName: text(c.userName), expiresAt: c.expiresAt, pages, pageId: id(c.pageId), appId: id(c.appId), brokerUrl: text(c.brokerUrl) }
    } catch { return localError() }
  }
  private async save(c: Credentials): Promise<void> {
    this.secure()
    const bytes = this.o.secrets.encryptString(JSON.stringify(c))
    await fs.mkdir(this.o.settingsDir, { recursive: true })
    await atomicSocialFile(this.file(), bytes)
  }

  private async config(): Promise<{ appId: string; brokerUrl: string }> {
    const s = await this.o.settings()
    if (!s.appId || !s.brokerUrl) return fail('FB_DISABLED', 'Posting to Facebook isn’t open yet. Settings › Posting says what’s missing.')
    return { appId: s.appId, brokerUrl: serviceOrigin(s.brokerUrl) }
  }
  private async credentials(): Promise<Credentials> {
    const c = await this.config()
    const saved = await this.load()
    if (!saved || saved.appId !== c.appId || saved.brokerUrl !== c.brokerUrl) return fail('FB_TOKEN', 'Connect Facebook again in Settings.')
    return saved
  }
  private run<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const signal = AbortSignal.any([this.connection.signal, AbortSignal.timeout(30 * 60_000)])
    const work = async () => {
      try { signal.throwIfAborted(); return await fn(signal) } catch (e) {
        if (signal.aborted) fail('FB_CANCELLED', 'The Facebook action was cancelled. Check your Page before posting again.')
        throw e
      }
    }
    const result = this.queue.then(work, work)
    this.queue = result.catch(() => undefined)
    return result
  }

  private toSession(c: Credentials): FacebookSession {
    const page = c.pages.find((p) => p.id === c.pageId) ?? c.pages[0]
    return { connected: true, userName: c.userName, page: { id: page.id, name: page.name }, pages: c.pages.map((p) => ({ id: p.id, name: p.name })), expiresAt: c.expiresAt }
  }

  session(): Promise<FacebookSession> {
    return this.run(async () => {
      const c = await this.config().catch((e: unknown) => {
        if (e instanceof FacebookError && e.code === 'FB_DISABLED') return null
        throw e
      })
      if (!c) return { connected: false }
      const saved = await this.load()
      if (!saved || saved.appId !== c.appId || saved.brokerUrl !== c.brokerUrl || saved.expiresAt <= this.now()) return { connected: false }
      return this.toSession(saved)
    })
  }

  connect(): Promise<FacebookSession> {
    this.cancelConnect()
    const ac = new AbortController()
    this.connecting = ac
    return this.run(async (outer) => {
      const signal = AbortSignal.any([outer, ac.signal])
      const config = await this.config()
      this.secure()
      const state = randomBytes(32).toString('base64url')
      const verifier = randomBytes(32).toString('base64url')
      const listener = await signinCallback('Facebook', '/facebook/callback', state, signal, {
        declined: () => new FacebookError('FB_DECLINED', 'Facebook was not connected. You can try again in Settings.'),
        cancelled: () => new FacebookError('FB_CANCELLED', 'Facebook connection was cancelled.'),
        failed: () => new FacebookError('FB_CALLBACK', 'Could not open the Facebook callback. Try again.')
      })
      try {
        const started = await request(this.o.fetch, `${config.brokerUrl}/v1/facebook/start`, jsonPost({
          state, loopback_uri: listener.redirectUri, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256'
        }), signal)
        let url: URL
        try { url = new URL(text(started.authorize_url)) } catch { return invalid() }
        // only Facebook's own sign-in page for this app, sending the person back through the service
        if (url.origin + url.pathname !== `https://www.facebook.com/${FACEBOOK_VERSION}/dialog/oauth` || url.searchParams.get('client_id') !== config.appId ||
            url.searchParams.get('redirect_uri') !== `${config.brokerUrl}/v1/facebook/callback`)
          return invalid()
        signal.throwIfAborted()
        await this.o.openExternal(url.toString())
        const handoff = await listener.result
        const data = await request(this.o.fetch, `${config.brokerUrl}/v1/facebook/complete`, jsonPost({ handoff, code_verifier: verifier }), signal)
        const granted = Array.isArray(data.permissions) ? data.permissions : []
        if (String(data.token_type).toLowerCase() !== 'bearer' || !FACEBOOK_SCOPES.every((s) => granted.includes(s)))
          return fail('FB_PERMISSION', 'Allow Reel Studio to see your Pages and post to them when you connect Facebook.')
        const userToken = text(data.access_token)
        const expiresIn = typeof data.expires_in === 'number' && data.expires_in > 0 ? data.expires_in : invalid()
        const me = await request(this.o.fetch, `${FACEBOOK_GRAPH}/me?fields=name`, get(userToken), signal)
        const listed = await request(this.o.fetch, `${FACEBOOK_GRAPH}/me/accounts?fields=id,name,access_token,tasks&limit=100`, get(userToken), signal)
        const pages = (Array.isArray(listed.data) ? listed.data : []).flatMap((p) => {
          const x = object(p)
          return Array.isArray(x.tasks) && x.tasks.includes('CREATE_CONTENT') ? [{ id: id(x.id), name: text(x.name), token: text(x.access_token) }] : []
        })
        if (!pages.length)
          return fail('FB_NO_PAGE', 'Reel Studio posts reels to a Facebook Page, and this account can’t post to one. Make a Page, or ask its admin to let you post, then connect again.')
        const previous = await this.load().catch(() => null)
        const keep = previous && pages.some((p) => p.id === previous.pageId) ? previous.pageId : pages[0].id
        const c: Credentials = { userToken, userName: text(me.name), expiresAt: this.now() + expiresIn * 1000, pages, pageId: keep, appId: config.appId, brokerUrl: config.brokerUrl }
        signal.throwIfAborted()
        await this.save(c)
        return this.toSession(c)
      } finally {
        listener.close()
        if (this.connecting === ac) this.connecting = undefined
      }
    })
  }
  cancelConnect(): void { this.connecting?.abort() }
  stop(): void { this.cancelConnect(); this.connection.abort() }

  /** Forgets the connection here, then asks Facebook to end Reel Studio's access (5 s at most). */
  async disconnect(): Promise<void> {
    this.stop()
    this.connection = new AbortController()
    const forget = async () => {
      const c = await this.load().catch(() => null)
      await fs.rm(this.file(), { force: true })
      if (c) await request(this.o.fetch, `${FACEBOOK_GRAPH}/me/permissions`, { method: 'DELETE', headers: { authorization: `Bearer ${c.userToken}` } }, AbortSignal.timeout(5_000)).catch(() => undefined)
    }
    const result = this.queue.then(forget, forget)
    this.queue = result.catch(() => undefined)
    return result
  }

  choosePage(pageId: unknown): Promise<FacebookSession> {
    return this.run(async () => {
      const c = await this.credentials()
      if (typeof pageId !== 'string' || !c.pages.some((p) => p.id === pageId)) return fail('FB_INPUT', 'Choose one of your Pages.')
      const next = { ...c, pageId }
      await this.save(next)
      return this.toSession(next)
    })
  }

  private async project(slug: string, version: number): Promise<string> {
    if (!/^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u.test(slug) || !Number.isSafeInteger(version) || version < 1) return fail('FB_INPUT', 'Choose a finished version.')
    const root = await fs.realpath(this.o.projectsDir())
    const dir = await fs.realpath(join(root, slug))
    if (!inside(root, dir)) return fail('FB_PATH', 'This project is outside the Reel Studio projects folder.')
    await fs.access(join(dir, 'project.json'))
    return dir
  }

  private async openVideo(dir: string, version: number) {
    const vdir = join(dir, 'versions', `v${version}`)
    if (await fs.stat(join(vdir, '.rendering')).then(() => true, () => false)) return fail('FB_RENDERING', 'Wait for this version to finish exporting before posting.')
    const file = join(vdir, 'export.mp4')
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK)
    try {
      const stat = await handle.stat({ bigint: true })
      if (!stat.isFile() || stat.size < 1n || stat.size > BigInt(MAX_VIDEO)) return fail('FB_FILE', 'The exported video is empty or too large for Facebook.')
      const resolved = await fs.realpath(file)
      if (!inside(dir, resolved)) return fail('FB_PATH', 'The exported video is outside this project.')
      const checked = await fs.stat(resolved, { bigint: true })
      if (checked.dev !== stat.dev || checked.ino !== stat.ino) return fail('FB_PATH', 'The export changed while opening it. Try again.')
      return { handle, size: Number(stat.size) }
    } catch (e) { await handle.close(); throw e }
  }

  publish(value: unknown): Promise<FacebookPost> {
    return this.run(async (signal) => {
      const p = object(value)
      if (typeof p.slug !== 'string' || typeof p.version !== 'number' || typeof p.description !== 'string' || p.description.length > 2200)
        return fail('FB_INPUT', 'Choose a finished version and a description of at most 2,200 characters.')
      const input: FacebookPublishInput = { slug: p.slug, version: p.version, description: p.description }
      const dir = await this.project(input.slug, input.version)
      const c = await this.credentials()
      const page = c.pages.find((x) => x.id === c.pageId) ?? c.pages[0]
      const inputHash = createHash('sha256').update(JSON.stringify({ page: page.id, description: input.description })).digest('hex')
      let saved = await receipt(dir, input.version)
      if (saved?.state === 'published') {
        await saveOutcome(dir, { ...saved.post, platform: 'facebook', apiVersion: FACEBOOK_VERSION, observedAt: null, metrics: null })
        return saved.post
      }
      if (saved?.state === 'publishing')
        return fail('FB_PUBLISH_UNKNOWN', 'Facebook didn’t confirm whether this reel was posted. Check your Page before posting this version again.')
      if (saved && saved.inputHash !== inputHash) return fail('FB_PUBLISH_CHANGED', 'This version started posting with another Page or description. Post it with those, or export a new version.')
      const video = await this.openVideo(dir, input.version)
      try {
        if (!saved) {
          const started = await request(this.o.fetch, `${FACEBOOK_GRAPH}/${page.id}/video_reels`, form({ upload_phase: 'start' }, page.token), signal)
          saved = { state: 'uploading', pageId: page.id, videoId: id(started.video_id), inputHash }
          await saveReceipt(dir, input.version, saved)
        }
        // Facebook's own count of what it has, so a stopped upload carries on instead of starting again
        const status = await request(this.o.fetch, `${FACEBOOK_GRAPH}/${saved.videoId}?fields=status`, get(page.token), signal)
        const phase = object(object(status.status ?? {}).uploading_phase ?? {})
        const have = typeof phase.bytes_transfered === 'number' && Number.isSafeInteger(phase.bytes_transfered) ? phase.bytes_transfered : 0
        if (have < 0 || have > video.size) return invalid()
        if (have < video.size) {
          const stream = video.handle.createReadStream({ start: have, autoClose: false })
          try {
            const init = {
              method: 'POST',
              headers: { authorization: `OAuth ${page.token}`, offset: String(have), file_size: String(video.size), 'content-type': 'application/octet-stream', 'content-length': String(video.size - have) },
              body: Readable.toWeb(stream) as unknown as BodyInit,
              duplex: 'half'
            } satisfies RequestInit & { duplex: 'half' }
            const up = await request(this.o.fetch, `${RUPLOAD}/${saved.videoId}`, init, signal)
            if (up.success !== true) return fail('FB_UPLOAD', 'Facebook didn’t take the whole video. Post this version again to carry on.')
          } finally { stream.destroy() }
        }
        signal.throwIfAborted()
        saved = { ...saved, state: 'publishing' }
        await saveReceipt(dir, input.version, saved)
        let dispatched = false
        try {
          const done = await request(this.o.fetch, `${FACEBOOK_GRAPH}/${page.id}/video_reels`, form({
            upload_phase: 'finish', video_id: saved.videoId, video_state: 'PUBLISHED', description: input.description
          }, page.token), signal, () => { dispatched = true })
          if (done.success !== true) return invalid()
        } catch (e) {
          // A definite rejection posted nothing; a lost answer may have, so the version stays blocked.
          if (!dispatched || (e instanceof FacebookError && ['FB_RATE_LIMIT', 'FB_TOKEN', 'FB_PERMISSION', 'FB_INPUT'].includes(e.code))) {
            await saveReceipt(dir, input.version, { ...saved, state: 'uploading' })
            throw e
          }
          return fail('FB_PUBLISH_UNKNOWN', 'Facebook didn’t confirm whether this reel was posted. Check your Page before posting this version again.')
        }
        const post: FacebookPost = { version: input.version, accountId: page.id, postId: saved.videoId, publishedAt: new Date(this.now()).toISOString() }
        try {
          await saveReceipt(dir, input.version, { ...saved, state: 'published', post })
          await saveOutcome(dir, { ...post, platform: 'facebook', apiVersion: FACEBOOK_VERSION, observedAt: null, metrics: null })
        } catch {
          return fail('FB_PUBLISHED_UNSAVED', `Facebook posted reel ${post.postId}, but Reel Studio couldn’t save that. Don’t post it again.`)
        }
        return post
      } finally { await video.handle.close() }
    })
  }
}
