// The job event contract through the real UI (stand-in engine + the mock AI acting like an AI run with
// REELSTUDIO_MOCK_FIRST_LOOK): the Working screen plays the first look (a real reel-media video, not
// ''), says what it is, shows "thinking" + time left, then the finished reel replaces it.
//
// Run: npx playwright test e2e/wire.spec.ts (after npm run build).
import { test, expect } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, launch, makeMedia, passFirstRun, shot } from './helpers'

const MINE = mkdtempSync(join(BASE, 'wire-'))

test('wire: first look plays on the Working screen, thinking + time left, then the reel', async () => {
  test.setTimeout(10 * 60_000)
  const media = makeMedia()
  const { app, page } = await launch({
    REELSTUDIO_ROOT: join(MINE, 'Documents', 'Reel Studio'),
    REELSTUDIO_USER_DATA: join(MINE, 'user data'),
    REELSTUDIO_MOCK_FIRST_LOOK: '12000',
    FAKE_ENGINE_SLOW: '1'
  })
  try {
    await passFirstRun(page)
    await page.getByTestId('new-video').click()
    await page.getByTestId('file-input').setInputFiles([media.video])
    await expect(page.getByText('Making your reel')).toBeVisible()

    // the first look: labelled, a real video that plays (muted), not the Reel screen's player
    const look = page.getByTestId('first-look')
    await expect(look).toHaveText("Here's a first look. I'm still adding pictures and music.", { timeout: 120_000 })
    await expect(look).toHaveAttribute('data-kind', 'first-look')
    await expect(page.getByTestId('player')).toHaveCount(0)
    const video = () =>
      page.evaluate(() => {
        const v = document.querySelector('[data-testid=first-look-video]') as HTMLVideoElement | null
        return v ? { src: v.currentSrc, ready: v.readyState, t: v.currentTime, w: v.videoWidth, muted: v.muted } : null
      })
    await expect.poll(async () => (await video())?.t ?? 0, { timeout: 10_000 }).toBeGreaterThan(0.2)
    const v = (await video())!
    expect(v.src).toMatch(/^reel-media:\/\/.+first-look\.mp4/)
    expect(v.ready).toBeGreaterThanOrEqual(2)
    expect(v.w).toBeGreaterThan(0)
    expect(v.muted).toBe(true)

    // the AI is "thinking": calm dots instead of a spinner, kept across the once-a-second repeats
    await expect(page.getByTestId('thinking')).toBeVisible()
    await page.waitForTimeout(2500)
    await expect(page.getByTestId('thinking')).toBeVisible()
    await expect(page.getByTestId('time-left')).toHaveText(/left|Almost done/)
    await shot(page, 'w-01-working-first-look')

    // done: the Reel screen with the final version
    await expect(page.getByTestId('player')).toBeVisible({ timeout: 240_000 })
    await expect(page.getByTestId('first-look')).toHaveCount(0)
    await shot(page, 'w-02-reel-after')
  } finally {
    await app.close().catch(() => {})
  }
})
