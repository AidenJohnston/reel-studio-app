// Updates against a local server that plays dl.getreelstudio.com: latest.json (anonymous) and the /u/ feed, which
// needs `Authorization: Bearer <download key>` like the real one (401 no key / bad key, 403 not entitled).
//
// REELSTUDIO_UPDATE_FEED points an unpackaged test run at the server (main/index.ts). Copies that install updates
// themselves download for real here; the others open the download page.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { APP_DIR, BASE, root, userData, passFirstRun, openSettings, shot } from './helpers'

/** The copies that install updates themselves (main/update-machine.ts updateMode). */
const INSTALLS = process.platform === 'darwin' || process.platform === 'win32'
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
/** latest.json's notes, newest first, as the update server writes them. */
const notes = () => [
  ...(latest === NEXT ? [{ version: NEXT, date: '2026-11-04', text: '- **Updates install themselves.** Say yes and restart.\n- Captions you can drag' }] : []),
  { version: CURRENT, date: '2026-10-30', text: 'Send to my phone over a QR code.' }
]

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
    if (path === '/latest.json') return json(200, { version: latest, url: 'https://getreelstudio.com/update.html', files: {}, notes: notes() })
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
  // main/index.ts names electron-updater's cache after the run's profile folder
  for (const dir of [userData(), join(BASE, 'nightly-user-data')]) rmSync(join(caches, `reel-studio-e2e-updater-${basename(join(dir, '..'))}`), { recursive: true, force: true })
})

async function launch(extra: Record<string, string> = {}): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env.ELECTRON_RUN_AS_NODE
  Object.assign(env, {
    REELSTUDIO_TEST: '1',
    REELSTUDIO_USER_DATA: userData(),
    REELSTUDIO_ROOT: root(),
    REELSTUDIO_MODELS_DIR: join(BASE, 'models'),
    REELSTUDIO_MOCK_AI: '1',
    REELSTUDIO_ENGINE_DIR: join(APP_DIR, 'dev', 'fake-engine'),
    REELSTUDIO_UPDATE_FEED: feed,
    ...extra
  })
  const app = await electron.launch({ args: [APP_DIR], cwd: APP_DIR, env })
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1280, height: 820 })
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

/** Settings › Automatic updates › "Paste link" with `text` on the clipboard. */
async function pasteKey(page: Page, app: ElectronApplication, text: string): Promise<void> {
  // Electron 44's clipboard.writeText returns a promise; returning it makes evaluate wait for it.
  await app.evaluate(({ clipboard }, t) => clipboard.writeText(t), text)
  await page.getByTestId('auto-updates-paste').click()
  await expect(page.locator('[data-setting="auto-updates"]')).toContainText('On.')
}

