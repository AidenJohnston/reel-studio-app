// Posting end to end across both halves: the app's real main-process client (main/posting-ipc.ts setupPosting,
// Node's fetch, real files) against the real posting Worker under `wrangler dev`, which talks to the fake Google
// (the site repo's posting/tools/fake-google-server.mjs). Skipped unless POSTING_IT_SERVER is set; nothing here
// runs in CI. To run it (site repo, posting/):
//
//   node tools/fake-google-server.mjs --port 8790            (its Allow page; this test clicks Allow)
//   npx wrangler d1 migrations apply DB --local
//   node tools/dev-seed.mjs            (save the key it prints to a file; --ended prints one whose subscription ended)
//   npx wrangler dev --port 8787
//
// then here: POSTING_IT_SERVER=http://127.0.0.1:8787 POSTING_IT_FAKE=http://127.0.0.1:8790 POSTING_IT_KEY_FILE=<key>
// POSTING_IT_VIDEO=<an .mp4 of 20 MB or more> [POSTING_IT_ENDED_KEY_FILE=<the --ended key>]
// npx vitest run test/posting-server.test.ts
//
// The Worker allows 20 sign-ins an hour from one address and a run makes about 6, so between runs clear the local
// limits: npx wrangler d1 execute DB --local --command "DELETE FROM rate_limits".
//
// The app reaches the Worker through a small proxy on 8788 (the local Worker's PUBLIC_ORIGIN, so its connect link
// passes the app's same-server check) that can cut a chunk off part way, like Wi-Fi dropping mid-send. The fake
// Google also drops one chunk part way on its side.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PostProgress, PostingStatus } from '../src/shared/api'
import { setupPosting } from '../src/main/posting-ipc'
import type { PostingService } from '../src/main/posting'

const SERVER = process.env.POSTING_IT_SERVER ?? ''
const FAKE = process.env.POSTING_IT_FAKE ?? 'http://127.0.0.1:8790'
const PROXY_PORT = Number(process.env.POSTING_IT_PROXY_PORT ?? 8788)
const PROXY = `http://127.0.0.1:${PROXY_PORT}`
const readKey = (f: string | undefined): string => (f ? readFileSync(f, 'utf8').replace(/[\r\n\s]/g, '') : '')

