// Updates against a local server that plays dl.getreelstudio.com: latest.json (anonymous) and the /u/ feed, which
// needs `Authorization: Bearer <download key>` like the real one (401 no key / bad key, 403 not entitled).
//
// Run: npx playwright test e2e/update.spec.ts (after npm run build). REELSTUDIO_UPDATE_FEED points an unpackaged test
// run at the server (main/index.ts). Copies that install updates themselves download for real here; the others open
// the download page.
import { test, expect, type Page } from '@playwright/test'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { launch, passFirstRun, shot, userData } from './helpers'

/** The copies that install updates themselves (main/update-machine.ts updateMode). */
const INSTALLS = process.platform === 'darwin'
const WIN = process.platform === 'win32'
const CURRENT = '0.1.4' // app/package.json
const NEXT = '0.1.5'
const PAYLOAD = WIN ? `Reel-Studio-Setup-${NEXT}-x64.exe` : `Reel-Studio-${NEXT}-arm64-mac.zip`
const FEED = WIN ? 'latest.yml' : 'latest-mac.yml'
const KEY = 'v1.eyJwIjoibW9udGhseSJ9.c2lnbmF0dXJl'

let server: Server
let feed = ''
let payload: Buffer
let latest = CURRENT
/** How the /u/ feed answers a request carrying the key. */
let entitlement: 'ok' | 'bad key' | 'not entitled' = 'ok'
const seen: { path: string; auth: string | null }[] = []

function refuse(req: IncomingMessage): [number, object] | null {
  const auth = req.headers.authorization ?? ''
  if (!auth.startsWith('Bearer ')) return [401, { error: 'no key' }]
  if (auth !== `Bearer ${KEY}` || entitlement === 'bad key') return [401, { error: 'bad key' }]
  if (entitlement === 'not entitled') return [403, { error: 'not entitled', reason: 'subscription ended' }]
  return null
}

