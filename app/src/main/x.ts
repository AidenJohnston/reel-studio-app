// Posting a reel to X, from the main process. X API v2.
// OAuth 2.0: https://docs.x.com/fundamentals/authentication/oauth-2-0/user-access-token
// Media upload: https://docs.x.com/x-api/media/quickstart/media-upload-chunked
// Posts: https://docs.x.com/x-api/posts/manage-tweets/introduction
//
// Connect signs in through Reel Studio's sign-in service (docs/signin.md), which adds X's PKCE and the client secret;
// the app keeps the two-hour access token and the refresh token (X replaces it on every refresh), encrypted, and
// refreshes through the service. A post uploads the export in 4 MB pieces (initialize, append, finalize, then waits
// while X processes it) and posts it with the text. x-publish.json keeps a post X may already have made, so a lost
// answer never turns into a second post.
import { createHash, randomBytes } from 'node:crypto'
import { constants, promises as fs } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { XPost, XSession } from '../shared/x'
import type { InstagramSecretStore } from './instagram-store'
import { serviceOrigin } from './instagram-http'
import { SocialError, type MetaFetch } from './meta-http'
import { signinCallback } from './signin-callback'
import { atomicSocialFile, withSocialFile } from './social-store'

export const X_API = 'https://api.x.com/2'
const TEXT_MAX = 280
const SEGMENT = 4 * 1024 * 1024
const MAX_VIDEO = 512 * 1024 * 1024

const fail = (code: string, message: string): never => { throw new SocialError(`X_${code}`, message) }
const invalid = (): never => fail('RESPONSE', 'X returned incomplete data. Try again later.')
const localError = (): never => fail('LOCAL_DATA', 'The saved X data could not be read. Connect X again in Settings.')
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return invalid()
  return v as Record<string, unknown>
}
function text(v: unknown): string {
  if (typeof v !== 'string' || !v || v.length > 10_000) return invalid()
  return v
}
function id(v: unknown): string {
  const t = text(v)
  if (!/^\d{1,32}$/.test(t)) return invalid()
  return t
}

/** One call to X or to the sign-in service. X's refusals become plain words. */
async function request(fetcher: MetaFetch, url: string, init: RequestInit, signal: AbortSignal, onDispatch?: () => void): Promise<Record<string, unknown>> {
  signal.throwIfAborted()
  let res: Response
  try {
    onDispatch?.()
    res = await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]) })
  } catch {
    signal.throwIfAborted()
    return fail('NETWORK', 'X could not be reached. Check your connection and try again.')
  }
  let data: unknown = null
  try { data = await res.json() } catch { /* below */ }
  if (res.ok && data && typeof data === 'object' && !('errors' in data && !('data' in data))) return data as Record<string, unknown>
  if (res.status === 401) return fail('TOKEN', 'Your X connection has ended. Connect X again in Settings.')
  if (res.status === 402) return fail('CREDITS', 'X needs more API credits on Reel Studio’s developer account before it can post. Post this one in X for now.')
  if (res.status === 429) return fail('RATE_LIMIT', 'X has reached a request limit. Wait a few minutes before trying again.')
  if (res.status === 403) return fail('PERMISSION', 'X didn’t allow this post. Videos can be up to 2 minutes 20 seconds on most accounts; check the account in X.')
  if (res.status === 400) return fail('INPUT', 'X couldn’t use this video or text. Check its length and try again.')
  return fail('API', 'X could not finish this request. Try again later.')
}
const jsonPost = (body: unknown, token?: string): RequestInit => ({
  method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body)
})

export interface XSettings {
  clientId: string | null
  brokerUrl: string | null
}

interface Credentials {
  token: string
  refresh: string
  expiresAt: number
  userId: string
  username: string
  clientId: string
  brokerUrl: string
}

type Receipt =
  | { state: 'posting'; userId: string; inputHash: string }
  | { state: 'published'; userId: string; inputHash: string; post: XPost }

interface Options {
  settings(): Promise<XSettings>
  settingsDir: string
  projectsDir(): string
  secrets: InstagramSecretStore
  fetch: MetaFetch
  openExternal(url: string): Promise<void>
  now?(): number
  /** Most to wait between processing checks when X gives no check_after_secs (tests pass 0). */
  waitMs?: number
}

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

export class XService {
  private queue: Promise<unknown> = Promise.resolve()
  private connection = new AbortController()
  private connecting?: AbortController

