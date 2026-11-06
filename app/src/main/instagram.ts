// Instagram API v26.0: https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/business-login
// Publishing: https://developers.facebook.com/documentation/instagram-platform/content-publishing
// Media: https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/media
// Insights: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-media/insights/
import { createHash, randomBytes } from 'node:crypto'
import { constants, promises as fs } from 'node:fs'
import { join, relative, isAbsolute } from 'node:path'
import { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import type { InstagramMetrics, InstagramOutcome, InstagramPost, InstagramPublishInput, InstagramSession, InstagramSettings } from '../shared/instagram'
import { instagramCallback } from './instagram-oauth'
import { httpsUrl, id, INSTAGRAM_GRAPH, INSTAGRAM_SCOPES, INSTAGRAM_VERSION, InstagramError, invalidResponse, jsonPost, object, positive, request, serviceOrigin, text, type InstagramFetch } from './instagram-http'
import { InstagramTokenStore, readObject, receipt, saveOutcome, saveReceipt, type InstagramCredentials, type InstagramSecretStore } from './instagram-store'

const DAY = 24 * 60 * 60_000
/** Connecting reads the profile picture too, so the Instagram preview can show the account as it is (Phone.tsx). */
const CONNECT_FIELDS = 'user_id,username,account_type,profile_picture_url'
const PICTURE_TYPES = ['image/jpeg', 'image/png', 'image/webp']
// Instagram serves profile pictures at 320 px or less, tens of kilobytes; anything far bigger is not one.
const PICTURE_MAX_BYTES = 512 * 1024
const METRICS = {
  plays: 'views', reach: 'reach', likes: 'likes', comments: 'comments', shares: 'shares', saves: 'saved',
  averageWatchTimeMs: 'ig_reels_avg_watch_time', totalWatchTimeMs: 'ig_reels_video_view_total_time', skipRatePercent: 'reels_skip_rate'
} satisfies Record<keyof InstagramMetrics, string>

interface Options {
  /** Where Instagram stands: the sign-in service's answer (main/signin-config.ts), or a developer's own app. */
  settings: () => Promise<InstagramSettings>
  settingsDir: string
  projectsDir: () => string
  secrets: InstagramSecretStore
  fetch: InstagramFetch
  openExternal: (url: string) => Promise<void>
  coverJpeg: (png: Buffer) => Buffer
  now?: () => number
}

// Node's web ReadableStream (stream/web) is what fetch takes as a streamed body, but @types/node and the DOM lib
// declare two ReadableStream types that do not match, so the body is passed as the DOM type it is at runtime.
const webBody = (stream: Readable): BodyInit => Readable.toWeb(stream) as unknown as BodyInit

export function instagramSettings(value: unknown): InstagramSettings {
  const s = object(value)
  if (typeof s.instagramEnabled !== 'boolean' || !Array.isArray(s.instagramUploadOrigins)) return invalidResponse()
  const appId = s.instagramAppId === null ? null : id(s.instagramAppId)
  const broker = s.instagramBrokerUrl === null ? null : serviceOrigin(s.instagramBrokerUrl)
  // storage Instagram fetches from: https only, since Meta's servers have to reach it
  const origins = s.instagramUploadOrigins.map((value) => {
    const u = httpsUrl(value)
    if (u.pathname !== '/' || u.search) return invalidResponse()
    return u.origin
  })
  return { instagramEnabled: s.instagramEnabled, instagramAppId: appId, instagramBrokerUrl: broker, instagramUploadOrigins: origins }
}

function publishInput(value: unknown): InstagramPublishInput {
  const p = object(value)
  if (typeof p.slug !== 'string' || !/^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u.test(p.slug) ||
      typeof p.version !== 'number' || !Number.isSafeInteger(p.version) || p.version < 1 ||
      typeof p.caption !== 'string' || [...p.caption].length > 2200)
    throw new InstagramError('IG_INPUT', 'Choose a finished version and a caption of at most 2,200 characters.')
  let trial: InstagramPublishInput['trial']
  if (p.trial !== undefined) {
    const t = object(p.trial)
    if (t.graduation !== 'MANUAL' && t.graduation !== 'SS_PERFORMANCE') throw new InstagramError('IG_INPUT', 'Choose how the trial reel is shared to your followers.')
    trial = { graduation: t.graduation }
  }
  const base = { slug: p.slug, version: p.version, caption: p.caption, ...(trial ? { trial } : {}) }
  const c = object(p.cover)
  if (c.kind === 'image') return { ...base, cover: { kind: 'image' } }
  if (c.kind === 'frame' && typeof c.offsetMs === 'number' && Number.isSafeInteger(c.offsetMs) && c.offsetMs >= 0)
    return { ...base, cover: { kind: 'frame', offsetMs: c.offsetMs } }
  throw new InstagramError('IG_COVER', 'Choose a cover image or a frame in the exported video.')
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel !== '' && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel)
}

