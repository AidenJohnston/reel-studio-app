// Posting a reel to Threads, from the main process. Threads API v1.0 on graph.threads.com.
// Sign-in: https://developers.facebook.com/docs/threads/get-started/get-access-tokens-and-permissions
// Posts: https://developers.facebook.com/docs/threads/posts
//
// Connect signs in through Reel Studio's sign-in service (docs/signin.md); the app keeps the 60-day token, encrypted,
// and refreshes it itself (Threads needs no secret for that). Threads fetches a video from a link, so a post first
// copies the export to the service's short-lived storage, then makes a container, waits for Threads to process it,
// and publishes. threads-publish.json in the project keeps where each version got to, so a lost answer to Publish
// blocks a second post instead of risking one.
import { createHash, randomBytes } from 'node:crypto'
import { constants, createReadStream, promises as fs } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import type { ThreadsOutcome, ThreadsPost, ThreadsSession } from '../shared/threads'
import type { InstagramSecretStore } from './instagram-store'
import { serviceOrigin } from './instagram-http'
import { metaApi, SocialError, type MetaFetch } from './meta-http'
import { signinCallback } from './signin-callback'
import { atomicSocialFile, withSocialFile } from './social-store'

export const THREADS_VERSION = 'v1.0'
export const THREADS_GRAPH = `https://graph.threads.com/${THREADS_VERSION}`
const TEXT_MAX = 500
const MAX_VIDEO = 1_000_000_000
const DAY = 86_400_000

const { fail, invalid, object, text, id, request } = metaApi('Threads', 'TH_')
const localError = (): never => fail('LOCAL_DATA', 'The saved Threads data could not be read. Connect Threads again in Settings.')
const jsonPost = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

export interface ThreadsSettings {
  appId: string | null
  brokerUrl: string | null
  mediaOrigins: string[]
}

interface Credentials {
  token: string
  expiresAt: number
  issuedAt: number
  userId: string
  username: string
  appId: string
  brokerUrl: string
  /** The sign-in service's pass for storage links, sealed to this account at sign-in. */
  uploadPass: string
}

type Receipt =
  | { state: 'processing' | 'publishing'; userId: string; containerId: string; inputHash: string }
  | { state: 'published'; userId: string; containerId: string; inputHash: string; post: ThreadsPost }

