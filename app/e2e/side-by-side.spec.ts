// Compare in one player, or both versions side by side: the choice is the person's and is remembered.
import { test, expect, type Page } from '@playwright/test'
import { join } from 'node:path'
import { BASE, launch, makeMedia, makeReel, openSettings, passFirstRun, shot } from './helpers'

async function openCompare(page: Page): Promise<void> {
  if (await page.getByTestId('log-watch').isVisible()) await page.getByTestId('log-watch').click()
  const changed = page.getByTestId('what-changed-2')
  if ((await changed.getAttribute('aria-expanded')) !== 'true') await changed.click()
  await page.getByTestId('compare-2').click()
}

test('fails if Side by side does not play both versions in step with one sound, Keep Version N does not leave that version on screen, or the choice is not remembered', async () => {
  test.setTimeout(10 * 60_000)
  const media = makeMedia()
  const dirs = { REELSTUDIO_USER_DATA: join(BASE, 'sbs', 'data'), REELSTUDIO_ROOT: join(BASE, 'sbs', 'Reel Studio'), REELSTUDIO_MOCK_CLAUDE: 'ready', REELSTUDIO_MOCK_NOTE: '300' }
  let { app, page } = await launch(dirs)
  try {
    test.skip((await page.evaluate(() => window.reel.app.info())).ai !== 'mock', 'the mock plays the connected editor')
    await passFirstRun(page)
    await openSettings(page)
    await page.getByTestId('use-claude-code').click()
    await expect(page.getByTestId('ai-connected')).toBeVisible()
    await makeReel(page, media.video)
    const slug = await page.evaluate(() => window.reel.projects.list().then((l) => l[0].slug))
    await page.getByTestId('note-input').fill('make the subtitles bigger')
    await page.getByTestId('send').click()
    await expect(page.getByTestId('log-play-2')).toBeVisible({ timeout: 120_000 })

    await openCompare(page)
    await expect(page.getByTestId('compare')).toBeVisible()
    await page.getByTestId('compare-side-by-side').click()
    const sbs = page.getByTestId('side-by-side')
    await expect(sbs).toBeVisible()
    await expect(page.getByTestId('sbs-video-1')).toHaveAttribute('src', /v1/)
    await expect(page.getByTestId('sbs-video-2')).toHaveAttribute('src', /v2/)
    await page.getByTestId('sbs-play').click()
    await expect.poll(() => page.evaluate(() => Array.from(document.querySelectorAll<HTMLVideoElement>('[data-testid^="sbs-video-"]')).map((v) => !v.paused))).toEqual([true, true])
    // one sound at a time: Version 1's until Version 2's is picked
    const muted = () => page.evaluate(() => Array.from(document.querySelectorAll<HTMLVideoElement>('[data-testid^="sbs-video-"]')).map((v) => v.muted))
    expect(await muted()).toEqual([false, true])
    await page.getByTestId('sbs-sound-b').click()
    expect(await muted()).toEqual([true, false])
    // in step: after more than a second of playing, after the sound switched, the two pictures are still within a
    // fraction of a second of each other
    const times = () => page.evaluate(() => Array.from(document.querySelectorAll<HTMLVideoElement>('[data-testid^="sbs-video-"]')).map((v) => v.currentTime))
    await expect.poll(async () => Math.min(...(await times())), { timeout: 15_000 }).toBeGreaterThan(1.2)
    const [ta, tb] = await times()
    expect(Math.abs(ta - tb)).toBeLessThan(0.3)
    // one picture with sound at a time: the player under the dialog does not play along
    const others = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLVideoElement>('video'))
        .filter((v) => !v.dataset.testid?.startsWith('sbs-video-') && v.dataset.testid !== 'change-window')
        .map((v) => ({ cls: v.className, src: v.getAttribute('src')?.split('/').slice(-3).join('/') ?? '', muted: v.muted, t: Math.round(v.currentTime * 10) / 10, paused: v.paused }))
    )
    expect(others.length).toBeGreaterThan(0)
    // each one still playing is named in the failure
    expect(others.filter((v) => !v.paused)).toEqual([])
    await shot(page, 'side-by-side-01-playing')
    // Keep Version 2 (the primary) leaves the newer one on screen; Keep Version 1 the older one
    await expect(page.getByTestId('sbs-done')).toHaveText('Keep Version 2')
    await page.getByTestId('sbs-done').click()
    await expect(sbs).toHaveCount(0)
    await expect(page.getByTestId('compare')).toHaveCount(0)
    await expect(page.getByTestId('version-on-screen')).toHaveText('Version 2')
    await openCompare(page)
    await expect(sbs).toBeVisible()
    await page.getByTestId('sbs-keep-1').click()
    await expect(sbs).toHaveCount(0)
    await expect(page.getByTestId('version-on-screen')).toHaveText('Version 1')
    await expect(page.getByTestId('version-latest')).toBeVisible()
    await app.close()

    // remembered: Compare opens side by side, and "Compare in one player" goes back to the one player
    ;({ app, page } = await launch(dirs))
    await page.evaluate((s) => window.dispatchEvent(new CustomEvent('rs:open', { detail: s })), slug)
    await page.getByTestId('project-card').first().click()
    await openCompare(page)
    await expect(page.getByTestId('side-by-side')).toBeVisible()
    await page.getByTestId('sbs-one').click()
    await expect(page.getByTestId('side-by-side')).toHaveCount(0)
    await expect(page.getByTestId('compare')).toBeVisible()
    await shot(page, 'side-by-side-02-one-player')
  } finally {
    await app.close()
  }
})
