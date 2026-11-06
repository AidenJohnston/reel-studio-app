// The sign-in service (src/server/signin, docs/signin.md) through its HTTP interface. Every platform answer is
// fabricated; no Meta, TikTok or storage host is contacted.
import { describe, expect, it } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { configFromEnv, type SigninConfig } from '../src/server/signin/config'
import { createSigninHandler, FACEBOOK_SCOPES, INSTAGRAM_SCOPES, THREADS_SCOPES } from '../src/server/signin/handler'
import { presign } from '../src/server/signin/presign'

const ORIGIN = 'https://signin.example'
const NOW = Date.UTC(2026, 10, 6, 12)
const SECRET = randomBytes(32).toString('base64url')
const LOOP = 'http://127.0.0.1:53123/instagram/callback'
const s256 = (v: string) => createHash('sha256').update(v).digest('base64url')

interface Call { url: string; init: RequestInit }
type Answer = (url: URL, init: RequestInit) => Response | undefined

function world(answer: Answer = () => undefined, env: Record<string, string> = {}) {
  const calls: Call[] = []
  let now = NOW
  const config: SigninConfig = configFromEnv({
    SIGNIN_PUBLIC_URL: ORIGIN, SIGNIN_SECRET: SECRET,
    INSTAGRAM_APP_ID: '1111', INSTAGRAM_APP_SECRET: 'ig-app-secret',
    FACEBOOK_APP_ID: '2222', FACEBOOK_APP_SECRET: 'fb-app-secret', FACEBOOK_REVIEW: 'approved',
    THREADS_APP_ID: '3333', THREADS_APP_SECRET: 'th-app-secret',
    TIKTOK_CLIENT_KEY: 'tt-key', TIKTOK_CLIENT_SECRET: 'tt-secret',
    MEDIA_BUCKET_URL: 'https://acct.r2.example/reels', MEDIA_ACCESS_KEY_ID: 'AKID', MEDIA_SECRET_ACCESS_KEY: 'media-secret',
    ...env
  }, async (url, init) => {
    calls.push({ url, init })
    const r = answer(new URL(url), init)
    if (!r) throw new Error(`unexpected upstream ${url}`)
    return r
  }, () => now)
  const handler = createSigninHandler(config)
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    handler(new Request(`${ORIGIN}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }))
  const get = (path: string) => handler(new Request(`${ORIGIN}${path}`))
  return { calls, handler, post, get, later: (ms: number) => { now += ms } }
}

/** Start, then play the platform sending the person back with `code`: the redirect the browser follows to the app. */
async function signIn(w: ReturnType<typeof world>, p: 'instagram' | 'facebook' | 'threads', verifier: string, code = 'fab-code', back = LOOP.replace('instagram', p)) {
  const started = await w.post(`/v1/${p}/start`, { state: 'a'.repeat(43), loopback_uri: back, code_challenge: s256(verifier), code_challenge_method: 'S256' })
  expect(started.status).toBe(200)
  const link = new URL(((await started.json()) as { authorize_url: string }).authorize_url)
  const res = await w.get(`/v1/${p}/callback?${new URLSearchParams({ code, state: link.searchParams.get('state')! })}`)
  return { link, res, to: res.headers.get('location') ? new URL(res.headers.get('location')!) : null }
}

describe('presign (S3 Signature Version 4)', () => {
  it("matches AWS's published presigned-URL example", async () => {
    // https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html, "An example"
    const url = await presign({
      method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/test.txt', region: 'us-east-1', expiresSec: 86400,
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', now: new Date('2013-05-24T00:00:00Z')
    })
    expect(new URL(url).searchParams.get('X-Amz-Signature')).toBe('aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404')
  })
})

describe('Instagram sign-in through the service', () => {
  const meta: Answer = (u, init) => {
    if (u.href === 'https://api.instagram.com/oauth/access_token') {
      const f = new URLSearchParams(String(init.body))
      expect(Object.fromEntries(f)).toEqual({ client_id: '1111', client_secret: 'ig-app-secret', grant_type: 'authorization_code', redirect_uri: `${ORIGIN}/v1/instagram/callback`, code: 'fab-code' })
      return Response.json({ data: [{ access_token: 'short-token', user_id: '42', permissions: INSTAGRAM_SCOPES.join(',') }] })
    }
    if (u.origin + u.pathname === 'https://graph.instagram.com/access_token') {
      expect(u.searchParams.get('client_secret')).toBe('ig-app-secret')
      expect(u.searchParams.get('access_token')).toBe('short-token')
      return Response.json({ access_token: 'long-token', token_type: 'bearer', expires_in: 5_184_000 })
    }
    if (u.href === 'https://graph.instagram.com/v26.0/me?fields=user_id,account_type') return Response.json({ user_id: '42', account_type: 'MEDIA_CREATOR' })
  }

  it('sends the person to Instagram and back to the app, and gives the token only for the right verifier', async () => {
    const w = world(meta)
    const verifier = randomBytes(32).toString('base64url')
    const { link, res, to } = await signIn(w, 'instagram', verifier)
    expect(link.origin + link.pathname).toBe('https://www.instagram.com/oauth/authorize')
    expect(link.searchParams.get('client_id')).toBe('1111')
    expect(link.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/v1/instagram/callback`)
    expect(link.searchParams.get('scope')?.split(',')).toEqual(INSTAGRAM_SCOPES)
    expect(res.status).toBe(302)
    expect(to!.origin + to!.pathname).toBe(LOOP)
    expect(to!.searchParams.get('state')).toBe('a'.repeat(43))
    // what reaches the loopback address holds no readable code
    expect(to!.href).not.toContain('fab-code')
    expect(w.calls).toEqual([])

    const handoff = to!.searchParams.get('handoff')!
    const wrong = await w.post('/v1/instagram/complete', { handoff, code_verifier: randomBytes(32).toString('base64url') })
    expect(wrong.status).toBe(401)
    expect(w.calls).toEqual([])
    const ok = await w.post('/v1/instagram/complete', { handoff, code_verifier: verifier })
    expect(ok.status).toBe(200)
    expect(ok.headers.get('cache-control')).toBe('no-store')
    expect(await ok.json()).toEqual({ access_token: 'long-token', token_type: 'bearer', expires_in: 5_184_000, permissions: INSTAGRAM_SCOPES, upload_pass: expect.any(String) })
  })

  it('refuses a state passed off as a handoff, and a handoff after five minutes', async () => {
    const w = world(meta)
    const verifier = randomBytes(32).toString('base64url')
    const { link, to } = await signIn(w, 'instagram', verifier)
    expect((await w.post('/v1/instagram/complete', { handoff: link.searchParams.get('state'), code_verifier: verifier })).status).toBe(401)
    w.later(5 * 60_000 + 1)
    expect((await w.post('/v1/instagram/complete', { handoff: to!.searchParams.get('handoff'), code_verifier: verifier })).status).toBe(401)
    expect(w.calls).toEqual([])
  })

  it('never sends a person anywhere but the app on this computer', async () => {
    const w = world()
    for (const back of ['https://127.0.0.1:53123/instagram/callback', 'http://evil.example:53123/instagram/callback', 'http://localhost:53123/instagram/callback',
      'http://127.0.0.1:53123/facebook/callback', 'http://127.0.0.1/instagram/callback', 'http://127.0.0.1:80/instagram/callback',
      'http://127.0.0.1:53123/instagram/callback?next=https://evil.example', 'http://user@127.0.0.1:53123/instagram/callback']) {
      const r = await w.post('/v1/instagram/start', { state: 'a'.repeat(43), loopback_uri: back, code_challenge: s256('v'.repeat(43)), code_challenge_method: 'S256' })
      expect(r.status, back).toBe(400)
    }
  })

  it('says no to the app when the person declines, and shows a page instead of redirecting for a broken link', async () => {
    const w = world()
    const started = await w.post('/v1/instagram/start', { state: 'b'.repeat(43), loopback_uri: LOOP, code_challenge: s256('v'.repeat(43)), code_challenge_method: 'S256' })
    const state = new URL(((await started.json()) as { authorize_url: string }).authorize_url).searchParams.get('state')!
    const declined = await w.get(`/v1/instagram/callback?${new URLSearchParams({ error: 'access_denied', state })}`)
    const to = new URL(declined.headers.get('location')!)
    expect(to.searchParams.get('error')).toBe('access_denied')
    expect(to.searchParams.has('handoff')).toBe(false)
    const forged = await w.get(`/v1/instagram/callback?code=x&state=${state.slice(0, -2)}AA`)
    expect(forged.status).toBe(400)
    expect(forged.headers.get('location')).toBeNull()
    // a Facebook state is not an Instagram one
    const fb = await w.post('/v1/facebook/start', { state: 'c'.repeat(43), loopback_uri: LOOP.replace('instagram', 'facebook'), code_challenge: s256('v'.repeat(43)), code_challenge_method: 'S256' })
    const fbState = new URL(((await fb.json()) as { authorize_url: string }).authorize_url).searchParams.get('state')!
    expect((await w.get(`/v1/instagram/callback?code=x&state=${fbState}`)).status).toBe(400)
  })
})

