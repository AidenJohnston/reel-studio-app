// "Post to YouTube", end to end in the real app, against the in-memory posting server (test/fake-posting.ts) served
// over HTTP on 127.0.0.1: the button only with REELSTUDIO_POSTING=1, Connect YouTube (the test plays the person
// clicking Allow in the browser, which a test run never opens), a post whose connection drops part way and carries
// on, the done screen, and Settings > Posting with Sign out everywhere.
//
// Run: npx playwright test e2e/posting.spec.ts (after npm run build).
import { test, expect } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { createFakePosting, type FakePosting } from '../test/fake-posting'
import { BASE, launch, makeMedia, passFirstRun, shot } from './helpers'

const MINE = mkdtempSync(join(BASE, 'posting-'))
const ROOT = join(MINE, 'Documents', 'Reel Studio')
const USER_DATA = join(MINE, 'user data')
const b64url = (s: string) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const KEY = `v1.${b64url(JSON.stringify({ s: 'cs_test_e2e', p: 'monthly', e: 1830000000 }))}.${'k'.repeat(43)}`

/** The fake posting server on a real port, so the app's main process reaches it with Node's fetch. */
async function serve(): Promise<{ fake: FakePosting; server: Server; url: string }> {
  let fake: FakePosting | null = null
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', async () => {
      const body = Buffer.concat(chunks)
      const headers = new Headers()
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v)
      try {
        const r = await fake!.handle(new Request(`${fake!.origin}${req.url}`, { method: req.method, headers, body: body.length ? body : undefined }))
        const out: Record<string, string> = {}
        r.headers.forEach((v, k) => (out[k] = v))
        res.writeHead(r.status, out)
        res.end(Buffer.from(await r.arrayBuffer()))
      } catch {
        res.destroy() // a fault that drops the connection
      }
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  fake = createFakePosting({ origin: url, chunkSize: 256 * 1024 })
  fake.state.now = () => Date.now()
  fake.state.keys.set(KEY, { sid: 'cs_test_e2e', plan: 'monthly' })
  return { fake, server, url }
}

test('post to YouTube: connect, a dropped connection, done, Settings', async () => {
  test.setTimeout(15 * 60_000)
  const media = makeMedia()
  const { fake, server, url } = await serve()
  // The download key from the receipt email (app PR "automatic updates"), already pasted.
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ updateKey: KEY }))
  const { app, page } = await launch({ REELSTUDIO_ROOT: ROOT, REELSTUDIO_USER_DATA: USER_DATA, REELSTUDIO_POSTING: '1', REELSTUDIO_POSTING_URL: url })
  try {
    await passFirstRun(page)
    await page.getByTestId('new-video').click()
    await page.getByTestId('file-input').setInputFiles([media.video])
    await expect(page.getByTestId('player')).toBeVisible({ timeout: 10 * 60_000 })
    await expect(page.getByTestId('post-youtube-reel')).toBeEnabled({ timeout: 10 * 60_000 })
    // the third button under the phone stays in view at the default window size (the phone gives up the room)
    await expect(page.getByTestId('post-youtube-reel')).toBeInViewport({ ratio: 1 })
    await page.getByTestId('post-youtube-reel').click()

    // Not signed in on this computer yet: Sign in first (the connection belongs to the purchase, so until then the
    // app can't tell whether it is there).
    const sheet = page.getByTestId('post-sheet')
    await expect(sheet).toHaveAttribute('data-state', 'signed_out')
    await page.getByTestId('post-sign-in').click()
    // Not connected yet: Connect YouTube waits for the browser.
    await expect(sheet).toHaveAttribute('data-state', 'not_connected')
    await shot(page, 'posting-1-connect')
    await page.getByTestId('post-connect').click()
    await expect(sheet).toHaveAttribute('data-state', 'connecting')
    await shot(page, 'posting-2-connecting')
    // the person clicks Allow on Google's page
    await expect.poll(() => fake.state.attempts.size).toBe(1)
    const [attempt] = [...fake.state.attempts.values()]
    attempt.status = 'connected'
    fake.state.connections.set(attempt.sid, { status: 'connected', channelName: 'My channel', channelUrl: 'https://www.youtube.com/@me' })

    await expect(sheet).toHaveAttribute('data-state', 'form')
    await expect(page.getByTestId('post-note')).toHaveCount(0) // connected: nothing to explain
    await expect(page.getByTestId('post-channel')).toHaveText('Posting to My channel')
    await expect(page.getByTestId('post-privacy-private')).toBeChecked()
    expect(await page.getByTestId('post-title').inputValue()).not.toBe('')
    await page.getByTestId('post-title').fill('How I got my first job')
    await shot(page, 'posting-3-form')

    // The connection drops after the first chunk: it waits, asks how much arrived, and carries on.
    fake.state.faults.push({ on: 'chunk', network: true, keepBytes: 256 * 1024, times: 1 })
    await page.getByTestId('post-submit').click()
    await expect(sheet).toHaveAttribute('data-state', /sending|retrying/)
    await expect(sheet).toHaveAttribute('data-state', 'done', { timeout: 60_000 })
    await expect(page.getByTestId('post-done')).toContainText('Only me')
    await shot(page, 'posting-4-done')

    const [upload] = [...fake.state.uploads.values()]
    expect(upload).toMatchObject({ status: 'done', title: 'How I got my first job', privacy: 'private' })
    const exportsDir = join(ROOT, 'Library', 'Exports')
    const exported = readFileSync(join(exportsDir, readdirSync(exportsDir).filter((f) => f.endsWith('.mp4'))[0]))
    expect(Buffer.from(upload.bytes).equals(exported)).toBe(true)
    expect(fake.state.calls.filter((c) => c.startsWith('GET /v1/uploads/')).length).toBeGreaterThan(0)
    expect(fake.state.auth.filter((a) => a.value === KEY).map((a) => a.path)).toEqual(['/v1/sessions'])
    await page.getByTestId('post-done-close').click()

    // Settings > Posting
    await page.getByTestId('nav-settings').click()
    const settings = page.getByTestId('posting-settings')
    await expect(settings).toBeVisible()
    await expect(page.getByTestId('posting-youtube')).toContainText('YouTube: My channel')
    await expect(page.getByTestId('posting-sign-in')).toContainText('Signed in on this computer.')
    await settings.scrollIntoViewIfNeeded()
    await shot(page, 'posting-5-settings')
    await page.getByTestId('posting-sign-out-everywhere').click()
    await page.getByTestId('confirm-yes').click()
    await expect(page.getByTestId('posting-sign-in')).toContainText('Not signed in.')
    // the connection stays, as the confirm box said: Settings doesn't call it "not connected"
    await expect(page.getByTestId('posting-youtube')).toContainText('YouTube: sign in to see your channel')
    await expect(page.getByTestId('posting-connect')).toHaveCount(0)
    expect(fake.state.sessions.size).toBe(0)
    expect(fake.state.connections.size).toBe(1) // the YouTube connection belongs to the purchase, not this computer
  } finally {
    await app.close()
    server.close()
  }
})

test('posting is hidden without REELSTUDIO_POSTING=1', async () => {
  const { app, page } = await launch({ REELSTUDIO_ROOT: ROOT, REELSTUDIO_USER_DATA: USER_DATA })
  try {
    await passFirstRun(page)
    await page.getByTestId('nav-settings').click()
    await expect(page.getByText('About', { exact: true })).toBeVisible()
    await expect(page.getByTestId('posting-settings')).toHaveCount(0)
  } finally {
    await app.close()
  }
})

