// Watching the reel full screen from the Reel screen: the window goes full screen and the reel fills
// its height at 9:16, playback carries over both ways, Space plays and pauses, Esc and the Exit
// button close it and focus goes back to "Full screen". Then: Esc straight after opening, Space
// while closing, an export dialog opened from the menu while watching, the smallest window, a window
// already in macOS full screen (it must stay there, and opening again after leaving it must work),
// and reduced motion.
//
// Run: npx playwright test e2e/fullscreen.spec.ts (after npm run build).
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { join } from 'node:path'
import { launch, makeMedia, passFirstRun, SHOTS } from './helpers'

const media = (page: Page, testid: string) =>
  page.getByTestId(testid).evaluate((v: HTMLVideoElement) => ({ at: v.currentTime, paused: v.paused, muted: v.muted }))
const winFull = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen())
/**
 * isFullScreen() once it holds still. macOS full screen changes take about half a second each and
 * Electron queues the ones asked for meanwhile, so a single reading can come before a queued change starts.
 */
async function settledFull(app: ElectronApplication): Promise<boolean | 'changing'> {
  const a = await winFull(app)
  await new Promise((r) => setTimeout(r, 800))
  return a === (await winFull(app)) ? a : 'changing'
}

/**
 * The view spans the display and is as tall as macOS lets a full-screen window be (on a notched
 * MacBook that is the display minus the strip beside the camera), and the frame is 9:16 at that full
 * height (or full width, on a display narrower than 9:16).
 */
async function expectTrueFrame(page: Page, app: ElectronApplication): Promise<void> {
  const win = () =>
    app.evaluate(({ BrowserWindow, screen }) => {
      const w = BrowserWindow.getAllWindows()[0]
      const [width, height] = w.getContentSize()
      return { width, height, displayWidth: screen.getDisplayMatching(w.getBounds()).size.width }
    })
  const page$ = () => page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
  await expect.poll(async () => (await win()).width === (await win()).displayWidth).toBe(true)
  await expect.poll(async () => JSON.stringify(await page$())).toBe(JSON.stringify(await win().then(({ width, height }) => ({ width, height }))))
  const view = await page$()
  const r = await page.locator('.fs-frame').evaluate(async (f) => {
    await Promise.allSettled(document.getAnimations().map((a) => a.finished)) // measure after the opening settle
    return f.getBoundingClientRect().toJSON() as { width: number; height: number }
  })
  expect(Math.abs(r.width / r.height - 9 / 16)).toBeLessThan(0.005)
  expect(Math.abs(r.height - Math.min(view.height, (view.width * 16) / 9))).toBeLessThan(1.5)
}

async function open(page: Page): Promise<void> {
  await page.getByTestId('phone').hover()
  await page.getByTestId('open-fullscreen').click()
  await expect(page.getByTestId('fullscreen')).toBeVisible()
  await expect(page.getByTestId('fullscreen')).toBeFocused()
}

async function closed(page: Page, app: ElectronApplication, stayFull = false): Promise<void> {
  await expect(page.getByTestId('fullscreen')).toHaveCount(0)
  await expect.poll(() => settledFull(app), { timeout: 15_000 }).toBe(stayFull)
  await expect(page.getByTestId('open-fullscreen')).toBeFocused()
}