describe('Instagram video links', () => {
  /** Instagram as two accounts see it: the code says who signs in, the token says who is asking. */
  const accounts = (type: Record<string, string>): Answer => (u, init) => {
    if (u.href === 'https://api.instagram.com/oauth/access_token') {
      const code = new URLSearchParams(String(init.body)).get('code')
      return Response.json({ access_token: `short-${code}`, user_id: '1', permissions: INSTAGRAM_SCOPES.join(',') })
    }
    if (u.origin + u.pathname === 'https://graph.instagram.com/access_token')
      return Response.json({ access_token: u.searchParams.get('access_token')!.replace('short-', 'token-'), token_type: 'bearer', expires_in: 5_184_000 })
    if (u.href === 'https://graph.instagram.com/v26.0/me?fields=user_id,account_type') {
      const who = /^Bearer token-(\d+)$/.exec((init.headers as Record<string, string>).authorization)?.[1]
      if (!who) return Response.json({ error: { code: 190 } }, { status: 401 })
      return Response.json({ user_id: who, account_type: type[who] ?? 'MEDIA_CREATOR' })
    }
  }
  /** Signs account `who` in through the service: its token and its storage pass. */
  const connected = async (w: ReturnType<typeof world>, who: string) => {
    const verifier = randomBytes(32).toString('base64url')
    const { to } = await signIn(w, 'instagram', verifier, who)
    const r = (await (await w.post('/v1/instagram/complete', { handoff: to!.searchParams.get('handoff'), code_verifier: verifier })).json()) as { access_token: string; upload_pass: string }
    return { token: r.access_token, pass: r.upload_pass }
  }

  it('makes upload links only for an account signed in through the service, signed for the size asked', async () => {
    const w = world(accounts({}))
    const a = await connected(w, '42')
    const b = await connected(w, '43')
    const ask = (body: Record<string, unknown>, token?: string) => w.post('/v1/instagram/uploads', body, token ? { authorization: `Bearer ${token}` } : {})
    expect((await ask({ video_size: 10, cover_size: null, upload_pass: a.pass })).status).toBe(401)
    // a working Instagram token from anywhere else has no pass
    expect((await ask({ video_size: 10, cover_size: null }, a.token)).status).toBe(401)
    // nor does one account's token with another's pass
    expect((await ask({ video_size: 10, cover_size: null, upload_pass: b.pass }, a.token)).status).toBe(401)
    expect((await ask({ video_size: 300_000_001, cover_size: null, upload_pass: a.pass }, a.token)).status).toBe(400)
    const r = await ask({ video_size: 1234, cover_size: 56, upload_pass: a.pass }, a.token)
    expect(r.status).toBe(200)
    const links = (await r.json()) as Record<string, { upload_url: string; public_url: string }>
    const put = new URL(links.video.upload_url)
    expect(put.origin + put.pathname).toMatch(/^https:\/\/acct\.r2\.example\/reels\/instagram\/42\/[A-Za-z0-9_-]{24}\.mp4$/)
    expect(put.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host')
    expect(put.searchParams.get('X-Amz-Expires')).toBe('600')
    const read = new URL(links.video.public_url)
    expect(read.pathname).toBe(put.pathname)
    expect(read.searchParams.get('X-Amz-SignedHeaders')).toBe('host')
    expect(new URL(links.cover.upload_url).pathname).toMatch(/\.jpg$/)
  })

  it('signs a personal account in, but gives it no storage', async () => {
    const w = world(accounts({ '44': 'PERSONAL' }))
    const c = await connected(w, '44')
    expect(c.pass).toEqual(expect.any(String))
    expect((await w.post('/v1/instagram/uploads', { video_size: 10, cover_size: null, upload_pass: c.pass }, { authorization: `Bearer ${c.token}` })).status).toBe(403)
  })

  it('stops reading a body past 16 KB, however it is sent', async () => {
    const w = world()
    const endless = new ReadableStream<Uint8Array>({ pull: (ctl) => ctl.enqueue(new Uint8Array(4096).fill(32)) })
    const r = await w.handler(new Request(`${ORIGIN}/v1/instagram/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: endless, duplex: 'half' } as RequestInit))
    expect(r.status).toBe(413)
  })
})

describe('Facebook sign-in through the service', () => {
  it('trades the code for a long-lived token and reports only the permissions granted', async () => {
    const graph = 'https://graph.facebook.com/v26.0'
    const w = world((u, init) => {
      if (u.origin + u.pathname === `${graph}/oauth/access_token` && u.searchParams.get('code')) {
        expect(u.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/v1/facebook/callback`)
        expect(u.searchParams.get('client_secret')).toBe('fb-app-secret')
        return Response.json({ access_token: 'fb-short', token_type: 'bearer', expires_in: 3600 })
      }
      if (u.origin + u.pathname === `${graph}/oauth/access_token` && u.searchParams.get('grant_type') === 'fb_exchange_token') {
        expect(u.searchParams.get('fb_exchange_token')).toBe('fb-short')
        return Response.json({ access_token: 'fb-long', token_type: 'bearer', expires_in: 5_183_944 })
      }
      if (u.href === `${graph}/me/permissions`) {
        expect((init.headers as Record<string, string>).authorization).toBe('Bearer fb-long')
        return Response.json({ data: [{ permission: 'pages_show_list', status: 'granted' }, { permission: 'pages_manage_posts', status: 'declined' }] })
      }
    })
    const verifier = randomBytes(32).toString('base64url')
    const { link, to } = await signIn(w, 'facebook', verifier)
    expect(link.origin + link.pathname).toBe('https://www.facebook.com/v26.0/dialog/oauth')
    expect(link.searchParams.get('scope')?.split(',')).toEqual(FACEBOOK_SCOPES)
    const r = await w.post('/v1/facebook/complete', { handoff: to!.searchParams.get('handoff'), code_verifier: verifier })
    expect(await r.json()).toEqual({ access_token: 'fb-long', token_type: 'bearer', expires_in: 5_183_944, permissions: ['pages_show_list'] })
  })
})

