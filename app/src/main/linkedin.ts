// Posting a reel to LinkedIn as the signed-in member, from the main process. LinkedIn REST API, version 202610.
// Sign-in: https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow
// Videos: https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api
// Posts: https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api
//
// Connect signs in through Reel Studio's sign-in service (docs/signin.md); the 60-day token is kept encrypted and,
// since LinkedIn gives refresh tokens only to its partner apps, the app asks to connect again when it ends. A post
// uploads the export in the parts LinkedIn names (4 MB each), finalizes it with each part's ETag, waits until
// LinkedIn has processed it, and posts it with the text. linkedin-publish.json keeps a post LinkedIn may already
// have made, so a lost answer never turns into a second post.
import { createHash, randomBytes } from 'node:crypto'
import { constants, promises as fs } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { LinkedInPost, LinkedInSession } from '../shared/linkedin'
import type { InstagramSecretStore } from './instagram-store'
import { serviceOrigin } from './instagram-http'
import { SocialError, type MetaFetch } from './meta-http'
import { signinCallback } from './signin-callback'
import { atomicSocialFile, withSocialFile } from './social-store'

export const LINKEDIN_API = 'https://api.linkedin.com'
export const LINKEDIN_VERSION = '202610'
const TEXT_MAX = 3000
const MAX_VIDEO = 500 * 1024 * 1024

const fail = (code: string, message: string): never => { throw new SocialError(`LI_${code}`, message) }
const invalid = (): never => fail('RESPONSE', 'LinkedIn returned incomplete data. Try again later.')
const localError = (): never => fail('LOCAL_DATA', 'The saved LinkedIn data could not be read. Connect LinkedIn again in Settings.')
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return invalid()
  return v as Record<string, unknown>
}
function text(v: unknown): string {
  if (typeof v !== 'string' || !v || v.length > 10_000) return invalid()
  return v
}

/** One call to LinkedIn or the sign-in service: the answer (JSON or empty) and its headers. Refusals become plain words. */
async function call(fetcher: MetaFetch, url: string, init: RequestInit, signal: AbortSignal, onDispatch?: () => void): Promise<{ data: Record<string, unknown>; headers: Headers }> {
  signal.throwIfAborted()
  let res: Response
  try {
    onDispatch?.()
    res = await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]) })
  } catch {
    signal.throwIfAborted()
    return fail('NETWORK', 'LinkedIn could not be reached. Check your connection and try again.')
  }
  const raw = await res.text().catch(() => '')
  let data: unknown = {}
  // a success often has no body (part uploads, new posts: what matters is in the headers); a body that isn't JSON is ignored
  if (raw) try { data = JSON.parse(raw) } catch { data = res.ok ? {} : null }
  if (res.ok && data && typeof data === 'object') return { data: data as Record<string, unknown>, headers: res.headers }
  if (res.status === 401) return fail('TOKEN', 'Your LinkedIn connection has ended. Connect LinkedIn again in Settings.')
  if (res.status === 403) return fail('PERMISSION', 'LinkedIn didn’t allow this. Connect LinkedIn again in Settings and allow posting.')
  if (res.status === 429) return fail('RATE_LIMIT', 'LinkedIn has reached a request limit. Try again later.')
  if (res.status === 400 || res.status === 422) return fail('INPUT', 'LinkedIn couldn’t use this video or text. Videos need to be 3 seconds to 30 minutes.')
  return fail('API', 'LinkedIn could not finish this request. Try again later.')
}
const rest = (token: string, json = true): Record<string, string> => ({
  authorization: `Bearer ${token}`, 'linkedin-version': LINKEDIN_VERSION, 'x-restli-protocol-version': '2.0.0', ...(json ? { 'content-type': 'application/json' } : {})
})
const jsonPost = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

export interface LinkedInSettings {
  clientId: string | null
  brokerUrl: string | null
}

interface Credentials {
  token: string
  expiresAt: number
  /** The member's id (OpenID `sub`); posts are by urn:li:person:<id>. */
  memberId: string
  name: string
  clientId: string
  brokerUrl: string
}

interface Options {
  settings(): Promise<LinkedInSettings>
  settingsDir: string
  projectsDir(): string
  secrets: InstagramSecretStore
  fetch: MetaFetch
  openExternal(url: string): Promise<void>
  now?(): number
  /** Between processing checks (tests pass 0). */
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

/** A LinkedIn upload link: https on a linkedin.com host, nothing else. */
function uploadLink(v: unknown): string {
  let u: URL
  try { u = new URL(text(v)) } catch { return invalid() }
  if (u.protocol !== 'https:' || !(u.hostname === 'linkedin.com' || u.hostname.endsWith('.linkedin.com'))) return invalid()
  return u.toString()
}

export class LinkedInService {
  private queue: Promise<unknown> = Promise.resolve()
  private connection = new AbortController()
  private connecting?: AbortController

