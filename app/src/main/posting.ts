// Posting a finished video to YouTube, from the main process. The app talks only to Reel Studio's posting server
// (post.getreelstudio.com, or REELSTUDIO_POSTING_URL); the server holds the Google sign-in and passes each chunk
// of the video to YouTube. This computer never sees a Google token.
//
// How it fits together:
//   - Sign-in: the buyer's download key (main/update-key.ts) is traded ONCE for this computer's own sign-in (a
//     session the server can end), and only when the person clicks Connect YouTube or Sign in: never in the
//     background, never after the server ended it. After that only the session is sent.
//   - Connect YouTube: the server makes a one-time link to its own page, which sends the browser on to Google. The
//     app opens it and asks the server every couple of seconds how it went.
//   - Post: the file is sent in chunks (8 MiB, as the server says). After a dropped connection the app asks the
//     server how much YouTube really has and carries on from there, for up to 5 minutes without progress; after
//     that "Finish posting" picks it up, even after a restart (the stopped post is kept in posting-uploads.json).
//
// Logs never carry the key, the session, the link's one-time token or any video bytes.
// This file never imports electron (like update-key.ts): main/posting-ipc.ts wires it, tests drive it with fakes.
import type { ConnectOutcome, PendingPost, PostingStatus, PostPrivacy, PostProgress, PostRequest, PostResult, PostStep, UserError } from '../shared/api'
import { descriptionProblem, postingError, titleProblem, type PostField, type PostingErrorCode } from '../shared/posting'

export const MAX_VIDEO = 4 * 1024 ** 3
const CHUNK_UNIT = 256 * 1024
const DEFAULT_CHUNK = 8 * 1024 * 1024
const MAX_CHUNK = 16 * 1024 * 1024
const CHUNK_TIMEOUT_MS = 120_000
/** A chunk gets at least the time it needs at this many bytes a second, so a slow uplink still gets through. */
const SLOWEST_UPLINK = 32 * 1024
/** Chunks in a row that go through before a chunk halved after a timeout grows again. */
const GROW_AFTER = 4
const CALL_TIMEOUT_MS = 30_000
const ME_CACHE_MS = 30_000
/** Waits between tries after a dropped connection, in seconds; the last one repeats. */
export const RETRY_WAITS = [2, 4, 8, 16, 30]
/** Give up (and offer Finish posting) after this long without a byte getting through. */
export const GIVE_UP_MS = 5 * 60_000
const PROGRESS_EVERY_MS = 250
const PENDING_KEEP_MS = 3 * 24 * 3600_000
/** How long Connect YouTube waits for the browser: the server's link lives 10 minutes. */
const ATTEMPT_WAIT_MS = 10 * 60_000 + 30_000
const ATTEMPT_OUTCOMES: ConnectOutcome[] = ['connected', 'denied', 'missing_permission', 'no_channel', 'failed', 'cancelled', 'expired']
/** A YouTube video id, as the server checks it. */
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{6,32}$/

/** This computer's sign-in, as stored (encrypted where the OS can: main/posting-ipc.ts). */
export interface StoredSession {
  v: 1
  /** The posting server it belongs to; a session for another server counts as none. */
  server: string
  session: string
  sessionId: string
  plan: 'monthly' | 'once'
  createdAt: number
}

/** A post that started, kept until it ends so Finish posting works after a restart. */
export interface PendingEntry {
  uploadId: string
  server: string
  slug: string
  version: number
  video: string
  size: number
  mtimeMs: number
  startedAt: number
  /** Who can see it, as asked (the done screen says when YouTube set something else). */
  privacy?: PostPrivacy
  /** Bytes the server had confirmed when it stopped (shown while the server can't be asked). */
  sent?: number
}

export interface PostingDeps {
  /** On unless REELSTUDIO_POSTING=0, with a usable address (postingConfig). */
  enabled: boolean
  /** The server's origin, no trailing slash. */
  baseUrl: string
  appVersion: string
  platform: NodeJS.Platform
  fetch: typeof fetch
  now(): number
  /** Resolves after ms, or rejects at once when the signal aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>
  /** The download key (update-key.ts), or null. */
  getKey(): Promise<string | null>
  loadSession(): Promise<StoredSession | null>
  saveSession(s: StoredSession): Promise<void>
  clearSession(): Promise<void>
  loadPending(): Promise<PendingEntry[]>
  savePending(list: PendingEntry[]): Promise<void>
  /** `length` bytes of the file from `start`. */
  readChunk(file: string, start: number, length: number): Promise<Uint8Array>
  statFile(file: string): Promise<{ size: number; mtimeMs: number } | null>
  /** The real path when it is an exported .mp4 in Library › Finished videos, else null. */
  isFinishedVideo(file: string): Promise<string | null>
  openExternal(url: string): Promise<void>
  log(line: string): void
  send(channel: 'posting:change' | 'posting:progress', value: unknown): void
}

/**
 * Posting is on for everyone: nothing reaches the server until the person clicks Sign in or Connect, and the Post
 * sheet says when Google hasn't verified the app yet (POST_COPY.connecting). It used to need REELSTUDIO_POSTING=1
 * while the server and Google's review were pending; REELSTUDIO_POSTING=0 still turns it off.
 * REELSTUDIO_POSTING_URL moves it to another server (https, or http on this computer).
 */