describe('Threads sign-in through the service', () => {
  it('sends the person to Threads and trades the code for the 60-day token', async () => {
    const w = world((u, init) => {
      if (u.href === 'https://graph.threads.com/oauth/access_token') {
        expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({ client_id: '3333', client_secret: 'th-app-secret', grant_type: 'authorization_code', redirect_uri: `${ORIGIN}/v1/threads/callback`, code: 'fab-code' })
        return Response.json({ access_token: 'th-short', user_id: 4242 })
      }
      if (u.origin + u.pathname === 'https://graph.threads.com/access_token') {
        expect(u.searchParams.get('grant_type')).toBe('th_exchange_token')
        return Response.json({ access_token: 'th-long', token_type: 'bearer', expires_in: 5_184_000 })
      }
      if (u.href === 'https://graph.threads.com/v1.0/me?fields=id') return Response.json({ id: '4242' })
    })
    const verifier = randomBytes(32).toString('base64url')
    const { link, to } = await signIn(w, 'threads', verifier)
    expect(link.origin + link.pathname).toBe('https://threads.com/oauth/authorize')
    expect(link.searchParams.get('scope')?.split(',')).toEqual(THREADS_SCOPES)
    const r = await w.post('/v1/threads/complete', { handoff: to!.searchParams.get('handoff'), code_verifier: verifier })
    expect(await r.json()).toEqual({ access_token: 'th-long', token_type: 'bearer', expires_in: 5_184_000, permissions: [], upload_pass: expect.any(String) })
  })
})