  constructor(private readonly o: Options) {}
  private now(): number { return this.o.now?.() ?? Date.now() }
  private file(): string { return join(this.o.settingsDir, 'linkedin-credentials.bin') }
  private secure(): void {
    if (!this.o.secrets.isEncryptionAvailable() || this.o.secrets.getSelectedStorageBackend?.() === 'basic_text')
      fail('SECURE_STORAGE', 'This computer cannot store the LinkedIn connection securely. Turn on its system keychain and try again.')
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
      return { token: text(c.token), expiresAt: c.expiresAt, memberId: text(c.memberId), name: text(c.name), clientId: text(c.clientId), brokerUrl: text(c.brokerUrl) }
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
    if (!s.clientId || !s.brokerUrl) return fail('DISABLED', 'Posting to LinkedIn isn’t open yet. Settings › Posting says what’s missing.')
    return { clientId: s.clientId, brokerUrl: serviceOrigin(s.brokerUrl) }
  }
  private async credentials(): Promise<Credentials> {
    const cfg = await this.config()
    const c = await this.load()
    if (!c || c.clientId !== cfg.clientId || c.brokerUrl !== cfg.brokerUrl || c.expiresAt <= this.now()) return fail('TOKEN', 'Connect LinkedIn again in Settings.')
    return c
  }
  private run<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const signal = AbortSignal.any([this.connection.signal, AbortSignal.timeout(30 * 60_000)])
    const work = async () => {
      try { signal.throwIfAborted(); return await fn(signal) } catch (e) {
        if (signal.aborted) fail('CANCELLED', 'The LinkedIn action was cancelled. Check LinkedIn before posting again.')
        throw e
      }
    }
    const result = this.queue.then(work, work)
    this.queue = result.catch(() => undefined)
    return result
  }

  session(): Promise<LinkedInSession> {
    return this.run(async () => {
      const cfg = await this.config().catch((e: unknown) => {
        if (e instanceof SocialError && e.code === 'LI_DISABLED') return null
        throw e
      })
      if (!cfg) return { connected: false }
      const c = await this.load()
      if (!c || c.clientId !== cfg.clientId || c.brokerUrl !== cfg.brokerUrl || c.expiresAt <= this.now()) return { connected: false }
      return { connected: true, accountId: c.memberId, name: c.name, expiresAt: c.expiresAt }
    })
  }

