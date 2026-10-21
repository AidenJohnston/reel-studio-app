// Updates, end to end on a dev build: a local server plays the release feed (electron-updater's generic
// provider, through dev-app-update.yml: main/index.ts REELSTUDIO_UPDATE_FEED), and the UI goes through
// "Download update", the progress ring, and "Restart to update" with its question. The install itself
// (Squirrel.Mac replacing the app) needs a Developer ID signed build and is not run here.
//
// REELSTUDIO_EVIDENCE_DIR=<dir> also saves a screenshot of each state there, and update-flow.mp4: available,
// downloading and ready, joined from screenshots by ffmpeg (Playwright's recordVideo hangs Electron's launch).
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { APP_DIR, BASE, ROOT, USER_DATA, passFirstRun } from './helpers'

const { latestMacYml } = createRequire(__filename)('../../packaging/latest-mac.js') as { latestMacYml(zip: string, version: string): string }
const EVIDENCE = process.env.REELSTUDIO_EVIDENCE_DIR
const ZIP_NAME = 'Reel-Studio-0.1.3-arm64-mac.zip'
const NOTES = [
  "## What's new",
  '',
  '* **Updates install themselves.** Reel Studio downloads a new version when you click, then restarts into it.',
  '* **Fix:** the update note no longer covers the AI status.',
  '',
  '## Download',
  '',
  '* Mac: the disk image.'
].join('\n')

let server: Server
let feed = ''
let zip: Buffer
let latest: 'old' | 'new' | 'broken' = 'old'

