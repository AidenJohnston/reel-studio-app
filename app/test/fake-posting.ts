// An in-memory posting server, as a `fetch`: the JSON of the contract's HTTP API (sessions, /v1/me, connect
// attempts, uploads in chunks) with switches for every error the app must turn into plain words. It stands in for
// both our server and YouTube; the real server and its fake Google live in the site repo.

const UNIT = 256 * 1024

export interface FakeUpload {
  id: string
  sid: string
  size: number
  received: number
  status: 'uploading' | 'done' | 'failed' | 'cancelled' | 'expired'
  privacy: string
  title: string
  bytes: Uint8Array
  error?: string
}

/** One queued failure, used up in order. `on` names the route. */
export interface Fault {
  on: 'session' | 'me' | 'attempt' | 'poll' | 'init' | 'chunk' | 'status' | 'disconnect' | 'signout'
  /** Throw like a dropped connection, instead of answering. */
  network?: boolean
  /** 'chunk' + network: keep this many bytes of the chunk first (rounded down to 256 KiB). */
  keepBytes?: number
  status?: number
  body?: Record<string, unknown>
  times?: number
}

export function createFakePosting(opts: { origin?: string; chunkSize?: number } = {}) {
  const origin = opts.origin ?? 'https://post.test'
  let n = 0
  const id = (p: string): string => `${p}_${(++n).toString(16).padStart(32, '0')}`
  const state = {
    /** Purchase keys the server signed: key → purchase. */
    keys: new Map<string, { sid: string; plan: 'monthly' | 'once'; ended?: string }>(),
    sessions: new Map<string, { id: string; sid: string; device: string; createdAt: number }>(),
    connections: new Map<string, { status: 'connected' | 'reconnect'; channelName: string | null; channelUrl: string | null }>(),
    attempts: new Map<string, { sid: string; status: string; expiresAt: number; begin: string }>(),
    uploads: new Map<string, FakeUpload>(),
    faults: [] as Fault[],
    /** 'POST /v1/sessions auth=key', 'PUT /v1/uploads/u_1 bytes 0-262143/600000 auth=session', … */
    calls: [] as string[],
    /** Every Authorization header seen, to prove what was sent where. */
    auth: [] as { path: string; value: string }[],
    /** Keep only this many bytes of each chunk (rounded down to 256 KiB): YouTube can take part of one. */
    shortChunks: 0,
    /** A chunk that starts here is answered offset_mismatch with this received, once. */
    mismatch: null as null | { at: number; received: number },
    /** The privacy YouTube "sets", whatever was asked. */
    forcePrivacy: null as string | null,
    channelName: 'My channel' as string | null,
    openUrlOrigin: null as string | null,
    now: () => 1_762_140_000_000
  }

  const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } })
  const err = (status: number, error: string, extra: Record<string, unknown> = {}): Response =>
    json(status, { error, ...extra }, status === 429 ? { 'Retry-After': '60' } : {})

  function fault(on: Fault['on']): Fault | null {
    const i = state.faults.findIndex((f) => f.on === on)
    if (i < 0) return null
    const f = state.faults[i]
    if (!f.times || f.times <= 1) state.faults.splice(i, 1)
    else f.times--
    return f
  }

  const bearer = (req: Request): string | null => /^Bearer (.+)$/.exec(req.headers.get('authorization') ?? '')?.[1] ?? null

  function connectionOf(sid: string) {
    const c = state.connections.get(sid)
    return c ? { platform: 'youtube', id: `c_${sid}`, status: c.status, channelId: c.channelName ? 'UC123' : null, channelName: c.channelName, channelUrl: c.channelUrl, connectedAt: state.now() } : null
  }

  function uploadAnswer(u: FakeUpload): Response {
    if (u.status === 'done')
      return json(200, {
        uploadId: u.id,
        status: 'done',
        size: u.size,
        received: u.size,
        video: { id: 'dQw4w9WgXcQ', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', studioUrl: 'https://studio.youtube.com/video/dQw4w9WgXcQ/edit', privacy: state.forcePrivacy ?? u.privacy, channelName: state.channelName }
      })
    if (u.status === 'uploading') return json(200, { uploadId: u.id, status: 'uploading', size: u.size, received: u.received })
    return json(200, { uploadId: u.id, status: u.status, ...(u.error ? { error: u.error } : {}) })
  }

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url)
    if (url.origin !== origin) throw new TypeError(`fake posting server: unexpected ${req.url}`)
    const path = url.pathname
    const method = req.method
    const token = bearer(req)
    if (token) state.auth.push({ path, value: token })
    const who = token ? (state.keys.has(token) ? 'key' : state.sessions.has(token) ? 'session' : 'unknown') : 'none'
    const range = req.headers.get('content-range')
    state.calls.push(`${method} ${path}${range ? ` ${range}` : ''} auth=${who}`)

    if (method === 'POST' && path === '/v1/sessions') {
      const f = fault('session')
      if (f?.network) throw new TypeError('network')
      if (f) return json(f.status ?? 500, f.body ?? { error: 'server_error' })
      if (!token) return err(401, 'no_key')
      const p = state.keys.get(token)
      if (!p) return err(401, 'bad_key')
      if (p.ended) return err(403, 'not_entitled', { reason: p.ended })
      const body = (await req.json()) as { device?: unknown }
      if (!['Windows', 'Mac', 'Linux'].includes(String(body.device))) return err(400, 'bad_request', { field: 'device' })
      const session = `ps1_${'x'.repeat(10)}${++n}`
      const sessionId = id('s')
      state.sessions.set(session, { id: sessionId, sid: p.sid, device: String(body.device), createdAt: state.now() })
      return json(201, { session, sessionId, plan: p.plan, device: body.device })
    }

    // Everything else needs a session.
    if (!token) return err(401, 'no_session')
    const s = state.sessions.get(token)
    if (!s) return err(401, 'bad_session')
    const purchase = [...state.keys.values()].find((p) => p.sid === s.sid)
    if (!purchase) return err(403, 'not_entitled', { reason: 'unknown purchase' })
    if (purchase.ended) return err(403, 'not_entitled', { reason: purchase.ended })

    if (method === 'GET' && path === '/v1/me') {
      const f = fault('me')
      if (f?.network) throw new TypeError('network')
      if (f) return json(f.status ?? 500, f.body ?? { error: 'server_error' })
      const others = [...state.sessions.values()].filter((x) => x.sid === s.sid && x.id !== s.id).length
      const c = connectionOf(s.sid)
      return json(200, { plan: purchase.plan, session: { id: s.id, device: s.device, createdAt: s.createdAt }, otherSessions: others, connections: c ? [c] : [] })
    }
    if (method === 'DELETE' && path === '/v1/sessions/current') {
      const f = fault('signout')
      if (f?.network) throw new TypeError('network')
      state.sessions.delete(token)
      return json(200, { ok: true })
    }
    if (method === 'DELETE' && path === '/v1/sessions') {
      const f = fault('signout')
      if (f?.network) throw new TypeError('network')
      if (f) return json(f.status ?? 500, f.body ?? { error: 'server_error' })
      let signedOut = 0
      for (const [k, x] of state.sessions) if (x.sid === s.sid) (state.sessions.delete(k), signedOut++)
      return json(200, { ok: true, signedOut })
    }

    if (method === 'POST' && path === '/v1/connections/youtube/attempts') {
      const f = fault('attempt')
      if (f?.network) throw new TypeError('network')
      if (f) return json(f.status ?? 500, f.body ?? { error: 'server_error' })
      for (const a of state.attempts.values()) if (a.sid === s.sid && (a.status === 'waiting' || a.status === 'opened')) a.status = 'cancelled'
      const attemptId = id('a')
      const begin = `begin${n}secret`
      state.attempts.set(attemptId, { sid: s.sid, status: 'waiting', expiresAt: state.now() + 600_000, begin })
      return json(201, { attemptId, openUrl: `${state.openUrlOrigin ?? origin}/oauth/youtube/begin?a=${attemptId}&t=${begin}`, expiresAt: state.now() + 600_000, pollMs: 2000 })
    }
    const attempt = /^\/v1\/connections\/youtube\/attempts\/([^/]+)$/.exec(path)
    if (attempt) {
      const a = state.attempts.get(attempt[1])
      if (!a || a.sid !== s.sid) return err(404, 'not_found')
      if (method === 'DELETE') {
        a.status = 'cancelled'
        return json(200, { ok: true })
      }
      const f = fault('poll')
      if (f?.network) throw new TypeError('network')
      if (f) return json(f.status ?? 500, f.body ?? { error: 'server_error' })
      const status = (a.status === 'waiting' || a.status === 'opened') && state.now() > a.expiresAt ? 'expired' : a.status
      const c = connectionOf(s.sid)
      return json(200, { status, ...(status === 'connected' && c ? { connection: c } : {}) })
    }
    if (method === 'DELETE' && path === '/v1/connections/youtube') {
      const f = fault('disconnect')
      if (f?.network) throw new TypeError('network')
      const had = state.connections.delete(s.sid)
      for (const [k, u] of state.uploads) if (u.sid === s.sid) state.uploads.delete(k)
      return json(200, { ok: true, revoked: had })
    }

    if (method === 'POST' && path === '/v1/uploads') {
      const f = fault('init')
      if (f?.network) throw new TypeError('network')
      if (f) return json(f.status ?? 500, f.body ?? { error: 'server_error' })
      const b = (await req.json()) as { size: number; title: string; privacy: string; description: string; madeForKids: unknown; mimeType: string; platform: string }
      if (b.platform !== 'youtube' || b.mimeType !== 'video/mp4') return err(400, 'bad_request')
      if (!b.title?.trim() || b.title.trim().length > 100 || /[<>]/.test(b.title)) return err(400, 'bad_request', { field: 'title' })
      if (typeof b.madeForKids !== 'boolean') return err(400, 'bad_request', { field: 'madeForKids' })
      const c = state.connections.get(s.sid)
      if (!c) return err(409, 'not_connected')
      if (c.status === 'reconnect') return err(409, 'reconnect_needed')
      const u: FakeUpload = { id: id('u'), sid: s.sid, size: b.size, received: 0, status: 'uploading', privacy: b.privacy, title: b.title, bytes: new Uint8Array(b.size) }
      state.uploads.set(u.id, u)
      return json(201, { uploadId: u.id, status: 'uploading', size: u.size, received: 0, chunkSize: opts.chunkSize ?? 8 * 1024 * 1024 })
    }
    const up = /^\/v1\/uploads\/([^/]+)$/.exec(path)
    if (up) {
      const u = state.uploads.get(up[1])
      if (!u || u.sid !== s.sid) return err(404, 'not_found')
      if (method === 'DELETE') {
        // Like the server: YouTube already has the whole video, so it is done, not cancelled.
        if (u.status === 'done') return json(200, { ok: true, ...((await uploadAnswer(u).json()) as object) })
        u.status = 'cancelled'
        return json(200, { ok: true })
      }
      if (method === 'GET') {
        const f = fault('status')
        if (f?.network) throw new TypeError('network')
        if (f) return json(f.status ?? 500, f.body ?? { error: 'server_error' })
        return uploadAnswer(u)
      }
      if (method === 'PUT') {
        const body = new Uint8Array(await req.arrayBuffer())
        if (u.status !== 'uploading') return err(409, 'upload_finished', { status: u.status })
        const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range ?? '')
        if (!m || Number(m[3]) !== u.size) return err(400, 'bad_request', { field: 'content_range' })
        const first = Number(m[1])
        const last = Number(m[2])
        if (state.mismatch && state.mismatch.at === first) {
          const r = state.mismatch.received
          state.mismatch = null
          return err(409, 'offset_mismatch', { received: r })
        }
        if (first !== u.received) return err(409, 'offset_mismatch', { received: u.received })
        const length = last - first + 1
        if (length !== body.length) return err(400, 'bad_request', { field: 'content_range' })
        if (length > 16 * 1024 * 1024) return err(413, 'chunk_too_large', { max: 16 * 1024 * 1024 })
        if (length % UNIT !== 0 && last !== u.size - 1) return err(400, 'bad_request', { field: 'content_range' })
        const f = fault('chunk')
        if (f?.network) {
          const keep = Math.floor(Math.min(f.keepBytes ?? 0, length) / UNIT) * UNIT
          u.bytes.set(body.subarray(0, keep), first)
          u.received += keep
          throw new TypeError('network')
        }
        if (f) {
          if (f.status === 410) u.status = 'expired'
          if (f.status === 429 && f.body?.error === 'upload_limit') (u.status = 'failed'), (u.error = 'uploadLimitExceeded')
          return json(f.status ?? 500, f.body ?? { error: 'server_error' })
        }
        let keep = length
        if (state.shortChunks && last !== u.size - 1) keep = Math.max(UNIT, Math.floor(Math.min(state.shortChunks, length) / UNIT) * UNIT)
        u.bytes.set(body.subarray(0, keep), first)
        u.received = first + keep
        if (u.received >= u.size) u.status = 'done'
        return uploadAnswer(u)
      }
    }
    return err(404, 'not_found')
  }

  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError')
    return handle(new Request(input, init))
  }) as typeof fetch

  return { origin, state, fetch: fetchFn, handle }
}

export type FakePosting = ReturnType<typeof createFakePosting>
