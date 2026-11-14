// The Reel screen's three ways to look at a reel (components/FullStage.tsx, PreviewControls.tsx, Phone.tsx):
// - speed: 0.5x to 2x from the transport row's menu or < and >, the voice at its own pitch, kept across a version
//   switch and a restart;
// - full screen: F or the button lifts the same playing video onto a stage at the window's height, with its own
//   controls; Esc puts it back and returns focus to where it was; undo can't reach the edit panel behind it;
// - phone shapes: the frame takes each phone's proportion, the reel is trimmed the way that phone shows it, and the
//   caption safe band stays clear of Instagram's buttons drawn on that phone.
//
// Run: npx playwright test e2e/preview-modes.spec.ts (after npm run build).
import { test, expect, type Locator, type Page } from '@playwright/test'
import { join } from 'node:path'
import { place, shapeById } from '../src/shared/phone-shapes'
import { BASE, dropFiles, launch, makeMedia, modelReady, painted, passSample, shot, viewMenu } from './helpers'

const player = (page: Page) =>
  page.evaluate(() => {
    const v = document.querySelector<HTMLVideoElement>('[data-testid="player"]')
    if (!v) return { rate: null, pitch: null, src: '', paused: true, time: 0, duration: 0 }
    return { rate: v.playbackRate, pitch: v.preservesPitch, src: v.currentSrc, paused: v.paused, time: v.currentTime, duration: v.duration }
  })

const rect = (page: Page, sel: string) =>
  page.evaluate((s) => {
    const r = document.querySelector(s)!.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  }, sel)

const focusedTestId = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName)

/** A playback speed from the speed pill's menu, on the Reel screen or the full-screen stage. */
async function pickSpeed(scope: Page | Locator, rate: string): Promise<void> {
  await scope.getByTestId('speed').click()
  await scope.getByTestId(`speed-${rate}`).click()
}