test.beforeAll(async () => {
  zip = randomBytes(3 * 1024 * 1024)
  const zipFile = join(BASE, ZIP_NAME)
  writeFileSync(zipFile, zip)
  const yml = (v: string) => latestMacYml(zipFile, '0.1.3').replace('version: 0.1.3', `version: ${v}`) + `releaseNotes: ${JSON.stringify(NOTES)}\n`
  server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0]
    if (path === '/latest-mac.yml') {
      if (latest === 'broken') return void res.writeHead(500).end('down')
      return void res.writeHead(200, { 'Content-Type': 'text/yaml' }).end(yml(latest === 'new' ? '0.1.3' : '0.1.2'))
    }
    if (path === `/${ZIP_NAME}`) {
      // about 6 s for the whole file, so the ring can be seen filling
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': zip.length })
      let at = 0
      const step = () => {
        if (at >= zip.length || res.destroyed) return void res.end()
        res.write(zip.subarray(at, (at += 48 * 1024)))
        setTimeout(step, 90)
      }
      return step()
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const a = server.address()
  feed = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`
})

test.afterAll(async () => {
  server?.close()
  rmSync(join(homedir(), 'Library', 'Caches', 'reel-studio-e2e-updater'), { recursive: true, force: true })
})

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env.ELECTRON_RUN_AS_NODE
  Object.assign(env, {
    REELSTUDIO_TEST: '1',
    REELSTUDIO_USER_DATA: USER_DATA,
    REELSTUDIO_ROOT: ROOT,
    REELSTUDIO_MODELS_DIR: join(BASE, 'models'),
    REELSTUDIO_MOCK_AI: '1',
    REELSTUDIO_ENGINE_DIR: join(APP_DIR, 'dev', 'fake-engine'),
    REELSTUDIO_UPDATE_FEED: feed
  })
  const app = await electron.launch({ args: [APP_DIR], cwd: APP_DIR, env })
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1280, height: 820 })
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

async function snap(page: Page, name: string, clip?: { x: number; y: number; width: number; height: number }): Promise<void> {
  if (!EVIDENCE) return
  mkdirSync(EVIDENCE, { recursive: true })
  await page.waitForTimeout(300)
  await page.screenshot({ path: join(EVIDENCE, `${name}.png`), ...(clip ? { clip } : {}) })
}

/** Screenshots every ~100 ms until stop(), then one mp4 (evidence only). */
function record(page: Page): { stop(): Promise<void> } {
  if (!EVIDENCE) return { stop: async () => {} }
  const dir = join(BASE, 'frames')
  mkdirSync(dir, { recursive: true })
  let n = 0
  let on = true
  const loop = (async () => {
    while (on) {
      await page.screenshot({ path: join(dir, `${String(n++).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 85 }).catch(() => {})
      await new Promise((r) => setTimeout(r, 60))
    }
  })()
  return {
    async stop() {
      on = false
      await loop
      execFileSync('ffmpeg', ['-y', '-v', 'error', '-framerate', '10', '-i', join(dir, '%05d.jpg'), '-vf', 'scale=1280:-2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(EVIDENCE, 'update-flow.mp4')])
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

/** Reel Studio > Check for Updates…, with the native dialog recorded (and, for evidence, photographed). */
async function menuCheck(app: ElectronApplication, shotName?: string): Promise<{ title: string; message: string; detail?: string; buttons: string[] }> {
  const capture = shotName && EVIDENCE ? join(EVIDENCE, `${shotName}.png`) : null
  await app.evaluate(({ dialog, BrowserWindow }, capture) => {
    const g = globalThis as { __dialogs?: unknown[]; __realShow?: typeof dialog.showMessageBox }
    g.__dialogs = []
    g.__realShow ??= dialog.showMessageBox.bind(dialog)
    ;(dialog as { showMessageBox: unknown }).showMessageBox = async (...a: unknown[]) => {
      const o = a[a.length - 1] as Electron.MessageBoxOptions
      g.__dialogs!.push(o)
      if (!capture) return { response: 1, checkboxChecked: false }
      // Show the real sheet for a moment so it can be photographed, then close it.
      const ac = new AbortController()
      setTimeout(() => ac.abort(), 2500)
      const w = BrowserWindow.getAllWindows()[0]
      return g.__realShow!(w, { ...o, signal: ac.signal })
    }
  }, capture)
  await app.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()!.items[0].submenu!.items.find((i) => i.label === 'Check for Updates…')!
    item.click()
  })
  await expect.poll(() => app.evaluate(() => ((globalThis as { __dialogs?: unknown[] }).__dialogs ?? []).length)).toBe(1)
  if (capture) {
    await new Promise((r) => setTimeout(r, 800))
    const id = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getMediaSourceId())
    try {
      execFileSync('screencapture', ['-x', '-o', `-l${id.split(':')[1]}`, capture])
    } catch {
      /* no screen recording permission here: the dialog's words are still checked below */
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  return app.evaluate(() => (globalThis as { __dialogs?: { title: string; message: string; detail?: string; buttons: string[] }[] }).__dialogs![0])
}

test("the app menu's answers", async () => {
  test.skip(process.platform !== 'darwin', 'the app menu exists only on macOS')
  const { app, page } = await launch()
  try {
    await passFirstRun(page)
    await page.getByTestId('nav-settings').click()
    latest = 'old'
    expect(await menuCheck(app, 'menu-up-to-date')).toMatchObject({ message: "You're up to date", detail: 'Reel Studio 0.1.2 is the newest version.' })
    latest = 'broken'
    expect(await menuCheck(app, 'menu-check-failed')).toMatchObject({ message: 'Update check failed', detail: 'I could not check for updates. Try again later.' })
  } finally {
    await app.close()
  }
})

test('find, download and get ready to install an update', async () => {
  const { app, page } = await launch()
  try {
    await passFirstRun(page)
    await page.getByTestId('nav-settings').click()
    const row = page.getByTestId('update-settings')
    await expect(row).toContainText('You have Reel Studio 0.1.2')
    await row.scrollIntoViewIfNeeded()
    await snap(page, 'settings-idle')

    // a new version is out
    latest = 'new'
    await page.getByTestId('update-settings-button').click()
    await expect(row).toContainText('Reel Studio 0.1.3 is ready to download.')
    await row.scrollIntoViewIfNeeded()
    await snap(page, 'settings-available')
    const button = page.getByTestId('update-button')
    await expect(button).toContainText('Download update')
    await expect(button).toContainText('Version 0.1.3')
    await page.getByTestId('nav-home').click()
    await snap(page, 'sidebar-available', { x: 0, y: 560, width: 520, height: 260 })

    // pointing at it shows what's new
    await button.hover()
    const pop = page.getByTestId('update-popover')
    await expect(pop).toHaveAttribute('data-open', 'true')
    await expect(pop).toContainText('Update ready to download')
    await expect(pop).toContainText('Updates install themselves.')
    await expect(pop).toContainText('Fix: the update note no longer covers the AI status.')
    await expect(pop).not.toContainText('the disk image')
    await snap(page, 'popover', { x: 0, y: 380, width: 560, height: 440 })
    // Escape, not moving the mouse away: Chromium also hit-tests the real macOS cursor, so a pointer-leave
    // check fails whenever the physical cursor happens to sit where the popover opens.
    await page.mouse.move(900, 300)
    await page.keyboard.press('Escape')
    await expect(pop).not.toHaveAttribute('data-open', 'true')

    // downloading: the ring fills
    const rec = record(page)
    await page.waitForTimeout(800)
    await button.click()
    await expect(button).toContainText(/Downloading \d+%/)
    await expect.poll(async () => Number((/Downloading (\d+)%/.exec((await button.textContent()) ?? '') ?? [])[1] ?? 0)).toBeGreaterThan(25)
    await snap(page, 'sidebar-downloading', { x: 0, y: 560, width: 520, height: 260 })

    // downloaded: the note, and the button asks to restart
    await expect(button).toContainText('Restart to update', { timeout: 60_000 })
    const toast = page.getByTestId('toast')
    await expect(toast).toContainText('Update downloaded')
    await expect(toast).toContainText('Restart from the update button in the sidebar to install it.')
    await snap(page, 'toast-downloaded')
    await snap(page, 'sidebar-downloaded', { x: 0, y: 560, width: 520, height: 260 })

    // the install question; "Not now" keeps everything as it was
    await button.click()
    const confirm = page.getByTestId('confirm')
    await expect(confirm).toContainText('Install update 0.1.3 and restart Reel Studio?')
    await expect(confirm).toContainText('Your videos and settings stay.')
    await snap(page, 'confirm-install')
    await page.getByTestId('confirm-no').click()
    await expect(confirm).toBeHidden()
    await rec.stop()

    await page.getByTestId('nav-settings').click()
    await expect(row).toContainText('Reel Studio 0.1.3 is downloaded.')
    await expect(page.getByTestId('update-settings-button')).toHaveText('Restart to update')
    await row.scrollIntoViewIfNeeded()
    await snap(page, 'settings-downloaded')
  } finally {
    await app.close()
  }
})
