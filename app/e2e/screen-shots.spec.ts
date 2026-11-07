// Screenshots of the reel screens, the sidebar, Library, Insights, Settings and their menus and dialogs at the four
// window sizes, for looking at a layout change before and after. Not a test of behaviour; skipped unless asked for.
//
//   REELSTUDIO_SHOTS_OUT=<folder>        where <state>@<w>x<h>.png go
//   REELSTUDIO_SHOTS_STATES=home,reel    only these states
//
// When e2e/layout-audit/detect.ts is there, each shot's findings are written next to it as findings.json.
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expectViewport, launch, makeMedia, makeReel, passFirstRun } from './helpers'

const OUT = process.env.REELSTUDIO_SHOTS_OUT
const ONLY = process.env.REELSTUDIO_SHOTS_STATES ? new Set(process.env.REELSTUDIO_SHOTS_STATES.split(',')) : null
const SIZES: [number, number][] = [
  [1100, 720],
  [1280, 820],
  [1512, 982],
  [1920, 1080]
]
const DETECT = join(__dirname, 'layout-audit', 'detect.ts')

test.skip(!OUT, 'set REELSTUDIO_SHOTS_OUT to run')

type Ctx = { app: ElectronApplication; page: Page }
type State = { id: string; enter: (c: Ctx) => Promise<void>; leave?: (c: Ctx) => Promise<void> }

async function setSize({ app, page }: Ctx, [w, h]: [number, number]): Promise<void> {
  await app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].setContentSize(s.w, s.h), { w, h })
  await expectViewport(page, w, h)
  await page.waitForTimeout(350)
}

const NIGHTLY = '0.1.3-nightly.20261028.9'
async function offerNightly({ app }: Ctx): Promise<void> {
  const state = {
    status: 'available', mode: 'page', autoCheck: true, currentVersion: '0.1.3-nightly.20261028.8', availableVersion: NIGHTLY, downloadedVersion: null,
    releaseNotes: [{ version: NIGHTLY, items: ['The update note no longer covers the AI status.', 'Subtitles keep their case.'], totalItems: 2 }],
    olderNotes: 0, releases: [], releaseUrl: null, downloadPercent: null, message: null, errorContext: null, snoozed: false
  }
  await app.evaluate(({ BrowserWindow }, st) => BrowserWindow.getAllWindows()[0].webContents.send('update:state', st), state)
}

const nav = (id: string) => async ({ page }: Ctx) => {
  await page.keyboard.press('Escape')
  await page.getByTestId(id).click()
}
const openReel = async ({ page }: Ctx): Promise<void> => {
  if (await page.locator('.reel-page').isVisible()) return
  await page.getByTestId('nav-home').click()
  await page.getByTestId('project-card').first().click()
  await expect(page.getByTestId('log-play-1')).toBeVisible()
}
const tab = (key: string) => async (c: Ctx) => {
  await openReel(c)
  if (!(await c.page.getByTestId('drawer').isVisible())) await c.page.getByTestId('edit-myself').click()
  await c.page.getByTestId(`tab-${key}`).click()
}
const settingsAt = (section: string) => async ({ page }: Ctx) => {
  await page.getByTestId('account').click()
  await expect(page.getByTestId('settings-search')).toBeVisible()
  await page.locator('.main').getByRole('button', { name: section, exact: true }).first().click()
  await page.waitForTimeout(600)
}

