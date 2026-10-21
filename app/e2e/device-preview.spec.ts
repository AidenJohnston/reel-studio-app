// "See it on": switch the Reel screen's phone between real phone shapes, turn Instagram view on and off on
// each, and check the choice is remembered after a reload. Saves a picture of every shape, with and without
// Instagram view, to REELSTUDIO_DEVICE_SHOTS (default e2e/screenshots/devices).
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
  } finally {
    await app.close().catch(() => {})
  }
})