test('full screen reel: open, hand-off both ways, Space, Esc, Exit button, small and full-screen windows', async () => {
  test.setTimeout(10 * 60_000)
  const m = makeMedia()
  const { app, page } = await launch({}, { realViewport: true })
  await passFirstRun(page)
  await page.getByTestId('new-video').click()
  await page.getByTestId('file-input').setInputFiles([m.video])
  await expect(page.getByTestId('export')).toBeEnabled({ timeout: 10 * 60_000 })

  // The reel arrives playing with the sound off; put it 4 seconds in.
  const player = page.getByTestId('player')
  await player.evaluate(async (v: HTMLVideoElement) => {
    v.muted = true
    v.currentTime = 4
    await v.play()
  })
  await page.getByTestId('phone').hover()
  await expect(page.getByTestId('open-fullscreen')).toHaveText('Full screen')
  await page.screenshot({ path: join(SHOTS, 'fullscreen-01-reel.png') })

  // ---- open: real full screen, true 9:16 frame, playback carried in, the phone stopped ----
  await open(page)
  await expect.poll(() => winFull(app), { timeout: 10_000 }).toBe(true)
  await expectTrueFrame(page, app)
  const inView = await media(page, 'fullscreen-video')
  expect(inView.at).toBeGreaterThanOrEqual(4)
  expect(inView).toMatchObject({ paused: false, muted: true })
  expect((await media(page, 'player')).paused).toBe(true)
  // the page behind is out of reach for Tab and screen readers
  expect(await page.evaluate(() => document.getElementById('root')!.inert)).toBe(true)
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(SHOTS, 'fullscreen-02-open.png') })

  // ---- Space plays and pauses (and the phone behind does not); sound turned on in here ----
  await page.keyboard.press('Space')
  await expect.poll(async () => (await media(page, 'fullscreen-video')).paused).toBe(true)
  await page.keyboard.press('Space')
  await expect.poll(async () => (await media(page, 'fullscreen-video')).paused).toBe(false)
  expect((await media(page, 'player')).paused).toBe(true)
  await page.locator('.fs-frame').hover()
  await page.getByTestId('fullscreen').getByRole('button', { name: 'Sound on' }).click()
  await page.getByTestId('fullscreen').focus()
  await page.keyboard.press('Space')
  await expect.poll(async () => (await media(page, 'fullscreen-video')).paused).toBe(true)
  await page.getByTestId('fullscreen-video').evaluate((v: HTMLVideoElement) => (v.currentTime = 6.5))
  await page.screenshot({ path: join(SHOTS, 'fullscreen-03-paused.png') })

  // ---- Esc: back to the phone at the same spot, paused, sound on, focus on "Full screen" ----
  await page.keyboard.press('Escape')
  await closed(page, app)
  const back = await media(page, 'player')
  expect(back.at).toBeCloseTo(6.5, 1)
  expect(back).toMatchObject({ paused: true, muted: false })
  await expect(page.getByRole('button', { name: 'Sound off' })).toHaveCount(1) // the phone's own button agrees
  expect(await page.evaluate(() => document.getElementById('root')!.inert)).toBe(false)

  // ---- the Exit button, while playing: the phone keeps playing ----
  await open(page)
  await page.keyboard.press('Space')
  await expect.poll(async () => (await media(page, 'fullscreen-video')).paused).toBe(false)
  await page.getByTestId('exit-fullscreen').click()
  await closed(page, app)
  expect((await media(page, 'player')).paused).toBe(false)
  await player.evaluate((v: HTMLVideoElement) => v.pause())

  // ---- Esc straight after opening: the opening reverses and the window comes back ----
  await open(page)
  await page.keyboard.press('Escape')
  await closed(page, app)

  // ---- Space pressed while it is closing plays the phone, not the view that is going away ----
  await open(page)
  await expect.poll(() => winFull(app), { timeout: 10_000 }).toBe(true)
  await page.keyboard.press('Escape')
  await page.keyboard.press('Space')
  await closed(page, app)
  expect((await media(page, 'player')).paused).toBe(false)
  await player.evaluate((v: HTMLVideoElement) => v.pause())

  // ---- Cmd+E while watching: the export dialog waits behind, Esc closes only the full-screen view,
  // and focus goes to the dialog ----
  await open(page)
  await page.evaluate(() => window.dispatchEvent(new Event('reel:export')))
  await expect(page.getByText('Saved to your computer')).toHaveCount(1, { timeout: 120_000 })
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('fullscreen')).toHaveCount(0)
  await expect(page.getByTestId('export-dialog')).toBeVisible()
  await expect(page.getByTestId('export-dialog').locator(':focus')).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('export-dialog')).toHaveCount(0)
  await expect.poll(() => settledFull(app), { timeout: 15_000 }).toBe(false)

  // ---- the smallest window the app allows (1024 x 700): the view still fills the screen at 9:16 ----
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1024, 700))
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1024)
  await open(page)
  await expectTrueFrame(page, app)
  await page.keyboard.press('Escape')
  await closed(page, app)

  // ---- the window is already in macOS full screen: closing the view leaves it there ----
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setFullScreen(true))
  await expect.poll(() => winFull(app), { timeout: 10_000 }).toBe(true)
  await page.waitForTimeout(1000) // let the macOS space animation settle
  await open(page)
  await expectTrueFrame(page, app)
  await page.keyboard.press('Escape')
  await closed(page, app, true)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setFullScreen(false))
  await expect.poll(() => winFull(app), { timeout: 10_000 }).toBe(false)
  await page.waitForTimeout(1000)

  // ---- the window has left macOS full screen: opening again still goes full screen ----
  await open(page)
  await expect.poll(() => winFull(app), { timeout: 10_000 }).toBe(true)
  await expectTrueFrame(page, app)
  await page.keyboard.press('Escape')
  await closed(page, app)

  // ---- reduced motion: no transition in or out ----
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await open(page)
  expect(await page.getByTestId('fullscreen').evaluate((el) => el.getAnimations({ subtree: true }).length)).toBe(0)
  await page.getByTestId('exit-fullscreen').click()
  await closed(page, app)

  await app.close()
})