describe('TikTok token calls', () => {
  it('adds the secret for a code from the app on this computer, and refuses anything else without calling TikTok', async () => {
    const w = world((u, init) => {
      if (u.href !== 'https://open.tiktokapis.com/v2/oauth/token/') return
      const f = Object.fromEntries(new URLSearchParams(String(init.body)))
      expect(f).toEqual({ client_key: 'tt-key', client_secret: 'tt-secret', grant_type: 'authorization_code', code: 'tt-code',
        redirect_uri: 'http://127.0.0.1:50000/tiktok/callback', code_verifier: 'v'.repeat(43) })
      return Response.json({ access_token: 'tt-token', open_id: 'x' })
    })
    for (const body of [
      { client_key: 'other', grant_type: 'refresh_token', refresh_token: 'r' },
      { client_key: 'tt-key', grant_type: 'password' },
      { client_key: 'tt-key', grant_type: 'authorization_code', redirect_uri: 'https://unapproved.example/callback', code_verifier: 'v'.repeat(43), code: 'tt-code' }
    ]) {
      const r = await w.post('/v1/tiktok/token', body)
      expect(r.status).toBe(400)
      expect(await r.text()).not.toContain('tt-secret')
    }
    expect(w.calls).toEqual([])
    const r = await w.post('/v1/tiktok/token', { client_key: 'tt-key', grant_type: 'authorization_code', code: 'tt-code', redirect_uri: 'http://127.0.0.1:50000/tiktok/callback', code_verifier: 'v'.repeat(43) })
    expect(await r.json()).toEqual({ access_token: 'tt-token', open_id: 'x' })
  })
})