export function postingConfig(env: Record<string, string | undefined>, fallback: string, log: (line: string) => void): { enabled: boolean; baseUrl: string } {
  if (env.REELSTUDIO_POSTING === '0') return { enabled: false, baseUrl: fallback }
  const raw = env.REELSTUDIO_POSTING_URL?.trim()
  if (!raw) return { enabled: true, baseUrl: fallback }
  const base = usableBase(raw)
  if (!base) {
    log('[posting] REELSTUDIO_POSTING_URL is not a usable address; posting stays off')
    return { enabled: false, baseUrl: fallback }
  }
  return { enabled: true, baseUrl: base }
}

function usableBase(raw: string): string | null {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.username || u.password || u.search || u.hash) return null
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null
  return (u.origin + u.pathname).replace(/\/+$/, '')
}

/** A user error, as thrown by every posting call. */
class PostingError extends Error {
  constructor(
    readonly code: PostingErrorCode,
    readonly userMessage: string,
    readonly link?: string,
    readonly field?: PostField
  ) {
    super(code)
  }
}
const fail = (code: PostingErrorCode, field?: PostField): PostingError => {
  const u = postingError(code, field)
  return new PostingError(code, u.userMessage, u.link, field)
}
const asUser = (e: PostingError): UserError => ({ code: e.code, userMessage: e.userMessage, ...(e.link ? { link: e.link } : {}) })

/** What the server answered (any status), or `net` when it couldn't be reached (`timedOut`: it ran out of time). */
type Answer = { net: false; status: number; body: any } | { net: true; aborted: boolean; timedOut: boolean }

/** The posting server's error (section 2 of the contract) as the user error the app shows. */
export function userErrorFor(status: number, body: any): PostingError {
  const error = typeof body?.error === 'string' ? body.error : ''
  switch (error) {
    case 'bad_request':
      return ['title', 'description', 'privacy'].includes(body.field) ? fail('BAD_FIELD', body.field) : fail('SERVER')
    case 'no_key':
    case 'bad_key':
      return fail('BAD_KEY')
    case 'no_session':
    case 'bad_session':
      return fail('SIGNED_OUT')
    case 'not_entitled':
      return fail('ENDED')
    case 'not_connected':
      return fail('NOT_CONNECTED')
    case 'reconnect_needed':
      return fail('RECONNECT')
    case 'no_channel':
      return fail('NO_CHANNEL')
    case 'upload_expired':
      return fail('EXPIRED')
    case 'rate_limited':
      return fail('RATE_LIMITED')
    case 'quota':
      return fail('QUOTA')
    case 'upload_limit':
      return fail('UPLOAD_LIMIT')
    case 'platform_error':
      return fail('PLATFORM')
    case 'not_configured':
      return fail('NOT_CONFIGURED')
  }
  if (status === 401) return fail('SIGNED_OUT')
  if (status === 403) return fail('ENDED')
  return fail('SERVER')
}

/** YouTube's reason for a failed upload (GET /v1/uploads/:id) as the user error. */
function failedReason(reason: unknown): PostingError {
  if (reason === 'uploadLimitExceeded') return fail('UPLOAD_LIMIT')
  if (reason === 'quotaExceeded') return fail('QUOTA')
  return fail('PLATFORM')
}

const PRIVACIES: PostPrivacy[] = ['private', 'unlisted', 'public']

/** The video's two links, made here from its id: the server's own url strings are never opened or copied. */
function resultOf(video: any, asked: PostPrivacy): PostResult {
  const id = typeof video?.id === 'string' ? video.id : ''
  if (!VIDEO_ID_RE.test(id)) throw fail('SERVER')
  return {
    videoId: id,
    videoUrl: `https://www.youtube.com/watch?v=${id}`,
    studioUrl: `https://studio.youtube.com/video/${id}/edit`,
    privacy: PRIVACIES.includes(video?.privacy) ? video.privacy : asked,
    channelName: typeof video?.channelName === 'string' ? video.channelName : null
  }
}

/** The only links openLink opens: a video's watch page, short link or YouTube Studio page. */
export function isVideoLink(raw: unknown): boolean {
  let u: URL
  try {
    u = new URL(String(raw))
  } catch {
    return false
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || u.hash) return false
  const isId = (s: string | null | undefined): boolean => !!s && VIDEO_ID_RE.test(s)
  if (u.hostname === 'www.youtube.com') return u.pathname === '/watch' && [...u.searchParams.keys()].join() === 'v' && isId(u.searchParams.get('v'))
  if (u.search) return false
  if (u.hostname === 'studio.youtube.com') return isId(/^\/video\/([^/]+)\/edit$/.exec(u.pathname)?.[1])
  if (u.hostname === 'youtu.be') return isId(/^\/([^/]+)$/.exec(u.pathname)?.[1])
  return false
}

/**
 * A server answer mid-upload that is safe to try again, and whose trouble it is; null = a real error. Safe because
 * the next step is a GET that re-reads how much YouTube has, so nothing is sent twice. That covers YouTube's own
 * hiccups (502 retry), our server failing for a moment (a 500 from a database blip), and anything that isn't our
 * JSON at all (an edge error page, a cut-off answer).
 */