  connect(): Promise<LinkedInSession> {
    this.cancelConnect()
    const ac = new AbortController()
    this.connecting = ac
    return this.run(async (outer) => {
      const signal = AbortSignal.any([outer, ac.signal])
      const cfg = await this.config()
      this.secure()
      const state = randomBytes(32).toString('base64url')
      const verifier = randomBytes(32).toString('base64url')
      const listener = await signinCallback('LinkedIn', '/linkedin/callback', state, signal, {
        declined: () => new SocialError('LI_DECLINED', 'LinkedIn was not connected. You can try again in Settings.'),
        cancelled: () => new SocialError('LI_CANCELLED', 'LinkedIn connection was cancelled.'),
        failed: () => new SocialError('LI_CALLBACK', 'Could not open the LinkedIn callback. Try again.')
      })
      try {
        const { data: started } = await call(this.o.fetch, `${cfg.brokerUrl}/v1/linkedin/start`, jsonPost({
          state, loopback_uri: listener.redirectUri, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256'
        }), signal)
        let url: URL
        try { url = new URL(text(started.authorize_url)) } catch { return invalid() }
        if (url.origin + url.pathname !== 'https://www.linkedin.com/oauth/v2/authorization' || url.searchParams.get('client_id') !== cfg.clientId ||
            url.searchParams.get('redirect_uri') !== `${cfg.brokerUrl}/v1/linkedin/callback`)
          return invalid()
        signal.throwIfAborted()
        await this.o.openExternal(url.toString())
        const handoff = await listener.result
        const { data } = await call(this.o.fetch, `${cfg.brokerUrl}/v1/linkedin/complete`, jsonPost({ handoff, code_verifier: verifier }), signal)
        const granted = Array.isArray(data.permissions) ? data.permissions : []
        if (!granted.includes('w_member_social')) return fail('PERMISSION', 'Allow Reel Studio to post for you when you connect LinkedIn.')
        const token = text(data.access_token)
        const { data: me } = await call(this.o.fetch, `${LINKEDIN_API}/v2/userinfo`, { method: 'GET', headers: { authorization: `Bearer ${token}` } }, signal)
        const memberId = text(me.sub)
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(memberId)) return invalid()
        const c: Credentials = {
          token, expiresAt: this.now() + (typeof data.expires_in === 'number' ? data.expires_in : invalid()) * 1000,
          memberId, name: text(me.name), clientId: cfg.clientId, brokerUrl: cfg.brokerUrl
        }
        signal.throwIfAborted()
        await this.save(c)
        return { connected: true, accountId: c.memberId, name: c.name, expiresAt: c.expiresAt }
      } finally {
        listener.close()
        if (this.connecting === ac) this.connecting = undefined
      }
    })
  }
  cancelConnect(): void { this.connecting?.abort() }
  stop(): void { this.cancelConnect(); this.connection.abort() }
  /** Forgets the connection on this computer. LinkedIn has no call for apps like this to end it; the member can in LinkedIn's settings. */
  async disconnect(): Promise<void> {
    this.stop()
    this.connection = new AbortController()
    const forget = () => fs.rm(this.file(), { force: true })
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

  /** Uploads the version's export and waits until LinkedIn can post it: its video URN. */
  private async upload(dir: string, version: number, c: Credentials, signal: AbortSignal): Promise<string> {
    const vdir = join(dir, 'versions', `v${version}`)
    if (await fs.stat(join(vdir, '.rendering')).then(() => true, () => false)) return fail('RENDERING', 'Wait for this version to finish exporting before posting.')
    const file = join(vdir, 'export.mp4')
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK)
    try {
      const stat = await handle.stat({ bigint: true })
      if (!stat.isFile() || stat.size < 1n || stat.size > BigInt(MAX_VIDEO)) return fail('FILE', 'The exported video is empty or larger than LinkedIn takes (500 MB).')
      const resolved = await fs.realpath(file)
      if (!inside(dir, resolved)) return fail('PATH', 'The exported video is outside this project.')
      const checked = await fs.stat(resolved, { bigint: true })
      if (checked.dev !== stat.dev || checked.ino !== stat.ino) return fail('PATH', 'The export changed while opening it. Try again.')
      const size = Number(stat.size)
      const { data: init } = await call(this.o.fetch, `${LINKEDIN_API}/rest/videos?action=initializeUpload`, {
        method: 'POST', headers: rest(c.token), body: JSON.stringify({ initializeUploadRequest: { owner: `urn:li:person:${c.memberId}`, fileSizeBytes: size, uploadCaptions: false, uploadThumbnail: false } })
      }, signal)
      const v = object(init.value)
      const video = text(v.video)
      if (!video.startsWith('urn:li:video:')) return invalid()
      const parts = Array.isArray(v.uploadInstructions) ? v.uploadInstructions.map((p) => {
        const x = object(p)
        if (!Number.isSafeInteger(x.firstByte) || !Number.isSafeInteger(x.lastByte)) return invalid()
        const first = x.firstByte as number, last = x.lastByte as number
        if (first < 0 || last < first || last >= size) return invalid()
        return { first, last, url: uploadLink(x.uploadUrl) }
      }) : invalid()
      if (!parts.length || parts[0].first !== 0 || parts[parts.length - 1].last !== size - 1 || parts.some((p, i) => i > 0 && p.first !== parts[i - 1].last + 1)) return invalid()
      const etags: string[] = []
      for (const p of parts) {
        const bytes = Buffer.alloc(p.last - p.first + 1)
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, p.first)
        if (bytesRead !== bytes.length) return fail('FILE', 'The export changed while uploading it. Export it again.')
        const { headers } = await call(this.o.fetch, p.url, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array(bytes) }, signal)
        etags.push(text(headers.get('etag')))
      }
      await call(this.o.fetch, `${LINKEDIN_API}/rest/videos?action=finalizeUpload`, {
        method: 'POST', headers: rest(c.token), body: JSON.stringify({ finalizeUploadRequest: { video, uploadToken: typeof v.uploadToken === 'string' ? v.uploadToken : '', uploadedPartIds: etags } })
      }, signal)
      for (let i = 0; i < 40; i++) {
        const { data } = await call(this.o.fetch, `${LINKEDIN_API}/rest/videos/${encodeURIComponent(video)}`, { method: 'GET', headers: rest(c.token, false) }, signal)
        if (data.status === 'AVAILABLE') return video
        if (data.status === 'PROCESSING_FAILED') return fail('PROCESSING', 'LinkedIn couldn’t use this video. LinkedIn takes MP4s from 3 seconds to 30 minutes.')
        if (data.status !== 'PROCESSING' && data.status !== 'WAITING_UPLOAD') return invalid()
        await delay(this.o.waitMs ?? 5_000, undefined, { signal })
      }
      return fail('PROCESSING', 'LinkedIn is still working on the video. Post this version again in a few minutes.')
    } finally { await handle.close() }
  }

  publish(value: unknown): Promise<LinkedInPost> {
    return this.run(async (signal) => {
      const p = object(value)
      if (typeof p.slug !== 'string' || typeof p.version !== 'number' || typeof p.text !== 'string' || [...p.text].length > TEXT_MAX)
        return fail('INPUT', `Choose a finished version and text of at most ${TEXT_MAX.toLocaleString('en-US')} characters.`)
      const dir = await this.project(p.slug, p.version)
      const c = await this.credentials()
      const version = p.version
      const file = join(dir, 'linkedin-publish.json')
      const all = await readJson(file)
      const versions = all?.versions && typeof all.versions === 'object' ? (all.versions as Record<string, unknown>) : {}
      const raw = versions[`v${version}`]
      const inputHash = createHash('sha256').update(JSON.stringify({ text: p.text })).digest('hex')
      if (raw !== undefined) {
        const r = object(raw)
        if (r.memberId !== c.memberId) return fail('ACCOUNT', 'This version was posted by another LinkedIn member.')
        if (r.state === 'published' && r.inputHash !== inputHash) return fail('ALREADY_POSTED', 'This version is already on LinkedIn with other text. Export a new version to post it again.')
        if (r.state === 'published') { const post = object(r.post); return { version, accountId: c.memberId, postId: text(post.postId), publishedAt: text(post.publishedAt) } }
        if (r.state === 'posting') return fail('PUBLISH_UNKNOWN', 'LinkedIn didn’t confirm whether this was posted. Check LinkedIn before posting this version again.')
        return localError()
      }
      const save = (r: Record<string, unknown>) => atomicSocialFile(file, JSON.stringify({ schemaVersion: 1, versions: { ...versions, [`v${version}`]: r } }, null, 2) + '\n')
      const video = await this.upload(dir, version, c, signal)
      signal.throwIfAborted()
      await save({ state: 'posting', memberId: c.memberId, inputHash })
      let dispatched = false
      let postId: string
      try {
        const { headers } = await call(this.o.fetch, `${LINKEDIN_API}/rest/posts`, {
          method: 'POST', headers: rest(c.token),
          body: JSON.stringify({
            author: `urn:li:person:${c.memberId}`, commentary: p.text, visibility: 'PUBLIC',
            distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
            content: { media: { id: video } }, lifecycleState: 'PUBLISHED', isReshareDisabledByAuthor: false
          })
        }, signal, () => { dispatched = true })
        postId = text(headers.get('x-restli-id'))
        if (!/^urn:li:(share|ugcPost):\d{1,32}$/.test(postId)) return invalid()
      } catch (e) {
        if (!dispatched || (e instanceof SocialError && ['LI_TOKEN', 'LI_PERMISSION', 'LI_RATE_LIMIT', 'LI_INPUT'].includes(e.code))) {
          const { [`v${version}`]: _dropped, ...others } = versions
          void _dropped
          await atomicSocialFile(file, JSON.stringify({ schemaVersion: 1, versions: others }, null, 2) + '\n')
          throw e
        }
        return fail('PUBLISH_UNKNOWN', 'LinkedIn didn’t confirm whether this was posted. Check LinkedIn before posting this version again.')
      }
      const post: LinkedInPost = { version, accountId: c.memberId, postId, publishedAt: new Date(this.now()).toISOString() }
      try {
        await save({ state: 'published', memberId: c.memberId, inputHash, post })
        await withSocialFile(join(dir, 'outcomes.json'), async () => {
          const saved = await readJson(join(dir, 'outcomes.json'))
          if (saved && saved.schemaVersion !== 1) return localError()
          const vs = saved?.versions && typeof saved.versions === 'object' ? (saved.versions as Record<string, unknown>) : {}
          const posts = vs[`v${version}`] && typeof vs[`v${version}`] === 'object' ? (vs[`v${version}`] as Record<string, unknown>) : {}
          await atomicSocialFile(join(dir, 'outcomes.json'), JSON.stringify({ ...saved, schemaVersion: 1, versions: { ...vs, [`v${version}`]: { ...posts, [`linkedin:${postId}`]: { ...post, platform: 'linkedin', apiVersion: LINKEDIN_VERSION, observedAt: null, metrics: null } } } }, null, 2) + '\n')
        })
      } catch {
        return fail('PUBLISHED_UNSAVED', `LinkedIn posted ${postId}, but Reel Studio couldn’t save that. Don’t post it again.`)
      }
      return post
    })
  }
}