interface Options {
  settings(): Promise<ThreadsSettings>
  settingsDir: string
  projectsDir(): string
  secrets: InstagramSecretStore
  fetch: MetaFetch
  openExternal(url: string): Promise<void>
  now?(): number
  /** Between status checks while Threads processes a video: 30 s, as Meta suggests (tests pass 0). */
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

async function receipt(dir: string, version: number): Promise<Receipt | null> {
  const saved = await readJson(join(dir, 'threads-publish.json'))
  const v = saved?.versions && typeof saved.versions === 'object' ? (saved.versions as Record<string, unknown>)[`v${version}`] : undefined
  if (v === undefined) return null
  try {
    const r = object(v)
    const base = { userId: id(r.userId), containerId: id(r.containerId), inputHash: text(r.inputHash) }
    if (r.state === 'processing' || r.state === 'publishing') return { ...base, state: r.state }
    if (r.state === 'published') {
      const p = object(r.post)
      return { ...base, state: 'published', post: { version, accountId: id(p.accountId), postId: id(p.postId), publishedAt: text(p.publishedAt) } }
    }
  } catch { /* below */ }
  return localError()
}

async function saveReceipt(dir: string, version: number, r: Receipt): Promise<void> {
  const file = join(dir, 'threads-publish.json')
  const saved = await readJson(file)
  const versions = saved?.versions && typeof saved.versions === 'object' ? (saved.versions as Record<string, unknown>) : {}
  await atomicSocialFile(file, JSON.stringify({ schemaVersion: 1, versions: { ...versions, [`v${version}`]: r } }, null, 2) + '\n')
}

/** SHA-256 of a version's export, or "" when there is none yet (stage() then says so). */
async function exportHash(dir: string, version: number): Promise<string> {
  const hash = createHash('sha256')
  try {
    for await (const chunk of createReadStream(join(dir, 'versions', `v${version}`, 'export.mp4'))) hash.update(chunk as Buffer)
  } catch (e) {
    if (e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT') return ''
    throw e
  }
  return hash.digest('hex')
}

/** outcomes.json, next to the other platforms' posts, as threads:<id>. */
async function saveOutcome(dir: string, value: ThreadsOutcome): Promise<void> {
  const file = join(dir, 'outcomes.json')
  return withSocialFile(file, async () => {
    const saved = await readJson(file)
    if (saved && saved.schemaVersion !== 1) return localError()
    const versions = saved?.versions && typeof saved.versions === 'object' ? (saved.versions as Record<string, unknown>) : {}
    const key = `v${value.version}`
    const posts = versions[key] && typeof versions[key] === 'object' ? (versions[key] as Record<string, unknown>) : {}
    if (posts[`threads:${value.postId}`] !== undefined) return
    await atomicSocialFile(file, JSON.stringify({ ...saved, schemaVersion: 1, versions: { ...versions, [key]: { ...posts, [`threads:${value.postId}`]: value } } }, null, 2) + '\n')
  })
}

export class ThreadsService {
  private queue: Promise<unknown> = Promise.resolve()
  private connection = new AbortController()
  private connecting?: AbortController

  constructor(private readonly o: Options) {}
  private now(): number { return this.o.now?.() ?? Date.now() }
  private file(): string { return join(this.o.settingsDir, 'threads-credentials.bin') }
  private secure(): void {
    if (!this.o.secrets.isEncryptionAvailable() || this.o.secrets.getSelectedStorageBackend?.() === 'basic_text')
      fail('SECURE_STORAGE', 'This computer cannot store the Threads connection securely. Turn on its system keychain and try again.')
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
      if (typeof c.expiresAt !== 'number' || typeof c.issuedAt !== 'number') return localError()
      return { token: text(c.token), expiresAt: c.expiresAt, issuedAt: c.issuedAt, userId: id(c.userId), username: text(c.username), appId: id(c.appId), brokerUrl: text(c.brokerUrl), uploadPass: text(c.uploadPass) }
    } catch { return localError() }
  }
  private async save(c: Credentials): Promise<void> {
    this.secure()
    const bytes = this.o.secrets.encryptString(JSON.stringify(c))
    await fs.mkdir(this.o.settingsDir, { recursive: true })
    await atomicSocialFile(this.file(), bytes)
  }
  private async config(): Promise<{ appId: string; brokerUrl: string; mediaOrigins: string[] }> {
    const s = await this.o.settings()
    if (!s.appId || !s.brokerUrl) return fail('DISABLED', 'Posting to Threads isn’t open yet. Settings › Posting says what’s missing.')
    return { appId: s.appId, brokerUrl: serviceOrigin(s.brokerUrl), mediaOrigins: s.mediaOrigins }
  }
  private async credentials(signal: AbortSignal): Promise<Credentials> {
    const cfg = await this.config()
    let c = await this.load()
    if (!c || c.appId !== cfg.appId || c.brokerUrl !== cfg.brokerUrl || c.expiresAt <= this.now()) return fail('TOKEN', 'Connect Threads again in Settings.')
    // Threads refreshes a token that is at least a day old and still valid; a week before it ends is when we ask
    if (c.expiresAt - this.now() <= 7 * DAY && c.issuedAt + DAY <= this.now()) {
      const q = new URLSearchParams({ grant_type: 'th_refresh_token', access_token: c.token })
      const r = await request(this.o.fetch, `https://graph.threads.com/refresh_access_token?${q}`, { method: 'GET' }, signal)
      c = { ...c, token: text(r.access_token), issuedAt: this.now(), expiresAt: this.now() + (typeof r.expires_in === 'number' ? r.expires_in : invalid()) * 1000 }
      await this.save(c)
    }
    return c
  }
  private run<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const signal = AbortSignal.any([this.connection.signal, AbortSignal.timeout(20 * 60_000)])
    const work = async () => {
      try { signal.throwIfAborted(); return await fn(signal) } catch (e) {
        if (signal.aborted) fail('CANCELLED', 'The Threads action was cancelled. Check Threads before posting again.')
        throw e
      }
    }
    const result = this.queue.then(work, work)
    this.queue = result.catch(() => undefined)
    return result
  }

  session(): Promise<ThreadsSession> {
    return this.run(async () => {
      const cfg = await this.config().catch((e: unknown) => {
        if (e instanceof SocialError && e.code === 'TH_DISABLED') return null
        throw e
      })
      if (!cfg) return { connected: false }
      const c = await this.load()
      if (!c || c.appId !== cfg.appId || c.brokerUrl !== cfg.brokerUrl || c.expiresAt <= this.now()) return { connected: false }
      return { connected: true, accountId: c.userId, username: c.username, expiresAt: c.expiresAt }
    })
  }

