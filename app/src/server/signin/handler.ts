// Reel Studio's sign-in service (docs/signin.md). A desktop app can't keep a platform's app secret, so this small
// service holds the secrets and does the parts of OAuth that need them: trading a sign-in code for a token, and a
// few calls TikTok and Instagram only accept with the secret. The app keeps the tokens and talks to each platform
// itself. Nothing is stored here: the state and handoff are sealed (seal.ts).
//
// Instagram and Facebook (Meta wants a registered https address to send people back to):
//   1. POST /v1/<p>/start      the app's state, loopback address and PKCE challenge -> the platform's sign-in link,
//                              whose state is all of that, sealed.
//   2. GET  /v1/<p>/callback   the platform sends the person here; this sends them on to the app's loopback with
//                              the app's state and a sealed handoff (the code, bound to the challenge). No token
//                              and no readable code ever reach the loopback address.
//   3. POST /v1/<p>/complete   handoff + verifier -> the token, only for the holder of the verifier.
// TikTok signs a desktop app in on a loopback address directly, with its own PKCE, so it only needs
//   POST /v1/tiktok/token (code or refresh token -> token) and POST /v1/tiktok/revoke.
// Instagram fetches a video from a link, so POST /v1/instagram/uploads hands out a short-lived storage link for one
// video, after checking the Instagram token belongs to a professional account (presign.ts).
//
// Every answer is JSON with Cache-Control: no-store, except the callback's redirect and its error page.
// Errors are { error: { code } } with no upstream detail. This file never logs.
import type { MetaApp, SigninConfig } from './config.ts'
import { presign } from './presign.ts'
import { b64url, s256, sameText, seal, sealKey, unseal } from './seal.ts'

export const META_VERSION = 'v26.0'
export const INSTAGRAM_SCOPES = ['instagram_business_basic', 'instagram_business_content_publish', 'instagram_business_manage_insights']
export const FACEBOOK_SCOPES = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'read_insights']
const TIKTOK = 'https://open.tiktokapis.com/v2'
const STATE_MS = 10 * 60_000
const HANDOFF_MS = 5 * 60_000
const UPLOAD_PUT_SEC = 10 * 60
/** Instagram may fetch a video a while after the container is made; it gives up on a container after a day. */
const UPLOAD_GET_SEC = 6 * 3600
const MAX_BODY = 16_384
const MAX_VIDEO = 300_000_000
const MAX_COVER = 8_000_000

type Platform = 'instagram' | 'facebook'

class Refused extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string) {
    super(code)
    this.status = status
    this.code = code
  }
}

const NO_STORE = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' }
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { ...NO_STORE, 'content-type': 'application/json' } })
const page = (status: number, text: string): Response =>
  new Response(text, { status, headers: { ...NO_STORE, 'content-type': 'text/plain; charset=utf-8', 'content-security-policy': "default-src 'none'" } })

async function body(req: Request): Promise<Record<string, unknown>> {
  if (!req.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new Refused(415, 'json_only')
  const raw = await req.text()
  if (raw.length > MAX_BODY) throw new Refused(413, 'too_large')
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    throw new Refused(400, 'bad_json')
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Refused(400, 'bad_json')
  return v as Record<string, unknown>
}

const str = (v: unknown, code: string, max = 4096): string => {
  if (typeof v !== 'string' || !v || v.length > max || /[\u0000-\u001f\u007f]/.test(v)) throw new Refused(400, code)
  return v
}

/** The app's loopback listener: exactly http://127.0.0.1:<port>/<platform>/callback. */
export function loopback(v: unknown, platform: string): string {
  let u: URL
  try {
    u = new URL(str(v, 'bad_loopback', 200))
  } catch {
    throw new Refused(400, 'bad_loopback')
  }
  const port = Number(u.port)
  if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || !Number.isInteger(port) || port < 1024 || port > 65535 ||
      u.pathname !== `/${platform}/callback` || u.search || u.hash || u.username || u.password)
    throw new Refused(400, 'bad_loopback')
  return u.toString()
}

const PKCE = /^[A-Za-z0-9_-]{43}$/
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/
const STATE = /^[A-Za-z0-9_-]{32,128}$/

/** One call to a platform: JSON back, no redirects, 20 s at most. A refusal becomes `code`, a fault 502. */
async function upstream(c: SigninConfig, url: string, init: RequestInit, code: string): Promise<Record<string, unknown>> {
  let res: Response
  try {
    res = await c.fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(20_000) })
  } catch {
    throw new Refused(502, 'upstream_unreachable')
  }
  let data: unknown = null
  try {
    data = await res.json()
  } catch {
    /* handled below */
  }
  if (res.status >= 500 || res.status === 429) throw new Refused(502, res.status === 429 ? 'upstream_limit' : 'upstream_failed')
  if (!res.ok || !data || typeof data !== 'object' || 'error' in data || 'error_type' in data) throw new Refused(res.status === 401 ? 401 : 400, code)
  return data as Record<string, unknown>
}

