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
import { metaApi, SocialError, type MetaFetch } from './meta-http'
import { atomicSocialFile, restoreSocialFile, snapshotSocialFile, withSocialFile } from './social-store'
import { readFacebookReel } from './facebook-insights'
import { keptTag } from './instagram-store'

export const FACEBOOK_VERSION = 'v26.0'
export const FACEBOOK_GRAPH = `https://graph.facebook.com/${FACEBOOK_VERSION}`
const RUPLOAD = `https://rupload.facebook.com/video-upload/${FACEBOOK_VERSION}`
// what posting needs; the sign-in service also asks for read_insights and pages_manage_engagement for Insights
// (server/signin/handler.ts), which a person may decline and still post
export const FACEBOOK_SCOPES = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts']
const INSIGHTS_SCOPES = ['read_insights', 'pages_manage_engagement']
const MAX_VIDEO = 1_000_000_000

const { fail, invalid, object, text, id, request } = metaApi('Facebook', 'FB_')
const localError = (): never => fail('LOCAL_DATA', 'The saved Facebook data could not be read. Connect Facebook again in Settings.')
type FacebookFetch = MetaFetch

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
  /** canRead: this Page's numbers can be read for Insights (the read_insights and pages_manage_engagement grants, and
   * the ANALYZE task on the Page, which Graph's video_insights requires). Saved before it existed: false. */
  pages: (FacebookPage & { token: string; canRead: boolean })[]
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

/** SHA-256 of the opened file, read in 1 MB pieces. */
async function fileHash(handle: fs.FileHandle, size: number): Promise<string> {
  const hash = createHash('sha256')
  const buffer = Buffer.alloc(1024 * 1024)
  for (let at = 0; at < size;) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - at), at)
    if (!bytesRead) return fail('FILE', 'The export changed while reading it. Export it again.')
    hash.update(buffer.subarray(0, bytesRead))
    at += bytesRead
  }
  return hash.digest('hex')
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

