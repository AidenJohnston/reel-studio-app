import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { createRequire } from 'node:module'
import { APP_DIR, BASE, ROOT, USER_DATA, passFirstRun } from './helpers'

const { latestMacYml } = createRequire(__filename)('../../packaging/latest-mac.js') as { latestMacYml(zip: string, version: string): string }
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
let latest: 'old' | 'new' = 'old'

test.beforeAll(async () => {
  zip = randomBytes(3 * 1024 * 1024)
  const zipFile = join(BASE, ZIP_NAME)
  writeFileSync(zipFile, zip)
  const yml = latestMacYml(zipFile, '0.1.3')
  const release = (tag: string, extra: Record<string, unknown> = {}) => ({
    tag_name: tag,
    draft: false,
    prerelease: false,
    html_url: `https://github.com/AidenJohnston/reel-studio-app/releases/tag/${tag}`,
    body: '',
    ...extra
  })
  server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0]
    if (path === '/releases') {
      const list = [release('v0.1.2')]
      if (latest === 'new') list.unshift(release('ffmpeg-7.1.1-rs3'), release('v0.1.3', { prerelease: true, body: NOTES }))
      return void res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(list))
    }
    if (path === '/download/v0.1.3/latest-mac.yml') return void res.writeHead(200, { 'Content-Type': 'text/yaml' }).end(yml)
    if (path === `/download/v0.1.3/${ZIP_NAME}`) {
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
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  rmSync(join(homedir(), 'Library', 'Caches', `reel-studio-e2e-updater-${basename(BASE)}`), { recursive: true, force: true })
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

test('fails if a prerelease update cannot be downloaded, declined or snoozed', async () => {
  test.skip(process.platform !== 'darwin', 'the in-app download backend is macOS-only')
  const { app, page } = await launch()
  try {
    await passFirstRun(page)
    await page.getByTestId('nav-settings').click()
    const row = page.getByTestId('update-settings')
    await expect(row).toContainText('You have Reel Studio 0.1.2')
    await expect(page.getByTestId('update-releases-link')).toHaveAttribute('href', 'https://github.com/AidenJohnston/reel-studio-app/releases')
    await row.scrollIntoViewIfNeeded()
    latest = 'new'
    await page.getByTestId('update-settings-button').click()
    await expect(row).toContainText('Reel Studio 0.1.3 is ready to download.')
    await row.scrollIntoViewIfNeeded()
    const button = page.getByTestId('update-button')
    await expect(button).toContainText('Download update')
    await expect(button).toContainText('Version 0.1.3')
    await page.getByTestId('nav-home').click()
    await button.hover()
    const pop = page.getByTestId('update-popover')
    await expect(pop).toHaveAttribute('data-open', 'true')
    await expect(pop).toContainText('Update ready to download')
    await expect(pop).toContainText('Updates install themselves.')
    await expect(pop).toContainText('Fix: the update note no longer covers the AI status.')
    await expect(pop).not.toContainText('the disk image')
    await page.mouse.move(900, 300)
    await page.keyboard.press('Escape')
    await expect(pop).not.toHaveAttribute('data-open', 'true')
    await button.click()
    await expect(button).toContainText(/Downloading \d+%/)
    await expect.poll(async () => Number((/Downloading (\d+)%/.exec((await button.textContent()) ?? '') ?? [])[1] ?? 0)).toBeGreaterThan(25)
    await expect(button).toContainText('Restart to update', { timeout: 60_000 })
    const toast = page.getByTestId('toast')
    await expect(toast).toContainText('Update downloaded')
    await expect(toast).toContainText('Restart from the update button in the sidebar to install it.')
    await button.click()
    const confirm = page.getByTestId('confirm')
    await expect(confirm).toContainText('Install update 0.1.3 and restart Reel Studio?')
    await expect(confirm).toContainText('Your videos and settings stay.')
    await expect(page.getByTestId('confirm-no')).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await expect(page.getByTestId('confirm-yes')).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(page.getByTestId('confirm-no')).toBeFocused()
    await page.getByTestId('confirm-no').click()
    await expect(confirm).toBeHidden()

    await page.getByTestId('nav-settings').click()
    await expect(row).toContainText('Reel Studio 0.1.3 is downloaded.')
    await expect(page.getByTestId('update-settings-button')).toHaveText('Restart to update')
    await row.scrollIntoViewIfNeeded()
    await page.getByTestId('nav-settings').focus()
    await page.keyboard.press('Tab') // keyboard focus opens the popover
    await expect(pop).toHaveAttribute('data-open', 'true')
    await page.getByTestId('update-not-now').click()
    await expect(button).toBeHidden()
    await expect(page.getByTestId('toast')).toContainText('Hidden until tomorrow. You can still update from Settings.')
    await expect(page.getByTestId('update-settings-button')).toHaveText('Restart to update')
  } finally {
    await app.close()
  }
})