const form = (fields: Record<string, string>): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields)
})

const positive = (v: unknown): number => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new Refused(502, 'upstream_failed')
  return v
}
const token = (v: unknown): string => {
  if (typeof v !== 'string' || !v || v.length > 4096) throw new Refused(502, 'upstream_failed')
  return v
}

/** Meta's answer to a code: the long-lived token, its lifetime and the permissions granted. */
interface Granted {
  access_token: string
  token_type: 'bearer'
  expires_in: number
  permissions: string[]
}

async function instagramExchange(c: SigninConfig, app: MetaApp, code: string, redirect: string): Promise<Granted> {
  const short = await upstream(c, 'https://api.instagram.com/oauth/access_token', form({
    client_id: app.appId, client_secret: app.appSecret, grant_type: 'authorization_code', redirect_uri: redirect, code
  }), 'code_rejected')
  // Meta answers either { access_token, user_id, permissions } or { data: [ that ] }
  const first = Array.isArray(short.data) ? (short.data[0] as Record<string, unknown> | undefined) ?? {} : short
  const raw = first.permissions
  const permissions = typeof raw === 'string' ? raw.split(',').filter(Boolean) : Array.isArray(raw) ? raw.filter((p): p is string => typeof p === 'string') : []
  const q = new URLSearchParams({ grant_type: 'ig_exchange_token', client_secret: app.appSecret, access_token: token(first.access_token) })
  const long = await upstream(c, `https://graph.instagram.com/access_token?${q}`, { method: 'GET' }, 'code_rejected')
  return { access_token: token(long.access_token), token_type: 'bearer', expires_in: positive(long.expires_in), permissions }
}

async function facebookExchange(c: SigninConfig, app: MetaApp, code: string, redirect: string): Promise<Granted> {
  const graph = `https://graph.facebook.com/${META_VERSION}`
  const q1 = new URLSearchParams({ client_id: app.appId, client_secret: app.appSecret, redirect_uri: redirect, code })
  const short = await upstream(c, `${graph}/oauth/access_token?${q1}`, { method: 'GET' }, 'code_rejected')
  // A long-lived user token (about 60 days); the Page tokens the app reads with it don't expire.
  const q2 = new URLSearchParams({ grant_type: 'fb_exchange_token', client_id: app.appId, client_secret: app.appSecret, fb_exchange_token: token(short.access_token) })
  const long = await upstream(c, `${graph}/oauth/access_token?${q2}`, { method: 'GET' }, 'code_rejected')
  const access = token(long.access_token)
  const perms = await upstream(c, `${graph}/me/permissions`, { method: 'GET', headers: { authorization: `Bearer ${access}` } }, 'code_rejected')
  const permissions = Array.isArray(perms.data)
    ? perms.data.flatMap((p) => (p && typeof p === 'object' && (p as Record<string, unknown>).status === 'granted' && typeof (p as Record<string, unknown>).permission === 'string' ? [(p as Record<string, string>).permission] : []))
    : []
  // Meta leaves expires_in out for a token that doesn't expire on a clock
  const expires = typeof long.expires_in === 'number' && long.expires_in > 0 ? long.expires_in : 60 * 86_400
  return { access_token: access, token_type: 'bearer', expires_in: expires, permissions }
}

function authorizeUrl(c: SigninConfig, p: Platform, app: MetaApp, state: string): string {
  const redirect = `${c.publicUrl}/v1/${p}/callback`
  if (p === 'instagram') {
    const u = new URL('https://www.instagram.com/oauth/authorize')
    u.search = new URLSearchParams({ client_id: app.appId, redirect_uri: redirect, response_type: 'code', scope: INSTAGRAM_SCOPES.join(','), state, enable_fb_login: 'false' }).toString()
    return u.toString()
  }
  const u = new URL(`https://www.facebook.com/${META_VERSION}/dialog/oauth`)
  u.search = new URLSearchParams({ client_id: app.appId, redirect_uri: redirect, response_type: 'code', scope: FACEBOOK_SCOPES.join(','), state }).toString()
  return u.toString()
}