const STATES: State[] = [
  { id: 'home', enter: nav('nav-home') },
  { id: 'reel', enter: openReel },
  { id: 'reel-more-menu', enter: async (c) => (await openReel(c), await c.page.getByTestId('more').click()), leave: async ({ page }) => page.keyboard.press('Escape') },
  { id: 'reel-share', enter: async (c) => (await openReel(c), await c.page.getByTestId('share').click()), leave: async ({ page }) => page.keyboard.press('Escape') },
  { id: 'edit-cut', enter: tab('cut') },
  { id: 'edit-captions', enter: tab('captions') },
  { id: 'edit-music', enter: tab('music') },
  { id: 'edit-broll', enter: tab('broll') },
  { id: 'edit-cover', enter: tab('cover'), leave: async ({ page }) => page.getByTestId('drawer-close').click() },
  { id: 'delete-dialog', enter: async (c) => (await openReel(c), await c.page.getByTestId('more').click(), await c.page.getByTestId('delete').click()), leave: async ({ page }) => page.keyboard.press('Escape') },
  { id: 'more-reels', enter: async (c) => (await openReel(c), await c.page.getByTestId('more').click(), await c.page.getByTestId('more-reels').click()) },
  {
    id: 'more-reels-open',
    enter: async (c) => {
      await openReel(c)
      await expect(c.page.locator('.rf-more').first()).toBeAttached()
      await c.page.evaluate(() => document.querySelectorAll<HTMLButtonElement>('.rf-more[aria-expanded="false"]').forEach((b) => b.click()))
    }
  },
  { id: 'library', enter: nav('nav-library') },
  { id: 'insights', enter: nav('nav-insights') },
  { id: 'settings', enter: settingsAt('Privacy') },
  { id: 'settings-reels', enter: settingsAt('Reels') },
  { id: 'settings-posting', enter: settingsAt('Posting') },
  { id: 'settings-about', enter: settingsAt('About and updates') },
  { id: 'update-offer', enter: async (c) => (await nav('nav-home')(c), await offerNightly(c)) },
  {
    id: 'update-popover',
    enter: async (c) => {
      await offerNightly(c)
      const box = (await c.page.getByTestId('update-button').boundingBox())!
      await c.page.mouse.move(box.x + 18, box.y + box.height / 2)
      await c.page.waitForTimeout(500)
    },
    leave: async ({ page }) => page.mouse.move(700, 5)
  },
  {
    id: 'collapsed-reel',
    enter: async (c) => {
      await openReel(c)
      if (!(await c.page.locator('.shell.rail, .rail').count())) await c.page.keyboard.press('Meta+Backslash')
    }
  },
  { id: 'collapsed-home', enter: nav('nav-home'), leave: async ({ page }) => page.keyboard.press('Meta+Backslash') }
]

test('screens at four sizes', async () => {
  test.setTimeout(20 * 60_000)
  const media = makeMedia()
  const { app, page } = await launch({ REELSTUDIO_MOCK_CLAUDE: 'ready', REELSTUDIO_MOCK_NOTE: '300' }, { realViewport: true })
  const ctx = { app, page }
  const detect = existsSync(DETECT) ? (require(DETECT) as { detectLayout: (o: { allow: unknown[] }) => { findings: unknown[] } }).detectLayout : null
  const found: Record<string, unknown[]> = {}
  try {
    await passFirstRun(page)
    await makeReel(page, media.video)
    // a note about a moment, so the notes carry an editor's reply
    await page.evaluate(() => (document.querySelector('[data-testid=player]') as HTMLVideoElement).pause())
    await page.getByTestId('note-input').fill('make the subtitles bigger here')
    await page.getByTestId('send').click()
    await expect(page.getByTestId('log-play-2')).toBeVisible({ timeout: 120_000 })
    mkdirSync(OUT!, { recursive: true })
    for (const s of STATES) {
      if (ONLY && !ONLY.has(s.id)) continue
      try {
        await setSize(ctx, SIZES[0])
        await s.enter(ctx)
        await page.waitForTimeout(400)
        for (const size of SIZES) {
          await setSize(ctx, size)
          const name = `${s.id}@${size[0]}x${size[1]}`
          await page.screenshot({ path: join(OUT!, `${name}.png`) })
          if (detect) found[name] = (await page.evaluate(detect, { allow: [] })).findings
        }
        await s.leave?.(ctx)
      } catch (e) {
        found[s.id] = [{ unreached: String(e instanceof Error ? e.message : e).split('\n')[0] }]
        await page.keyboard.press('Escape').catch(() => {})
      }
    }
  } finally {
    if (detect || Object.keys(found).length) writeFileSync(join(OUT!, 'findings.json'), JSON.stringify(found, null, 1))
    await app.close()
  }
})