test('fails if speed, full screen or the phone shapes stop working, applying or coming back as they were', async () => {
  test.setTimeout(8 * 60_000)
  const media = makeMedia()
  const mine = join(BASE, 'preview-modes')
  const { app, page } = await launch({ REELSTUDIO_ROOT: join(mine, 'Reel Studio'), REELSTUDIO_USER_DATA: join(mine, 'user data'), REELSTUDIO_MOCK_CLAUDE: 'ready', REELSTUDIO_MOCK_NOTE: '300' })
  try {
    // a new person's path, kept whole (passFirstRun reloads after it): the first run ends on a reel with no video and
    // the window arriving around it, and the video goes into that reel
    await passSample(page)
    await modelReady(page)
    await page.getByTestId('not-now').or(page.getByTestId('editor-continue')).click()
    await expect(page.getByTestId('planned-stage')).toBeVisible()
    await dropFiles(page, 'planned-stage', [media.video])
    await expect(page.getByTestId('log-play-1')).toBeVisible({ timeout: 240_000 })
    const slug = await page.evaluate(() => window.reel.projects.list().then((l) => l[0].slug))
    await page.evaluate((s) => window.reel.projects.note(s, 'make the subtitles bigger'), slug)
    await expect(page.getByTestId('log-play-2')).toBeVisible({ timeout: 120_000 })
    await expect.poll(async () => (await player(page)).duration > 0).toBe(true)

    await test.step('full screen right after the first run covers the whole window, the sidebar too', async () => {
      // the first run's arrival animation could leave .main a stacking context, which would put the stage under the sidebar
      expect(await page.evaluate(() => document.querySelector('.shell')!.className)).toContain('arriving')
      await page.getByTestId('full-screen').click()
      await expect(page.getByTestId('full-stage')).toBeVisible()
      // painted, not hit-tested: elementFromPoint skips the inert page, so it cannot tell what is drawn on top
      const { w, h } = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }))
      for (const [where, x, y] of [['sidebar', 24, h / 2], ['title bar', w / 2 + 300, 20], ['notes', w - 60, h / 2]] as const)
        await expect.poll(() => painted(page, x, Math.round(y)).then((c) => Math.max(...c)), { message: `the stage's dark over the ${where}` }).toBeLessThan(40)
      await page.getByTestId('exit-full-screen').click()
      await expect(page.getByTestId('full-stage')).toHaveCount(0)
    })

    await test.step('speed: picked from the menu, at its own pitch, kept on a version switch and a restart', async () => {
      await pickSpeed(page, '0.5')
      await expect.poll(() => player(page).then((p) => [p.rate, p.pitch])).toEqual([0.5, true])
      await expect(page.getByTestId('speed')).toHaveText('0.5×')
      await expect(page.getByTestId('speed')).toBeFocused()
      await expect(page.getByTestId('speed')).toHaveAttribute('aria-label', 'Playback speed, 0.5×')
      await page.getByTestId('speed').click()
      await shot(page, 'preview-speed-menu')
      await page.keyboard.press('Escape')

      // to Version 1, then to Version 2: a different video on screen
      await page.getByTestId('log-play-1').click()
      // the title names the version whose video is on screen (Reel.tsx versionOnScreen)
      await expect(page.getByTestId('version-on-screen')).toHaveText('Version 1')
      const before = (await player(page)).src
      await page.getByTestId('log-play-2').click()
      await expect(page.getByTestId('version-on-screen')).toHaveText('Version 2')
      await expect.poll(() => player(page).then((p) => [p.src !== before, p.rate])).toEqual([true, 0.5])

      await page.reload()
      await page.getByTestId('project-card').first().click()
      await expect.poll(() => player(page).then((p) => p.rate)).toBe(0.5)
      await expect(page.getByTestId('speed')).toHaveText('0.5×')

      // > and < step and stop at the ends
      await page.getByTestId('timeline').focus()
      await page.keyboard.press('>')
      await expect.poll(() => player(page).then((p) => p.rate)).toBe(1)
      await expect(page.getByTestId('announce')).toHaveText('Speed 1×')
      for (let i = 0; i < 3; i++) await page.keyboard.press('<')
      await expect.poll(() => player(page).then((p) => p.rate)).toBe(0.5)
      await pickSpeed(page, '1')
      await expect.poll(() => player(page).then((p) => p.rate)).toBe(1)
    })

    await test.step('full screen: the same video on a stage at the window height, with its own controls; Esc puts it back', async () => {
      await page.evaluate(() => ((document.querySelector('[data-testid="player"]') as HTMLVideoElement & { kept?: boolean }).kept = true))
      await page.getByTestId('full-screen').click()
      const stage = page.getByTestId('full-stage')
      await expect(stage).toBeVisible()
      const height = await page.evaluate(() => innerHeight)
      // the phone as tall as the window leaves once its controls are under it (brief rule 1: controls sit with what
      // they control): the controls centred on the phone and no wider, the close button among them, all inside the
      // window; its screen an iPhone 17's (the shape until one is picked)
      await expect
        .poll(() =>
          page.evaluate(() => {
            const r = (sel: string) => document.querySelector(sel)!.getBoundingClientRect()
            const phone = r('.stage-v .phone')
            const dock = r('[data-testid="stage-dock"]')
            const exit = r('[data-testid="exit-full-screen"]')
            return {
              under: dock.top >= phone.bottom && dock.top - phone.bottom <= 24,
              centred: Math.abs((dock.left + dock.right) / 2 - (phone.left + phone.right) / 2) <= 1 && dock.width <= phone.width + 0.5,
              exitInDock: exit.top >= dock.top && exit.bottom <= dock.bottom && exit.left >= dock.left && exit.right <= dock.right,
              inside: phone.top >= 16 && dock.bottom <= innerHeight - 16
            }
          })
        )
        .toEqual({ under: true, centred: true, exitInDock: true, inside: true })
      await expect.poll(() => rect(page, '.stage-v .phone-screen').then((r) => Math.abs(r.w / r.h - 402 / 874) < 0.005)).toBe(true)
      expect(await page.evaluate(() => !!(document.querySelector('[data-testid="player"]') as HTMLVideoElement & { kept?: boolean }).kept)).toBe(true)
      expect(await page.evaluate(() => [!!document.querySelector('[data-testid="timeline"]')?.closest('[inert]'), !!document.querySelector('.ncol')?.closest('[inert]')])).toEqual([true, true])
      await expect(stage.getByTestId('stage-play')).toBeFocused()

      await page.keyboard.press('Space')
      await expect.poll(() => player(page).then((p) => p.paused)).toBe(false)
      await page.keyboard.press('Space')
      await expect.poll(() => player(page).then((p) => p.paused)).toBe(true)

      await pickSpeed(stage, '2')
      await expect.poll(() => player(page).then((p) => p.rate)).toBe(2)
      await expect(page.getByTestId('speed').first()).toHaveText('2×')

      const range = stage.locator('.stage-scrub input[type=range]')
      const box = (await range.boundingBox())!
      await range.click({ position: { x: box.width / 2, y: box.height / 2 } })
      await expect.poll(() => player(page).then((p) => Math.abs(p.time - p.duration / 2) < 0.6)).toBe(true)
      // the arrows move a second, as on the player (the range's own step is 0.01 s)
      const at = (await player(page)).time
      await page.keyboard.press('ArrowRight')
      await expect.poll(() => player(page).then((p) => Math.abs(p.time - (at + 1)) < 0.05)).toBe(true)

      await expect(page.getByTestId('ig-overlay')).toBeVisible()
      await shot(page, 'preview-full-screen-instagram')
      await stage.getByTestId('view-clean').click()
      await expect(page.getByTestId('ig-overlay')).toBeHidden()
      await shot(page, 'preview-full-screen-clean')
      await stage.getByTestId('view-instagram').click()
      await expect(page.getByTestId('ig-overlay')).toBeVisible()

      await page.keyboard.press('Escape')
      await expect(stage).toHaveCount(0)
      await expect.poll(() => focusedTestId(page)).toBe('full-screen')
      expect(await page.evaluate(() => !!document.querySelector('[data-testid="timeline"]')?.closest('[inert]'))).toBe(false)
      await expect.poll(() => rect(page, '.stage .phone-screen').then((r) => r.h < height - 120)).toBe(true)

      // from the keyboard: F from the timeline, Esc back to it
      await page.getByTestId('timeline').focus()
      await page.keyboard.press('f')
      await expect(stage).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(stage).toHaveCount(0)
      await expect.poll(() => focusedTestId(page)).toBe('timeline')

      // fails if Cmd/Ctrl+Z on the stage reaches the edit panel behind it, which would drop an edit out of sight (#133)
      await page.getByTestId('edit-myself').click()
      await page.locator('.word').first().click()
      await expect(page.getByTestId('drawer-undo')).toBeVisible()
      await page.getByTestId('full-screen').click()
      await expect(stage).toBeVisible()
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Z' : 'Control+Z')
      await page.keyboard.press('Escape')
      await expect(stage).toHaveCount(0)
      await expect(page.getByTestId('drawer-undo')).toBeVisible()
      await page.getByTestId('drawer-undo').click()
      await page.getByTestId('drawer-close').click()
      await expect(page.getByTestId('drawer')).toHaveCount(0)

      // an f typed in a note is a letter
      await page.getByTestId('note-input').fill('')
      await page.getByTestId('note-input').pressSequentially('f')
      await expect(page.getByTestId('note-input')).toHaveValue('f')
      await expect(stage).toHaveCount(0)
      await page.getByTestId('note-input').fill('')
      await pickSpeed(page, '1')
    })

    await test.step('phone shapes: the proportion, the trim and the safe band on each, kept after a restart', async () => {
      const SHAPES = [
        { id: 'reel', label: 'Whole reel', ratio: 9 / 16, said: 'whole reel' },
        { id: 'iphone-se', label: 'iPhone SE', ratio: 375 / 667, said: 'off the top and bottom' },
        { id: 'iphone-17', label: 'iPhone 17', ratio: 402 / 874, said: 'off each side' },
        { id: 'iphone-pro-max', label: 'iPhone 17 Pro Max', ratio: 440 / 956, said: 'off each side' }
      ]
      for (const s of SHAPES) {
        await viewMenu(page, `shape-${s.id}`)
        await expect(page.getByTestId('view-menu')).toHaveAttribute('aria-label', `View: Instagram, ${s.label}`)
        await expect(page.getByTestId('announce')).toContainText(s.said)
        await expect.poll(() => rect(page, '.stage .phone-screen').then((r) => Math.abs(r.w / r.h - s.ratio) < 0.004), { message: `${s.label}: the screen's proportion` }).toBe(true)
        const screen = await rect(page, '.stage .phone-screen')
        const video = await rect(page, '[data-testid="player"]')
        const tabs = await rect(page, '.igc-tabs')
        // a phone looks like one: its status bar over Instagram's screen, and the Dynamic Island on a Face ID phone; the
        // whole reel's frame is the reel alone
        const drawn = await page.evaluate(() => {
          const status = document.querySelector('.stage .igc-status')
          return { island: getComputedStyle(document.querySelector('.stage .phone-screen')!, '::after').content !== 'none', status: !!status && getComputedStyle(status).display !== 'none' }
        })
        expect(drawn, `${s.label}: island and status bar`).toEqual({ island: s.id === 'iphone-17' || s.id === 'iphone-pro-max', status: s.id !== 'reel' })
        if (s.id === 'reel') expect([video.x, video.y, video.w, video.h].map((n, i) => Math.round(n - [screen.x, screen.y, screen.w, screen.h][i]))).toEqual([0, 0, 0, 0])
        else if (s.id === 'iphone-se') {
          // 16:9: full width, trimmed top and bottom; the reel ends at Instagram's tab bar
          expect(Math.round(video.w - screen.w)).toBe(0)
          expect(video.y).toBeLessThan(screen.y - 2)
          expect(Math.abs(video.y + video.h - tabs.y - (screen.y - video.y))).toBeLessThan(1.5)
        } else {
          // tall: full height above the tab bar, trimmed at the sides
          expect(video.x).toBeLessThan(screen.x - 2)
          expect(Math.abs(video.y - screen.y)).toBeLessThan(1)
          expect(Math.abs(video.y + video.h - tabs.y)).toBeLessThan(1)
        }
        await shot(page, `preview-shape-${s.id}`)
      }

      // the safe band, with Edit it myself on the subtitles, on each phone: clear of every part of Instagram drawn there
      await page.getByTestId('edit-myself').click()
      await page.getByTestId('tab-captions').click()
      await expect(page.getByTestId('safe-band')).toBeVisible()
      await page.getByTestId('cap-pos-higher').click() // 0.66 of the reel's height (caption-presets.ts rowPosition)
      for (const s of SHAPES) {
        await viewMenu(page, `shape-${s.id}`)
        const band = await rect(page, '[data-testid="safe-band"]')
        const screen = await rect(page, '.stage .phone-screen')
        // fails if the subtitle preview leaves the spot the export burns it at: centred on the whole reel, at its
        // position down the whole reel, trimmed parts included. The SE trims the reel's top and bottom, so the viewer's
        // 0.66 would land a few px higher; the tall phones draw the reel wider than the screen, so a scaled-down line
        // pulled off centre (#3, 9e2d0894, d9982758)
        const { reel: r } = place(shapeById(s.id))
        const shape = shapeById(s.id)
        const line = await rect(page, '[data-testid="sub-preview"]')
        expect(Math.abs(line.x + line.w / 2 - (screen.x + ((r.x + r.w / 2) / shape.w) * screen.w)), `${s.label}: subtitle preview x`).toBeLessThan(2)
        expect(Math.abs(line.y + line.h / 2 - (screen.y + ((r.y + 0.66 * r.h) / shape.h) * screen.h)), `${s.label}: subtitle preview y`).toBeLessThan(2)
        expect(band.x >= screen.x - 0.5 && band.y >= screen.y - 0.5 && band.x + band.w <= screen.x + screen.w + 0.5 && band.y + band.h <= screen.y + screen.h + 0.5, `${s.label}: band on the screen`).toBe(true)
        // the whole reel's band is the engine's own (phone-shapes.test.ts); a phone's must clear what is drawn on it
        if (s.id === 'reel') continue
        for (const part of ['.igc-top', '.igc-rail', '.igc-meta', '.igc-tabs']) {
          const r = await rect(page, part)
          const overlap = Math.min(band.x + band.w, r.x + r.w) - Math.max(band.x, r.x) > 0.5 && Math.min(band.y + band.h, r.y + r.h) - Math.max(band.y, r.y) > 0.5
          expect(overlap, `${s.label}: safe band clear of ${part}`).toBe(false)
        }
        await shot(page, `preview-safe-band-${s.id}`)
      }
      await page.keyboard.press('Escape')

      // the longest name, at the smallest window and just above where the name hides: the row stays inside the stage
      await viewMenu(page, 'shape-iphone-pro-max')
      for (const size of [{ width: 1100, height: 720 }, { width: 1180, height: 760 }, { width: 1240, height: 800 }]) {
        await page.setViewportSize(size)
        await expect
          .poll(() => page.evaluate(() => {
            const row = document.querySelector('.transport')!.getBoundingClientRect()
            const last = document.querySelector('[data-testid="full-screen"]')!.getBoundingClientRect()
            const speed = document.querySelector('.transport [data-testid="speed"]')!
            return last.right <= row.right + 0.5 && last.width >= 24 && speed.scrollWidth <= speed.clientWidth
          }), { message: `transport row at ${size.width}x${size.height}: the full-screen button inside it, the speed unclipped` })
          .toBe(true)
      }
      await page.setViewportSize({ width: 1280, height: 820 })

      await viewMenu(page, 'shape-iphone-17')
      await page.getByTestId('full-screen').click()
      await expect(page.getByTestId('full-stage')).toBeVisible()
      await expect.poll(() => rect(page, '.stage-v .phone-screen').then((r) => Math.abs(r.w / r.h - 402 / 874) < 0.004)).toBe(true)
      await shot(page, 'preview-full-screen-iphone-17')
      await page.keyboard.press('Escape')

      await page.reload()
      await page.getByTestId('project-card').first().click()
      await expect(page.getByTestId('view-menu')).toHaveAttribute('aria-label', 'View: Instagram, iPhone 17')
      await viewMenu(page, 'shape-reel')
    })
  } finally {
    await app.close()
  }
})