  connect(): Promise<ThreadsSession> {
    this.cancelConnect()
    const ac = new AbortController()
    this.connecting = ac
    return this.run(async (outer) => {
      const signal = AbortSignal.any([outer, ac.signal])
      const cfg = await this.config()
      this.secure()
      const state = randomBytes(32).toString('base64url')
      const verifier = randomBytes(32).toString('base64url')
      const listener = await signinCallback('Threads', '/threads/callback', state, signal, {
        declined: () => new SocialError('TH_DECLINED', 'Threads was not connected. You can try again in Settings.'),
        cancelled: () => new SocialError('TH_CANCELLED', 'Threads connection was cancelled.'),
        failed: () => new SocialError('TH_CALLBACK', 'Could not open the Threads callback. Try again.')
      })
      try {
        const started = await request(this.o.fetch, `${cfg.brokerUrl}/v1/threads/start`, jsonPost({
          state, loopback_uri: listener.redirectUri, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256'
        }), signal)
        let url: URL
        try { url = new URL(text(started.authorize_url)) } catch { return invalid() }
        if (url.origin + url.pathname !== 'https://threads.com/oauth/authorize' || url.searchParams.get('client_id') !== cfg.appId ||
            url.searchParams.get('redirect_uri') !== `${cfg.brokerUrl}/v1/threads/callback`)
          return invalid()
        signal.throwIfAborted()
        await this.o.openExternal(url.toString())
        const handoff = await listener.result
        const data = await request(this.o.fetch, `${cfg.brokerUrl}/v1/threads/complete`, jsonPost({ handoff, code_verifier: verifier }), signal)
        if (String(data.token_type).toLowerCase() !== 'bearer') return invalid()
        const token = text(data.access_token)
        const expiresIn = typeof data.expires_in === 'number' && data.expires_in > 0 ? data.expires_in : invalid()
        const me = await request(this.o.fetch, `${THREADS_GRAPH}/me?fields=id,username`, { method: 'GET', headers: { authorization: `Bearer ${token}` } }, signal)
        const c: Credentials = { token, expiresAt: this.now() + expiresIn * 1000, issuedAt: this.now(), userId: id(me.id), username: text(me.username), appId: cfg.appId, brokerUrl: cfg.brokerUrl, uploadPass: text(data.upload_pass) }
        signal.throwIfAborted()
        await this.save(c)
        return { connected: true, accountId: c.userId, username: c.username, expiresAt: c.expiresAt }
      } finally {
        listener.close()
        if (this.connecting === ac) this.connecting = undefined
      }
    })
  }
  cancelConnect(): void { this.connecting?.abort() }
  stop(): void { this.cancelConnect(); this.connection.abort() }
  /** Forgets the connection on this computer. Threads has no call to end the access; the person removes it in Threads. */
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

