// "See it on": switch the Reel screen's phone between real phone shapes, turn Instagram view on and off on
// each, and check the choice is remembered after a reload. Saves a picture of every shape, with and without
// Instagram view, to REELSTUDIO_DEVICE_SHOTS (default e2e/screenshots/devices). Also the phone around it: the
// Working phone is paper until the first frame shows, the Reel column fits the window without scrolling,
// and the subtitle preview never splits a word.
//
// Run: npx playwright test e2e/device-preview.spec.ts (after npm run build).
import { test, expect, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { DEVICES } from '../src/shared/devices'
import { BASE, launch, makeMedia, passFirstRun, SHOTS } from './helpers'

const MINE = mkdtempSync(join(BASE, 'devices-'))
const OUT = process.env.REELSTUDIO_DEVICE_SHOTS ?? join(SHOTS, 'devices')

async function pauseAt(page: Page, t: number): Promise<void> {
  await page.evaluate((at) => {
    const v = document.querySelector('[data-testid=player]') as HTMLVideoElement
    v.pause()
    v.currentTime = at
  }, t)
  await page.waitForFunction(() => (document.querySelector('[data-testid=player]') as HTMLVideoElement).readyState >= 2)
}

async function snap(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(350) // the covered areas fade in
  await page.screenshot({ path: join(OUT, `${name}.png`) })
}

test('see it on: phone shapes, Instagram view on each, remembered', async () => {
  test.setTimeout(10 * 60_000)
  mkdirSync(OUT, { recursive: true })
  const media = makeMedia()
  const { app, page } = await launch({ REELSTUDIO_ROOT: join(MINE, 'Documents', 'Reel Studio'), REELSTUDIO_USER_DATA: join(MINE, 'user data') })
  try {
    await passFirstRun(page)
    await page.getByTestId('new-video').click()
    await page.getByTestId('file-input').setInputFiles([media.video])
    // Working: the take's first frame fades in over paper.
    await expect(page.getByTestId('working-frame')).toHaveClass(/shown/, { timeout: 60_000 })
    await expect(page.getByTestId('working-screen')).not.toHaveClass(/waiting/)
    await expect(page.getByTestId('working-spinner')).toHaveCount(0) // the spinner shows only until the footage is in
    await expect(page.getByTestId('player')).toBeVisible({ timeout: 10 * 60_000 })
    await expect(page.getByTestId('export')).toBeEnabled({ timeout: 10 * 60_000 })
    await pauseAt(page, 3)

    // Nobody picked a phone yet: the plain phone, as before.
    const pick = page.getByTestId('device-pick')
    await expect(pick).toHaveValue('any')
    await expect(page.getByTestId('device-frame')).toHaveAttribute('data-device', 'any')
    await expect(page.getByTestId('device-layer')).toHaveCount(0)
    await snap(page, 'any')

    const phone = page.getByTestId('phone')
    const ig = page.getByTestId('ig-toggle')
    for (const d of DEVICES) {
      await pick.selectOption(d.id)
      const frame = page.getByTestId('device-frame')
      await expect(frame).toHaveAttribute('data-device', d.id)
      // The screen has this phone's shape (its points, drawn smaller).
      const box = (await page.locator('.phone-screen').boundingBox())!
      expect(box.width / box.height).toBeCloseTo(d.screen.w / d.screen.h, 1)
      await expect(page.getByTestId('device-covered')).toHaveCount(0)
      await snap(page, d.id)

      await ig.click()
      await expect(ig).toHaveAttribute('aria-pressed', 'true')
      const covered = page.getByTestId('device-covered')
      await expect(covered).toBeVisible()
      for (const zone of ['top', 'buttons', 'caption']) await expect(covered.getByTestId(`zone-${zone}`)).toBeVisible()
      // The plain phone's stand-in buttons are not drawn on top of the real layout.
      await expect(page.getByTestId('ig-overlay')).toBeHidden()
      await snap(page, `${d.id}-instagram`)

      await ig.click()
      await expect(covered).toHaveCount(0)
    }
    // Still the phone you can play and drag out.
    await expect(phone).toBeVisible()

    // The choice is remembered.
    const last = DEVICES[DEVICES.length - 1]
    await page.reload()
    await page.getByTestId('project-card').first().click()
    await expect(page.getByTestId('player')).toBeVisible()
    await expect(page.getByTestId('device-pick')).toHaveValue(last.id)
    await expect(page.getByTestId('device-frame')).toHaveAttribute('data-device', last.id)

    // And back to the plain phone.
    await page.getByTestId('device-pick').selectOption('any')
    await expect(page.getByTestId('device-frame')).toHaveAttribute('data-device', 'any')
    await expect(page.getByTestId('device-layer')).toHaveCount(0)

    // The phone column fits the window: Send to my phone in view, and nothing in the column makes the page scroll.
    for (const [width, height] of [[1280, 820], [1024, 700]]) {
      await page.setViewportSize({ width, height })
      for (const id of ['any', ...DEVICES.map((d) => d.id)]) {
        await page.getByTestId('device-pick').selectOption(id)
        const send = (await page.getByTestId('send-to-phone-reel').boundingBox())!
        expect(send.y + send.height, `${width}x${height} ${id}`).toBeLessThanOrEqual(height - 24) // the page's bottom padding
      }
    }
    await page.setViewportSize({ width: 1280, height: 820 })
    await page.getByTestId('device-pick').selectOption('any')
    // With the right column short enough too (the "No AI editor yet" banner put away), the page does not scroll.
    await page.getByTestId('banner-close').click()
    expect(await page.evaluate(() => { const m = document.querySelector('.main')!; return m.scrollHeight - m.clientHeight })).toBe(0)

    // Big subtitles: the preview breaks lines only between words, as the export does.
    await page.getByTestId('edit-myself').click()
    await page.getByTestId('tab-captions').click()
    await page.getByTestId('cap-size-big').click()
    const sub = page.getByTestId('sub-preview')
    await expect(sub).toBeVisible()
    // Every word on a line is a whole word of the transcript ("PLACEHOLDE" / "R" would not be).
    const slug = (await page.evaluate(() => window.reel.projects.list()))[0].slug
    const heard = new Set((await page.evaluate((s) => window.reel.projects.get(s), slug)).words.map((w) => w.w.toUpperCase()))
    const lines = await sub.locator('span').allTextContents()
    expect(lines.length).toBeGreaterThan(0)
    for (const word of lines.join(' ').split(' ')) expect(heard, word).toContain(word)
    await page.screenshot({ path: join(OUT, 'subtitles-big.png') })
    await page.keyboard.press('Escape')
  } finally {
    await app.close().catch(() => {})
  }
})