test('fails if the daily check carries the key, or a missing, refused or accepted key does the wrong thing', async () => {
  test.skip(!INSTALLS, 'updates exist on Mac and Windows only')
  test.setTimeout(5 * 60_000)
  const { app, page } = await launch()
  try {
    await passFirstRun(page)
    await openSettings(page)
    const row = page.getByTestId('update-settings')
    const auto = page.locator('[data-setting="auto-updates"]')
    await row.scrollIntoViewIfNeeded()
    await expect(page.getByTestId('update-settings-text')).toHaveText(`You have Reel Studio ${CURRENT}.`)
    await expect(page.locator('[data-setting="whats-new"]')).toContainText('Release notes show here after Reel Studio checks for updates.')
    await expect(auto).toContainText('Off.')

    latest = NEXT
    await page.getByTestId('update-settings-button').click()
    const button = page.getByTestId('update-button')
    const pop = page.getByTestId('update-popover')
    await expect(button).toContainText('Open download page')
    await expect(page.getByTestId('update-settings-button')).toHaveText('Open download page')
    // What's new: the release on offer, marked new, then the installed one.
    await expect(page.getByTestId(`release-${NEXT}`).locator('.whats-new-tag')).toHaveText('New')
    await expect(page.getByTestId(`release-${NEXT}`).locator('li')).toHaveText(['Updates install themselves. Say yes and restart.', 'Captions you can drag'])
    await expect(page.getByTestId(`release-${CURRENT}`).locator('.whats-new-tag')).toHaveText('Installed')
    await page.getByTestId('licence-link').click()
    await expect(page.getByTestId('legal')).toContainText('GNU AFFERO GENERAL PUBLIC LICENSE')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('legal')).toHaveCount(0)

    // No key yet: the page, and the way to turn automatic updates on. Keyboard focus opens the popover.
    await page.getByTestId('nav-home').click()
    await page.getByTestId('nav-insights').focus() // the last nav row: Tab goes on to the update button
    await page.keyboard.press('Tab')
    await expect(pop).toHaveAttribute('data-open', 'true')
    await expect(pop).toContainText('Update available')
    await expect(pop).toContainText('Updates install themselves.')
    await expect(pop).not.toContainText('QR code') // the installed version's notes stay in Settings
    await expect(page.getByTestId('update-auto-link')).toBeVisible()
    await shot(page, 'update-no-key')
    await page.mouse.move(900, 300)
    await page.keyboard.press('Escape')
    await expect(pop).not.toHaveAttribute('data-open', 'true')

    // The anonymous check never reaches the feed and never carries a key.
    expect(seen.filter((r) => r.path === '/latest.json').length).toBeGreaterThan(0)
    expect(seen.every((r) => r.path === '/latest.json' && r.auth === null)).toBe(true)

    // 401: the key is cleared and the person is sent to the page, with the way to turn updates on again.
    await openSettings(page)
    entitlement = 'bad key'
    await pasteKey(page, app, KEY)
    await expect(button).toContainText('Download update')
    await expect(page.getByTestId('update-auto-link')).toHaveCount(0)
    await button.click()
    await expect(button).toContainText('Open download page')
    await expect(auto).toContainText('Off.')
    await expect(row).toContainText('did not accept the download key')

    // 403: the key stays; the page, with no request for a new key.
    entitlement = 'not entitled'
    await pasteKey(page, app, KEY)
    await expect(button).toContainText('Download update')
    await button.click()
    await expect(button).toContainText('Open download page')
    await expect(row).toContainText('no longer includes new versions')
    await expect(auto).toContainText('On.')

    // Accepted: it downloads (only now with the key), then waits for the person to restart.
    entitlement = 'ok'
    await page.getByTestId('auto-updates-off').click()
    await expect(auto).toContainText('Off.')
    await pasteKey(page, app, KEY) // another key may belong to another purchase, so the download is offered again
    await expect(button).toContainText('Download update')
    await button.click()
    await expect(button).toContainText(/Downloading \d+%/)
    await expect(button).toContainText('Restart to update', { timeout: 60_000 })
    await expect(page.getByTestId('toast')).toContainText('Restart from the update button in the sidebar to install it.')
    await shot(page, 'update-downloaded')
    expect(seen.filter((r) => r.path.startsWith('/u/')).every((r) => r.auth === `Bearer ${KEY}`)).toBe(true)
    expect(seen.filter((r) => r.path === '/latest.json').every((r) => r.auth === null)).toBe(true)
    // Confirming would run the downloaded installer (Windows) or the bundle check (Mac) and quit; the random-byte
    // payload can't be either, so the test stops at the question.
    await button.click()
    const confirm = page.getByTestId('confirm')
    await expect(confirm).toContainText(`Install update ${NEXT} and restart Reel Studio?`)
    await expect(confirm).toContainText('Your reels and settings stay.')
    await expect(page.getByTestId('confirm-no')).toBeFocused()
    await page.getByTestId('confirm-no').click()
    await expect(confirm).toBeHidden()

    // Not now: the sidebar item goes for a day, and Settings still offers the restart.
    await page.getByTestId('nav-insights').focus()
    await page.keyboard.press('Tab')
    await expect(pop).toHaveAttribute('data-open', 'true')
    await page.getByTestId('update-not-now').click()
    await expect(button).toBeHidden()
    await expect(page.getByTestId('toast')).toContainText('Hidden until tomorrow. You can still update from Settings.')
    await openSettings(page)
    await expect(page.getByTestId('update-settings-button')).toHaveText('Restart to update')

    if (process.platform === 'darwin') {
      // No new work while the app restarts to install (main/updater.ts assertCanStartWork); the Mac's random-byte
      // bundle fails its check, so work is allowed again after that.
      const project = join(root(), 'Projects', 'update-export')
      mkdirSync(join(project, 'versions', 'v1'), { recursive: true })
      writeFileSync(join(project, 'project.json'), JSON.stringify({ title: 'Update export', version: 1, sources: [] }))
      writeFileSync(join(project, 'versions', 'v1', 'export.mp4'), 'completed export fixture')
      const exportError = await page.evaluate(async () => {
        const attempt = new Promise<unknown>((resolve) => {
          const off = window.reel.update.onState((s) => {
            if (s.status !== 'installing') return
            off()
            resolve(window.reel.projects.exportVersion('update-export', 1).then(() => null, (error) => error))
          })
        })
        const installation = window.reel.update.install()
        const error = await attempt
        await installation
        return error
      })
      expect(exportError).toMatchObject({ code: 'UPDATING', userMessage: expect.stringContaining('restarting') })
      await page.evaluate(() => window.reel.projects.exportVersion('update-export', 1))
    }
  } finally {
    entitlement = 'ok'
    latest = CURRENT
    await app.close()
  }
})

// The site's feed has only stable releases: a nightly that checked it would be offered the stable installer.
test('fails if a nightly build checks the site for updates, or hides why it does not', async () => {
  test.skip(!INSTALLS, 'updates exist on Mac and Windows only')
  latest = NEXT
  const before = seen.length
  const { app, page } = await launch({ REELSTUDIO_UPDATE_AS: '0.1.4-nightly.20261104.9', REELSTUDIO_USER_DATA: join(BASE, 'nightly-user-data') })
  try {
    await passFirstRun(page)
    await openSettings(page)
    await expect(page.getByTestId('update-settings-text')).toHaveText("Nightly builds don't update themselves yet. Install the newest nightly from its releases page.")
    await expect(page.getByTestId('update-settings-button')).toHaveCount(0)
    await expect(page.locator('[data-setting="auto-updates"]')).toHaveCount(0)
    await expect(page.getByTestId('update-button')).toHaveCount(0)
    expect(seen.length).toBe(before)
  } finally {
    latest = CURRENT
    await app.close()
  }
})