describe.skipIf(!SERVER)('posting: the app against the real posting Worker and the fake Google', () => {
  const key = readKey(process.env.POSTING_IT_KEY_FILE)
  const endedKey = readKey(process.env.POSTING_IT_ENDED_KEY_FILE)
  const root = mkdtempSync(join(tmpdir(), 'rs-posting-it-'))
  const exportsDir = join(root, 'Library', 'Exports')
  const video = join(exportsDir, 'reel-v1.mp4')
  let proxy: http.Server
  /** Cut the connection on this chunk PUT (counted from 1), after this many bytes. */
  let dropChunk = { number: 0, afterBytes: 0 }
  let chunkPuts = 0
  /** Runs when the Worker has answered the chunk that ends the file, before the app sees that answer. */
  let onLastChunkAnswered: (() => void) | null = null
  let proxyDrops = 0
  const logs: string[] = []
  const browserPages: { status: number; text: string }[] = []

  /** A browser for the one-time link: our begin page, the fake Google's Allow page, back to our callback. */
  async function browser(url: string): Promise<void> {
    const begin = await fetch(url, { redirect: 'manual' })
    const cookie = (begin.headers.get('set-cookie') ?? '').split(';')[0]
    const consent = await fetch(begin.headers.get('location') ?? '', { redirect: 'manual' })
    const allow = /id="allow" href="([^"]+)"/.exec(await consent.text())?.[1]?.replace(/&amp;/g, '&')
    if (!allow) throw new Error('no Allow link on the fake consent page')
    const back = await fetch(allow, { redirect: 'manual' })
    const cb = await fetch(back.headers.get('location') ?? '', { redirect: 'manual', headers: { Cookie: cookie } })
    browserPages.push({ status: cb.status, text: await cb.text() })
  }

  /** One computer: its own settings folder, so its own sign-in. */
  function computer(name: string, k: string): { svc: PostingService; progress: PostProgress[]; dir: string } {
    const dir = join(root, name)
    mkdirSync(dir, { recursive: true })
    const progress: PostProgress[] = []
    const svc = setupPosting({
      handle: () => undefined,
      env: { REELSTUDIO_POSTING: '1', REELSTUDIO_POSTING_URL: PROXY },
      settingsDir: dir,
      exportsDir: () => exportsDir,
      secrets: null,
      appVersion: '0.1.4',
      getKey: async () => k || null,
      openExternal: async (url) => {
        void browser(url).catch((e) => logs.push(`[it] browser: ${String(e)}`))
      },
      send: (ch, v) => {
        if (ch === 'posting:progress') progress.push(v as PostProgress)
      },
      log: (line) => logs.push(`[${name}] ${line}`)
    })
    return { svc, progress, dir }
  }
  const storedSession = (dir: string): string => JSON.parse(readFileSync(join(dir, 'posting-session.json'), 'utf8')).session
  const me = (session: string): Promise<Response> => fetch(`${SERVER}/v1/me`, { headers: { Authorization: `Bearer ${session}` } })
  const fake = async (path: string, init?: RequestInit): Promise<any> => (await fetch(FAKE + path, init)).json()
  const codeOf = async (p: Promise<unknown>): Promise<string> => p.then(() => 'no error', (e) => String(e?.code ?? e))

  beforeAll(async () => {
    expect(key, 'POSTING_IT_KEY_FILE').toMatch(/^v1\./)
    mkdirSync(exportsDir, { recursive: true })
    copyFileSync(process.env.POSTING_IT_VIDEO ?? '', video)
    const upstream = new URL(SERVER)
    proxy = http.createServer((req, res) => {
      const isChunk = req.method === 'PUT' && /^\/v1\/uploads\//.test(req.url ?? '') && !/^bytes \*\//.test(String(req.headers['content-range'] ?? ''))
      const drop = isChunk && ++chunkPuts === dropChunk.number ? dropChunk.afterBytes : null
      const range = /^bytes \d+-(\d+)\/(\d+)$/.exec(String(req.headers['content-range'] ?? ''))
      const isLast = isChunk && !!range && Number(range[1]) + 1 === Number(range[2])
      const up = http.request({ host: upstream.hostname, port: upstream.port, method: req.method, path: req.url, headers: req.headers }, (ur) => {
        if (isLast && onLastChunkAnswered) {
          const f = onLastChunkAnswered
          onLastChunkAnswered = null
          f()
        }
        res.writeHead(ur.statusCode ?? 502, ur.headers)
        ur.pipe(res)
      })
      up.on('error', () => res.destroy())
      let n = 0
      req.on('data', (c: Buffer) => {
        if (drop !== null && n + c.length > drop) {
          proxyDrops++
          up.destroy()
          req.socket.destroy()
          return
        }
        n += c.length
        up.write(c)
      })
      req.on('end', () => up.end())
    })
    await new Promise<void>((done) => proxy.listen(PROXY_PORT, '127.0.0.1', done))
  })
  afterAll(async () => {
    await new Promise((done) => proxy?.close(done))
    rmSync(root, { recursive: true, force: true })
  })

  const a = computer('laptop', key)
  const b = computer('desktop', key)

  it('trades the key, connects through the Allow page, posts with two dropped chunks, and every byte arrives in order', async () => {
    expect(await a.svc.status()).toMatchObject<Partial<PostingStatus>>({ enabled: true, hasKey: true, signedIn: false })
    // The connection belongs to the purchase, so an earlier run may have left one: start from none.
    await a.svc.signIn()
    if ((await a.svc.status()).youtube) await a.svc.disconnect('youtube')
    const c = await a.svc.connect('youtube')
    expect(c.outcome).toBe('connected')
    expect(c.status).toMatchObject({ signedIn: true, youtube: { state: 'connected', channelName: 'Fake Channel' } })
    expect(browserPages.length).toBe(1)
    expect(browserPages[0].status).toBe(200)

    const before = (await fake('/__fake/state')).uploads.length
    // Google's side drops the first chunk it is handed after 3 MB; this computer's Wi-Fi drops the third chunk after 5 MB.
    await fake('/__fake/faults', { method: 'POST', body: JSON.stringify({ on: 'chunk', dropAfterBytes: 3_000_000 }) })
    chunkPuts = 0
    dropChunk = { number: 3, afterBytes: 5_000_000 }
    const done = await a.svc.post({ video, slug: 'reel', version: 1, title: 'Integration test reel', description: 'Posted by the integration test.', privacy: 'private', madeForKids: false })

    expect(done.step).toBe('done')
    expect(done.result?.privacy).toBe('private')
    expect(done.result?.videoUrl).toMatch(/^https:\/\/www\.youtube\.com\//)
    expect(proxyDrops).toBe(1)
    expect(a.progress.filter((p) => p.step === 'retrying').length).toBeGreaterThanOrEqual(2)

    const st = await fake('/__fake/state')
    expect(st.uploads.length).toBe(before + 1)
    const up = st.uploads.at(-1)
    const arrived = await fake(`/__fake/upload?id=${up.id}`)
    const file = readFileSync(video)
    expect(arrived).toMatchObject({ size: file.length, received: file.length, length: file.length, done: true })
    expect(arrived.sha256).toBe(createHash('sha256').update(file).digest('hex'))
    expect(up).toMatchObject({ title: 'Integration test reel', privacy: 'private' })
  }, 180_000)

  it('Finish posting after a restart: carries on from what YouTube has', async () => {
    // A post that stopped after its first chunk, as a closed app leaves it: the upload on the server, the entry on disk.
    const auth = { Authorization: `Bearer ${storedSession(a.dir)}` }
    const file = readFileSync(video)
    const started: any = await (
      await fetch(`${SERVER}/v1/uploads`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: 'youtube', size: file.length, mimeType: 'video/mp4', title: 'Finished later', description: '', privacy: 'unlisted', madeForKids: false })
      })
    ).json()
    const first = started.chunkSize as number
    const put = await fetch(`${SERVER}/v1/uploads/${started.uploadId}`, {
      method: 'PUT',
      headers: { ...auth, 'Content-Type': 'application/octet-stream', 'Content-Range': `bytes 0-${first - 1}/${file.length}` },
      body: file.subarray(0, first)
    })
    expect(await put.json()).toMatchObject({ status: 'uploading', received: first })
    const st = statSync(video)
    const entry = { uploadId: started.uploadId, server: PROXY, slug: 'reel', version: 3, video, size: st.size, mtimeMs: st.mtimeMs, startedAt: Date.now(), privacy: 'unlisted', sent: first }
    writeFileSync(join(a.dir, 'posting-uploads.json'), JSON.stringify([entry]))

    const restarted = computer('laptop', key) // the same settings folder: the same sign-in and stopped posts
    expect(await restarted.svc.pending('reel', 3)).toMatchObject({ uploadId: started.uploadId, sent: first, total: file.length })
    const done = await restarted.svc.resume(started.uploadId)
    expect(done).toMatchObject({ step: 'done', result: { privacy: 'unlisted' } })
    const arrived = await fake(`/__fake/upload?id=${(await fake('/__fake/state')).uploads.at(-1).id}`)
    expect(arrived.sha256).toBe(createHash('sha256').update(file).digest('hex'))
    expect(await restarted.svc.pending('reel', 3)).toBeNull()
  }, 120_000)

  it('Stop pressed after the last chunk reached YouTube: the server says it is posted, and so does the app', async () => {
    const before = (await fake('/__fake/state')).uploads.length
    onLastChunkAnswered = () => void a.svc.cancel()
    const done = await a.svc.post({ video, slug: 'reel', version: 4, title: 'Stopped too late', description: '', privacy: 'unlisted', madeForKids: false })
    expect(onLastChunkAnswered).toBeNull()
    expect(done).toMatchObject({ step: 'done', result: { privacy: 'unlisted' } })
    const st = await fake('/__fake/state')
    expect(st.uploads.length).toBe(before + 1)
    expect((await fake(`/__fake/upload?id=${st.uploads.at(-1).id}`)).done).toBe(true)
    expect(logs.some((l) => l.includes('stopped after YouTube had all of it'))).toBe(true)
    expect(await a.svc.pending('reel', 4)).toBeNull()
  }, 120_000)

  it("YouTube's daily limits come through as the app's own messages", async () => {
    const req = { video, slug: 'reel', version: 1, title: 'Over the limit', description: '', privacy: 'private' as const, madeForKids: false }
    try {
      await fake('/__fake/flags', { method: 'POST', body: JSON.stringify({ quotaExceeded: true }) })
      expect(await a.svc.post(req)).toMatchObject({ step: 'failed', error: { code: 'QUOTA' } })
      await fake('/__fake/flags', { method: 'POST', body: JSON.stringify({ quotaExceeded: false, uploadLimitExceeded: true }) })
      expect(await a.svc.post(req)).toMatchObject({ step: 'failed', error: { code: 'UPLOAD_LIMIT' } })
    } finally {
      await fake('/__fake/flags', { method: 'POST', body: JSON.stringify({ quotaExceeded: false, uploadLimitExceeded: false }) })
    }
  })

  it('a second computer signs in with the same key and sees the same channel', async () => {
    await b.svc.signIn()
    const s = await b.svc.status()
    expect(s).toMatchObject({ signedIn: true, youtube: { state: 'connected', channelName: 'Fake Channel' } })
    expect(s.otherComputers).toBeGreaterThanOrEqual(1) // the laptop (and any run that stopped before signing out)
  })

  it('disconnect removes access at Google; the sign-in stays', async () => {
    const revokedBefore = (await fake('/__fake/state')).revokeCalls
    const s = await a.svc.disconnect('youtube')
    expect(s).toMatchObject({ signedIn: true, youtube: null })
    expect((await fake('/__fake/state')).revokeCalls).toBe(revokedBefore + 1)
    expect(logs.some((l) => l.includes('access removed at Google: yes'))).toBe(true)
  })

  it('sign out everywhere: both sessions are refused by the server, and the app asks to sign in again', async () => {
    const sa = storedSession(a.dir)
    const sb = storedSession(b.dir)
    expect((await me(sa)).status).toBe(200)
    const s = await a.svc.signOutEverywhere()
    expect(s).toMatchObject({ signedIn: false, signedOutByServer: false })
    expect((await me(sa)).status).toBe(401)
    expect((await me(sb)).status).toBe(401)
    // The other computer finds out on its next call (its status may be cached for 30 s) and does not trade the key
    // again by itself: the post fails as signed out, then the sheet shows Sign in.
    const uploadsBefore = (await fake('/__fake/state')).uploads.length
    const p = await b.svc.post({ video, slug: 'reel', version: 2, title: 'Should not post', description: '', privacy: 'private', madeForKids: false })
    expect(p).toMatchObject({ step: 'failed', error: { code: 'SIGNED_OUT' } })
    expect(await b.svc.status()).toMatchObject({ signedIn: false, signedOutByServer: true })
    expect(await codeOf(b.svc.post({ video, slug: 'reel', version: 2, title: 'x', description: '', privacy: 'private', madeForKids: false }))).toBe('SIGNED_OUT')
    expect((await fake('/__fake/state')).uploads.length).toBe(uploadsBefore) // nothing reached Google
  })

  it('a revoked session (Sign out on that computer) is refused', async () => {
    await a.svc.signIn()
    const sa = storedSession(a.dir)
    await a.svc.signOut()
    expect((await me(sa)).status).toBe(401)
    expect(await a.svc.status()).toMatchObject({ signedIn: false })
  })

  it.skipIf(!endedKey)('a key whose subscription ended gets no session', async () => {
    const ended = computer('ended', endedKey)
    expect(await codeOf(ended.svc.signIn())).toBe('ENDED')
    expect(await ended.svc.status()).toMatchObject({ signedIn: false, ended: true })
  })

  it('logs never carry the key or a session', () => {
    expect(logs.length).toBeGreaterThan(5)
    for (const l of logs) {
      expect(l).not.toContain(key)
      expect(l).not.toMatch(/ps1_[A-Za-z0-9_-]{20,}/)
    }
  })
})
