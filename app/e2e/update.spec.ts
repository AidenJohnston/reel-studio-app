import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { createRequire } from 'node:module'
import { APP_DIR, BASE, root, userData, passFirstRun, openSettings } from './helpers'

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
let latest: 'old' | 'new' | 'nightly' = 'old'
const NIGHTLY = '0.1.3-nightly.20261028.9'

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
      if (latest === 'nightly') {
        const tag = (v: string) => release(`v${v}`, { prerelease: true, html_url: `https://github.com/SamGu-NRX/reel-studio-app/releases/tag/v${v}`, body: NOTES })
        return void res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify([tag(NIGHTLY), tag('0.1.3-nightly.20261028.8')]))
      }
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

test('fails if a prerelease update cannot be downloaded, declined or snoozed', async () => {
  test.skip(process.platform !== 'darwin', 'the in-app download backend is macOS-only')
  const { app, page } = await launch()
  try {
    await passFirstRun(page)
    await openSettings(page)
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
    await expect(button).toContainText('Reel Studio 0.1.3') // #76's words: "Version N" is a reel's version
    await page.getByTestId('nav-home').click()
    await page.getByTestId('nav-insights').focus() // the last nav row (always there since polish-home): Tab goes on to the update button
    await page.keyboard.press('Tab')
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
    await expect(confirm).toContainText('Your reels and settings stay.')
    await expect(page.getByTestId('confirm-no')).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await expect(page.getByTestId('confirm-yes')).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(page.getByTestId('confirm-no')).toBeFocused()
    await page.getByTestId('confirm-no').click()
    await expect(confirm).toBeHidden()

    await openSettings(page)
    await expect(row).toContainText('Reel Studio 0.1.3 is downloaded.')
    await expect(page.getByTestId('update-settings-button')).toHaveText('Restart to update')
    await row.scrollIntoViewIfNeeded()
    await page.getByTestId('nav-insights').focus() // the last nav row (always there since polish-home): Tab goes on to the update button
    await page.keyboard.press('Tab') // keyboard focus opens the popover
    await expect(pop).toHaveAttribute('data-open', 'true')
    await page.getByTestId('update-not-now').click()
    await expect(button).toBeHidden()
    await expect(page.getByTestId('toast')).toContainText('Hidden until tomorrow. You can still update from Settings.')
    await expect(page.getByTestId('update-settings-button')).toHaveText('Restart to update')
    const project = join(root(), 'Projects', 'update-export')
    mkdirSync(join(project, 'versions', 'v1'), { recursive: true })
    // version 1: a vN above project.json's version is a render no note saved, not a version (#87)
    writeFileSync(join(project, 'project.json'), JSON.stringify({ title: 'Update export', version: 1, sources: [] }))
    writeFileSync(join(project, 'versions', 'v1', 'export.mp4'), 'completed export fixture')
    await page.evaluate(() => window.reel.projects.exportVersion('update-export', 1))
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
    // The random-byte download cannot install; work becomes available again after that failure.
    await page.evaluate(() => window.reel.projects.exportVersion('update-export', 1))
  } finally {
    await app.close()
  }
})

type Box = { left: number; top: number; right: number; bottom: number; width: number; height: number }
const boxOf = (page: Page, sel: string): Promise<Box> =>
  page.locator(sel).first().evaluate((el) => {
    const r = el.getBoundingClientRect()
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }
  })
const meets = (a: Box, b: Box): boolean => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom

// Sam's Mac nightly (notes/design/r12/sam-1028/4-update-popover-sidebar-overflow.png): the item's text ran out of the
// sidebar across the page, and its popover opened in the middle of the window over Choose video.
test('fails if the nightly update item leaves the sidebar, or its popover leaves the window or covers the page', async () => {
  test.skip(process.platform !== 'darwin', 'page mode for a nightly is the Mac nightly')
  latest = 'nightly'
  // its own settings: the first test's Not now hides the offer for a day
  const { app, page } = await launch({ REELSTUDIO_UPDATE_AS: '0.1.3-nightly.20261028.8', REELSTUDIO_USER_DATA: join(BASE, 'nightly-user-data') })
  try {
    await passFirstRun(page)
    await openSettings(page)
    await page.getByTestId('update-settings-button').click()
    const button = page.getByTestId('update-button')
    await expect(button).toContainText('Open download page')
    await expect(button).toContainText('Nightly Oct 28, build 9')
    await expect(button).toHaveAttribute('aria-label', `Open download page: Reel Studio ${NIGHTLY}`)
    await expect(button).toHaveAttribute('title', new RegExp(`Reel Studio ${NIGHTLY.replace(/\./g, '\\.')} is out`))
    await page.getByTestId('nav-home').click()
    const pop = page.getByTestId('update-popover')
    for (const [width, height] of [[1100, 720], [1280, 820], [1512, 982], [1920, 1080]]) {
      await page.setViewportSize({ width, height })
      const side = await boxOf(page, '.side')
      // nothing of the item reaches past the sidebar's edge
      const parts = await page.getByTestId('update-button-wrap').evaluate((wrap) =>
        Array.from(wrap.querySelectorAll('*'))
          .filter((el) => !el.closest('[data-testid="update-popover"]') && !el.closest('.sr-only'))
          .map((el) => el.getBoundingClientRect().right)
      )
      expect(Math.max(...parts), `${width}x${height}`).toBeLessThanOrEqual(side.right)
      await button.hover()
      await expect(pop).toHaveAttribute('data-open', 'true')
      await expect(pop).toContainText(`Reel Studio ${NIGHTLY}`)
      const item = await boxOf(page, '[data-testid="update-button"]')
      const p = await boxOf(page, '[data-testid="update-popover"]')
      // above its item, inside the sidebar's column and the window
      expect(p.bottom, `${width}x${height}`).toBeLessThanOrEqual(item.top)
      expect(p.left).toBeGreaterThanOrEqual(side.left)
      expect(p.right).toBeLessThanOrEqual(side.right)
      expect(p.top).toBeGreaterThanOrEqual(0)
      expect(meets(p, await boxOf(page, 'role=button[name="Choose video"]'))).toBe(false)
      // its two actions sit on one line each, side by side
      const link = await boxOf(page, '[data-testid="update-release-link"]')
      const notNow = await boxOf(page, '[data-testid="update-not-now"]')
      expect(link.height).toBeLessThanOrEqual(32)
      expect(notNow.height).toBeLessThanOrEqual(32)
      expect(Math.abs(link.top - notNow.top)).toBeLessThan(2)
      await page.mouse.move(width / 2, 10)
      await expect(pop).not.toHaveAttribute('data-open', 'true')
    }
    // folded to the rail: still there, as its icon, and its popover stays in the window
    await page.setViewportSize({ width: 1100, height: 720 })
    await page.keyboard.press('Meta+Backslash')
    await expect.poll(async () => (await boxOf(page, '.side')).width).toBe(64)
    const rail = await boxOf(page, '.side')
    const item = await boxOf(page, '[data-testid="update-button"]')
    expect(item.width).toBeGreaterThanOrEqual(24)
    expect(item.right).toBeLessThanOrEqual(rail.right)
    await button.hover()
    await expect(pop).toHaveAttribute('data-open', 'true')
    const p = await boxOf(page, '[data-testid="update-popover"]')
    expect(p.bottom).toBeLessThanOrEqual(item.top)
    expect(p.right).toBeLessThanOrEqual(1100)
    expect(p.top).toBeGreaterThanOrEqual(0)
  } finally {
    latest = 'old'
    await app.close()
  }
})
