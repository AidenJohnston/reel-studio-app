// TikTok Login Kit / OAuth v2: https://developers.tiktok.com/doc/login-kit-desktop/
// Content Posting v2: https://developers.tiktok.com/doc/content-posting-api-reference-direct-post/
// Upload v2: https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide/
// Status v2: https://developers.tiktok.com/doc/content-posting-api-reference-get-video-status/
// Stats v2: https://developers.tiktok.com/doc/tiktok-api-v2-video-query/
import { createHash, randomBytes } from 'node:crypto'
import { constants, promises as fs } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { InstagramSecretStore } from './instagram-store'
import type { TikTokCreator, TikTokOutcome, TikTokPrivacy, TikTokPublishInput, TikTokPublishResult, TikTokSession, TikTokSettings } from '../shared/tiktok'
import { apiError, count, fail, invalid, jsonPost, object, positive, request, text, TikTokError, TIKTOK_API, transport, type TikTokFetch } from './tiktok-http'
import { serviceOrigin } from './instagram-http'
import { tiktokCallback } from './tiktok-oauth'
import { clearReceipt, receipt, saveOutcome, saveReceipt, strings, TikTokTokenStore, uploadUrl, type TikTokCredentials, type TikTokReceipt } from './tiktok-store'

interface Options {
  /** Where TikTok stands: the sign-in service's answer (main/signin-config.ts), or a developer's own app. */
  settings: () => Promise<TikTokSettings>
  settingsDir: string
  projectsDir: () => string
  secrets: InstagramSecretStore
  fetch: TikTokFetch
  openExternal: (url: string) => Promise<void>
  now?: () => number
}
export function tiktokSettings(value: unknown): TikTokSettings {
  const s = object(value)
  if (typeof s.tiktokEnabled !== 'boolean' || typeof s.tiktokAudited !== 'boolean' || typeof s.tiktokDirectPost !== 'boolean') return invalid()
  const clientKey = s.tiktokClientKey === null ? null : text(s.tiktokClientKey)
  if (clientKey && !/^[A-Za-z0-9_-]{1,128}$/.test(clientKey)) return invalid()
  let broker: string | null = null
  try { broker = s.tiktokBrokerUrl === null ? null : serviceOrigin(s.tiktokBrokerUrl) } catch { return invalid() }
  return { tiktokEnabled: s.tiktokEnabled, tiktokAudited: s.tiktokAudited, tiktokDirectPost: s.tiktokDirectPost,
    tiktokClientKey: clientKey, tiktokBrokerUrl: broker }
}
function privacy(value: unknown): TikTokPrivacy {
  if (value === 'PUBLIC_TO_EVERYONE' || value === 'MUTUAL_FOLLOW_FRIENDS' || value === 'FOLLOWER_OF_CREATOR' || value === 'SELF_ONLY') return value
  return fail('TT_PRIVACY', 'Choose a privacy option for this TikTok post.')
}
function publishInput(value: unknown): TikTokPublishInput {
  const p = object(value)
  if (typeof p.slug !== 'string' || !/^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u.test(p.slug) ||
      typeof p.version !== 'number' || !Number.isSafeInteger(p.version) || p.version < 1 ||
      typeof p.caption !== 'string' || p.caption.length > 2200 ||
      (p.mode !== 'direct-or-inbox' && p.mode !== 'inbox') ||
      typeof p.durationSec !== 'number' || !Number.isFinite(p.durationSec) || p.durationSec <= 0)
    return fail('TT_INPUT', 'Choose a finished version, its duration, and a caption of at most 2,200 characters.')
  if (p.consent !== true) return fail('TT_CONSENT', 'Confirm sending this video to TikTok before uploading.')
  if (typeof p.disableComment !== 'boolean' || typeof p.disableDuet !== 'boolean' || typeof p.disableStitch !== 'boolean' ||
      typeof p.brandContent !== 'boolean' || typeof p.brandOrganic !== 'boolean' || typeof p.isAigc !== 'boolean')
    return fail('TT_INPUT', 'Choose the interaction, commercial content and AI content settings for this post.')
  return { slug: p.slug, version: p.version, caption: p.caption, mode: p.mode, consent: true, privacy: privacy(p.privacy), durationSec: p.durationSec,
    disableComment: p.disableComment, disableDuet: p.disableDuet, disableStitch: p.disableStitch,
    brandContent: p.brandContent, brandOrganic: p.brandOrganic, isAigc: p.isAigc }
}
function inside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel !== '' && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel)
}
export class TikTokService {
  private readonly tokens: TikTokTokenStore
  private queue: Promise<unknown> = Promise.resolve()
  private connection = new AbortController()
  private connecting?: AbortController
  constructor(private readonly o: Options) { this.tokens = new TikTokTokenStore(o.settingsDir, o.secrets) }
  private now(): number { return this.o.now?.() ?? Date.now() }
  private async config() {
    const c = tiktokSettings(await this.o.settings())
    if (!c.tiktokEnabled || !c.tiktokClientKey || !c.tiktokBrokerUrl)
      return fail('TT_DISABLED', 'Posting to TikTok isn’t open yet. Settings › Posting says what’s missing.')
    return { ...c, tiktokClientKey: c.tiktokClientKey, tiktokBrokerUrl: c.tiktokBrokerUrl }
  }
  private run<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const signal = AbortSignal.any([this.connection.signal, AbortSignal.timeout(10 * 60_000)])
    const work = async () => {
      try { signal.throwIfAborted(); return await fn(signal) } catch (e) {
        if (signal.aborted) return fail('TT_CANCELLED', 'The TikTok action was cancelled. Resume the saved upload before starting another export.')
        throw e
      }
    }
    const result = this.queue.then(work, work)
    this.queue = result.catch(() => undefined)
    return result
  }
  private async credentials(): Promise<TikTokCredentials> {
    const config = await this.config()
    const c = await this.tokens.load()
    if (!c || c.clientKey !== config.tiktokClientKey || c.brokerUrl !== config.tiktokBrokerUrl)
      return fail('TT_TOKEN', 'Connect TikTok again in Settings.')
    return c
  }
  private parseToken(data: Record<string, unknown>, config: { tiktokClientKey: string; tiktokBrokerUrl: string }, displayName: string): TikTokCredentials {
    if (String(data.token_type).toLowerCase() !== 'bearer') return invalid()
    const scopes = text(data.scope).split(',')
    if (!scopes.includes('user.info.basic')) throw apiError('scope_not_authorized')
    return { accessToken: text(data.access_token), refreshToken: text(data.refresh_token), expiresAt: this.now() + positive(data.expires_in) * 1000,
      refreshExpiresAt: this.now() + positive(data.refresh_expires_in) * 1000, accountId: text(data.open_id), displayName, scopes,
      clientKey: config.tiktokClientKey, brokerUrl: config.tiktokBrokerUrl }
  }
  private async refresh(c: TikTokCredentials, signal: AbortSignal): Promise<TikTokCredentials> {
    if (c.refreshExpiresAt <= this.now()) throw apiError('invalid_grant')
    const data = await request(this.o.fetch, `${c.brokerUrl}/v1/tiktok/token`, jsonPost({
      client_key: c.clientKey, grant_type: 'refresh_token', refresh_token: c.refreshToken
    }), signal, false)
    const next = this.parseToken(data, { tiktokClientKey: c.clientKey, tiktokBrokerUrl: c.brokerUrl }, c.displayName)
    if (next.accountId !== c.accountId) return fail('TT_ACCOUNT', 'TikTok returned another account. Connect again in Settings.')
    signal.throwIfAborted()
    await this.tokens.save(next)
    signal.throwIfAborted()
    return next
  }
  private async api(path: string, init: RequestInit, signal: AbortSignal): Promise<Record<string, unknown>> {
    let c = await this.credentials()
    // Five minutes is a conservative expiry margin, not a measured network latency budget.
    if (c.expiresAt <= this.now() + 5 * 60_000) c = await this.refresh(c, signal)
    const send = () => request(this.o.fetch, `${TIKTOK_API}/${path}`, { ...init,
      headers: { ...init.headers, authorization: `Bearer ${c.accessToken}` } }, signal)
    try { return await send() } catch (e) {
      // Retry only a definite invalid-token response, never an uncertain init or upload.
      if (!(e instanceof TikTokError) || e.code !== 'TT_TOKEN') throw e
      c = await this.refresh(c, signal)
      return send()
    }
  }
  session(): Promise<TikTokSession> {
    return this.run(async () => {
      // TikTok not open yet is an answer, not an error: Settings and Share ask on every visit
      try { await this.config() } catch (e) { if (e instanceof TikTokError && e.code === 'TT_DISABLED') return { connected: false }; throw e }
      let c: TikTokCredentials
      try { c = await this.credentials() } catch (e) { if (e instanceof TikTokError && e.code === 'TT_TOKEN') return { connected: false }; throw e }
      if (c.refreshExpiresAt <= this.now()) return { connected: false }
      return { connected: true, accountId: c.accountId, displayName: c.displayName, expiresAt: c.expiresAt, scopes: c.scopes }
    })
  }
  connect(): Promise<TikTokSession> {
    this.cancelConnect()
    const ac = new AbortController(); this.connecting = ac
    return this.run(async (outer) => {
      const signal = AbortSignal.any([outer, ac.signal])
      const config = await this.config(); this.tokens.assertSecure()
      const state = randomBytes(32).toString('base64url'), verifier = randomBytes(32).toString('base64url')
      const listener = await tiktokCallback(state, signal)
      const scopes = ['user.info.basic', 'video.list', 'video.upload', ...(config.tiktokDirectPost ? ['video.publish'] : [])]
      try {
        const url = new URL('https://www.tiktok.com/v2/auth/authorize/')
        url.search = new URLSearchParams({ client_key: config.tiktokClientKey, response_type: 'code', scope: scopes.join(','), state,
          redirect_uri: listener.redirectUri, code_challenge: createHash('sha256').update(verifier).digest('hex'), code_challenge_method: 'S256' }).toString()
        signal.throwIfAborted(); await this.o.openExternal(url.toString())
        const code = await listener.result
        const data = await request(this.o.fetch, `${config.tiktokBrokerUrl}/v1/tiktok/token`, jsonPost({
          client_key: config.tiktokClientKey, grant_type: 'authorization_code', code, redirect_uri: listener.redirectUri, code_verifier: verifier
        }), signal, false)
        let credentials = this.parseToken(data, config, 'TikTok creator')
        if (!['video.list', 'video.upload'].every((s) => credentials.scopes.includes(s))) throw apiError('scope_not_authorized')
        const profile = object((await request(this.o.fetch, `${TIKTOK_API}/user/info/?fields=open_id,display_name`, {
          method: 'GET', headers: { authorization: `Bearer ${credentials.accessToken}` }
        }, signal)).user)
        if (text(profile.open_id) !== credentials.accountId) return fail('TT_ACCOUNT', 'TikTok returned another account. Connect again in Settings.')
        credentials = { ...credentials, displayName: text(profile.display_name) }
        const previous = await this.tokens.load()
        signal.throwIfAborted(); await this.tokens.save(credentials)
        if (signal.aborted) {
          if (previous) await this.tokens.save(previous); else await this.tokens.clear()
          signal.throwIfAborted()
        }
        return { connected: true, accountId: credentials.accountId, displayName: credentials.displayName, expiresAt: credentials.expiresAt, scopes: credentials.scopes }
      } catch (e) {
        if (signal.aborted) return fail('TT_CANCELLED', 'TikTok connection was cancelled.')
        throw e
      } finally { listener.close(); if (this.connecting === ac) this.connecting = undefined }
    })
  }
  cancelConnect(): void { this.connecting?.abort() }
  stop(): void { this.cancelConnect(); this.connection.abort() }
  /** Forgets the connection on this computer, then asks TikTok (through the sign-in service) to end the grant too. */
  async disconnect(): Promise<void> {
    this.stop(); this.connection = new AbortController()
    const forget = async () => {
      const c = await this.tokens.load().catch(() => null)
      await this.tokens.clear()
      // best effort, for at most 5 s: the grant also ends on its own, and the person can remove the app in TikTok
      if (c) await request(this.o.fetch, `${c.brokerUrl}/v1/tiktok/revoke`, jsonPost({ client_key: c.clientKey, token: c.accessToken }),
        AbortSignal.timeout(5_000), false).catch(() => undefined)
    }
    const result = this.queue.then(forget, forget)
    this.queue = result.catch(() => undefined)
    return result
  }
  private async creatorInfo(signal: AbortSignal): Promise<TikTokCreator> {
    const config = await this.config()
    const data = await this.api('post/publish/creator_info/query/', jsonPost({}), signal)
    if (typeof data.comment_disabled !== 'boolean' || typeof data.duet_disabled !== 'boolean' || typeof data.stitch_disabled !== 'boolean') return invalid()
    const options = strings(data.privacy_level_options).map(privacy)
    return { displayName: text(data.creator_nickname), privateOnly: !config.tiktokAudited,
      privacyOptions: config.tiktokAudited ? options : options.filter((v) => v === 'SELF_ONLY'),
      commentDisabled: data.comment_disabled, duetDisabled: data.duet_disabled, stitchDisabled: data.stitch_disabled,
      maxDurationSec: positive(data.max_video_post_duration_sec) }
  }
  creator(): Promise<TikTokCreator> { return this.run((signal) => this.creatorInfo(signal)) }
  private async project(slug: string, version: number): Promise<string> {
    if (!/^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u.test(slug) || !Number.isSafeInteger(version) || version < 1)
      return fail('TT_INPUT', 'Choose a finished project version.')
    const root = await fs.realpath(this.o.projectsDir()), dir = await fs.realpath(join(root, slug))
    if (!inside(root, dir)) return fail('TT_PATH', 'This project is outside the Reel Studio projects folder.')
    await fs.access(join(dir, 'project.json'))
    return dir
  }
  private async openVideo(dir: string, version: number) {
    const path = join(dir, 'versions', `v${version}`)
    try { await fs.access(join(path, '.rendering')); return fail('TT_RENDERING', 'Wait for this version to finish exporting before uploading.') }
    catch (e) { if (!(e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT')) throw e }
    const file = join(path, 'export.mp4')
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK)
    try {
      const stat = await handle.stat({ bigint: true })
      if (!stat.isFile() || stat.size < 1n || stat.size > 4_000_000_000n) return fail('TT_FILE', 'Choose a regular MP4 export smaller than 4 GB.')
      const resolved = await fs.realpath(file)
      if (!inside(dir, resolved)) return fail('TT_PATH', 'The exported video is outside this project.')
      // Opening first catches ancestor swaps that O_NOFOLLOW cannot prevent. Read only this verified descriptor.
      const checked = await fs.stat(resolved, { bigint: true })
      if (checked.dev !== stat.dev || checked.ino !== stat.ino) return fail('TT_PATH', 'The export changed while opening it. Try again.')
      const size = Number(stat.size)
      const hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024)
      for (let position = 0; position < size;) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - position), position)
        if (!bytesRead) return fail('TT_FILE', 'The export changed while reading it. Export a new version.')
        hash.update(buffer.subarray(0, bytesRead)); position += bytesRead
      }
      return { handle, size, hash: hash.digest('hex') }
    } catch (e) { await handle.close(); throw e }
  }
  private async status(publishId: string, signal: AbortSignal) {
    const data = await this.api('post/publish/status/fetch/', jsonPost({ publish_id: publishId }), signal)
    if (data.status === 'FAILED') throw apiError(text(data.fail_reason))
    if (!['PROCESSING_UPLOAD', 'PROCESSING_DOWNLOAD', 'SEND_TO_USER_INBOX', 'PUBLISH_COMPLETE'].includes(text(data.status))) return invalid()
    const postIds = data.publicaly_available_post_id === undefined ? [] : strings(data.publicaly_available_post_id)
    if (postIds.some((id) => !/^\d+$/.test(id))) return invalid()
    return { status: text(data.status), postIds, uploadedBytes: data.uploaded_bytes === undefined ? undefined : count(data.uploaded_bytes) }
  }
  private result(saved: Extract<TikTokReceipt, { state: 'upload' }>, state: TikTokPublishResult['state'], postIds: string[]): TikTokPublishResult {
    const message = state === 'inbox' ? 'Sent to your TikTok inbox. Open the notification in TikTok to edit and finish posting. This is a draft, not a published post.'
      : state === 'processing' ? 'TikTok is still processing this upload. Resume this version later to check its status.'
      : saved.privateOnly && saved.mode === 'direct' ? 'TikTok confirmed publication. This unaudited app can only publish privately. Check the post in TikTok; private posts have no public video ID for stats.'
      : 'TikTok confirmed publication.'
    return { state, mode: saved.mode, publishId: saved.publishId, postIds, privateOnly: saved.privateOnly, message }
  }
  private async record(dir: string, version: number, saved: TikTokReceipt & { state: 'complete' }): Promise<void> {
    if (!saved.publishedAt) return
    for (const postId of saved.result.postIds) await saveOutcome(dir, { version, accountId: saved.accountId, postId,
      publishedAt: saved.publishedAt, platform: 'tiktok', apiVersion: 'v2', observedAt: null, metrics: null }, true)
  }
  publish(value: unknown): Promise<TikTokPublishResult> {
    return this.run(async (signal) => {
      const config = await this.config(), input = publishInput(value), c = await this.credentials()
      const dir = await this.project(input.slug, input.version)
      let saved = await receipt(dir, input.version)
      if (saved && saved.accountId !== c.accountId) return fail('TT_ACCOUNT', 'This version has an upload for another TikTok account.')
      if (saved?.state === 'initializing') return fail('TT_PUBLISH_UNKNOWN', 'TikTok did not confirm the upload request. Check TikTok before starting another export. This version is blocked to prevent duplicate posts.')
      if (saved?.state === 'complete') {
        // An inbox notification is not publication. A later explicit check can attribute the user's post.
        if (saved.result.state === 'inbox') {
          const current = await this.status(saved.result.publishId, signal)
          if (current.status === 'PUBLISH_COMPLETE') {
            saved = { ...saved, publishedAt: new Date(this.now()).toISOString(), result: { ...saved.result,
              state: 'published', postIds: current.postIds, message: 'TikTok confirmed publication.' } }
            await saveReceipt(dir, input.version, saved)
          }
        }
        await this.record(dir, input.version, saved)
        return saved.result
      }
      const video = await this.openVideo(dir, input.version)
      try {
        const inputHash = createHash('sha256').update(JSON.stringify(input)).update(video.hash).digest('hex')
        if (saved && saved.inputHash !== inputHash) return fail('TT_PUBLISH_CHANGED', 'The video or post settings changed. Resume with the original export and settings.')
        if (!saved) {
          let creator: TikTokCreator | undefined
          if (input.mode === 'direct-or-inbox' && config.tiktokDirectPost && c.scopes.includes('video.publish')) {
            try { creator = await this.creatorInfo(signal) } catch (e) {
              if (!(e instanceof TikTokError) || e.code !== 'TT_PERMISSION') throw e
            }
          }
          const mode = creator ? 'direct' : 'inbox'
          if (mode === 'inbox' && !c.scopes.includes('video.upload')) throw apiError('scope_not_authorized')
          if (creator) {
            if (creator.privateOnly && input.privacy !== 'SELF_ONLY') throw apiError('unaudited_client_can_only_post_to_private_accounts')
            if (!creator.privacyOptions.includes(input.privacy)) throw apiError('privacy_level_option_mismatch')
            if (input.durationSec > creator.maxDurationSec) throw apiError('duration_check_failed')
            if (input.brandContent && input.privacy === 'SELF_ONLY') return fail('TT_PRIVACY', 'Paid partnership posts cannot use Only me. Choose another allowed privacy option after the app audit, or send a draft to TikTok.')
          }
          const chunkSize = Math.min(video.size, 10_000_000), chunkCount = Math.max(1, Math.floor(video.size / chunkSize))
          const base = { accountId: c.accountId, inputHash }
          signal.throwIfAborted()
          await saveReceipt(dir, input.version, { ...base, state: 'initializing' })
          let data: Record<string, unknown>
          try {
            data = await this.api(mode === 'direct' ? 'post/publish/video/init/' : 'post/publish/inbox/video/init/', jsonPost({
              source_info: { source: 'FILE_UPLOAD', video_size: video.size, chunk_size: chunkSize, total_chunk_count: chunkCount },
              ...(creator ? { post_info: { title: input.caption, privacy_level: input.privacy,
                disable_comment: input.disableComment || creator.commentDisabled, disable_duet: input.disableDuet || creator.duetDisabled,
                disable_stitch: input.disableStitch || creator.stitchDisabled, brand_content_toggle: input.brandContent,
                brand_organic_toggle: input.brandOrganic, is_aigc: input.isAigc } } : {})
            }), signal)
          } catch (e) {
            // Definite rejections create no upload. Keep the marker for uncertain transport/server failures.
            if (e instanceof TikTokError && !['TT_NETWORK', 'TT_API', 'TT_RESPONSE'].includes(e.code) && !signal.aborted) {
              await clearReceipt(dir, input.version)
            }
            throw e
          }
          saved = { ...base, state: 'upload', publishId: text(data.publish_id), uploadUrl: uploadUrl(data.upload_url), size: video.size,
            chunkSize, chunkCount, offset: 0, expiresAt: this.now() + 60 * 60_000, mode, privateOnly: !config.tiktokAudited }
          await saveReceipt(dir, input.version, saved)
        }
        // TikTok's authoritative byte count also recovers a chunk whose HTTP response was lost.
        let status = await this.status(saved.publishId, signal)
        if (status.status === 'PROCESSING_UPLOAD' && status.uploadedBytes !== undefined) {
          if (status.uploadedBytes > saved.size || status.uploadedBytes < saved.offset) return invalid()
          saved = { ...saved, offset: status.uploadedBytes }
        }
        if (status.status === 'PROCESSING_UPLOAD') {
          if (saved.expiresAt <= this.now()) return fail('TT_UPLOAD_EXPIRED', 'This TikTok upload expired. Check TikTok before starting a new export.')
          while (saved.offset < saved.size) {
            signal.throwIfAborted()
            const start = saved.offset, chunkIndex = Math.floor(start / saved.chunkSize)
            if (start % saved.chunkSize !== 0 || chunkIndex >= saved.chunkCount) return invalid()
            const end: number = chunkIndex === saved.chunkCount - 1 ? saved.size : start + saved.chunkSize
            const bytes = Buffer.alloc(end - start)
            let read = 0
            while (read < bytes.length) {
              const result = await video.handle.read(bytes, read, bytes.length - read, start + read)
              if (!result.bytesRead) return fail('TT_FILE', 'The export changed during upload. Resume with the original file.')
              read += result.bytesRead
            }
            const res = await transport(this.o.fetch, saved.uploadUrl, { method: 'PUT', headers: { 'content-type': 'video/mp4',
              'content-length': String(bytes.length), 'content-range': `bytes ${start}-${end - 1}/${saved.size}` }, body: new Uint8Array(bytes) }, signal)
            await res.body?.cancel()
            if (res.status === 429) throw apiError('rate_limit_exceeded', 429)
            if (res.status === 403 || res.status === 404) return fail('TT_UPLOAD_EXPIRED', 'TikTok could not find an active upload. Check TikTok before starting another export.')
            if (res.status === 416) return fail('TT_UPLOAD_RESUME', 'TikTok has different upload progress. Resume this version to check the received bytes before retrying.')
            if (res.status !== (end === saved.size ? 201 : 206)) return fail('TT_UPLOAD', 'This video chunk was not confirmed. Resume this version to check TikTok upload progress.')
            saved = { ...saved, offset: end }; await saveReceipt(dir, input.version, saved)
          }
          status = await this.status(saved.publishId, signal)
        }
        // 2 seconds respects the documented 30 status requests/minute per access token.
        for (let attempt = 0; attempt < 5 && ['PROCESSING_UPLOAD', 'PROCESSING_DOWNLOAD'].includes(status.status); attempt++) {
          await delay(2_000, undefined, { signal }); status = await this.status(saved.publishId, signal)
        }
        const state = status.status === 'PUBLISH_COMPLETE' ? 'published' : status.status === 'SEND_TO_USER_INBOX' ? 'inbox' : 'processing'
        const result = this.result(saved, state, status.postIds)
        if (state !== 'processing') {
          const complete = { accountId: c.accountId, inputHash, state: 'complete', result,
            publishedAt: state === 'published' ? new Date(this.now()).toISOString() : null } satisfies TikTokReceipt
          await saveReceipt(dir, input.version, complete); await this.record(dir, input.version, complete)
        }
        return result
      } finally { await video.handle.close() }
    })
  }
  insights(slug: string, version: number, postId: string): Promise<TikTokOutcome> {
    return this.run(async (signal) => {
      const c = await this.credentials(), dir = await this.project(slug, version), saved = await receipt(dir, version)
      if (!/^\d+$/.test(postId) || saved?.state !== 'complete' || !saved.publishedAt || saved.accountId !== c.accountId || !saved.result.postIds.includes(postId))
        return fail('TT_POST', 'This TikTok video is not linked to that project version and account. Private posts and inbox drafts may have no public video ID.')
      if (!c.scopes.includes('video.list')) throw apiError('scope_not_authorized')
      const data = await this.api('video/query/?fields=id,view_count,like_count,comment_count,share_count', jsonPost({ filters: { video_ids: [postId] } }), signal)
      if (!Array.isArray(data.videos) || data.videos.length !== 1) return fail('TT_STATS_UNAVAILABLE', 'TikTok has no stats for this video. It may be private or still under review.')
      const video = object(data.videos[0])
      if (video.id !== postId) return invalid()
      const metric = (value: unknown) => value === undefined ? null : count(value)
      const outcome: TikTokOutcome = { version, accountId: c.accountId, postId, publishedAt: saved.publishedAt, platform: 'tiktok', apiVersion: 'v2',
        observedAt: new Date(this.now()).toISOString(), metrics: { plays: metric(video.view_count), likes: metric(video.like_count),
          comments: metric(video.comment_count), shares: metric(video.share_count), reach: null, saves: null,
          averageWatchTimeMs: null, totalWatchTimeMs: null, skipRatePercent: null } }
      await saveOutcome(dir, outcome)
      return outcome
    })
  }
}