  constructor(private readonly o: Options) {}
  private now(): number { return this.o.now?.() ?? Date.now() }
  private file(): string { return join(this.o.settingsDir, 'x-credentials.bin') }
  private secure(): void {
    if (!this.o.secrets.isEncryptionAvailable() || this.o.secrets.getSelectedStorageBackend?.() === 'basic_text')
      fail('SECURE_STORAGE', 'This computer cannot store the X connection securely. Turn on its system keychain and try again.')
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
      if (typeof c.expiresAt !== 'number') return localError()
      return { token: text(c.token), refresh: text(c.refresh), expiresAt: c.expiresAt, userId: id(c.userId), username: text(c.username), clientId: text(c.clientId), brokerUrl: text(c.brokerUrl) }
    } catch { return localError() }
  }
  private async save(c: Credentials): Promise<void> {
    this.secure()
    const bytes = this.o.secrets.encryptString(JSON.stringify(c))
    await fs.mkdir(this.o.settingsDir, { recursive: true })
    await atomicSocialFile(this.file(), bytes)
  }
  private async config(): Promise<{ clientId: string; brokerUrl: string }> {
    const s = await this.o.settings()
    if (!s.clientId || !s.brokerUrl) return fail('DISABLED', 'Posting to X isn’t open yet. Settings › Posting says what’s missing.')
    return { clientId: s.clientId, brokerUrl: serviceOrigin(s.brokerUrl) }
  }
  /** The saved connection, refreshed through the service when its two hours are nearly up. */
  private async credentials(signal: AbortSignal): Promise<Credentials> {
    const cfg = await this.config()
    let c = await this.load()
    if (!c || c.clientId !== cfg.clientId || c.brokerUrl !== cfg.brokerUrl) return fail('TOKEN', 'Connect X again in Settings.')
    if (c.expiresAt - this.now() < 5 * 60_000) {
      const r = await request(this.o.fetch, `${cfg.brokerUrl}/v1/x/refresh`, jsonPost({ refresh_token: c.refresh }), signal)
      c = { ...c, token: text(r.access_token), refresh: text(r.refresh_token), expiresAt: this.now() + (typeof r.expires_in === 'number' ? r.expires_in : invalid()) * 1000 }
      // X has already retired the old refresh token: keep the new one before anything else can fail
      await this.save(c)
    }
    return c
  }
  private run<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const signal = AbortSignal.any([this.connection.signal, AbortSignal.timeout(20 * 60_000)])
    const work = async () => {
      try { signal.throwIfAborted(); return await fn(signal) } catch (e) {
        if (signal.aborted) fail('CANCELLED', 'The X action was cancelled. Check X before posting again.')
        throw e
      }
    }
    const result = this.queue.then(work, work)
    this.queue = result.catch(() => undefined)
    return result
  }

  session(): Promise<XSession> {
    return this.run(async () => {
      const cfg = await this.config().catch((e: unknown) => {
        if (e instanceof SocialError && e.code === 'X_DISABLED') return null
        throw e
      })
      if (!cfg) return { connected: false }
      const c = await this.load()
      if (!c || c.clientId !== cfg.clientId || c.brokerUrl !== cfg.brokerUrl) return { connected: false }
      return { connected: true, accountId: c.userId, username: c.username }
    })
  }

  connect(): Promise<XSession> {
    this.cancelConnect()
    const ac = new AbortController()
    this.connecting = ac
    return this.run(async (outer) => {
      const signal = AbortSignal.any([outer, ac.signal])
      const cfg = await this.config()
      this.secure()
      const state = randomBytes(32).toString('base64url')
      const verifier = randomBytes(32).toString('base64url')
      const listener = await signinCallback('X', '/x/callback', state, signal, {
        declined: () => new SocialError('X_DECLINED', 'X was not connected. You can try again in Settings.'),
        cancelled: () => new SocialError('X_CANCELLED', 'X connection was cancelled.'),
        failed: () => new SocialError('X_CALLBACK', 'Could not open the X callback. Try again.')
      })
      try {
        const started = await request(this.o.fetch, `${cfg.brokerUrl}/v1/x/start`, jsonPost({
          state, loopback_uri: listener.redirectUri, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256'
        }), signal)
        let url: URL
        try { url = new URL(text(started.authorize_url)) } catch { return invalid() }
        if (url.origin + url.pathname !== 'https://x.com/i/oauth2/authorize' || url.searchParams.get('client_id') !== cfg.clientId ||
            url.searchParams.get('redirect_uri') !== `${cfg.brokerUrl}/v1/x/callback`)
          return invalid()
        signal.throwIfAborted()
        await this.o.openExternal(url.toString())
        const handoff = await listener.result
        const data = await request(this.o.fetch, `${cfg.brokerUrl}/v1/x/complete`, jsonPost({ handoff, code_verifier: verifier }), signal)
        const granted = Array.isArray(data.permissions) ? data.permissions : []
        if (!['tweet.write', 'media.write', 'users.read'].every((s) => granted.includes(s)))
          return fail('PERMISSION', 'Allow Reel Studio to post and upload media when you connect X.')
        const token = text(data.access_token)
        const me = object((await request(this.o.fetch, `${X_API}/users/me`, { method: 'GET', headers: { authorization: `Bearer ${token}` } }, signal)).data)
        const c: Credentials = {
          token, refresh: text(data.refresh_token), expiresAt: this.now() + (typeof data.expires_in === 'number' ? data.expires_in : invalid()) * 1000,
          userId: id(me.id), username: text(me.username), clientId: cfg.clientId, brokerUrl: cfg.brokerUrl
        }
        signal.throwIfAborted()
        await this.save(c)
        return { connected: true, accountId: c.userId, username: c.username }
      } finally {
        listener.close()
        if (this.connecting === ac) this.connecting = undefined
      }
    })
  }
  cancelConnect(): void { this.connecting?.abort() }
  stop(): void { this.cancelConnect(); this.connection.abort() }
  /** Forgets the connection here, then asks X (through the service) to end the token, 5 s at most. */
  async disconnect(): Promise<void> {
    this.stop()
    this.connection = new AbortController()
    const forget = async () => {
      const c = await this.load().catch(() => null)
      await fs.rm(this.file(), { force: true })
      if (c) await request(this.o.fetch, `${c.brokerUrl}/v1/x/revoke`, jsonPost({ token: c.token }), AbortSignal.timeout(5_000)).catch(() => undefined)
    }
    const result = this.queue.then(forget, forget)
    this.queue = result.catch(() => undefined)
    return result
  }

  private async project(slug: string, version: number): Promise<string> {
    if (!/^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u.test(slug) || !Number.isSafeInteger(version) || version < 1) return fail('INPUT', 'Choose a finished version.')
    const root = await fs.realpath(this.o.projectsDir())
    const dir = await fs.realpath(join(root, slug))
    if (!inside(root, dir)) return fail('PATH', 'This project is outside the Reel Studio projects folder.')
    await fs.access(join(dir, 'project.json'))
    return dir
  }

  /** Uploads the version's export to X and waits until X can post it: its media id. */
  private async upload(dir: string, version: number, c: Credentials, signal: AbortSignal): Promise<string> {
    const vdir = join(dir, 'versions', `v${version}`)
    if (await fs.stat(join(vdir, '.rendering')).then(() => true, () => false)) return fail('RENDERING', 'Wait for this version to finish exporting before posting.')
    const file = join(vdir, 'export.mp4')
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK)
    try {
      const stat = await handle.stat({ bigint: true })
      if (!stat.isFile() || stat.size < 1n || stat.size > BigInt(MAX_VIDEO)) return fail('FILE', 'The exported video is empty or too large for X.')
      const resolved = await fs.realpath(file)
      if (!inside(dir, resolved)) return fail('PATH', 'The exported video is outside this project.')
      const checked = await fs.stat(resolved, { bigint: true })
      if (checked.dev !== stat.dev || checked.ino !== stat.ino) return fail('PATH', 'The export changed while opening it. Try again.')
      const size = Number(stat.size)
      const auth = { authorization: `Bearer ${c.token}` }
      const init = object((await request(this.o.fetch, `${X_API}/media/upload/initialize`, jsonPost({ media_type: 'video/mp4', total_bytes: size, media_category: 'tweet_video' }, c.token), signal)).data)
      const mediaId = id(init.id)
      const buffer = Buffer.alloc(SEGMENT)
      for (let at = 0, segment = 0; at < size; segment++) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(SEGMENT, size - at), at)
        if (!bytesRead) return fail('FILE', 'The export changed while uploading it. Export it again.')
        const part = new FormData()
        part.set('segment_index', String(segment))
        part.set('media', new Blob([new Uint8Array(buffer.subarray(0, bytesRead))], { type: 'application/octet-stream' }), 'chunk')
        await request(this.o.fetch, `${X_API}/media/upload/${mediaId}/append`, { method: 'POST', headers: auth, body: part }, signal)
        at += bytesRead
      }
      let info = object((await request(this.o.fetch, `${X_API}/media/upload/${mediaId}/finalize`, { method: 'POST', headers: auth }, signal)).data).processing_info
      for (let i = 0; i < 30 && info !== undefined; i++) {
        const p = object(info)
        if (p.state === 'succeeded') break
        if (p.state === 'failed') return fail('PROCESSING', 'X couldn’t use this video. X takes MP4s up to 2 minutes 20 seconds on most accounts.')
        if (p.state !== 'pending' && p.state !== 'in_progress') return invalid()
        const wait = typeof p.check_after_secs === 'number' && p.check_after_secs > 0 ? Math.min(p.check_after_secs, 30) * 1000 : 5_000
        await delay(this.o.waitMs ?? wait, undefined, { signal })
        const q = new URLSearchParams({ command: 'STATUS', media_id: mediaId })
        info = object((await request(this.o.fetch, `${X_API}/media/upload?${q}`, { method: 'GET', headers: auth }, signal)).data).processing_info
      }
      if (info !== undefined && object(info).state !== 'succeeded') return fail('PROCESSING', 'X is still working on the video. Post this version again in a few minutes.')
      return mediaId
    } finally { await handle.close() }
  }

  publish(value: unknown): Promise<XPost> {
    return this.run(async (signal) => {
      const p = object(value)
      if (typeof p.slug !== 'string' || typeof p.version !== 'number' || typeof p.text !== 'string' || [...p.text].length > TEXT_MAX)
        return fail('INPUT', `Choose a finished version and text of at most ${TEXT_MAX} characters.`)
      const dir = await this.project(p.slug, p.version)
      const c = await this.credentials(signal)
      const version = p.version
      const file = join(dir, 'x-publish.json')
      const all = await readJson(file)
      const versions = all?.versions && typeof all.versions === 'object' ? (all.versions as Record<string, unknown>) : {}
      const raw = versions[`v${version}`]
      const inputHash = createHash('sha256').update(JSON.stringify({ text: p.text })).digest('hex')
      if (raw !== undefined) {
        const r = object(raw)
        if (r.userId !== c.userId) return fail('ACCOUNT', 'This version was posted to another X account.')
        if (r.state === 'published') return { version, accountId: c.userId, postId: id(object(r.post).postId), publishedAt: text(object(r.post).publishedAt) }
        if (r.state === 'posting') return fail('PUBLISH_UNKNOWN', 'X didn’t confirm whether this was posted. Check X before posting this version again.')
        return localError()
      }
      const save = (r: Receipt) => atomicSocialFile(file, JSON.stringify({ schemaVersion: 1, versions: { ...versions, [`v${version}`]: r } }, null, 2) + '\n')
      const mediaId = await this.upload(dir, version, c, signal)
      signal.throwIfAborted()
      await save({ state: 'posting', userId: c.userId, inputHash })
      let dispatched = false
      let postId: string
      try {
        const r = object((await request(this.o.fetch, `${X_API}/tweets`, jsonPost({ text: p.text, media: { media_ids: [mediaId] } }, c.token), signal, () => { dispatched = true })).data)
        postId = id(r.id)
      } catch (e) {
        // A definite refusal posted nothing: forget the attempt. A lost answer may have posted, so it stays blocked.
        if (!dispatched || (e instanceof SocialError && ['X_TOKEN', 'X_CREDITS', 'X_RATE_LIMIT', 'X_PERMISSION', 'X_INPUT'].includes(e.code))) {
          const { [`v${version}`]: _dropped, ...rest } = versions
          void _dropped
          await atomicSocialFile(file, JSON.stringify({ schemaVersion: 1, versions: rest }, null, 2) + '\n')
          throw e
        }
        return fail('PUBLISH_UNKNOWN', 'X didn’t confirm whether this was posted. Check X before posting this version again.')
      }
      const post: XPost = { version, accountId: c.userId, postId, publishedAt: new Date(this.now()).toISOString() }
      try {
        await save({ state: 'published', userId: c.userId, inputHash, post })
        await withSocialFile(join(dir, 'outcomes.json'), async () => {
          const saved = await readJson(join(dir, 'outcomes.json'))
          if (saved && saved.schemaVersion !== 1) return localError()
          const vs = saved?.versions && typeof saved.versions === 'object' ? (saved.versions as Record<string, unknown>) : {}
          const posts = vs[`v${version}`] && typeof vs[`v${version}`] === 'object' ? (vs[`v${version}`] as Record<string, unknown>) : {}
          await atomicSocialFile(join(dir, 'outcomes.json'), JSON.stringify({ ...saved, schemaVersion: 1, versions: { ...vs, [`v${version}`]: { ...posts, [`x:${postId}`]: { ...post, platform: 'x', apiVersion: 'v2', observedAt: null, metrics: null } } } }, null, 2) + '\n')
        })
      } catch {
        return fail('PUBLISHED_UNSAVED', `X posted ${postId}, but Reel Studio couldn’t save that. Don’t post it again.`)
      }
      return post
    })
  }
}
