// My style and "Learn from my past edits" at the four window sizes, for looking at, not for asserting.
// SHOTS_DIR picks the folder (default e2e/screenshots/my-style); SHOTS_PHASE=before skips the sheet, which an
// older build doesn't have.
//
// Run: npm run build && npx playwright test e2e/my-style-shots.spec.ts
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, expectViewport, launch, passFirstRun, SHOTS } from './helpers'
import { makePastEditsHome } from './past-edits-home'

const DIR = process.env.SHOTS_DIR ?? join(SHOTS, 'my-style')
const SIZES = [
  { width: 1100, height: 720 },
  { width: 1280, height: 820 },
  { width: 1512, height: 982 },
  { width: 1920, height: 1080 }
]
const RULES = [
  'Keep reels around 30 seconds.',
  'Cut to a new shot every 3 seconds or so.',
  'Always use big subtitles, two lines at most, in the lower third of the phone.',
  'Put music under the talking, quiet enough that every word is clear.',
  'Open with a title on screen in the first few seconds.',
  'Use straight cuts between shots, no transitions.'
]

async function open(rules: string[], pastEdits: boolean, env: Record<string, string> = {}): Promise<{ app: ElectronApplication; page: Page }> {
  const mine = mkdtempSync(join(BASE, 'style-shots-'))
  const root = join(mine, 'Documents', 'Reel Studio')
  mkdirSync(root, { recursive: true })
  writeFileSync(
    join(root, 'My style.json'),
    JSON.stringify({ version: 1, rules: rules.map((text, i) => ({ id: `r${i}`, text, createdAt: new Date(Date.UTC(2026, 9, 20 + i)).toISOString() })) })
  )
  const home = join(mine, 'home')
  mkdirSync(home)
  if (pastEdits) makePastEditsHome(home)
  const { app, page } = await launch({ REELSTUDIO_ROOT: root, REELSTUDIO_USER_DATA: join(mine, 'user data'), REELSTUDIO_TEST_PAST_EDITS_HOME: home, ...env }, { realViewport: true })
  await passFirstRun(page)
  await page.getByTestId('nav-style').click()
  return { app, page }
}

async function sized(app: ElectronApplication, page: Page, name: string): Promise<void> {
  mkdirSync(DIR, { recursive: true })
  for (const size of SIZES) {
    await app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].setContentSize(s.width, s.height), size)
    await expectViewport(page, size.width, size.height)
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(DIR, `${name}-${size.width}x${size.height}.png`) })
  }
}

test('My style, empty and with rules', async () => {
  for (const [name, rules] of [['empty', []], ['rules', RULES]] as const) {
    const { app, page } = await open([...rules], false)
    try {
      await expect(page.getByTestId(rules.length ? 'style-rule' : 'style-empty').first()).toBeVisible()
      await sized(app, page, `page-${name}`)
    } finally {
      await app.close().catch(() => {})
    }
  }
})

test('Learn from my past edits: the sheet, found and not found, and what it read', async () => {
  test.skip(process.env.SHOTS_PHASE === 'before', 'the older build opens a file dialog')
  for (const found of [true, false]) {
    const { app, page } = await open([], found)
    try {
      await page.getByTestId('style-learn').click()
      await expect(page.getByTestId(found ? 'learn-item' : 'learn-none').first()).toBeVisible()
      if (found) await expect(page.getByTestId('learn-item').first()).toContainText('timeline')
      await sized(app, page, found ? 'sheet-found' : 'sheet-none')
      if (found) {
        await page.getByTestId('learn-go').click()
        await expect(page.getByTestId('style-lesson')).toBeVisible()
        await sized(app, page, 'lesson')
      }
    } finally {
      await app.close().catch(() => {})
    }
  }
})

test('Learn from my past edits when a limit stopped the look', async () => {
  test.skip(process.env.SHOTS_PHASE === 'before', 'the older build opens a file dialog')
  const { app, page } = await open([], true, { REELSTUDIO_TEST_PAST_EDITS_LIMITS: JSON.stringify({ walk: 7 }) })
  try {
    await page.getByTestId('style-learn').click()
    await expect(page.getByTestId('learn-cut')).toBeVisible()
    await sized(app, page, 'sheet-cut')
  } finally {
    await app.close().catch(() => {})
  }
})