/** A reading of a posted reel's numbers replaces its entry (saveOutcome above never overwrites), keeping any trial tag. */
async function saveReading(dir: string, value: FacebookOutcome): Promise<void> {
  const file = join(dir, 'outcomes.json')
  return withSocialFile(file, async () => {
    const saved = await readJson(file)
    if (saved && saved.schemaVersion !== 1) return localError()
    const versions = saved?.versions && typeof saved.versions === 'object' ? (saved.versions as Record<string, unknown>) : {}
    const key = `v${value.version}`
    const posts = versions[key] && typeof versions[key] === 'object' ? (versions[key] as Record<string, unknown>) : {}
    const postKey = `facebook:${value.postId}`
    const before = posts[postKey] && typeof posts[postKey] === 'object' ? (posts[postKey] as Record<string, unknown>) : {}
    await atomicSocialFile(file, JSON.stringify({ ...saved, schemaVersion: 1, versions: { ...versions, [key]: { ...posts, [postKey]: { ...keptTag(before), ...value } } } }, null, 2) + '\n')
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
      fail('SECURE_STORAGE', 'This computer cannot store the Facebook connection securely. Turn on its system keychain and try again.')
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
      const pages = (Array.isArray(c.pages) ? c.pages : []).map((p) => { const x = object(p); return { id: id(x.id), name: text(x.name), token: text(x.token), canRead: x.canRead === true } })
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
    if (!s.appId || !s.brokerUrl) return fail('DISABLED', 'Posting to Facebook isn’t open yet. Settings › Posting says what’s missing.')
    return { appId: s.appId, brokerUrl: serviceOrigin(s.brokerUrl) }
  }
  private async credentials(): Promise<Credentials> {
    const c = await this.config()
    const saved = await this.load()
    if (!saved || saved.appId !== c.appId || saved.brokerUrl !== c.brokerUrl) return fail('TOKEN', 'Connect Facebook again in Settings.')
    return saved
  }
  private run<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const signal = AbortSignal.any([this.connection.signal, AbortSignal.timeout(30 * 60_000)])
    const work = async () => {
      try { signal.throwIfAborted(); return await fn(signal) } catch (e) {
        if (signal.aborted) fail('CANCELLED', 'The Facebook action was cancelled. Check your Page before posting again.')
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
        if (e instanceof SocialError && e.code === 'FB_DISABLED') return null
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
        declined: () => new SocialError('FB_DECLINED', 'Facebook was not connected. You can try again in Settings.'),
        cancelled: () => new SocialError('FB_CANCELLED', 'Facebook connection was cancelled.'),
        failed: () => new SocialError('FB_CALLBACK', 'Could not open the Facebook callback. Try again.')
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
          return fail('PERMISSION', 'Allow Reel Studio to see your Pages and post to them when you connect Facebook.')
        const userToken = text(data.access_token)
        const expiresIn = typeof data.expires_in === 'number' && data.expires_in > 0 ? data.expires_in : invalid()
        const me = await request(this.o.fetch, `${FACEBOOK_GRAPH}/me?fields=name`, get(userToken), signal)
        const listed = await request(this.o.fetch, `${FACEBOOK_GRAPH}/me/accounts?fields=id,name,access_token,tasks&limit=100`, get(userToken), signal)
        const readGranted = INSIGHTS_SCOPES.every((s) => granted.includes(s))
        const pages = (Array.isArray(listed.data) ? listed.data : []).flatMap((p) => {
          const x = object(p)
          if (!Array.isArray(x.tasks) || !x.tasks.includes('CREATE_CONTENT')) return []
          return [{ id: id(x.id), name: text(x.name), token: text(x.access_token), canRead: readGranted && x.tasks.includes('ANALYZE') }]
        })
        if (!pages.length)
          return fail('NO_PAGE', 'Reel Studio posts reels to a Facebook Page, and this account can’t post to one. Make a Page, or ask its admin to let you post, then connect again.')
        const previous = await this.load().catch(() => null)
        const keep = previous && pages.some((p) => p.id === previous.pageId) ? previous.pageId : pages[0].id
        const c: Credentials = { userToken, userName: text(me.name), expiresAt: this.now() + expiresIn * 1000, pages, pageId: keep, appId: config.appId, brokerUrl: config.brokerUrl }
        const before = await snapshotSocialFile(this.file())
        signal.throwIfAborted()
        await this.save(c)
        // Cancel pressed while the sign-in was being saved: put back what was there, so a cancelled connect connects nothing
        if (signal.aborted) {
          await restoreSocialFile(this.file(), before)
          throw new SocialError('FB_CANCELLED', 'Facebook connection was cancelled.')
        }
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
      if (typeof pageId !== 'string' || !c.pages.some((p) => p.id === pageId)) return fail('INPUT', 'Choose one of your Pages.')
      const next = { ...c, pageId }
      await this.save(next)
      return this.toSession(next)
    })
  }

  private async project(slug: string, version: number): Promise<string> {
    if (!/^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u.test(slug) || !Number.isSafeInteger(version) || version < 1) return fail('INPUT', 'Choose a finished version.')
    const root = await fs.realpath(this.o.projectsDir())
    const dir = await fs.realpath(join(root, slug))
    if (!inside(root, dir)) return fail('PATH', 'This project is outside the Reel Studio projects folder.')
    await fs.access(join(dir, 'project.json'))
    return dir
  }

  private async openVideo(dir: string, version: number) {
    const vdir = join(dir, 'versions', `v${version}`)
    if (await fs.stat(join(vdir, '.rendering')).then(() => true, () => false)) return fail('RENDERING', 'Wait for this version to finish exporting before posting.')
    const file = join(vdir, 'export.mp4')
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK)
    try {
      const stat = await handle.stat({ bigint: true })
      if (!stat.isFile() || stat.size < 1n || stat.size > BigInt(MAX_VIDEO)) return fail('FILE', 'The exported video is empty or too large for Facebook.')
      const resolved = await fs.realpath(file)
      if (!inside(dir, resolved)) return fail('PATH', 'The exported video is outside this project.')
      const checked = await fs.stat(resolved, { bigint: true })
      if (checked.dev !== stat.dev || checked.ino !== stat.ino) return fail('PATH', 'The export changed while opening it. Try again.')
      return { handle, size: Number(stat.size) }
    } catch (e) { await handle.close(); throw e }
  }

  /**
   * Reads one posted reel's lifetime numbers (facebook-insights.ts) with the token of the Page it went to, and saves
   * them beside the post in outcomes.json. The results refresh (results-refresh.ts) calls it on its schedule.
   */
  insights(slug: string, version: number, postId: string): Promise<FacebookOutcome> {
    return this.run(async (signal) => {
      id(postId)
      const dir = await this.project(slug, version)
      const c = await this.credentials()
      const saved = await receipt(dir, version)
      if (saved?.state !== 'published' || saved.post.postId !== postId) return fail('POST', 'This reel is not linked to that project version.')
      const page = c.pages.find((p) => p.id === saved.post.accountId)
      if (!page) return fail('POST', 'The Page this reel was posted to is no longer connected.')
      // declined at sign-in, or a Page this person can post to but not analyze: no read is attempted
      if (!page.canRead) return fail('PERMISSION', 'Connect Facebook again and allow Reel Studio to read your Page’s results.')
      const metrics = await readFacebookReel(this.o.fetch, page.token, postId, signal)
      const outcome: FacebookOutcome = { ...saved.post, platform: 'facebook', apiVersion: FACEBOOK_VERSION, observedAt: new Date(this.now()).toISOString(), metrics }
      signal.throwIfAborted()
      await saveReading(dir, outcome)
      return outcome
    })
  }

  publish(value: unknown): Promise<FacebookPost> {
    return this.run(async (signal) => {
      const p = object(value)
      if (typeof p.slug !== 'string' || typeof p.version !== 'number' || typeof p.description !== 'string' || p.description.length > 2200)
        return fail('INPUT', 'Choose a finished version and a description of at most 2,200 characters.')
      const input: FacebookPublishInput = { slug: p.slug, version: p.version, description: p.description }
      const dir = await this.project(input.slug, input.version)
      const c = await this.credentials()
      const page = c.pages.find((x) => x.id === c.pageId) ?? c.pages[0]
      let saved = await receipt(dir, input.version)
      if (saved?.state === 'published') {
        await saveOutcome(dir, { ...saved.post, platform: 'facebook', apiVersion: FACEBOOK_VERSION, observedAt: null, metrics: null })
        return saved.post
      }
      if (saved?.state === 'publishing')
        return fail('PUBLISH_UNKNOWN', 'Facebook didn’t confirm whether this reel was posted. Check your Page before posting this version again.')
      const video = await this.openVideo(dir, input.version)
      try {
        // the bytes are part of what was asked: a resumed upload must carry on with the very same file
        const inputHash = createHash('sha256').update(JSON.stringify({ page: page.id, description: input.description })).update(await fileHash(video.handle, video.size)).digest('hex')
        if (saved && saved.inputHash !== inputHash)
          return fail('PUBLISH_CHANGED', 'This version started posting with another Page, description or video. Post it as it was, or export a new version.')
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
            if (up.success !== true) return fail('UPLOAD', 'Facebook didn’t take the whole video. Post this version again to carry on.')
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
          if (!dispatched || (e instanceof SocialError && ['FB_RATE_LIMIT', 'FB_TOKEN', 'FB_PERMISSION', 'FB_INPUT'].includes(e.code))) {
            await saveReceipt(dir, input.version, { ...saved, state: 'uploading' })
            throw e
          }
          return fail('PUBLISH_UNKNOWN', 'Facebook didn’t confirm whether this reel was posted. Check your Page before posting this version again.')
        }
        const post: FacebookPost = { version: input.version, accountId: page.id, postId: saved.videoId, publishedAt: new Date(this.now()).toISOString() }
        try {
          await saveReceipt(dir, input.version, { ...saved, state: 'published', post })
          await saveOutcome(dir, { ...post, platform: 'facebook', apiVersion: FACEBOOK_VERSION, observedAt: null, metrics: null })
        } catch {
          return fail('PUBLISHED_UNSAVED', `Facebook posted reel ${post.postId}, but Reel Studio couldn’t save that. Don’t post it again.`)
        }
        return post
      } finally { await video.handle.close() }
    })
  }
}