export function troubleOf(status: number, body: any): 'PLATFORM' | 'SERVER' | null {
  const error = typeof body?.error === 'string' ? body.error : null
  if (error === 'platform_error') return body.retry === true ? 'PLATFORM' : null
  if (error) return status >= 500 && error !== 'not_configured' ? 'SERVER' : null
  return status === 401 || status === 403 || status === 404 ? null : 'SERVER'
}

const device = (p: NodeJS.Platform): 'Windows' | 'Mac' | 'Linux' => (p === 'win32' ? 'Windows' : p === 'darwin' ? 'Mac' : 'Linux')

function chunkSizeOf(n: unknown): number {
  return typeof n === 'number' && Number.isInteger(n) && n > 0 && n % CHUNK_UNIT === 0 && n <= MAX_CHUNK ? n : DEFAULT_CHUNK
}

interface Running {
  uploadId: string | null
  slug: string
  version: number
  controller: AbortController
  cancelled: boolean
  /** The privacy asked for: the result's privacy if YouTube's answer doesn't say. */
  asked: PostPrivacy
  last: PostProgress
  lastSentAt: number
  done: Promise<PostProgress>
}

export function createPostingService(d: PostingDeps) {
  const origin = new URL(d.baseUrl).origin
  let me: { at: number; body: any } | null = null
  let ended = false
  let signedOutByServer = false
  let connecting: { controller: AbortController; attemptId: string; expiresAt: number; promise: Promise<{ outcome: ConnectOutcome; status: PostingStatus }> } | null = null
  let running: Running | null = null

  const off = (): void => {
    if (!d.enabled) throw fail('POSTING_OFF')
  }

  async function session(): Promise<StoredSession | null> {
    const s = await d.loadSession().catch(() => null)
    return s && s.v === 1 && s.server === d.baseUrl && typeof s.session === 'string' ? s : null
  }

  async function request(method: string, path: string, o: { auth?: string; json?: unknown; bytes?: Uint8Array; range?: string; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<Answer> {
    const headers: Record<string, string> = { 'X-Reel-Studio-Version': d.appVersion }
    if (o.auth) headers.Authorization = `Bearer ${o.auth}`
    let body: string | Uint8Array | undefined
    if (o.json !== undefined) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(o.json)
    } else if (o.bytes) {
      headers['Content-Type'] = 'application/octet-stream'
      body = o.bytes
    }
    if (o.range) headers['Content-Range'] = o.range
    const timeout = AbortSignal.timeout(o.timeoutMs ?? CALL_TIMEOUT_MS)
    const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout
    let res: Response
    try {
      res = await d.fetch(`${d.baseUrl}${path}`, { method, headers, body: body as RequestInit['body'], signal, redirect: 'error' })
    } catch (e) {
      return { net: true, aborted: !!o.signal?.aborted, timedOut: timeout.aborted || (e as Error | null)?.name === 'TimeoutError' }
    }
    let parsed: any = null
    try {
      parsed = JSON.parse(await res.text())
    } catch {
      /* not JSON: a proxy's page, an empty answer */
    }
    return { net: false, status: res.status, body: parsed }
  }

  /** The server said this computer's sign-in is gone (Sign out everywhere, or 180 days unused). */
  async function lostSession(): Promise<void> {
    await d.clearSession().catch(() => undefined)
    me = null
    signedOutByServer = true
    d.log('[posting] the server ended this computer\'s sign-in')
    void broadcast()
  }

  /** A call with this computer's session; throws the user error for anything but 2xx. `upload`: an upload's own route. */
  async function api(method: string, path: string, o: { json?: unknown; signal?: AbortSignal; upload?: boolean } = {}): Promise<any> {
    const s = await session()
    if (!s) throw fail(signedOutByServer ? 'SIGNED_OUT' : 'NOT_CONNECTED')
    const a = await request(method, path, { json: o.json, signal: o.signal, auth: s.session })
    if (a.net) throw fail('OFFLINE')
    if (a.status >= 200 && a.status < 300) return a.body ?? {}
    throw await problem(a.status, a.body, o.upload)
  }

  let refreshing = false
  /** The YouTube connection changed on the server (connect again, removed, no channel): forget the cached /v1/me
   * and tell the pages, so the Post sheet offers Connect YouTube instead of the form. */
  function connectionChanged(): void {
    me = null
    if (refreshing) return // the refresh itself got the same answer
    refreshing = true
    void broadcast(true)
      .catch(() => undefined)
      .finally(() => (refreshing = false))
  }

  /** The user error for a server answer, after its side effects (sign-in gone, subscription ended, connection
   * changed). `upload`: the answer is about one upload, so a 404 means it is gone (its connection was removed or
   * replaced on another computer). */
  async function problem(status: number, body: any, upload = false): Promise<PostingError> {
    const gone = upload && status === 404
    const e = gone ? fail('EXPIRED') : userErrorFor(status, body)
    if (e.code === 'SIGNED_OUT') await lostSession()
    if (e.code === 'ENDED' && !ended) {
      ended = true
      void broadcast()
    }
    if (gone || e.code === 'RECONNECT' || e.code === 'NOT_CONNECTED' || e.code === 'NO_CHANNEL') connectionChanged()
    return e
  }

  async function fetchMe(force = false): Promise<any | null> {
    if (!force && me && d.now() - me.at < ME_CACHE_MS) return me.body
    try {
      const body = await api('GET', '/v1/me')
      me = { at: d.now(), body }
      ended = false
      return body
    } catch (e) {
      if (e instanceof PostingError && e.code === 'OFFLINE') return me?.body ?? null
      me = { at: d.now(), body: null } // ended or signed out: don't ask again on every status
      return null
    }
  }

  async function status(force = false): Promise<PostingStatus> {
    const base: PostingStatus = { enabled: d.enabled, hasKey: false, signedIn: false, signedOutByServer, otherComputers: 0, youtube: null, ended, connecting: !!connecting }
    if (!d.enabled) return base
    base.hasKey = !!(await d.getKey().catch(() => null))
    if (!(await session())) return { ...base, signedOutByServer, ended }
    const body = await fetchMe(force)
    const signedIn = !!(await session())
    const yt = Array.isArray(body?.connections) ? body.connections.find((c: any) => c?.platform === 'youtube') : null
    return {
      ...base,
      signedIn,
      signedOutByServer,
      ended,
      otherComputers: signedIn && typeof body?.otherSessions === 'number' ? body.otherSessions : 0,
      youtube:
        signedIn && yt
          ? { state: yt.status === 'reconnect' ? 'reconnect' : 'connected', channelName: typeof yt.channelName === 'string' ? yt.channelName : null, channelUrl: typeof yt.channelUrl === 'string' ? yt.channelUrl : null }
          : null
    }
  }

  async function broadcast(force = false): Promise<PostingStatus> {
    const s = await status(force)
    d.send('posting:change', s)
    return s
  }

  /** Trade the download key for this computer's sign-in. Only ever called from a click. */
  async function signIn(): Promise<StoredSession> {
    const key = await d.getKey().catch(() => null)
    if (!key) throw fail('NO_KEY')
    const a = await request('POST', '/v1/sessions', { auth: key, json: { device: device(d.platform) } })
    if (a.net) throw fail('OFFLINE')
    if (a.status !== 201 && a.status !== 200) throw await problem(a.status, a.body)
    const b = a.body ?? {}
    if (typeof b.session !== 'string' || typeof b.sessionId !== 'string') throw fail('SERVER')
    const s: StoredSession = { v: 1, server: d.baseUrl, session: b.session, sessionId: b.sessionId, plan: b.plan === 'once' ? 'once' : 'monthly', createdAt: d.now() }
    await d.saveSession(s)
    signedOutByServer = false
    ended = false
    me = null
    d.log(`[posting] signed in on this computer (${s.sessionId})`)
    return s
  }

  async function ensureSession(): Promise<StoredSession> {
    return (await session()) ?? signIn()
  }

  // ---- Connect YouTube ----------------------------------------------------------------------------

  /** A fresh one-time link to the server's own page. Main opens nothing else. */
  async function newAttempt(signal?: AbortSignal): Promise<{ attemptId: string; openUrl: string; expiresAt: number; pollMs: number }> {
    const b = await api('POST', '/v1/connections/youtube/attempts', { signal })
    let u: URL | null = null
    try {
      u = new URL(String(b.openUrl))
    } catch {
      /* checked below */
    }
    if (!u || u.origin !== origin || u.pathname !== '/oauth/youtube/begin' || typeof b.attemptId !== 'string') {
      d.log('[posting] the server sent a connect link that is not its own page; not opened')
      throw fail('SERVER')
    }
    await d.openExternal(u.toString())
    d.log(`[posting] opened the YouTube connect page (${b.attemptId})`) // never the link: it carries a one-time token
    // Timed on this computer's clock, not the server's expiresAt: a clock that is a few minutes off would otherwise
    // give up at once. The server answers 'expired' itself when the link runs out.
    return { attemptId: b.attemptId, openUrl: u.toString(), expiresAt: d.now() + ATTEMPT_WAIT_MS, pollMs: Math.max(500, Number(b.pollMs) || 2000) }
  }

  async function runConnect(controller: AbortController): Promise<ConnectOutcome> {
    await ensureSession()
    // The connection belongs to the purchase: another computer may have connected it already.
    const current = await fetchMe(true)
    const yt = Array.isArray(current?.connections) ? current.connections.find((c: any) => c?.platform === 'youtube') : null
    if (yt?.status === 'connected') return 'connected'
    const a = await newAttempt(controller.signal)
    connecting!.attemptId = a.attemptId
    connecting!.expiresAt = a.expiresAt
    void broadcast()
    for (;;) {
      try {
        await d.sleep(a.pollMs, controller.signal)
      } catch {
        /* cancelled: checked below */
      }
      if (controller.signal.aborted) {
        await api('DELETE', `/v1/connections/youtube/attempts/${encodeURIComponent(connecting!.attemptId)}`).catch(() => undefined)
        return 'cancelled'
      }
      if (d.now() > connecting!.expiresAt) return 'expired'
      let b: any
      try {
        b = await api('GET', `/v1/connections/youtube/attempts/${encodeURIComponent(connecting!.attemptId)}`)
      } catch (e) {
        if (e instanceof PostingError && e.code === 'OFFLINE') continue // the browser part may still finish: keep asking
        throw e
      }
      if (ATTEMPT_OUTCOMES.includes(b?.status)) return b.status
    }
  }

  function connect(platform: unknown): Promise<{ outcome: ConnectOutcome; status: PostingStatus }> {
    off()
    if (platform !== 'youtube') throw fail('SERVER')
    if (connecting) return connecting.promise
    const controller = new AbortController()
    const c = { controller, attemptId: '', expiresAt: 0, promise: null as never as Promise<{ outcome: ConnectOutcome; status: PostingStatus }> }
    connecting = c
    c.promise = (async () => {
      try {
        const outcome = await runConnect(controller).catch((e) => {
          if (controller.signal.aborted) return 'cancelled' as const // Cancel pressed while signing in or asking for the link
          throw e
        })
        d.log(`[posting] connect YouTube: ${outcome}`)
        return outcome
      } finally {
        connecting = null
      }
    })().then(async (outcome) => ({ outcome, status: await broadcast(true) }))
    c.promise.catch(() => void broadcast())
    return c.promise
  }

  // ---- posting --------------------------------------------------------------------------------------

  /** The stopped posts still worth offering: the server gives up on an unfinished upload after 2 days. */
  const pendingList = async (): Promise<PendingEntry[]> => {
    const l = await d.loadPending().catch(() => [])
    return Array.isArray(l) ? l.filter((e) => e && typeof e.uploadId === 'string' && d.now() - Number(e.startedAt) < PENDING_KEEP_MS) : []
  }
  async function dropPending(uploadId: string): Promise<void> {
    const l = await pendingList()
    if (l.some((e) => e.uploadId === uploadId)) await d.savePending(l.filter((e) => e.uploadId !== uploadId))
  }
  async function keepPending(entry: PendingEntry): Promise<void> {
    const l = (await pendingList()).filter((e) => e.uploadId !== entry.uploadId && !(e.server === entry.server && e.slug === entry.slug && e.version === entry.version))
    await d.savePending([...l, entry])
  }

  function emit(r: Running, step: PostStep, patch: Partial<PostProgress> = {}): PostProgress {
    const p: PostProgress = { uploadId: r.uploadId, slug: r.slug, version: r.version, step, sent: r.last.sent, total: r.last.total, ...patch }
    const changed = p.step !== r.last.step || p.retryInSec !== r.last.retryInSec || p.retryReason !== r.last.retryReason
    r.last = p
    const t = d.now()
    if (changed || t - r.lastSentAt >= PROGRESS_EVERY_MS) {
      r.lastSentAt = t
      d.send('posting:progress', p)
    }
    return p
  }

  /** Sends the file from `start` until YouTube has all of it, riding out dropped connections. */
  async function sendFrom(r: Running, entry: PendingEntry, start: number, fullChunk: number, asked: PostPrivacy): Promise<PostProgress> {
    const s = await session()
    if (!s) throw fail('SIGNED_OUT')
    const path = `/v1/uploads/${encodeURIComponent(entry.uploadId)}`
    let received = start
    let lastProgress = d.now()
    let tries = 0
    let lastTrouble: Trouble = 'OFFLINE'
    // Halved after a chunk runs out of time (a slow uplink), grown back once chunks go through again.
    let chunk = fullChunk
    let okInARow = 0
    emit(r, 'sending', { sent: received })

    const finish = async (video: unknown): Promise<PostProgress> => {
      await dropPending(entry.uploadId)
      d.log(`[posting] posted ${entry.uploadId} (${entry.size} bytes)`)
      return emit(r, 'done', { sent: entry.size, result: resultOf(video, asked) })
    }
    /** What the server's GET says, as the next step: a number = carry on from there. */
    const settle = async (b: any): Promise<number | PostProgress> => {
      if (b?.status === 'uploading') return typeof b.received === 'number' ? b.received : received
      if (b?.status === 'done') return finish(b.video)
      if (b?.status === 'cancelled') throw new Cancelled()
      throw b?.status === 'expired' ? fail('EXPIRED') : failedReason(b?.error)
    }

    for (;;) {
      if (r.cancelled) throw new Cancelled()
      if (received >= entry.size) {
        // Every byte went but the last answer got lost: the wait below asks the server how it ended.
        lastTrouble = 'OFFLINE'
      } else {
        const length = Math.min(chunk, entry.size - received)
        const bytes = await d.readChunk(entry.video, received, length)
        if (bytes.length !== length) throw fail('FILE_CHANGED')
        const a = await request('PUT', path, {
          auth: s.session,
          bytes,
          range: `bytes ${received}-${received + length - 1}/${entry.size}`,
          signal: r.controller.signal,
          timeoutMs: Math.max(CHUNK_TIMEOUT_MS, Math.ceil((length / SLOWEST_UPLINK) * 1000))
        })
        if (r.cancelled) throw new Cancelled()
        if (!a.net) {
          const b = a.body ?? {}
          if (a.status === 200 && b.status === 'done') return finish(b.video)
          if (a.status === 200 && b.status === 'uploading' && typeof b.received === 'number') {
            if (b.received > received) {
              lastProgress = d.now()
              tries = 0
              if (++okInARow >= GROW_AFTER && chunk < fullChunk) {
                chunk = Math.min(fullChunk, chunk * 2)
                okInARow = 0
              }
            }
            received = b.received // always the server's count: YouTube may have kept only part of the chunk
            emit(r, 'sending', { sent: received })
            continue
          }
          if (a.status === 409 && b.error === 'offset_mismatch' && typeof b.received === 'number') {
            received = b.received
            continue
          }
          if (a.status === 409 && b.error === 'upload_finished') {
            const g = await api('GET', path, { upload: true })
            const next = await settle(g)
            if (typeof next !== 'number') return next
            received = next
            continue
          }
          const trouble = troubleOf(a.status, a.body)
          if (!trouble) throw await problem(a.status, b, true)
          lastTrouble = trouble
        } else {
          lastTrouble = 'OFFLINE'
          if (a.timedOut && chunk > CHUNK_UNIT) {
            // Too slow to send this much in time: smaller chunks, so each one can get through.
            chunk = Math.max(CHUNK_UNIT, Math.floor(chunk / 2 / CHUNK_UNIT) * CHUNK_UNIT)
            d.log(`[posting] ${entry.uploadId}: a chunk ran out of time; now sending ${chunk} bytes at a time`)
          }
        }
        okInARow = 0
      }

      // A dropped connection, or YouTube or our server having a moment: wait, ask how much YouTube has, carry on.
      for (;;) {
        if (d.now() - lastProgress >= GIVE_UP_MS) throw new GaveUp(lastTrouble, received)
        const wait = RETRY_WAITS[Math.min(tries, RETRY_WAITS.length - 1)]
        tries++
        emit(r, 'retrying', { sent: received, retryInSec: wait, retryReason: RETRY_REASON[lastTrouble] })
        d.log(`[posting] ${entry.uploadId}: ${TROUBLE_LOG[lastTrouble]} at ${received} bytes; trying again in ${wait} s`)
        await d.sleep(wait * 1000, r.controller.signal).catch(() => undefined)
        if (r.cancelled) throw new Cancelled()
        const g = await request('GET', path, { auth: s.session, signal: r.controller.signal })
        if (r.cancelled) throw new Cancelled()
        if (g.net) {
          lastTrouble = 'OFFLINE'
          continue
        }
        const ok = g.status === 200 && typeof g.body?.status === 'string'
        const trouble = ok ? null : troubleOf(g.status, g.body)
        if (trouble) {
          lastTrouble = trouble
          continue
        }
        if (!ok) throw await problem(g.status, g.body, true)
        const next = await settle(g.body)
        if (typeof next !== 'number') return next
        if (next > received) {
          lastProgress = d.now()
          tries = 0
        }
        received = next
        emit(r, 'sending', { sent: received })
        break
      }
    }
  }

  /** Runs one post (new or resumed) to its end: done, failed or cancelled. Never throws. */
  function run(slug: string, version: number, total: number, body: (r: Running) => Promise<PostProgress>): Promise<PostProgress> {
    if (running) throw fail('BUSY')
    const r: Running = {
      uploadId: null,
      slug,
      version,
      controller: new AbortController(),
      cancelled: false,
      asked: 'private',
      last: { uploadId: null, slug, version, step: 'starting', sent: 0, total },
      lastSentAt: 0,
      done: null as never as Promise<PostProgress>
    }
    running = r
    d.send('posting:progress', r.last)
    r.done = (async () => {
      try {
        return await body(r)
      } catch (e) {
        if (e instanceof Cancelled || r.cancelled) {
          if (r.uploadId) {
            const s = await session()
            const a = s ? await request('DELETE', `/v1/uploads/${encodeURIComponent(r.uploadId)}`, { auth: s.session }) : null
            // Stop came after YouTube already had the whole video: it is posted, so say so.
            if (a && !a.net && a.status === 200 && a.body?.status === 'done') {
              const result = (() => {
                try {
                  return resultOf(a.body.video, r.asked)
                } catch {
                  return null
                }
              })()
              if (result) {
                await dropPending(r.uploadId)
                d.log(`[posting] ${r.uploadId}: stopped after YouTube had all of it; posted`)
                return emit(r, 'done', { sent: r.last.total, result })
              }
            }
            // Forgotten only once the server says it stopped the upload ({ ok: true }) or no longer has it. Without
            // that answer YouTube may already have the whole video (the answer to the last chunk can be lost too),
            // so the post is kept: Finish posting asks the server, and a new Post would upload it a second time.
            const stopped = a !== null && !a.net && ((a.status === 200 && a.body?.status !== 'done' && a.body?.ok === true) || a.status === 404)
            if (!stopped) {
              const kept = (await pendingList()).some((x) => x.uploadId === r.uploadId)
              d.log(`[posting] ${r.uploadId}: the server didn't confirm Stop; kept for Finish posting`)
              return emit(r, 'failed', { error: asUser(fail(kept ? 'STOP_UNCONFIRMED' : a === null ? 'SIGNED_OUT' : a.net ? 'OFFLINE' : 'SERVER')), canResume: kept })
            }
            await dropPending(r.uploadId)
          }
          d.log(`[posting] stopped ${r.uploadId ?? 'before it started'}`)
          return emit(r, 'cancelled')
        }
        if (e instanceof GaveUp) {
          if (r.uploadId) {
            const l = await pendingList()
            const entry = l.find((x) => x.uploadId === r.uploadId)
            if (entry) await keepPending({ ...entry, sent: e.received })
          }
          d.log(`[posting] ${r.uploadId}: no progress for 5 minutes; Finish posting can pick it up`)
          return emit(r, 'failed', { sent: e.received, error: asUser(fail(e.code)), canResume: true })
        }
        const u = e instanceof PostingError ? e : fail('SERVER')
        if (!(e instanceof PostingError)) d.log(`[posting] ${r.uploadId ?? 'post'}: ${String(e)}`)
        else d.log(`[posting] ${r.uploadId ?? 'post'} failed: ${u.code}`)
        // Kept: a dropped connection or a server error part way (Finish posting: YouTube keeps what it has), and a
        // lost sign-in (uploads outlive it: sign in, then finish).
        const keep = u.code === 'OFFLINE' || u.code === 'SERVER' || u.code === 'SIGNED_OUT' || u.code === 'FILE_CHANGED'
        if (r.uploadId && !keep) await dropPending(r.uploadId)
        const kept = !!r.uploadId && (await pendingList()).some((x) => x.uploadId === r.uploadId)
        return emit(r, 'failed', { error: asUser(u), canResume: (u.code === 'OFFLINE' || u.code === 'SERVER') && kept })
      } finally {
        running = null
      }
    })()
    return r.done
  }

  async function checkRequest(req: PostRequest): Promise<{ file: string; size: number; mtimeMs: number }> {
    const file = typeof req?.video === 'string' ? await d.isFinishedVideo(req.video).catch(() => null) : null
    const st = file ? await d.statFile(file).catch(() => null) : null
    if (!file || !st || st.size < 1 || st.size > MAX_VIDEO) throw fail('NOT_A_FINISHED_VIDEO')
    if (typeof req.title !== 'string' || titleProblem(req.title)) throw fail('BAD_FIELD', 'title')
    if (typeof req.description !== 'string' || descriptionProblem(req.description)) throw fail('BAD_FIELD', 'description')
    if (!PRIVACIES.includes(req.privacy)) throw fail('BAD_FIELD', 'privacy')
    return { file, size: st.size, mtimeMs: st.mtimeMs }
  }

  async function post(req: PostRequest): Promise<PostProgress> {
    off()
    if (running) throw fail('BUSY')
    const { file, size, mtimeMs } = await checkRequest(req)
    if (!(await session())) throw fail('SIGNED_OUT')
    const slug = String(req.slug)
    const version = Number(req.version) || 0
    return run(slug, version, size, async (r) => {
      r.asked = req.privacy
      const b = await api('POST', '/v1/uploads', {
        signal: r.controller.signal,
        json: {
          platform: 'youtube',
          size,
          mimeType: 'video/mp4',
          title: req.title.trim(),
          description: req.description,
          privacy: req.privacy,
          madeForKids: req.madeForKids === true
        }
      }).catch((e) => {
        throw r.cancelled ? new Cancelled() : e
      })
      if (typeof b.uploadId !== 'string') throw fail('SERVER')
      r.uploadId = b.uploadId
      const entry: PendingEntry = { uploadId: b.uploadId, server: d.baseUrl, slug, version, video: file, size, mtimeMs, startedAt: d.now(), privacy: req.privacy }
      await keepPending(entry)
      d.log(`[posting] started ${b.uploadId} (${size} bytes)`)
      return sendFrom(r, entry, typeof b.received === 'number' ? b.received : 0, chunkSizeOf(b.chunkSize), req.privacy)
    })
  }

  async function resume(uploadId: unknown): Promise<PostProgress> {
    off()
    if (running) throw fail('BUSY')
    const entry = (await pendingList()).find((e) => e.uploadId === uploadId && e.server === d.baseUrl)
    if (!entry) throw fail('EXPIRED')
    const st = await d.statFile(entry.video).catch(() => null)
    if (!st || st.size !== entry.size || st.mtimeMs !== entry.mtimeMs) throw fail('FILE_CHANGED')
    return run(entry.slug, entry.version, entry.size, async (r) => {
      r.uploadId = entry.uploadId
      r.last = { ...r.last, uploadId: entry.uploadId, sent: entry.sent ?? 0 }
      const g = await api('GET', `/v1/uploads/${encodeURIComponent(entry.uploadId)}`, { signal: r.controller.signal, upload: true })
      const asked = entry.privacy && PRIVACIES.includes(entry.privacy) ? entry.privacy : 'private'
      r.asked = asked
      if (g?.status === 'done') {
        await dropPending(entry.uploadId)
        return emit(r, 'done', { sent: entry.size, result: resultOf(g.video, asked) })
      }
      if (g?.status === 'cancelled') throw new Cancelled()
      if (g?.status !== 'uploading') throw g?.status === 'expired' ? fail('EXPIRED') : failedReason(g?.error)
      d.log(`[posting] finishing ${entry.uploadId} from ${g.received} bytes`)
      return sendFrom(r, entry, Number(g.received) || 0, DEFAULT_CHUNK, asked)
    })
  }

  return {
    status: () => status(),
    async signIn(): Promise<PostingStatus> {
      off()
      await signIn()
      return broadcast(true)
    },
    async signOut(): Promise<PostingStatus> {
      off()
      const s = await session()
      if (s) await request('DELETE', '/v1/sessions/current', { auth: s.session })
      await d.clearSession()
      me = null
      signedOutByServer = false
      d.log('[posting] signed out on this computer')
      return broadcast()
    },
    /** Every computer with this key. The sign-in here is kept if the server can't be reached, so it can be tried again. */
    async signOutEverywhere(): Promise<PostingStatus> {
      off()
      const s = await session()
      if (s) {
        const a = await request('DELETE', '/v1/sessions', { auth: s.session })
        if (a.net) throw fail('OFFLINE')
        if (a.status !== 200 && a.status !== 401) throw await problem(a.status, a.body)
        d.log(`[posting] signed out everywhere (${typeof a.body?.signedOut === 'number' ? a.body.signedOut : '?'} computers)`)
      }
      await d.clearSession()
      me = null
      signedOutByServer = false
      return broadcast()
    },
    connect,
    async reopenConnect(): Promise<void> {
      off()
      const c = connecting
      if (!c || !c.attemptId) return
      const a = await newAttempt(c.controller.signal) // the server cancels the old attempt
      if (connecting === c) {
        c.attemptId = a.attemptId
        c.expiresAt = a.expiresAt
      }
    },
    async cancelConnect(): Promise<void> {
      off()
      connecting?.controller.abort()
    },
    async disconnect(platform: unknown): Promise<PostingStatus> {
      off()
      if (platform !== 'youtube') throw fail('SERVER')
      const b = await api('DELETE', '/v1/connections/youtube')
      d.log(`[posting] disconnected YouTube (access removed at Google: ${b?.revoked === true ? 'yes' : 'no'})`)
      me = null
      return broadcast(true)
    },
    post,
    async cancel(): Promise<void> {
      off()
      const r = running
      if (!r) return
      r.cancelled = true
      r.controller.abort()
      await r.done
    },
    async current(): Promise<PostProgress | null> {
      return d.enabled && running ? running.last : null
    },
    async pending(slug: unknown, version: unknown): Promise<PendingPost | null> {
      off()
      const entry = (await pendingList()).find((e) => e.server === d.baseUrl && e.slug === slug && e.version === version)
      if (!entry || running?.uploadId === entry.uploadId) return null
      const st = await d.statFile(entry.video).catch(() => null)
      if (!st || st.size !== entry.size || st.mtimeMs !== entry.mtimeMs) {
        await dropPending(entry.uploadId)
        return null
      }
      const s = await session()
      if (!s) return null // signed out: the post waits for Sign in
      const a = await request('GET', `/v1/uploads/${encodeURIComponent(entry.uploadId)}`, { auth: s.session })
      const shown = (sent: number): PendingPost => ({ uploadId: entry.uploadId, slug: entry.slug, version: entry.version, sent, total: entry.size })
      // can't ask now (offline, or the server busy or failing for a moment): Finish posting will
      if (a.net || a.status === 429 || a.status >= 500) return shown(entry.sent ?? 0)
      if (a.status === 200 && a.body?.status === 'uploading') return shown(Number(a.body.received) || 0)
      // YouTube has all of it, but the answer to the last chunk was lost: Finish posting reports the video. Forgetting
      // it here would offer Post again, which uploads the same video a second time.
      if (a.status === 200 && a.body?.status === 'done') return shown(entry.size)
      if (a.status === 401) {
        await lostSession()
        return null
      }
      await dropPending(entry.uploadId)
      return null
    },
    resume,
    async discard(uploadId: unknown): Promise<void> {
      off()
      if (typeof uploadId !== 'string') return
      const s = await session()
      if (s) await request('DELETE', `/v1/uploads/${encodeURIComponent(uploadId)}`, { auth: s.session })
      await dropPending(uploadId)
    },
    async openLink(url: unknown): Promise<void> {
      off()
      if (isVideoLink(url)) await d.openExternal(new URL(String(url)).toString())
    }
  }
}

/** Why a chunk didn't go through and is being tried again. */
type Trouble = 'OFFLINE' | 'PLATFORM' | 'SERVER'
const RETRY_REASON: Record<Trouble, NonNullable<PostProgress['retryReason']>> = { OFFLINE: 'offline', PLATFORM: 'youtube', SERVER: 'server' }
const TROUBLE_LOG: Record<Trouble, string> = { OFFLINE: 'connection dropped', PLATFORM: 'YouTube busy', SERVER: 'posting server error' }

class Cancelled extends Error {}
class GaveUp extends Error {
  constructor(
    readonly code: Trouble,
    readonly received: number
  ) {
    super(code)
  }
}

export type PostingService = ReturnType<typeof createPostingService>
