// Pictures of the first run and the phone at the four window sizes the app must work at, to look at before and after
// a layout change. Not a test of behaviour; skipped unless asked for.
//
//   REELSTUDIO_SHOTS_OUT=<dir>   where the PNGs go
//
// One fresh profile walks welcome, the sample (while it is made and once it is done), the editor step (Advanced shut
// and open, with the server form) and the new reel the first run ends on, then makes a reel and takes the Reel screen's phone in each
// shape, in Clean, and on the full-screen stage.
import { test, expect, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, dropFiles, launch, makeMedia, modelReady, toEditorStep } from './helpers'

const OUT = process.env.REELSTUDIO_SHOTS_OUT

test.skip(!OUT, 'set REELSTUDIO_SHOTS_OUT to run')

const SIZES = [
  { width: 1100, height: 720 },
  { width: 1280, height: 820 },
  { width: 1512, height: 982 },
  { width: 1920, height: 1080 }
]

async function snap(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(450)
  await page.screenshot({ path: join(OUT!, `${name}.png`) })
}

/** The same screen at every size, named `<name>-<width>`. Ends at the default size. */
async function atEverySize(page: Page, name: string): Promise<void> {
  for (const s of SIZES) {
    await page.setViewportSize(s)
    await snap(page, `${name}-${s.width}`)
  }
  await page.setViewportSize({ width: 1280, height: 820 })
}

test('first run and phone pictures at four sizes', async () => {
  test.setTimeout(10 * 60_000)
  mkdirSync(OUT!, { recursive: true })
  const media = makeMedia()
  const mine = join(BASE, 'first-run-shots')
  const { app, page } = await launch({ REELSTUDIO_ROOT: join(mine, 'Reel Studio'), REELSTUDIO_USER_DATA: join(mine, 'user data'), REELSTUDIO_MOCK_CLAUDE: 'ready' })
  try {
    await expect(page.getByTestId('get-started')).toBeVisible()
    await atEverySize(page, '01-welcome')

    await page.getByTestId('get-started').click()
    // the welcome's middle reel on its way into the phone (360 ms)
    await page.waitForTimeout(170)
    await page.screenshot({ path: join(OUT!, '01b-flight-1280.png') })
    await expect(page.getByTestId('steps-list').locator('li').nth(2)).toHaveAttribute('data-state', 'done', { timeout: 30_000 })
    await atEverySize(page, '02-sample-making')

    await page.getByTestId('demo-skip').click()
    await expect(page.getByTestId('sample-v1')).toBeVisible()
    await atEverySize(page, '03-sample-done')

    await toEditorStep(page)
    await expect(page.getByTestId('ai-picker')).toBeVisible()
    await modelReady(page)
    await atEverySize(page, '04-editor')
    await page.getByTestId('ai-advanced').click()
    await atEverySize(page, '05-editor-advanced')
    await page.getByTestId('own-server-toggle').click()
    await atEverySize(page, '05b-editor-server-form')
    await page.getByTestId('connection-cancel').click()
    await page.getByTestId('ai-advanced').click()

    await page.getByTestId('not-now').or(page.getByTestId('editor-continue')).click()
    await expect(page.getByTestId('planned-stage')).toBeVisible()
    await atEverySize(page, '06-your-reel')

    await dropFiles(page, 'planned-stage', [media.video])
    await expect(page.getByTestId('log-play-1')).toBeVisible({ timeout: 240_000 })
    await page.getByTestId('player').evaluate((v: HTMLVideoElement) => {
      v.currentTime = 2
    })
    await atEverySize(page, '07-reel')

    for (const id of ['reel', 'iphone-se', 'iphone-17', 'iphone-pro-max']) {
      await page.getByTestId('shape').click()
      await page.getByTestId(`shape-${id}`).click()
      await snap(page, `08-shape-${id}`)
    }
    await page.getByTestId('view-clean').click()
    await snap(page, '09-clean')
    await page.getByTestId('view-instagram').click()

    await page.getByTestId('full-screen').click()
    await expect(page.getByTestId('full-stage')).toBeVisible()
    await atEverySize(page, '10-full-screen')
    await page.keyboard.press('Escape')
  } finally {
    await app.close()
  }
})