export function createSigninHandler(c: SigninConfig): (req: Request) => Promise<Response> {
  const keyP = sealKey(c.secret)
  const meta = (p: Platform): MetaApp => {
    const app = c[p]
    if (!app) throw new Refused(404, 'platform_off')
    return app
  }

  const start = async (p: Platform, req: Request) => {
    const app = meta(p)
    const b = await body(req)
    const state = str(b.state, 'bad_state', 128)
    const challenge = str(b.code_challenge, 'bad_challenge', 43)
    if (!STATE.test(state)) throw new Refused(400, 'bad_state')
    if (b.code_challenge_method !== 'S256' || !PKCE.test(challenge)) throw new Refused(400, 'bad_challenge')
    const back = loopback(b.loopback_uri, p)
    const sealed = await seal(await keyP, 'state', { p, back, state, challenge }, c.now() + STATE_MS)
    return json(200, { authorize_url: authorizeUrl(c, p, app, sealed) })
  }

  const callback = async (p: Platform, url: URL) => {
    meta(p)
    const raw = url.searchParams.getAll('state')
    const s = raw.length === 1 ? await unseal(await keyP, 'state', raw[0], c.now()) : null
    if (!s || s.p !== p || typeof s.back !== 'string' || typeof s.state !== 'string' || typeof s.challenge !== 'string')
      return page(400, 'This sign-in link has run out or isn’t valid. Go back to Reel Studio and click Connect again.')
    const to = new URL(s.back)
    to.searchParams.set('state', s.state)
    const codes = url.searchParams.getAll('code')
    if (url.searchParams.has('error') || codes.length !== 1 || !codes[0] || codes[0].length > 2048) {
      to.searchParams.set('error', url.searchParams.get('error') === 'access_denied' ? 'access_denied' : 'failed')
    } else {
      // Meta adds "#_" after the code on some redirects; it is not part of the code
      const code = codes[0].replace(/#_$/, '')
      to.searchParams.set('handoff', await seal(await keyP, 'handoff', { p, code, challenge: s.challenge }, c.now() + HANDOFF_MS))
    }
    return new Response(null, { status: 302, headers: { ...NO_STORE, location: to.toString() } })
  }

  const complete = async (p: Platform, req: Request) => {
    const app = meta(p)
    const b = await body(req)
    const verifier = str(b.code_verifier, 'bad_verifier', 128)
    if (!VERIFIER.test(verifier)) throw new Refused(400, 'bad_verifier')
    const h = await unseal(await keyP, 'handoff', str(b.handoff, 'bad_handoff'), c.now())
    if (!h || h.p !== p || typeof h.code !== 'string' || typeof h.challenge !== 'string') throw new Refused(401, 'handoff_expired')
    if (!sameText(await s256(verifier), h.challenge)) throw new Refused(401, 'wrong_verifier')
    const redirect = `${c.publicUrl}/v1/${p}/callback`
    return json(200, p === 'instagram' ? await instagramExchange(c, app, h.code, redirect) : await facebookExchange(c, app, h.code, redirect))
  }

  const uploads = async (req: Request) => {
    meta('instagram')
    const media = c.media
    if (!media) throw new Refused(404, 'platform_off')
    const auth = req.headers.get('authorization') ?? ''
    const bearer = /^Bearer ([^\s]{1,4096})$/.exec(auth)?.[1]
    if (!bearer) throw new Refused(401, 'no_token')
    const b = await body(req)
    const size = (v: unknown, max: number) => {
      if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1 || v > max) throw new Refused(400, 'bad_size')
      return v
    }
    const videoSize = size(b.video_size, MAX_VIDEO)
    const coverSize = b.cover_size === null || b.cover_size === undefined ? null : size(b.cover_size, MAX_COVER)
    // Only a connected professional account gets storage: anyone else is refused before a link is made.
    const me = await upstream(c, `https://graph.instagram.com/${META_VERSION}/me?fields=user_id,account_type`, { method: 'GET', headers: { authorization: `Bearer ${bearer}` } }, 'token_rejected')
    if (typeof me.user_id !== 'string' && typeof me.user_id !== 'number') throw new Refused(502, 'upstream_failed')
    if (typeof me.account_type !== 'string' || !['BUSINESS', 'MEDIA_CREATOR'].includes(me.account_type.toUpperCase())) throw new Refused(403, 'not_professional')
    const owner = String(me.user_id).replace(/[^0-9]/g, '').slice(0, 32) || 'x'
    const one = async (ext: 'mp4' | 'jpg', type: string, length: number) => {
      const id = b64url(crypto.getRandomValues(new Uint8Array(18)))
      const url = `${media.bucketUrl}/instagram/${owner}/${id}.${ext}`
      const now = new Date(c.now())
      const keys = { accessKeyId: media.accessKeyId, secretAccessKey: media.secretAccessKey, region: media.region, now }
      return {
        upload_url: await presign({ ...keys, method: 'PUT', url, expiresSec: UPLOAD_PUT_SEC, headers: { 'content-type': type, 'content-length': String(length) } }),
        public_url: await presign({ ...keys, method: 'GET', url, expiresSec: UPLOAD_GET_SEC })
      }
    }
    return json(200, { video: await one('mp4', 'video/mp4', videoSize), ...(coverSize ? { cover: await one('jpg', 'image/jpeg', coverSize) } : {}) })
  }

  /** TikTok's own error shape, which the app already reads (main/tiktok-http.ts). */
  const tiktokFail = (code: string, status = 400) => json(status, { error: { code, userMessage: 'The TikTok sign-in request was not accepted.' } })

  const tiktokToken = async (req: Request) => {
    const tt = c.tiktok
    if (!tt) return tiktokFail('TT_SETUP', 404)
    const b = await body(req)
    if (b.client_key !== tt.clientKey) return tiktokFail('TT_SETUP')
    const fields: Record<string, string> = { client_key: tt.clientKey, client_secret: tt.clientSecret }
    if (b.grant_type === 'authorization_code') {
      // TikTok's desktop flow: the app's own loopback address, any port (docs/tiktok.md)
      try {
        loopback(b.redirect_uri, 'tiktok')
      } catch {
        return tiktokFail('TT_INPUT')
      }
      if (typeof b.code_verifier !== 'string' || !VERIFIER.test(b.code_verifier)) return tiktokFail('TT_INPUT')
      Object.assign(fields, { grant_type: 'authorization_code', code: str(b.code, 'TT_INPUT', 2048), redirect_uri: String(b.redirect_uri), code_verifier: b.code_verifier })
    } else if (b.grant_type === 'refresh_token') {
      Object.assign(fields, { grant_type: 'refresh_token', refresh_token: str(b.refresh_token, 'TT_INPUT') })
    } else return tiktokFail('TT_INPUT')
    let res: Response
    try {
      res = await c.fetch(`${TIKTOK}/oauth/token/`, { ...form(fields), redirect: 'error', signal: AbortSignal.timeout(20_000) })
    } catch {
      return tiktokFail('TT_NETWORK', 502)
    }
    // TikTok's own answer goes back as it is: its error codes are what the app turns into words
    const data = await res.json().catch(() => null)
    if (!data || typeof data !== 'object') return tiktokFail('TT_API', 502)
    return json(res.ok ? 200 : res.status >= 500 ? 502 : 400, data)
  }

  const tiktokRevoke = async (req: Request) => {
    const tt = c.tiktok
    if (!tt) return tiktokFail('TT_SETUP', 404)
    const b = await body(req)
    if (b.client_key !== tt.clientKey) return tiktokFail('TT_SETUP')
    const fields = { client_key: tt.clientKey, client_secret: tt.clientSecret, token: str(b.token, 'TT_INPUT') }
    try {
      const res = await c.fetch(`${TIKTOK}/oauth/revoke/`, { ...form(fields), redirect: 'error', signal: AbortSignal.timeout(20_000) })
      await res.body?.cancel()
      return json(res.ok ? 200 : 502, {})
    } catch {
      return tiktokFail('TT_NETWORK', 502)
    }
  }

  const platforms = () =>
    json(200, {
      v: 1,
      platforms: {
        ...(c.instagram && c.media ? { instagram: { clientId: c.instagram.appId, review: c.instagram.review, mediaOrigins: [new URL(c.media.bucketUrl).origin] } } : {}),
        ...(c.facebook ? { facebook: { clientId: c.facebook.appId, review: c.facebook.review } } : {}),
        ...(c.tiktok ? { tiktok: { clientKey: c.tiktok.clientKey, audited: c.tiktok.audited, directPost: c.tiktok.directPost } } : {})
      }
    })

  return async (req: Request) => {
    let url: URL
    try {
      url = new URL(req.url)
    } catch {
      return json(400, { error: { code: 'bad_url' } })
    }
    const route = `${req.method} ${url.pathname}`
    try {
      if (route === 'GET /v1/platforms') return platforms()
      const m = /^\/v1\/(instagram|facebook)\/(start|callback|complete)$/.exec(url.pathname)
      if (m) {
        const p = m[1] as Platform
        if (m[2] === 'start' && req.method === 'POST') return await start(p, req)
        if (m[2] === 'callback' && req.method === 'GET') return await callback(p, url)
        if (m[2] === 'complete' && req.method === 'POST') return await complete(p, req)
      }
      if (route === 'POST /v1/instagram/uploads') return await uploads(req)
      if (route === 'POST /v1/tiktok/token') return await tiktokToken(req)
      if (route === 'POST /v1/tiktok/revoke') return await tiktokRevoke(req)
      return json(404, { error: { code: 'not_found' } })
    } catch (e) {
      if (e instanceof Refused) return json(e.status, { error: { code: e.code } })
      return json(500, { error: { code: 'internal' } })
    }
  }
}