test.beforeAll(async () => {
  payload = randomBytes(3 * 1024 * 1024)
  const sha512 = createHash('sha512').update(payload).digest('base64')
  // What the update server renders from its manifest (same fields for latest.yml and latest-mac.yml).
  const yml = `version: ${NEXT}\nfiles:\n  - url: ${PAYLOAD}\n    sha512: ${sha512}\n    size: ${payload.length}\npath: ${PAYLOAD}\nsha512: ${sha512}\nreleaseDate: '2026-11-04T00:00:00.000Z'\n`
  server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0]
    seen.push({ path, auth: req.headers.authorization ?? null })
    const json = (status: number, body: object) => void res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
    if (path === '/latest.json') return json(200, { version: latest, url: 'https://getreelstudio.com/update.html', files: {}, notes: [] })
    if (!path.startsWith('/u/')) return void res.writeHead(404).end()
    const no = refuse(req)
    if (no) return json(...no)
    if (path === `/u/${FEED}`) return void res.writeHead(200, { 'Content-Type': 'text/yaml' }).end(yml)
    if (path === `/u/${PAYLOAD}`) {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': payload.length })
      let at = 0
      const step = () => {
        if (at >= payload.length || res.destroyed) return void res.end()
        res.write(payload.subarray(at, (at += 48 * 1024)))
        setTimeout(step, 90)
      }
      return step()
    }
    json(404, { error: 'no such file in the current release' })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const a = server.address()
  feed = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`
})

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  const caches = WIN ? (process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')) : join(homedir(), 'Library', 'Caches')
  // main/index.ts names electron-updater's cache after this run's profile
  rmSync(join(caches, `reel-studio-e2e-updater-${basename(join(userData(), '..'))}`), { recursive: true, force: true })
})

/** Settings › About › "Paste my download link" with `text` on the clipboard. */
async function pasteKey(page: Page, app: Awaited<ReturnType<typeof launch>>['app'], text: string): Promise<void> {
  // Electron 44's clipboard.writeText returns a promise; returning it makes evaluate wait for it.
  await app.evaluate(({ clipboard }, t) => clipboard.writeText(t), text)
  await page.getByTestId('auto-updates-paste').click()
  await expect(page.getByTestId('auto-updates')).toContainText('Automatic updates: on')
}

test('fails if the daily check carries the key, or a missing, refused or accepted key does the wrong thing', async () => {
  test.skip(process.platform !== 'darwin' && !WIN, 'updates exist on Mac and Windows only')
  test.setTimeout(5 * 60_000)
  const { app, page } = await launch({ REELSTUDIO_UPDATE_FEED: feed })
  try {
    await passFirstRun(page)
    await page.getByTestId('nav-settings').click()
    const row = page.getByTestId('update-settings')
    await row.scrollIntoViewIfNeeded()
    await expect(row).toContainText(`You have Reel Studio ${CURRENT}`)
    await expect(page.getByTestId('update-releases-link')).toHaveAttribute('href', 'https://getreelstudio.com/update.html')

    latest = NEXT
    await page.getByTestId('update-settings-button').click()
    const button = page.getByTestId('update-button')
    const pop = page.getByTestId('update-popover')
    await expect(button).toContainText('Open download page')
    await expect(row).toContainText(`Reel Studio ${NEXT} is out.`)
    // No key yet: the page, and on a copy that can install, the way to turn automatic updates on.
    await page.getByTestId('nav-settings').focus()
    await page.keyboard.press('Tab') // keyboard focus opens the card
    await expect(pop).toHaveAttribute('data-open', 'true')
    await expect(pop).toContainText('Update available')
    if (INSTALLS) await expect(page.getByTestId('update-turn-on')).toBeVisible()
    else await expect(page.getByTestId('update-turn-on')).toHaveCount(0)
    await shot(page, 'update-no-key')
    await page.keyboard.press('Escape')
    await expect(pop).not.toHaveAttribute('data-open', 'true')

    // The anonymous check never reaches the feed and never carries a key.
    expect(seen.filter((r) => r.path === '/latest.json').length).toBeGreaterThan(0)
    expect(seen.every((r) => r.path === '/latest.json' && r.auth === null)).toBe(true)

    await pasteKey(page, app, KEY)
    if (!INSTALLS) {
      // A key changes nothing on a copy that opens the download page, and still nothing goes to the feed.
      await expect(button).toContainText('Open download page')
      expect(seen.some((r) => r.path.startsWith('/u/'))).toBe(false)
      return
    }

    // 401: the key is cleared and the person is sent to the page, with the way to turn updates on again.
    entitlement = 'bad key'
    await expect(button).toContainText('Download update')
    await button.click()
    await expect(button).toContainText('Open download page')
    await expect(page.getByTestId('auto-updates')).toContainText('Automatic updates: off')
    await expect(row).toContainText('did not accept the download key')

    // 403: the key stays; the page, with no request for a new key.
    entitlement = 'not entitled'
    await pasteKey(page, app, KEY)
    await expect(button).toContainText('Download update')
    await button.click()
    await expect(button).toContainText('Open download page')
    await expect(row).toContainText('no longer includes new versions')
    await expect(page.getByTestId('auto-updates')).toContainText('Automatic updates: on')

    // Accepted: it downloads (only now with the key), then waits for the person to restart.
    entitlement = 'ok'
    await page.getByTestId('auto-updates-off').click()
    await pasteKey(page, app, KEY) // another key may belong to another purchase, so the download is offered again
    await expect(button).toContainText('Download update')
    await button.click()
    await expect(button).toContainText(/Downloading \d+%/)
    await expect(button).toContainText('Restart to update', { timeout: 60_000 })
    await shot(page, 'update-downloaded')
    expect(seen.filter((r) => r.path.startsWith('/u/')).every((r) => r.auth === `Bearer ${KEY}`)).toBe(true)
    expect(seen.filter((r) => r.path === '/latest.json').every((r) => r.auth === null)).toBe(true)
    await button.click()
    const confirm = page.getByTestId('confirm')
    await expect(confirm).toContainText(`Install update ${NEXT} and restart Reel Studio?`)
    await expect(page.getByTestId('confirm-no')).toBeFocused()
    await page.getByTestId('confirm-no').click()
    await expect(confirm).toBeHidden()
  } finally {
    await app.close()
  }
})
