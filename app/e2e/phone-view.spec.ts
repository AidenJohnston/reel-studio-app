// The Reel screen's phone (components/Phone.tsx): Instagram view by default, Clean on request, the choice kept in
// the app's settings, the phone (an iPhone 17 until another shape is picked) filling its column's height at the three
// window sizes the spec names, and
// the safe zone only while the subtitles are being set up, and full screen still closing with Instagram's looping
// audio ticker inside it. The window's own full screen is stubbed: fullscreen.spec covers it.
//
// Run: npx playwright test e2e/phone-view.spec.ts (after npm run build).
import { test, expect, type Page } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, launch, makeMedia, makeReel, passFirstRun, shot } from './helpers'

const SIZES = [
  { width: 1100, height: 720 },
  { width: 1280, height: 820 },
  { width: 1512, height: 945 }
]

/** The phone, its screen, its slot, and how far the stage's last row (the transport) reaches. */
const layout = (page: Page) =>
  page.evaluate(() => {
    const r = (sel: string) => document.querySelector(sel)!.getBoundingClientRect()
    const stage = document.querySelector('.stage')!
    return { phone: r('.stage .phone'), screen: r('.stage .phone-screen'), slot: r('.stage .phone-fill'), bottom: stage.lastElementChild!.getBoundingClientRect().bottom, view: innerHeight, scrollW: document.documentElement.scrollWidth, w: innerWidth }
  })

test('fails if the phone stops filling its column as an iPhone 17, the view is not Instagram first and remembered, or full screen cannot close', async () => {
  test.setTimeout(6 * 60_000)
  const media = makeMedia()
  const { app, page } = await launch()
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('app:fullScreen')
    ipcMain.handle('app:fullScreen', () => undefined)
  })
  try {
    await passFirstRun(page)
    await makeReel(page, media.video, 5 * 60_000)

    for (const size of SIZES) {
      await page.setViewportSize(size)
      await expect
        .poll(async () => {
          const l = await layout(page)
          return [
            Math.abs(l.screen.width / l.screen.height - 402 / 874) < 0.005,
            Math.abs(l.phone.height - l.slot.height) <= 1,
            l.bottom <= l.view,
            l.scrollW <= l.w
          ]
        }, { message: `phone at ${size.width}x${size.height}: an iPhone 17's screen, the whole phone at the slot's height, stage inside the window, no sideways scroll` })
        .toEqual([true, true, true, true])
    }

    // Instagram first: its screen is drawn; speed sits in the transport row under the video in either view.
    await expect(page.getByTestId('ig-overlay')).toBeVisible()
    await expect(page.getByTestId('speed')).toBeVisible()

    await page.getByTestId('view-clean').click()
    await expect(page.getByTestId('ig-overlay')).toBeHidden()
    await expect(page.getByTestId('view-clean')).toHaveAttribute('aria-checked', 'true')
    await expect.poll(() => page.evaluate(() => window.reel.app.info().then((i) => i.phoneView))).toBe('clean')
    await expect(page.getByTestId('speed')).toBeVisible()

    // kept across a restart of the page, from the app's settings
    await page.reload()
    await page.getByTestId('project-card').first().click()
    await expect(page.getByTestId('player')).toBeVisible()
    await expect(page.getByTestId('view-clean')).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByTestId('ig-overlay')).toBeHidden()

    // the safe zone shows while the subtitles are being set up, and only then
    await page.getByTestId('view-instagram').click()
    await expect(page.getByTestId('ig-overlay')).toBeVisible()
    await expect(page.getByTestId('safe-band')).toHaveCount(0)
    await page.getByTestId('edit-myself').click()
    await page.getByTestId('tab-captions').click()
    await expect(page.getByTestId('safe-band')).toBeVisible()
    await page.getByTestId('tab-cut').click()
    await expect(page.getByTestId('safe-band')).toHaveCount(0)
    await page.keyboard.press('Escape')
  } finally {
    await app.close()
  }
})

// The first run's sample is drawn under the same Instagram screen as every reel (Phone.tsx InstagramChrome), so it
// shows the preview without making a reel. Test builds keep Instagram off; REELSTUDIO_TEST_INSTAGRAM stands in for a
// connected account (main/instagram-ipc.ts).
// fails if the preview shows a made-up handle or counts again, or not the connected account's handle and picture
test('the Instagram preview shows the connected account, a plain placeholder without one, and no counts', async () => {
  const cases: { name: string; env: Record<string, string>; handle: string; audio: string; picture: number }[] = [
    { name: 'none', env: {}, handle: 'Your account', audio: 'Original audio', picture: 0 },
    { name: 'connected', env: { REELSTUDIO_TEST_INSTAGRAM: 'fixture.creator' }, handle: 'fixture.creator', audio: 'fixture.creator · Original audio', picture: 1 }
  ]
  for (const c of cases) {
    const dir = mkdtempSync(join(BASE, `ig-${c.name}-`))
    const { app, page } = await launch({ REELSTUDIO_ROOT: join(dir, 'Reel Studio'), REELSTUDIO_USER_DATA: join(dir, 'user data'), ...c.env })
    try {
      await page.getByTestId('get-started').click()
      const ig = page.getByTestId('sample-phone').getByTestId('ig-overlay')
      await expect(ig).toBeVisible()
      await expect(ig.getByTestId('ig-handle')).toHaveText(c.handle)
      await expect(ig.locator('.igc-tick span').first()).toHaveText(c.audio)
      await expect(ig.locator('.igc-rail')).not.toHaveText(/\d/)
      await expect(ig.locator('.igc-who img.igc-avatar')).toHaveCount(c.picture)
      await expect(page.locator('.fr-welcome')).toHaveCount(0) // the welcome's reel has landed on the phone
      await shot(page, `instagram-preview-${c.name}`)
    } finally {
      await app.close()
    }
  }
})