export class InstagramService {
  private readonly tokens: InstagramTokenStore
  private queue: Promise<unknown> = Promise.resolve()
  private connection = new AbortController()
  private connecting?: AbortController

  constructor(private readonly o: Options) { this.tokens = new InstagramTokenStore(o.settingsDir, o.secrets) }
  private now(): number { return this.o.now?.() ?? Date.now() }
  private async config(): Promise<InstagramSettings & { instagramAppId: string; instagramBrokerUrl: string }> {
    const c = instagramSettings(await this.o.settings())
    if (!c.instagramEnabled || !c.instagramAppId || !c.instagramBrokerUrl)
      throw new InstagramError('IG_DISABLED', 'Posting to Instagram isn’t open yet. Settings › Posting says what’s missing.')
    return { ...c, instagramAppId: c.instagramAppId, instagramBrokerUrl: c.instagramBrokerUrl }
  }
  private run<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const signal = AbortSignal.any([this.connection.signal, AbortSignal.timeout(10 * 60_000)])
    const work = async () => {
      try { signal.throwIfAborted(); return await fn(signal) } catch (e) {
        if (signal.aborted) throw new InstagramError('IG_CANCELLED', 'The Instagram action was cancelled. Check Instagram before retrying a publish.')
        throw e
      }
    }
    const result = this.queue.then(work, work)
    this.queue = result.catch(() => undefined)
    return result
  }
  private async credentials(): Promise<InstagramCredentials> {
    const c = await this.config()
    const saved = await this.tokens.load()
    if (!saved || saved.appId !== c.instagramAppId || saved.brokerUrl !== c.instagramBrokerUrl)
      throw new InstagramError('IG_TOKEN', 'Connect Instagram again in Settings.')
    return saved
  }
  private async refresh(c: InstagramCredentials, signal: AbortSignal): Promise<InstagramCredentials> {
    // Meta cannot refresh an expired token or one less than 24 hours old.
    if (c.expiresAt <= this.now() || c.issuedAt + DAY > this.now())
      throw new InstagramError('IG_TOKEN', 'Your Instagram connection has expired. Connect Instagram again in Settings.')
    const url = new URL('https://graph.instagram.com/refresh_access_token')
    url.search = new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: c.accessToken }).toString()
    const data = object(await request(this.o.fetch, url.toString(), { method: 'GET' }, signal))
    if (String(data.token_type).toLowerCase() !== 'bearer') return invalidResponse()
    const next = { ...c, accessToken: text(data.access_token), issuedAt: this.now(), expiresAt: this.now() + positive(data.expires_in) * 1000 }
    signal.throwIfAborted()
    await this.tokens.save(next)
    return next
  }
  private async graph(path: string, init: RequestInit, signal: AbortSignal, onDispatch?: () => void): Promise<unknown> {
    let c = await this.credentials()
    if (c.expiresAt <= this.now()) throw new InstagramError('IG_TOKEN', 'Your Instagram connection has expired. Connect Instagram again in Settings.')
    // An unmeasured seven-day window leaves time to reconnect before expiry.
    if (c.expiresAt - this.now() <= 7 * DAY && c.issuedAt + DAY <= this.now()) c = await this.refresh(c, signal)
    const send = () => request(this.o.fetch, `${INSTAGRAM_GRAPH}/${path}`, { ...init, headers: { ...init.headers, authorization: `Bearer ${c.accessToken}` } }, signal, onDispatch)
    try { return await send() } catch (e) {
      // A definite OAuth rejection is safe to retry once. Transport and publish errors are never retried.
      if (!(e instanceof InstagramError) || e.code !== 'IG_TOKEN') throw e
      c = await this.refresh(c, signal)
      return send()
    }
  }
  async session(): Promise<InstagramSession> {
    return this.run(async () => {
      // Instagram off or not set up is an answer, not an error: the preview asks on every reel (Phone.tsx).
      const settings = await this.config().catch((e: unknown) => {
        if (e instanceof InstagramError && (e.code === 'IG_DISABLED' || e.code === 'IG_SETUP')) return null
        throw e
      })
      if (!settings) return { connected: false }
      const c = await this.tokens.load()
      if (!c || c.appId !== settings.instagramAppId || c.brokerUrl !== settings.instagramBrokerUrl || c.expiresAt <= this.now()) return { connected: false }
      return { connected: true, accountId: c.accountId, username: c.username, expiresAt: c.expiresAt, ...(c.picture ? { picture: c.picture } : {}) }
    })
  }
  connect(): Promise<InstagramSession> {
    this.cancelConnect()
    const ac = new AbortController()
    this.connecting = ac
    return this.run(async (outerSignal) => {
      const signal = AbortSignal.any([outerSignal, ac.signal])
      const config = await this.config()
      this.tokens.assertSecure()
      const state = randomBytes(32).toString('base64url')
      const verifier = randomBytes(32).toString('base64url')
      const listener = await instagramCallback(state, signal)
      try {
        // The sign-in service (docs/signin.md) makes Instagram's link; only Instagram's own page, for this app,
        // sending the person back through the service, is opened.
        const started = object(await request(this.o.fetch, `${config.instagramBrokerUrl}/v1/instagram/start`, jsonPost({
          state, loopback_uri: listener.redirectUri,
          code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256'
        }), signal))
        const url = httpsUrl(started.authorize_url)
        if (url.origin + url.pathname !== 'https://www.instagram.com/oauth/authorize' || url.searchParams.get('client_id') !== config.instagramAppId ||
            url.searchParams.get('redirect_uri') !== `${config.instagramBrokerUrl}/v1/instagram/callback`)
          return invalidResponse()
        signal.throwIfAborted()
        await this.o.openExternal(url.toString())
        const handoff = await listener.result
        const data = object(await request(this.o.fetch, `${config.instagramBrokerUrl}/v1/instagram/complete`, jsonPost({ handoff, code_verifier: verifier }), signal))
        const permissions = data.permissions
        if (String(data.token_type).toLowerCase() !== 'bearer' || !Array.isArray(permissions) || !INSTAGRAM_SCOPES.every((s) => permissions.includes(s)))
          throw new InstagramError('IG_PERMISSION', 'Allow publishing and insights when connecting your Instagram account.')
        const accessToken = text(data.access_token)
        const expiresAt = this.now() + positive(data.expires_in) * 1000
        const account = await this.profile(accessToken, signal)
        signal.throwIfAborted()
        const previous = await this.tokens.load()
        signal.throwIfAborted()
        await this.tokens.save({ accessToken, expiresAt, issuedAt: this.now(), ...account, appId: config.instagramAppId, brokerUrl: config.instagramBrokerUrl })
        if (signal.aborted) {
          if (previous) await this.tokens.save(previous)
          else await this.tokens.clear()
          throw new InstagramError('IG_CANCELLED', 'Instagram connection was cancelled.')
        }
        return { connected: true, ...account, expiresAt }
      } finally {
        listener.close()
        if (this.connecting === ac) this.connecting = undefined
      }
    })
  }
  cancelConnect(): void { this.connecting?.abort() }
  stop(): void { this.cancelConnect(); this.connection.abort() }
  async disconnect(): Promise<void> {
    this.stop()
    this.connection = new AbortController()
    const clear = () => this.tokens.clear()
    const result = this.queue.then(clear, clear)
    this.queue = result.catch(() => undefined)
    return result
  }
  private async profile(token: string, signal: AbortSignal): Promise<{ accountId: string; username: string; picture?: string }> {
    const data = object(await request(this.o.fetch, `${INSTAGRAM_GRAPH}/me?fields=${CONNECT_FIELDS}`, { method: 'GET', headers: { authorization: `Bearer ${token}` } }, signal))
    const account = this.parseProfile(data)
    const p = Array.isArray(data.data) ? object(data.data[0]) : data
    const picture = await this.picture(p.profile_picture_url, signal)
    return { ...account, ...(picture ? { picture } : {}) }
  }
  /**
   * The profile picture, fetched once while connecting and kept as a data URL: Meta's picture links expire, and the
   * renderer loads nothing remote (its img-src is local). Best effort: without it the preview shows a plain circle.
   * The request carries no token; the link is a public CDN address.
   */
  private async picture(raw: unknown, signal: AbortSignal): Promise<string | undefined> {
    if (raw === undefined || raw === null || raw === '') return undefined
    try {
      const url = httpsUrl(raw)
      const res = await this.o.fetch(url.toString(), { method: 'GET', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) })
      const type = res.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? ''
      const length = Number(res.headers.get('content-length') ?? 0)
      if (!res.ok || !PICTURE_TYPES.includes(type) || length > PICTURE_MAX_BYTES) {
        await res.body?.cancel()
        return undefined
      }
      // read with a running limit: a missing or wrong Content-Length must not let a big body into memory
      const chunks: Uint8Array[] = []
      let size = 0
      const reader = res.body?.getReader()
      for (let r = await reader?.read(); r && !r.done; r = await reader!.read()) {
        size += r.value.byteLength
        if (size > PICTURE_MAX_BYTES) {
          await reader!.cancel()
          return undefined
        }
        chunks.push(r.value)
      }
      if (!size) return undefined
      return `data:${type};base64,${Buffer.concat(chunks).toString('base64')}`
    } catch {
      signal.throwIfAborted()
      return undefined
    }
  }
  private parseProfile(data: Record<string, unknown>): { accountId: string; username: string } {
    const p = Array.isArray(data.data) ? object(data.data[0]) : data
    if (typeof p.account_type !== 'string' || !['BUSINESS', 'MEDIA_CREATOR'].includes(p.account_type.toUpperCase()))
      throw new InstagramError('IG_PROFESSIONAL', 'Instagram publishing requires a Professional account. Switch to a Business or Creator account in Instagram, then connect again.')
    return { accountId: id(p.user_id), username: text(p.username) }
  }
  private async project(slug: string, version: number): Promise<string> {
    if (!/^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u.test(slug) || !Number.isSafeInteger(version) || version < 1)
      throw new InstagramError('IG_INPUT', 'Choose a finished project version.')
    const root = await fs.realpath(this.o.projectsDir())
    const dir = await fs.realpath(join(root, slug))
    if (!inside(root, dir)) throw new InstagramError('IG_PATH', 'This project is outside the Reel Studio projects folder.')
    await fs.access(join(dir, 'project.json'))
    return dir
  }
  private async openFile(dir: string, file: string, maxSize: number) {
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK)
    try {
      const stat = await handle.stat({ bigint: true })
      if (!stat.isFile() || stat.size < 1n || stat.size > BigInt(maxSize)) throw new InstagramError('IG_FILE', 'The export or cover is empty, too large or not a regular file.')
      const resolved = await fs.realpath(file)
      if (!inside(dir, resolved)) throw new InstagramError('IG_PATH', 'The export or cover is outside this project.')
      // O_NOFOLLOW cannot stop an ancestor swap. Validate the opened file's identity,
      // then keep this descriptor for both the cover read and the video stream.
      const checked = await fs.stat(resolved, { bigint: true })
      if (checked.dev !== stat.dev || checked.ino !== stat.ino) throw new InstagramError('IG_PATH', 'The export or cover changed while opening it. Try again.')
      return { handle, size: Number(stat.size) }
    } catch (e) { await handle.close(); throw e }
  }
  private async stagedMedia(dir: string, input: InstagramPublishInput, signal: AbortSignal): Promise<{ videoUrl: string; coverUrl?: string }> {
    const config = await this.config()
    const video = await this.openFile(dir, join(dir, 'versions', `v${input.version}`, 'export.mp4'), 300_000_000)
    try {
      if (await fs.stat(join(dir, 'versions', `v${input.version}`, '.rendering')).then(() => true, () => false))
        throw new InstagramError('IG_RENDERING', 'Wait for this version to finish exporting before publishing.')
      let cover: Buffer | undefined
      if (input.cover.kind === 'image') {
        const source = await this.openFile(dir, join(dir, 'versions', `v${input.version}`, 'cover.png'), 32_000_000)
        try { cover = this.o.coverJpeg(await source.handle.readFile()) } finally { await source.handle.close() }
        if (!cover.length || cover.length > 8_000_000) throw new InstagramError('IG_COVER', 'The JPEG cover must be smaller than 8 MB.')
      }
      const credentials = await this.credentials()
      const upload = object(await request(this.o.fetch, `${config.instagramBrokerUrl}/v1/instagram/uploads`, {
        ...jsonPost({ video_size: video.size, cover_size: cover?.length ?? null }),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${credentials.accessToken}` }
      }, signal))
      const parseUpload = (value: unknown) => {
        const part = object(value)
        const put = httpsUrl(part.upload_url)
        const read = httpsUrl(part.public_url)
        if (!config.instagramUploadOrigins.includes(put.origin) || !config.instagramUploadOrigins.includes(read.origin))
          throw new InstagramError('IG_UPLOAD_HOST', 'The sign-in service returned a storage address it doesn’t list. Try again later.')
        return { put: put.toString(), read: read.toString() }
      }
      const v = parseUpload(upload.video)
      const c = cover ? parseUpload(upload.cover) : undefined
      // Stream from the validated descriptor. A 300 MB export must not be buffered in Electron.
      const stream = video.handle.createReadStream({ autoClose: false })
      try {
        const init = { method: 'PUT', headers: { 'content-type': 'video/mp4', 'content-length': String(video.size) }, body: webBody(stream), duplex: 'half', redirect: 'error', signal } satisfies RequestInit & { duplex: 'half' }
        const result = await this.o.fetch(v.put, init)
        if (!result.ok) throw new InstagramError('IG_UPLOAD', 'The video could not be uploaded. Try again later.')
        await result.body?.cancel()
      } finally { stream.destroy() }
      if (cover && c) {
        const result = await this.o.fetch(c.put, { method: 'PUT', body: new Uint8Array(cover), headers: { 'content-type': 'image/jpeg' }, redirect: 'error', signal })
        if (!result.ok) throw new InstagramError('IG_UPLOAD', 'The cover could not be uploaded. Try again later.')
        await result.body?.cancel()
      }
      return { videoUrl: v.read, ...(c ? { coverUrl: c.read } : {}) }
    } finally { await video.handle.close() }
  }
  publish(value: unknown): Promise<InstagramPost> {
    return this.run(async (signal) => {
      await this.config()
      const input = publishInput(value)
      const dir = await this.project(input.slug, input.version)
      const c = await this.credentials()
      const account = this.parseProfile(object(await this.graph('me?fields=user_id,username,account_type', { method: 'GET' }, signal)))
      if (account.accountId !== c.accountId) throw new InstagramError('IG_ACCOUNT', 'Instagram returned another account. Connect again in Settings.')
      // a trial is part of what was asked: posting the same version again as a normal reel is a different post
      const inputHash = createHash('sha256').update(JSON.stringify(input.trial ? { caption: input.caption, cover: input.cover, trial: input.trial } : { caption: input.caption, cover: input.cover })).digest('hex')
      let saved = await receipt(dir, input.version)
      if (saved && saved.accountId !== c.accountId) throw new InstagramError('IG_ACCOUNT', 'This version already has a publish attempt for another Instagram account.')
      if (saved?.state === 'published') {
        await this.ensureOutcome(dir, saved.post)
        return saved.post
      }
      if (saved?.state === 'publishing') throw new InstagramError('IG_PUBLISH_UNKNOWN', 'A publish was already sent for this version. Check Instagram before trying anything else. The saved container can be reconciled by support.')
      if (saved && saved.inputHash !== inputHash) throw new InstagramError('IG_PUBLISH_CHANGED', 'This upload has a different caption or cover. Resume it with the original settings, or export a new version.')
      if (!saved) {
        const media = await this.stagedMedia(dir, input, signal)
        const fields = new URLSearchParams({ media_type: 'REELS', video_url: media.videoUrl, caption: input.caption })
        if (media.coverUrl) fields.set('cover_url', media.coverUrl)
        else if (input.cover.kind === 'frame') fields.set('thumb_offset', String(input.cover.offsetMs))
        if (input.trial) fields.set('trial_params', JSON.stringify({ graduation_strategy: input.trial.graduation }))
        const data = object(await this.graph(`${c.accountId}/media`, { method: 'POST', body: fields }, signal))
        saved = { state: 'processing', accountId: c.accountId, containerId: id(data.id), inputHash }
        await saveReceipt(dir, input.version, saved)
      }
      let finished = false
      // Meta recommends once per minute, for at most five minutes. No busy polling.
      for (let attempt = 0; attempt < 6; attempt++) {
        const data = object(await this.graph(`${saved.containerId}?fields=status_code`, { method: 'GET' }, signal))
        if (data.status_code === 'FINISHED') { finished = true; break }
        if (data.status_code === 'ERROR' || data.status_code === 'EXPIRED')
          throw new InstagramError('IG_CONTAINER', 'Instagram could not process this video, or its upload expired. Export a new version before trying again.')
        if (data.status_code !== 'IN_PROGRESS') return invalidResponse()
        if (attempt < 5) await delay(60_000, undefined, { signal })
      }
      if (!finished) throw new InstagramError('IG_PROCESSING', 'Instagram is still processing the video. Try this version again later to resume checking it.')
      signal.throwIfAborted()
      await saveReceipt(dir, input.version, { ...saved, state: 'publishing' })
      let postId: string
      let dispatched = false
      try {
        postId = id(object(await this.graph(`${c.accountId}/media_publish`, { method: 'POST', body: new URLSearchParams({ creation_id: saved.containerId }) }, signal, () => { dispatched = true })).id)
      } catch (e) {
        // A definite rejection did not publish. A lost response may have, so keep the publishing receipt.
        if (!dispatched || (e instanceof InstagramError && ['IG_RATE_LIMIT', 'IG_TOKEN', 'IG_PERMISSION', 'IG_INPUT'].includes(e.code))) {
          await saveReceipt(dir, input.version, { ...saved, state: 'processing' })
          throw e
        }
        throw new InstagramError('IG_PUBLISH_UNKNOWN', 'Instagram did not confirm whether this reel was published. Check Instagram before retrying. This version is blocked to prevent a duplicate post.')
      }
      const post: InstagramPost = { version: input.version, accountId: c.accountId, postId, publishedAt: new Date(this.now()).toISOString(), ...(input.trial ? { trial: input.trial } : {}) }
      try {
        await saveReceipt(dir, input.version, { ...saved, state: 'published', post })
        await this.ensureOutcome(dir, post)
      } catch {
        throw new InstagramError('IG_PUBLISHED_UNSAVED', `Instagram published post ${postId}, but its local record could not be saved. Do not publish it again. Restore disk access and keep this post ID.`)
      }
      return post
    })
  }
  private async ensureOutcome(dir: string, post: InstagramPost): Promise<void> {
    // A retry after a local write failure must keep insights already collected for this post.
    const saved = await readObject(join(dir, 'outcomes.json'))
    if (saved && object(object(saved.versions)[`v${post.version}`] ?? {})[post.postId] !== undefined) return
    await saveOutcome(dir, { ...post, platform: 'instagram', apiVersion: INSTAGRAM_VERSION, observedAt: null, metrics: null })
  }
  insights(slug: string, version: number, postId: string): Promise<InstagramOutcome> {
    return this.run(async (signal) => {
      await this.config()
      id(postId)
      const dir = await this.project(slug, version)
      const c = await this.credentials()
      const saved = await receipt(dir, version)
      if (saved?.state !== 'published' || saved.accountId !== c.accountId || saved.post.postId !== postId)
        throw new InstagramError('IG_POST', 'This post is not linked to that project version and Instagram account.')
      const query = new URLSearchParams({ metric: Object.values(METRICS).join(','), period: 'lifetime' })
      const data = object(await this.graph(`${postId}/insights?${query}`, { method: 'GET' }, signal))
      if (!Array.isArray(data.data)) return invalidResponse()
      const values = new Map<string, number | null>()
      for (const entry of data.data) {
        const metric = object(entry)
        const name = text(metric.name)
        if (values.has(name)) return invalidResponse()
        const raw = metric.total_value !== undefined ? object(metric.total_value).value
          : Array.isArray(metric.values) && metric.values.length === 1 ? object(metric.values[0]).value
          : Array.isArray(metric.values) && metric.values.length === 0 ? null : invalidResponse()
        if (raw !== null && (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0)) return invalidResponse()
        values.set(name, raw)
      }
      const metrics: InstagramMetrics = {
        plays: values.get(METRICS.plays) ?? null, reach: values.get(METRICS.reach) ?? null, likes: values.get(METRICS.likes) ?? null,
        comments: values.get(METRICS.comments) ?? null, shares: values.get(METRICS.shares) ?? null, saves: values.get(METRICS.saves) ?? null,
        averageWatchTimeMs: values.get(METRICS.averageWatchTimeMs) ?? null, totalWatchTimeMs: values.get(METRICS.totalWatchTimeMs) ?? null,
        skipRatePercent: values.get(METRICS.skipRatePercent) ?? null
      }
      const outcome: InstagramOutcome = { ...saved.post, platform: 'instagram', apiVersion: INSTAGRAM_VERSION, observedAt: new Date(this.now()).toISOString(), metrics }
      signal.throwIfAborted()
      await saveOutcome(dir, outcome)
      return outcome
    })
  }
}