describe('what the service offers', () => {
  it('lists only the platforms it has an app for, with what the app needs to know', async () => {
    const w = world(undefined, { FACEBOOK_APP_ID: '', FACEBOOK_APP_SECRET: '', TIKTOK_AUDITED: '1' })
    expect(await (await w.get('/v1/platforms')).json()).toEqual({
      v: 1,
      platforms: {
        instagram: { clientId: '1111', review: 'testers', mediaOrigins: ['https://acct.r2.example'] },
        tiktok: { clientKey: 'tt-key', audited: true, directPost: false },
        threads: { clientId: '3333', review: 'testers', mediaOrigins: ['https://acct.r2.example'] }
      }
    })
    expect((await w.post('/v1/facebook/start', {})).status).toBe(404)
  })

  it('will not start half set up', () => {
    const base = { SIGNIN_PUBLIC_URL: ORIGIN, SIGNIN_SECRET: SECRET }
    const f = async () => new Response()
    expect(() => configFromEnv({ ...base, INSTAGRAM_APP_ID: '1' }, f)).toThrow(/INSTAGRAM_APP_SECRET/)
    expect(() => configFromEnv({ ...base, INSTAGRAM_APP_ID: '1', INSTAGRAM_APP_SECRET: 's' }, f)).toThrow(/MEDIA_BUCKET_URL/)
    expect(() => configFromEnv({ ...base, SIGNIN_SECRET: 'short' }, f)).toThrow(/SIGNIN_SECRET/)
    expect(() => configFromEnv({ ...base, SIGNIN_PUBLIC_URL: 'http://signin.example' }, f)).toThrow(/SIGNIN_PUBLIC_URL/)
    expect(() => configFromEnv({ ...base, TIKTOK_CLIENT_KEY: 'k', TIKTOK_CLIENT_SECRET: 's', TIKTOK_AUDITED: 'yes' }, f)).toThrow(/TIKTOK_AUDITED/)
  })
})