  private async stage(dir: string, version: number, c: Credentials, cfg: { brokerUrl: string; mediaOrigins: string[] }, signal: AbortSignal): Promise<string> {
    const vdir = join(dir, 'versions', `v${version}`)
    if (await fs.stat(join(vdir, '.rendering')).then(() => true, () => false)) return fail('RENDERING', 'Wait for this version to finish exporting before posting.')
    const file = join(vdir, 'export.mp4')
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK)
    try {
      const stat = await handle.stat({ bigint: true })
      if (!stat.isFile() || stat.size < 1n || stat.size > BigInt(MAX_VIDEO)) return fail('FILE', 'The exported video is empty or too large for Threads.')
      const resolved = await fs.realpath(file)
      if (!inside(dir, resolved)) return fail('PATH', 'The exported video is outside this project.')
      const checked = await fs.stat(resolved, { bigint: true })
      if (checked.dev !== stat.dev || checked.ino !== stat.ino) return fail('PATH', 'The export changed while opening it. Try again.')
      const size = Number(stat.size)
      const up = await request(this.o.fetch, `${cfg.brokerUrl}/v1/threads/uploads`, {
        ...jsonPost({ video_size: size, cover_size: null, upload_pass: c.uploadPass }), headers: { 'content-type': 'application/json', authorization: `Bearer ${c.token}` }
      }, signal)
      const v = object(up.video)
      const put = new URL(text(v.upload_url))
      const read = new URL(text(v.public_url))
      if (put.protocol !== 'https:' || read.protocol !== 'https:' || !cfg.mediaOrigins.includes(put.origin) || !cfg.mediaOrigins.includes(read.origin))
        return fail('UPLOAD_HOST', 'The sign-in service returned a storage address it doesn’t list. Try again later.')
      const stream = handle.createReadStream({ autoClose: false })
      try {
        const init = { method: 'PUT', headers: { 'content-type': 'video/mp4', 'content-length': String(size) }, body: Readable.toWeb(stream) as unknown as BodyInit, duplex: 'half', redirect: 'error', signal } satisfies RequestInit & { duplex: 'half' }
        const res = await this.o.fetch(put.toString(), init)
        await res.body?.cancel()
        if (!res.ok) return fail('UPLOAD', 'The video could not be uploaded. Try again later.')
      } finally { stream.destroy() }
      return read.toString()
    } finally { await handle.close() }
  }

  publish(value: unknown): Promise<ThreadsPost> {
    return this.run(async (signal) => {
      const p = object(value)
      if (typeof p.slug !== 'string' || typeof p.version !== 'number' || typeof p.text !== 'string' || [...p.text].length > TEXT_MAX)
        return fail('INPUT', `Choose a finished version and text of at most ${TEXT_MAX} characters.`)
      const cfg = await this.config()
      const dir = await this.project(p.slug, p.version)
      const c = await this.credentials(signal)
      const version = p.version
      let saved = await receipt(dir, version)
      if (saved && saved.userId !== c.userId) return fail('ACCOUNT', 'This version already started posting to another Threads account.')
      if (saved?.state === 'published' && saved.inputHash !== createHash('sha256').update(JSON.stringify({ text: p.text })).update(await exportHash(dir, version)).digest('hex'))
        return fail('ALREADY_POSTED', 'This version is already on Threads with other text. Export a new version to post it again.')
      if (saved?.state === 'published') {
        await saveOutcome(dir, { ...saved.post, platform: 'threads', apiVersion: THREADS_VERSION, observedAt: null, metrics: null })
        return saved.post
      }
      if (saved?.state === 'publishing') return fail('PUBLISH_UNKNOWN', 'Threads didn’t confirm whether this was posted. Check Threads before posting this version again.')
      // the bytes are part of what was asked: a container made from an older export is never published for a newer one
      const inputHash = createHash('sha256').update(JSON.stringify({ text: p.text })).update(await exportHash(dir, version)).digest('hex')
      if (saved && saved.inputHash !== inputHash) return fail('PUBLISH_CHANGED', 'This version started posting with other text or another export. Post it as it was, or export a new version.')
      const auth = { authorization: `Bearer ${c.token}` }
      if (!saved) {
        const videoUrl = await this.stage(dir, version, c, cfg, signal)
        const made = await request(this.o.fetch, `${THREADS_GRAPH}/${c.userId}/threads`, {
          method: 'POST', headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ media_type: 'VIDEO', video_url: videoUrl, text: p.text })
        }, signal)
        saved = { state: 'processing', userId: c.userId, containerId: id(made.id), inputHash }
        await saveReceipt(dir, version, saved)
      }
      // Threads processes the video before it can be published; about 30 s, Meta says
      let ready = false
      for (let i = 0; i < 10 && !ready; i++) {
        const s = await request(this.o.fetch, `${THREADS_GRAPH}/${saved.containerId}?fields=status,error_message`, { method: 'GET', headers: auth }, signal)
        if (s.status === 'FINISHED') ready = true
        else if (s.status === 'ERROR' || s.status === 'EXPIRED') return fail('CONTAINER', 'Threads couldn’t use this video. Threads takes MP4s up to 5 minutes; export a new version and try again.')
        else if (s.status !== 'IN_PROGRESS') return invalid()
        else await delay(this.o.waitMs ?? 30_000, undefined, { signal })
      }
      if (!ready) return fail('PROCESSING', 'Threads is still working on the video. Post this version again in a few minutes to carry on.')
      saved = { ...saved, state: 'publishing' }
      await saveReceipt(dir, version, saved)
      let dispatched = false
      let postId: string
      try {
        postId = id((await request(this.o.fetch, `${THREADS_GRAPH}/${c.userId}/threads_publish`, {
          method: 'POST', headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ creation_id: saved.containerId })
        }, signal, () => { dispatched = true })).id)
      } catch (e) {
        if (!dispatched || (e instanceof SocialError && ['TH_RATE_LIMIT', 'TH_TOKEN', 'TH_PERMISSION', 'TH_INPUT'].includes(e.code))) {
          await saveReceipt(dir, version, { ...saved, state: 'processing' })
          throw e
        }
        return fail('PUBLISH_UNKNOWN', 'Threads didn’t confirm whether this was posted. Check Threads before posting this version again.')
      }
      const post: ThreadsPost = { version, accountId: c.userId, postId, publishedAt: new Date(this.now()).toISOString() }
      try {
        await saveReceipt(dir, version, { ...saved, state: 'published', post })
        await saveOutcome(dir, { ...post, platform: 'threads', apiVersion: THREADS_VERSION, observedAt: null, metrics: null })
      } catch {
        return fail('PUBLISHED_UNSAVED', `Threads posted ${postId}, but Reel Studio couldn’t save that. Don’t post it again.`)
      }
      return post
    })
  }
}
