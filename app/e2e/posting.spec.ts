// "Post to YouTube", end to end in the real app, against the in-memory posting server (test/fake-posting.ts) served
// over HTTP on 127.0.0.1: Share offers it only with REELSTUDIO_POSTING=1, Connect YouTube (the test plays the person
// clicking Allow in the browser, which a test run never opens), a post whose connection drops part way and carries
// on, the done screen, and Settings › Posting with Sign out everywhere.
//
// Run: npx playwright test e2e/posting.spec.ts (after npm run build).
import { test, expect } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { createFakePosting, type FakePosting } from '../test/fake-posting'
import { launch, makeMedia, openSettings, passFirstRun, root, shot, startReel, userData } from './helpers'

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

test('post to YouTube from Share: connect, a dropped connection, done, Settings', async () => {
  test.setTimeout(15 * 60_000)
  const media = makeMedia()
  const { fake, server, url } = await serve()
  // The download key from the receipt email (automatic updates), already pasted.
  mkdirSync(userData(), { recursive: true })
  writeFileSync(join(userData(), 'settings.json'), JSON.stringify({ updateKey: KEY }))
  const { app, page } = await launch({ REELSTUDIO_POSTING: '1', REELSTUDIO_POSTING_URL: url })
  try {
    await passFirstRun(page)
    await startReel(page, media.video)
    await expect(page.getByTestId('share')).toBeEnabled({ timeout: 10 * 60_000 })
    await page.getByTestId('share').click()
    const pop = page.getByTestId('share-pop')
    await expect(pop.getByTestId('share-youtube')).toContainText('Connect your channel once')
    await pop.getByTestId('share-youtube').click()

    // Not signed in on this computer yet: Sign in first (the connection belongs to the purchase, so until then the
    // app can't tell whether it is there).
    const sheet = page.getByTestId('post-sheet')
    await expect(sheet).toHaveAttribute('data-state', 'signed_out', { timeout: 5 * 60_000 })
    await expect(pop).toBeHidden() // Share stepped aside for the sheet
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
    // Who can see it is one Tab stop, the checked choice, both ways (components/ui.tsx Modal, #118)
    const focusedName = () => page.evaluate(() => (document.activeElement as HTMLInputElement | null)?.name ?? null)
    for (const key of ['Tab', 'Shift+Tab']) {
      await page.getByTestId('post-privacy-private').focus()
      await page.keyboard.press(key)
      expect(await focusedName(), key).not.toBe('post-privacy')
    }

    // Back returns to Share, and Share's row now names the channel.
    await page.getByTestId('post-back').click()
    await expect(sheet).toHaveCount(0)
    await expect(pop.getByTestId('share-youtube')).toContainText('To My channel')
    await pop.getByTestId('share-youtube').click()
    await expect(sheet).toHaveAttribute('data-state', 'form')
    await page.getByTestId('post-title').fill('How I got my first job')

    // The connection drops after the first chunk, three times: it waits (2, 4, then 8 s), asks how much arrived, and
    // carries on.
    fake.state.faults.push({ on: 'chunk', network: true, keepBytes: 256 * 1024, times: 3 })
    await page.getByTestId('post-submit').click()
    await expect(sheet).toHaveAttribute('data-state', /sending|retrying/)
    // while it sends, Esc doesn't close the sheet: Stop is the way out
    await page.keyboard.press('Escape')
    await expect(sheet).toBeVisible()
    // Stop asks first, in a dialog over the sheet's: Tab moves inside that one only (components/ui.tsx Modal), and
    // Keep going carries on
    await expect(page.getByTestId('post-retrying')).toBeVisible({ timeout: 30_000 })
    await page.getByTestId('post-stop').click()
    await expect(page.getByTestId('confirm-no')).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(page.getByTestId('confirm-yes')).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(page.getByTestId('confirm-no')).toBeFocused()
    await page.getByTestId('confirm-no').click()
    await expect(page.getByTestId('confirm')).toHaveCount(0)
    await expect(sheet).toHaveAttribute('data-state', 'done', { timeout: 60_000 })
    await expect(page.getByTestId('post-done')).toContainText('Only me')
    await shot(page, 'posting-4-done')

    const [upload] = [...fake.state.uploads.values()]
    expect(upload).toMatchObject({ status: 'done', title: 'How I got my first job', privacy: 'private' })
    const exportsDir = join(root(), 'Library', 'Exports')
    const exported = readFileSync(join(exportsDir, readdirSync(exportsDir).filter((f) => f.endsWith('.mp4'))[0]))
    expect(Buffer.from(upload.bytes).equals(exported)).toBe(true)
    expect(fake.state.calls.filter((c) => c.startsWith('GET /v1/uploads/')).length).toBeGreaterThan(0)
    expect(fake.state.auth.filter((a) => a.value === KEY).map((a) => a.path)).toEqual(['/v1/sessions'])
    await page.getByTestId('post-done-close').click()
    await expect(sheet).toHaveCount(0)

    // Settings › Posting
    await openSettings(page)
    const youtube = page.locator('[data-setting="youtube"]')
    const signIn = page.locator('[data-setting="posting-sign-in"]')
    await youtube.scrollIntoViewIfNeeded()
    await expect(youtube).toContainText('My channel.')
    await expect(signIn).toContainText('Signed in on this computer.')
    await shot(page, 'posting-5-settings')
    await page.getByTestId('posting-sign-out-everywhere').click()
    await page.getByTestId('confirm-yes').click()
    await expect(signIn).toContainText('Not signed in.')
    // the connection stays, as the confirm box said: Settings doesn't call it "not connected"
    await expect(youtube).toContainText('Sign in to see your channel.')
    await expect(page.getByTestId('posting-connect')).toHaveCount(0)
    expect(fake.state.sessions.size).toBe(0)
    expect(fake.state.connections.size).toBe(1) // the YouTube connection belongs to the purchase, not this computer
  } finally {
    await app.close()
    server.close()
  }
})

test('posting is hidden without REELSTUDIO_POSTING=1', async () => {
  const media = makeMedia()
  // a profile of its own: the first test's sign-in and finished first run stay out of it
  const own = join(userData(), '..', 'hidden')
  const { app, page } = await launch({ REELSTUDIO_USER_DATA: join(own, 'user data'), REELSTUDIO_ROOT: join(own, 'Reel Studio') })
  try {
    await passFirstRun(page)
    await startReel(page, media.video)
    await expect(page.getByTestId('share')).toBeEnabled({ timeout: 10 * 60_000 })
    await page.getByTestId('share').click()
    await expect(page.getByTestId('share-pop').getByTestId('share-finder')).toBeVisible()
    await expect(page.getByTestId('share-youtube')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await openSettings(page)
    await expect(page.locator('[data-setting="instagram"]')).toBeVisible()
    await expect(page.locator('[data-setting="youtube"]')).toHaveCount(0)
  } finally {
    await app.close()
  }
})
